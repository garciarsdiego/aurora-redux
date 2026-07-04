// Streaming Omniroute caller (D-H2.026).
//
// PARALLEL to omniroute-call.ts — that function stays synchronous (decomposer,
// reviewer, consolidator, patternMatcher all need a single string back to feed
// JSON.parse + Zod). This one yields token chunks as they arrive over SSE for
// callers that genuinely benefit from incremental rendering (REPL prompt
// dispatch, llm_call tasks with task.stream_output=true, daemon /stream/llm
// bridge).
//
// Behavior:
//   - POST /v1/chat/completions with stream: true and stream_options.include_usage
//   - SSE parser via eventsource-parser (battle-tested; not from scratch)
//   - AbortController propagation via opts.signal
//   - Idle timeout reset on each chunk; default 60s, configurable via env
//   - Yields delta.content strings; final chunk's `usage` reported via opts.onUsage
//   - ZERO automatic retry (refazer dobra custo; user/caller decides)
//
// See docs/plans/REPL-LEVEL-D.md § 7 (Streaming protocol) and decisions.md D-H2.026.

import { createParser, type EventSourceMessage } from 'eventsource-parser';
import { request as undiciRequest } from 'undici';
import { getOmnirouteUrl, getOmnirouteApiKey } from './config.js';
import { checkRateLimit, RateLimitError } from './rate-limiter.js';

export interface OmnirouteStreamUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly total_cost_usd?: number;
}

export interface OmnirouteStreamOpts {
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly model: string;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
  readonly onUsage?: (usage: OmnirouteStreamUsage) => void;
  /** Reset on each chunk; aborts if exceeded. Default 60s. */
  readonly idleTimeoutMs?: number;
  /** Workspace for rate-limit tracking. Default 'default'. */
  readonly workspace?: string;
}

export class OmnirouteStreamIdleTimeoutError extends Error {
  constructor(public readonly idleMs: number, public readonly chunksReceived: number) {
    super(`Omniroute stream idle for ${idleMs}ms after ${chunksReceived} chunks`);
    this.name = 'OmnirouteStreamIdleTimeoutError';
  }
}

const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DONE_SENTINEL = '[DONE]';

/**
 * Stream tokens from Omniroute as an AsyncIterable<string>.
 *
 * Usage:
 *   for await (const chunk of callOmnirouteStream({systemPrompt, userPrompt, model, signal})) {
 *     tokenBuffer.push(chunk);
 *   }
 *
 * Each yielded string is a delta.content fragment from the SSE stream — typically
 * 1-5 tokens worth for Anthropic, sometimes whole words for OpenAI. The consumer
 * is responsible for accumulation if they need the full text.
 */
export async function* callOmnirouteStream(
  opts: OmnirouteStreamOpts,
): AsyncIterable<string> {
  const workspace = opts.workspace ?? 'default';
  const rateCheck = checkRateLimit(workspace);
  if (!rateCheck.allowed) {
    throw new RateLimitError(rateCheck.retryAfterMs);
  }

  const url = `${getOmnirouteUrl()}/v1/chat/completions`;
  const apiKey = getOmnirouteApiKey();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
    'Cache-Control': 'no-cache',
    // Omniroute's Next.js layer always sets Content-Encoding: gzip in the
    // response header even though the SSE body is plain text. Node.js 22's
    // native fetch (undici) auto-decompresses based on that header and
    // immediately throws Z_DATA_ERROR. We bypass this via undiciRequest with
    // decompress:false, so the raw (already-plain-text) stream passes through
    // without attempted gzip unwrapping.
  };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  // Claude models in extended-thinking or adaptive mode (Opus 4+, Sonnet 4.6+
  // routed via cc/ or similar) reject any temperature other than 1.
  // Safest: omit temperature entirely for all Claude-family models and let the
  // Anthropic API use its default (1). Non-Claude providers (e.g. OpenAI gpt-*)
  // still receive an explicit temperature for determinism.
  const isClaude = /claude[-.]|^cc\/|^anthropic\/|opus-4|sonnet-4-[6-9]/i.test(opts.model);
  const body = JSON.stringify({
    model: opts.model,
    messages: [
      { role: 'system', content: opts.systemPrompt },
      { role: 'user', content: opts.userPrompt },
    ],
    ...(isClaude ? {} : { temperature: opts.temperature ?? 0.2 }),
    stream: true,
    stream_options: { include_usage: true },
  });

  const idleMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

  // Compose external signal (user abort) with internal idle-timeout signal.
  const internalCtrl = new AbortController();
  const onExternalAbort = () => internalCtrl.abort();
  if (opts.signal) {
    if (opts.signal.aborted) internalCtrl.abort();
    else opts.signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  // Use undici's request with decompress:false — Omniroute's Next.js layer
  // sets Content-Encoding: gzip in the response header even though the SSE
  // body is plain text. Node.js fetch (undici) would try to gzip-decompress
  // and immediately throw Z_DATA_ERROR. decompress:false gives us the raw body.
  let undiciRes: Awaited<ReturnType<typeof undiciRequest>>;
  try {
    undiciRes = await undiciRequest(url, {
      method: 'POST',
      headers,
      body,
      signal: internalCtrl.signal,
      reset: true,
      // decompress is intentionally absent: unlike global fetch, undici's
      // request does NOT auto-decompress based on Content-Encoding, so we
      // always receive the raw (plain-text) SSE bytes even when the server
      // responds with Content-Encoding: gzip.
    });
  } catch (err) {
    opts.signal?.removeEventListener('abort', onExternalAbort);
    throw err;
  }

  if (undiciRes.statusCode < 200 || undiciRes.statusCode >= 300) {
    // Consume body for error text
    const chunks: Buffer[] = [];
    for await (const chunk of undiciRes.body) {
      if (Buffer.isBuffer(chunk)) chunks.push(chunk);
    }
    const errText = Buffer.concat(chunks).toString('utf8').slice(0, 500);
    opts.signal?.removeEventListener('abort', onExternalAbort);
    throw new Error(`Omniroute stream HTTP ${undiciRes.statusCode}: ${errText}`);
  }

  const decoder = new TextDecoder('utf-8', { fatal: false });

  // Pending chunks from the parser (parser is push-based, we consume pull-based).
  const pending: string[] = [];
  let parserError: Error | null = null;
  let isDone = false;

  const parser = createParser({
    onEvent: (event: EventSourceMessage): void => {
      const data = event.data;
      if (data === DONE_SENTINEL) {
        isDone = true;
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return; // skip unparseable chunk; non-fatal
      }
      const delta = extractDelta(parsed);
      if (typeof delta === 'string' && delta.length > 0) {
        pending.push(delta);
      }
      const usage = extractUsage(parsed);
      if (usage && opts.onUsage) {
        try { opts.onUsage(usage); } catch { /* user callback failures are theirs */ }
      }
    },
    onError: (err: Error): void => {
      parserError = err;
    },
  });

  let chunksReceived = 0;
  let lastChunkAt = Date.now();

  // Idle watchdog: poll every 1s; abort if no chunk has arrived in idleMs.
  const watchdog = setInterval(() => {
    if (Date.now() - lastChunkAt > idleMs && !isDone) {
      internalCtrl.abort();
    }
  }, 1000);

  try {
    for await (const rawChunk of undiciRes.body) {
      if (isDone) break;

      const chunk: Uint8Array = Buffer.isBuffer(rawChunk)
        ? rawChunk
        : Buffer.from(rawChunk as ArrayBuffer);

      lastChunkAt = Date.now();
      chunksReceived++;
      parser.feed(decoder.decode(chunk, { stream: true }));
      if (parserError) throw parserError;

      // Flush whatever the parser pushed into `pending`.
      while (pending.length > 0) {
        const next = pending.shift()!;
        yield next;
      }
    }

    // Drain any remaining buffered chunks after [DONE].
    parser.feed(decoder.decode(new Uint8Array(0), { stream: false }));
    while (pending.length > 0) {
      const next = pending.shift()!;
      yield next;
    }
  } catch (err) {
    // Surface typed idle-timeout error when watchdog fired.
    if (Date.now() - lastChunkAt > idleMs && !opts.signal?.aborted) {
      throw new OmnirouteStreamIdleTimeoutError(idleMs, chunksReceived);
    }
    throw err;
  } finally {
    clearInterval(watchdog);
    opts.signal?.removeEventListener('abort', onExternalAbort);
    // undici body iterator cleans up automatically; no explicit release needed.
  }
}

// --- Response shape extraction ---

function extractDelta(parsed: unknown): string | null {
  const data = parsed as { choices?: Array<{ delta?: { content?: string } }> };
  return data.choices?.[0]?.delta?.content ?? null;
}

function extractUsage(parsed: unknown): OmnirouteStreamUsage | null {
  const data = parsed as {
    usage?: {
      prompt_tokens?: number;
      input_tokens?: number;
      completion_tokens?: number;
      output_tokens?: number;
      total_cost_usd?: number;
    };
  };
  if (!data.usage) return null;
  const u = data.usage;
  return {
    ...(u.input_tokens ?? u.prompt_tokens ? { input_tokens: u.input_tokens ?? u.prompt_tokens } : {}),
    ...(u.output_tokens ?? u.completion_tokens ? { output_tokens: u.output_tokens ?? u.completion_tokens } : {}),
    ...(u.total_cost_usd !== undefined ? { total_cost_usd: u.total_cost_usd } : {}),
  };
}
