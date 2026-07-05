import {
  getOmnirouteUrl,
  getOmnirouteApiKey,
  getOmnirouteTimeoutMs,
  getOmnirouteMaxRetries,
  computeOmnirouteTimeoutMs,
  getAutoTagOverrides,
  getPromptPrefixCacheEnabled,
  getDirectProviderMaxTokens,
} from './config.js';
// Aurora-Redux (2026-07-04): direct OpenAI-compat providers (Kimi/MiniMax/GLM)
// and CLI-backed brain roles (claude-cli/codex-cli), both routed by model-id
// prefix. A model with no known prefix falls through to the legacy Omniroute
// path completely unchanged.
import {
  resolveDirectProviderRoute,
  stripRoutePrefix,
  buildDirectProviderUrl,
  getDirectProviderApiKey,
  extractContentRobust,
  providerSupportsVision,
} from './provider-routes.js';
import { isCliModel, callViaCli } from './cli-invoker.js';
// Fase A / Wave 1 (visual reviewer multimodal, 2026-07-05): pure image ->
// data-URL conversion, see docs/VISION-SPIKE-2026-07-05.md for the transport
// evidence this wiring is based on.
import { imageToDataUrl, type ReviewImageAttachment } from './image-attachment.js';
import { resolveAutoTag } from '../v2/models/auto-tags.js';
import {
  isLlmCacheEnabled,
  computeLlmCacheKey,
  getCachedResponse,
  putCachedResponse,
} from './llm-cache.js';
import {
  startTraceSpan,
  endTraceSpan,
  spanContextStorage,
} from '../v2/observability/tracing.js';
import http from 'node:http';
import https from 'node:https';
import { checkRateLimit, RateLimitError } from './rate-limiter.js';
import { getCostDatabase } from '../cost/index.js';
import { getCostAwareRouter, type SelectModelResult } from '../cost/index.js';
import { getRealTimeCostTracker } from '../cost/index.js';
import { CostRouterBudgetExceededError } from '../v2/budget/control.js';

// Workaround for the Node 22+/undici gzip decompression bug observed against
// OmniRoute v3.8.0 (AGENTS.md "OmniRoute Known Issues 2026-05-19"). We bypass
// the global `fetch` and drive `node:http`/`node:https` directly with
// `Accept-Encoding: identity` so the response body stays uncompressed.
// `signal` MUST be honored — without it a workflow cancel keeps burning
// provider tokens for the full per-call timeout, silently regressing the
// M1-W1-B / F-REL-1 fix.
function nativeFetch(url: string, options: {
  method: string;
  headers: Record<string, string>;
  body: string;
  timeout?: number;
  signal?: AbortSignal;
}): Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  /**
   * Lowercased response header map. Surfacing this lets callers pick up
   * Omniroute's `x-omniroute-response-cost` / `x-omniroute-cache-hit` /
   * `x-omniroute-latency-ms` headers which are absent from the JSON body
   * (F-LIVE-2). Empty `{}` when the underlying transport can't provide
   * them (older Node, unusual test mocks).
   */
  responseHeaders: Record<string, string>;
}> {
  // Test-mode escape hatch: respect globalThis.fetch so vitest can install
  // a captureFetch mock. Production keeps using node:http directly to avoid
  // the undici gzip decompression bug.
  if (process.env.NODE_ENV === 'test' || process.env.VITEST === 'true') {
    const { signal } = options;
    return (globalThis.fetch as typeof fetch)(url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      ...(signal ? { signal } : {}),
    }).then(async (res) => {
      const responseHeaders: Record<string, string> = {};
      if (res.headers && typeof res.headers.forEach === 'function') {
        res.headers.forEach((value, key) => {
          responseHeaders[key.toLowerCase()] = value;
        });
      }
      return {
        ok: res.ok,
        status: res.status,
        text: async () => res.text(),
        responseHeaders,
      };
    });
  }

  return new Promise((resolve, reject) => {
    const { signal } = options;

    const makeAbortError = (): Error => {
      const reason = signal?.reason instanceof Error ? signal.reason : new Error('Aborted');
      // Create a new AbortError instead of modifying the existing one
      // to avoid "Cannot set property name of which has only a getter" error
      const abortError = new Error(reason.message);
      abortError.name = 'AbortError';
      abortError.cause = reason;
      return abortError;
    };

    if (signal?.aborted) {
      reject(makeAbortError());
      return;
    }

    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const client = isHttps ? https : http;

    const req = client.request(url, {
      method: options.method,
      headers: {
        ...options.headers,
        'Accept-Encoding': 'identity',
        'Content-Length': Buffer.byteLength(options.body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        // node:http delivers headers as a Record<string, string|string[]>;
        // flatten to a lowercased string map for cross-transport parity.
        const responseHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(res.headers)) {
          if (value === undefined) continue;
          responseHeaders[key.toLowerCase()] = Array.isArray(value)
            ? value.join(', ')
            : String(value);
        }
        resolve({
          ok: res.statusCode! >= 200 && res.statusCode! < 300,
          status: res.statusCode!,
          text: async () => data,
          responseHeaders,
        });
      });
    });

    const onAbort = () => {
      const err = makeAbortError();
      req.destroy(err);
      reject(err);
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => signal?.removeEventListener('abort', onAbort);

    req.on('error', (err) => {
      cleanup();
      reject(err);
    });
    req.on('timeout', () => {
      cleanup();
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.on('close', cleanup);

    if (options.timeout) {
      req.setTimeout(options.timeout);
    }

    req.write(options.body);
    req.end();
  });
}

export interface OmniroutePromptInput {
  systemPrompt: string;
  userPrompt: string;
  model: string;
  temperature?: number;
  /**
   * Optional AbortSignal — when provided, propagates to the underlying
   * `fetch()` so that a cancelled workflow aborts the LLM call within
   * one event-loop tick instead of waiting up to ~300s for the per-call
   * timeout. The signal is composed with the existing
   * `AbortSignal.timeout(effectiveTimeoutMs)` via `AbortSignal.any`
   * (Node 22+), so both deadlines remain honored.
   *
   * Tier 0 Wave 3 / M1-W1-B fix for F-REL-1 — without this the adaptive
   * supervisor's per-turn defaultExecuteTurn ignored its `signal`
   * parameter, leaving cost-bleed during workflow cancel.
   */
  signal?: AbortSignal;
  /**
   * Optional budget constraint for cost-aware routing (USD).
   * When provided, the CostAwareRouter will select a model that fits
   * within this budget while maximizing quality.
   */
  budgetUsd?: number;
  /**
   * Task type for cost-aware routing (e.g., 'planning', 'code', 'debug', 'review').
   * Helps the router select the most appropriate model for the specific use case.
   */
  taskType?: string;
  /**
   * Minimum quality threshold (0-1) for cost-aware routing.
   * The router will not select models below this quality threshold.
   */
  minQuality?: number;
  /**
   * Aurora-parity Wave 2 — opt-in enforce. When true AND the cost router finds
   * no model within `budgetUsd` at `minQuality`, the call is HARD-GATED
   * (throws BudgetExceededError) instead of proceeding over budget. Default
   * (false/undefined) = soft: downshift if possible, else proceed + warn.
   * Only consulted when the cost-aware branch fires (budget args present).
   */
  enforceBudget?: boolean;
  /**
   * Workflow ID for cost tracking purposes.
   */
  workflowId?: string;
  /**
   * Task ID for cost tracking purposes.
   */
  taskId?: string;
  /**
   * Fase A / Wave 1 (visual reviewer multimodal, 2026-07-05) — optional local
   * image attachments (e.g. reviewer screenshots) to send alongside the
   * prompt as OpenAI-style content-parts. Purely additive: when absent/empty
   * the call behaves byte-identically to before this field existed (plain
   * string `content`, no content-parts array — see docs/VISION-SPIKE-2026-07-05.md
   * for the transport evidence). When present, requires a direct-provider
   * route with confirmed vision support (`providerSupportsVision`) — CLI
   * transports and the legacy Omniroute path both fail fast with an explicit
   * error rather than silently dropping the image (see the transport branch
   * below in `callOmnirouteWithUsage`).
   */
  images?: ReviewImageAttachment[];
}

export interface OmnirouteUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_cost_usd?: number;
  /**
   * Anthropic prompt-prefix cache fields (B6.1 / N3 follow-up).
   * Present when:
   *   - Request body had `cache_control: ephemeral` on the system block
   *   - Omniroute provider passes the marker through to Anthropic
   *   - Anthropic actually cached / hit the prefix
   * Absent on non-Anthropic providers, on requests below the cache floor,
   * or when the upstream Omniroute strips the marker. When non-zero,
   * cache_read_input_tokens proves the prefix is being reused — that's
   * the only post-hoc verification of the B6.1 wire's effectiveness.
   */
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface OmnirouteCallResult {
  content: string;
  model_used: string;
  usage?: OmnirouteUsage;
}

/**
 * Minimal Omniroute HTTP caller.
 *
 * Scope for D2: single POST to /v1/chat/completions, no retry, no idempotency.
 * Robust executor with retry/idempotency/paralelism is Bloco 2 (D6-D12).
 */
export async function callOmniroute(
  input: OmniroutePromptInput,
  workspace: string = 'default',
): Promise<string> {
  const result = await callOmnirouteWithUsage(input, workspace);
  return result.content;
}

export async function callOmnirouteWithUsage(
  input: OmniroutePromptInput,
  workspace: string = 'default',
): Promise<OmnirouteCallResult> {
  const rateCheck = checkRateLimit(workspace);
  if (!rateCheck.allowed) {
    throw new RateLimitError(rateCheck.retryAfterMs);
  }

  const {
    systemPrompt,
    userPrompt,
    model,
    temperature = 0.2,
    signal: externalSignal,
    budgetUsd,
    taskType,
    minQuality,
    enforceBudget,
    workflowId,
    taskId,
    images,
  } = input;

  // Cost-aware routing (Aurora-parity Wave 2): when the caller threads budget
  // constraints (opt-in via OMNIFORGE_COST_ROUTER + a budget cap — see
  // internal-utils.ts), downshift to a cheaper adequate model as the cap is
  // approached. A router FAILURE degrades to the requested model; the opt-in
  // enforce gate is the one INTENTIONAL throw and must not be swallowed — it is
  // thrown as a BudgetExceededError so the retry loop treats it as terminal.
  let resolvedModel = model;
  // Gate on budgetUsd specifically: routing is meaningless without a budget,
  // and this avoids the branch firing if a future caller threads only
  // taskType/minQuality. (executeTask threads all-or-nothing today.)
  if (budgetUsd !== undefined) {
    let routingDecision: SelectModelResult | undefined;
    try {
      routingDecision = getCostAwareRouter().selectModel({
        requested_model: model,
        task_type: taskType || 'general',
        budget_usd: budgetUsd,
        // `?? 0.7`, NOT `|| 0.7`: a deliberately-configured minQuality of 0
        // (accept any cheaper model) must NOT be coerced back to the default.
        min_quality: minQuality ?? 0.7,
        use_case: taskType || 'general',
        // Thread the REAL prompt size so the per-call estimate reflects this
        // actual call rather than a ~13-char "task: <type>" literal. Without
        // this the downshift/enforce gate stayed inert until the budget
        // headroom itself went sub-cent (medium-sev correctness bug).
        prompt_chars: systemPrompt.length + userPrompt.length,
      });
    } catch (error) {
      // Router failure (e.g. cost DB unavailable) must never block a call —
      // degrade to the requested model. Distinct from the enforce gate below,
      // which is a deliberate budget decision rather than a failure.
      console.warn('[CostAwareRouting] Failed to select optimal model, using original:', error);
      routingDecision = undefined;
    }
    if (routingDecision) {
      if (routingDecision.recommended_model !== model) {
        console.log(
          `[CostAwareRouting] Switched from ${model} to ${routingDecision.recommended_model} (reason: ${routingDecision.reasoning})`,
        );
        resolvedModel = routingDecision.recommended_model;
      }
      if (enforceBudget && !routingDecision.within_budget) {
        // No model fits the remaining budget at the required quality and enforce
        // is on → gate the call BEFORE any HTTP request (no trace span has been
        // opened at this point — the span is started further down, after auto-tag
        // resolution). CostRouterBudgetExceededError subclasses BudgetExceededError
        // so the retry loop still treats it as terminal (never retried), but its
        // fields/message are correctly labelled: arg 2 is the upcoming call's
        // ESTIMATED cost (we have no db handle here to read realized spend) and
        // arg 3 is the remaining budget HEADROOM (not the cap) — so the audit
        // message never claims money was spent that wasn't.
        throw new CostRouterBudgetExceededError(
          workflowId ?? 'unknown',
          routingDecision.estimated_cost_usd,
          budgetUsd, // narrowed to number by the enclosing `budgetUsd !== undefined`
        );
      }
    }
  }

  // Apply auto-tag resolution
  resolvedModel = resolveAutoTag(resolvedModel, getAutoTagOverrides());

  // Aurora-Redux: resolve the direct-provider route (if any) once, up front.
  // Non-null → Kimi/MiniMax/GLM direct HTTP; null → legacy Omniroute path.
  // (CLI-backed models are handled by a separate branch below.)
  const directRoute = resolveDirectProviderRoute(resolvedModel);

  // Fail fast with a precise message when a direct provider's key is missing —
  // otherwise the request goes out unauthenticated and returns a confusing
  // "HTTP 401" that reads like an Omniroute problem. (Review finding M2.)
  if (directRoute && !getDirectProviderApiKey(directRoute)) {
    throw new Error(
      `${directRoute.envVar} not set — required for direct provider '${directRoute.providerName}' (model ${resolvedModel})`,
    );
  }

  // Fase A / Wave 1 (visual reviewer multimodal, 2026-07-05): fail fast on
  // any unsupported image transport, BEFORE any HTTP request or CLI spawn is
  // made — same fail-fast posture as the missing-key check above. Silently
  // dropping the image and sending a text-only prompt would be worse than an
  // explicit error: the caller would get a plausible-looking response that
  // never actually looked at the screenshot. See docs/VISION-SPIKE-2026-07-05.md
  // for the evidence backing each branch below.
  if (images && images.length > 0) {
    if (directRoute) {
      if (!providerSupportsVision(directRoute)) {
        throw new Error(
          `Direct provider '${directRoute.providerName}' does not support image/vision input ` +
            `(model ${resolvedModel}) — use kimi/ or minimax/ instead (verified by the vision ` +
            'spike, docs/VISION-SPIKE-2026-07-05.md).',
        );
      }
      // vision-capable direct provider — content-parts assembled below.
    } else if (isCliModel(resolvedModel)) {
      // Wave 2: CLI-specific support is delegated to callViaCli(). codex-cli
      // attaches images by mentioning local paths in stdin; claude-cli still
      // fail-fasts there with a transport-specific explanation because the
      // spike did not confirm a reliable image mechanism for Claude CLI.
    } else {
      throw new Error(
        `Image attachments are not supported on the legacy Omniroute path (model ${resolvedModel}) — ` +
          'use a direct HTTP provider with vision support (kimi/, minimax/) instead.',
      );
    }
  }

  // Initialize real-time cost tracking
  const costTracker = getRealTimeCostTracker();
  const trackingId = costTracker.startTracking({
    model: resolvedModel,
    workflow_id: workflowId,
    task_id: taskId,
    task_type: taskType || 'general',
  });

  const url = directRoute
    ? buildDirectProviderUrl(directRoute)
    : `${getOmnirouteUrl()}/api/v1/chat/completions`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const apiKey = directRoute ? getDirectProviderApiKey(directRoute) : getOmnirouteApiKey();
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  // Aurora-Redux: direct coding-plan providers reject a custom temperature
  // (e.g. Kimi-for-coding: "only 1 is allowed for this model"), and diversity in
  // the consensus path comes from using different models, not temperature — so
  // omit it entirely on the direct path and let each provider use its default.
  const supportsTemperature =
    !directRoute && !/claude-opus-4|claude-sonnet-4/i.test(resolvedModel);

  // Wave 2 — exact-match response cache (opt-in via OMNIFORGE_LLM_CACHE). Replays
  // a byte-identical call at $0. The key hashes the FULL system prompt (which
  // carries the injected reflection block + active variant), so a newly-learned
  // lesson MISSES and never silently serves a stale decomposition. Uses the
  // workflow db from the trace span context; skipped when neither is available.
  const cacheDb = spanContextStorage.getStore()?.db ?? null;
  const cacheKey = isLlmCacheEnabled() && cacheDb
    ? computeLlmCacheKey({
        model: resolvedModel,
        systemPrompt,
        userPrompt,
        temperature: supportsTemperature ? temperature : null,
      })
    : null;
  if (cacheKey && cacheDb) {
    const cached = getCachedResponse(cacheDb, cacheKey);
    if (cached) {
      // Replay is free — attribute $0 so the ledger reflects true post-cache spend.
      const replayUsage = {
        ...((cached.usage as Record<string, unknown> | null) ?? {}),
        total_cost_usd: 0,
      } as unknown as OmnirouteUsage;
      return { content: cached.content, model_used: cached.model, usage: replayUsage };
    }
  }

  // Anthropic prompt-prefix cache (B6.1 / AUDIT §6 perf-win 1).
  // For Anthropic-family models with a sizeable system prompt, we mark
  // the system block with `cache_control: ephemeral` so Anthropic caches
  // the prefix for ~5 minutes. Subsequent calls with the same prefix
  // (e.g. repeated worker invocations sharing WORKER_CLI_SPAWN_PREFIX or
  // a persona system prompt) skip prefix re-tokenisation — typical wins:
  //   - ~50% input-token cost on cache hits
  //   - ~70% latency reduction on cache hits for large prefixes
  // Anthropic ignores cache_control on prompts smaller than its minimum
  // (~1024 tokens) so the floor here just avoids serialising it pointlessly.
  // Disabled by default — opt-in via OMNIFORGE_PROMPT_PREFIX_CACHE=true. Some
  // Omniroute provider adapters may not pass `cache_control` through; verify
  // before flipping the flag in production.
  const cacheEnabled = getPromptPrefixCacheEnabled();
  const isAnthropicFamily = /^cc\/|claude-/.test(resolvedModel);
  const useCacheControl =
    cacheEnabled && isAnthropicFamily && systemPrompt.length >= 4_000;

  // Omniroute's chat API does not reliably honour a separate `system` field
  // across all of its provider adapters, so we concatenate the system prompt
  // into the user message. When prefix caching is enabled for an Anthropic-family
  // model, the system block is sent as a cache_control'd content part.
  // (Aurora-parity Wave 0 / GHOST-03: the prior USE_OMNIROUTE_SYSTEM_PROMPT branch
  // built a `system`-field body, discarded it, and swallowed errors in this hot
  // path — removed as inert dead code.)
  //
  // Fase A / Wave 1 (visual reviewer multimodal, 2026-07-05): when `images`
  // are present on a vision-capable direct HTTP provider, content becomes an
  // OpenAI-style content-parts array: one text part carrying the EXACT SAME
  // `${systemPrompt}\n\n${userPrompt}` string the no-image path already sends
  // (so prompt content is byte-identical either way), followed by one optional
  // short label part + one image_url part per attachment. By this point the
  // fail-fast block above has already guaranteed direct providers support
  // vision. Wave 2 lets CLI image calls pass through too, but those must NOT
  // build data URLs here: callViaCli() attaches local paths in stdin instead.
  //
  // Interaction with `useCacheControl` (cache_control branch, decided here):
  // `images` takes priority over prompt-prefix caching. Anthropic-family
  // models are the only ones useCacheControl targets (isAnthropicFamily),
  // and no Anthropic-family model is currently vision-confirmed on the direct
  // path (kimi/minimax only) — so in practice the two conditions don't
  // overlap yet. Should that change, correctness (the model actually seeing
  // the image) outranks the cache_control perf-win: we build the image
  // content-parts WITHOUT a cache_control marker on the text part rather than
  // risk a provider adapter choking on cache_control mixed with image_url
  // parts (untested combination, out of scope for this wave's spike).
  const hasDirectProviderImages = directRoute !== null && images !== undefined && images.length > 0;
  const userContent:
    | string
    | Array<{
        type: string;
        text?: string;
        cache_control?: { type: string };
        image_url?: { url: string };
      }> = hasDirectProviderImages
    ? [
        { type: 'text', text: `${systemPrompt}\n\n${userPrompt}` },
        ...images!.flatMap((img) => {
          const { dataUrl } = imageToDataUrl(img.path);
          const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
          if (img.label) parts.push({ type: 'text', text: img.label });
          parts.push({ type: 'image_url', image_url: { url: dataUrl } });
          return parts;
        }),
      ]
    : useCacheControl
      ? [
          { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: `\n\n${userPrompt}` },
        ]
      : `${systemPrompt}\n\n${userPrompt}`;

  const body = JSON.stringify({
    // Direct providers only know their native id — strip the routing prefix
    // (e.g. 'glm/glm-5.2' -> 'glm-5.2'). Omniroute keeps the full id.
    model: directRoute ? stripRoutePrefix(resolvedModel, directRoute) : resolvedModel,
    messages: [
      { role: 'user', content: userContent },
    ],
    ...(supportsTemperature ? { temperature } : {}),
    // Reasoning models consume budget on hidden thinking — set an explicit
    // ceiling for direct providers so the visible answer isn't truncated.
    ...(directRoute ? { max_tokens: getDirectProviderMaxTokens() } : {}),
    stream: false,
  });

  // D-H2.078: scale the per-call timeout by total prompt size so large
  // objectives (the new 200K cap allowed) get proportionally more time
  // before AbortSignal fires. See `computeOmnirouteTimeoutMs` for the
  // formula. Operators can still pin the floor via OMNIROUTE_TIMEOUT_MS.
  const promptChars = systemPrompt.length + userPrompt.length;
  const effectiveTimeoutMs = computeOmnirouteTimeoutMs(promptChars);

  const spanCtx = spanContextStorage.getStore();
  let spanId: string | undefined;
  const callStart = Date.now();
  if (spanCtx) {
    try {
      const span = startTraceSpan(spanCtx.db, {
        workflowId: spanCtx.workflowId ?? '',
        parentSpanId: spanCtx.parentSpanId,
        name: `llm_call:${model}`,
        kind: 'llm_call',
        attributes: { model: resolvedModel, requested_model: model, url },
      });
      spanId = span.id;
    } catch { /* tracing must not break execution */ }
  }

  const maxRetries = getOmnirouteMaxRetries();
  let lastError: unknown;
  let result: OmnirouteCallResult | undefined;

  // Aurora-Redux CLI-backed brain roles (claude-cli/*, codex-cli/*): satisfy
  // the call by spawning a local CLI instead of HTTP. Set `result` (do NOT
  // early-return) so the shared finalize block below — trace span close, cost
  // tracking, ledger recording — runs identically for both transports. On
  // failure, record `lastError` and fall through to finalize (which closes the
  // span as error and cleans up tracking) then the final rethrow — never let
  // the exception skip finalize, and never let a CLI model enter the HTTP loop.
  // (Review finding A1.)
  const cliModel = isCliModel(resolvedModel);
  if (cliModel) {
    try {
      result = await callViaCli({ ...input, model: resolvedModel });
      if (trackingId && result.usage) {
        costTracker.updateTracking(trackingId, {
          input_tokens: result.usage.input_tokens,
          output_tokens: result.usage.output_tokens,
          estimated_cost_usd: 0,
        });
      }
    } catch (err) {
      lastError = err;
    }
  }

  for (let attempt = 0; !cliModel && result === undefined && attempt <= maxRetries; attempt++) {
    // M1-W1-B (F-REL-1) — compose the per-call timeout with the optional
    // external AbortSignal so a workflow cancel aborts the in-flight fetch
    // immediately (within one event-loop tick) instead of letting it run
    // to its server-side timeout. `AbortSignal.any` is Node 22+; we fall
    // back to a manual composition when it's not available so older
    // Node builds still work in development. The fast-fail check
    // `externalSignal.aborted` short-circuits before we even open the
    // socket on the next retry attempt.
    if (externalSignal?.aborted) {
      const err = new Error('omniroute call aborted by external signal');
      (err as Error & { name: string }).name = 'AbortError';
      throw err;
    }
    const timeoutSignal = AbortSignal.timeout(effectiveTimeoutMs);
    const fetchSignal = externalSignal
      ? composeAbortSignals(timeoutSignal, externalSignal)
      : timeoutSignal;
    try {
      const res = await nativeFetch(url, {
        method: 'POST',
        headers,
        body,
        timeout: effectiveTimeoutMs,
        signal: fetchSignal,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '<unreadable body>');
        // Attach the HTTP status + response headers so the failover classifier
        // (classifier.ts extractContext) can (a) classify by status — its
        // documented Step 2, previously never reached because this hot path
        // dropped the status — and (b) honour the server `Retry-After` window
        // in the executor's backoff (Aurora-parity Wave-1.5 #1). Survives
        // normalizeOmnirouteTransportError, which returns non-transport errors
        // unchanged.
        const error = new Error(
          `Omniroute HTTP ${res.status}: ${errText.slice(0, 500)}`,
        ) as Error & { status?: number; responseHeaders?: Record<string, string> };
        error.status = res.status;
        error.responseHeaders = res.responseHeaders;
        if (res.status < 500 || attempt >= maxRetries) throw error;
        lastError = error;
        continue;
      }

      const text = await res.text();
      const json: unknown = JSON.parse(text);
      // Direct providers may isolate reasoning in `reasoning_content` (Kimi/GLM)
      // or inline it as a <think> block (MiniMax) — extractContentRobust handles
      // both; the Omniroute path keeps the original extractor.
      const content = directRoute ? extractContentRobust(json) : extractContent(json);
      if (content === null) {
        throw new Error(
          `Omniroute response missing expected content shape: ${JSON.stringify(
            json,
          ).slice(0, 500)}`,
        );
      }
      // F-LIVE-2: Omniroute v3.x returns per-call cost in HTTP headers,
      // not in the JSON body. Merge `x-omniroute-response-cost` into the
      // usage shape so the model_calls ledger stops reporting $0.
      const usageFromJson = extractUsage(json);
      const usage = mergeUsageWithResponseHeaders(usageFromJson, res.responseHeaders);
      
      // Update real-time cost tracking with actual usage
      if (usage && trackingId) {
        costTracker.updateTracking(trackingId, {
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          estimated_cost_usd: usage.total_cost_usd,
        });
      }
      
      result = {
        content,
        model_used: extractModelUsed(json) ?? resolvedModel,
        ...(usage ? { usage } : {}),
      };
      // Wave 2: store for byte-identical replay (best-effort; no-op unless enabled).
      if (cacheKey && cacheDb) {
        putCachedResponse(cacheDb, cacheKey, result.model_used, result.content, result.usage ?? null);
      }
      break;
    } catch (err) {
      lastError = normalizeOmnirouteTransportError(err, url, {
        model,
        promptChars,
        timeoutMs: effectiveTimeoutMs,
      });
      if (attempt >= maxRetries) break;
    }
  }

  if (spanId && spanCtx) {
    try {
      const latencyMs = Date.now() - callStart;
      if (result) {
        endTraceSpan(spanCtx.db, spanId, {
          status: 'ok',
          attributes: {
            output_tokens: result.usage?.output_tokens ?? null,
            actual_cost: result.usage?.total_cost_usd ?? null,
            latency_ms: latencyMs,
            model_used: result.model_used,
            // B6.1 cache observability — non-null when the upstream provider
            // returned cache fields (Anthropic). cache_read_input_tokens > 0
            // is the smoking-gun signal that the prompt prefix was reused.
            cache_creation_input_tokens: result.usage?.cache_creation_input_tokens ?? null,
            cache_read_input_tokens: result.usage?.cache_read_input_tokens ?? null,
          },
        });
      } else {
        endTraceSpan(spanCtx.db, spanId, {
          status: 'error',
          attributes: {
            error: lastError instanceof Error ? lastError.message : String(lastError),
            latency_ms: latencyMs,
          },
        });
      }
    } catch { /* tracing must not break execution */ }
  }

  // MÉDIO-4 (revisão adversarial 2026-07-04): brain-roles (decomposer /
  // reviewer / consolidator) rodam fora do caminho de task do executor, então
  // success-finalize nunca grava a linha deles em model_calls — reviews via
  // codex-cli eram invisíveis no ledger. Quando o chamador optou-in via
  // spanCtx.ledgerSource, gravamos aqui. O executor tem spanCtx SEM
  // ledgerSource → pulado → sem double-count.
  const ledgerWorkflowId = workflowId ?? spanCtx?.workflowId;
  if (result && spanCtx?.db && spanCtx.ledgerSource && ledgerWorkflowId) {
    try {
      const { recordModelCall } = await import('../v2/llm-ledger/store.js');
      recordModelCall(spanCtx.db, {
        workflowId: ledgerWorkflowId,
        taskId: taskId || undefined,
        model: result.model_used,
        inputTokens: result.usage?.input_tokens,
        outputTokens: result.usage?.output_tokens,
        costUsd: result.usage?.total_cost_usd,
        latencyMs: Date.now() - callStart,
        source: spanCtx.ledgerSource,
        // kind alimenta só o hint de source do SSE cost_delta — não é coluna
        // persistida em model_calls.
        kind: 'llm_call',
      });
    } catch (err) {
      // Ledger é best-effort: nunca quebra a chamada.
      console.warn('[Ledger] Failed to record brain-role model_call:', err);
    }
  }

  // Finalize cost tracking and register in database
  if (result && trackingId) {
    try {
      const finalTracking = costTracker.endTracking(trackingId);
      
      // Register cost in database for historical analysis
      if (finalTracking && result.usage) {
        const costDatabase = getCostDatabase();
        costDatabase.recordUsageCost({
          model: result.model_used,
          input_tokens: result.usage.input_tokens || 0,
          output_tokens: result.usage.output_tokens || 0,
          cost_usd: result.usage.total_cost_usd || 0,
          workflow_id: workflowId,
          task_id: taskId,
          task_type: taskType || 'general',
          timestamp: Date.now(),
        });
        
        console.log(`[CostTracking] Recorded cost for ${result.model_used}: $${(result.usage.total_cost_usd || 0).toFixed(6)} (${result.usage.input_tokens} input, ${result.usage.output_tokens} output tokens)`);
      }
    } catch (error) {
      // Cost tracking failures must not break the main flow, but they MUST be
      // visible. The console.warn alone is easy to miss on a detached daemon
      // (stdout/stderr → data/daemon.log) and is absent from the auditable
      // `events` stream the dashboard reads. OPS-02: additionally emit a
      // `cost_insert_failed` event when we have both a workflow_id and an
      // already-open DB handle from the active trace span. We deliberately do
      // NOT open a fresh DB connection on this hot per-call path, and we gate
      // on workflowId because insertEvent requires a non-null workflow_id
      // (FK → workflows). Untraced calls fall back to the console.warn only.
      console.warn('[CostTracking] Failed to record cost in database:', error);
      const spanCtx = spanContextStorage.getStore();
      if (spanCtx?.db && workflowId) {
        try {
          const { insertEvent } = await import('../db/persist.js');
          insertEvent(spanCtx.db, {
            workflow_id: workflowId,
            task_id: taskId ?? null,
            type: 'cost_insert_failed',
            payload: {
              model: result.model_used,
              task_type: taskType || 'general',
              error: error instanceof Error ? error.message : String(error),
            },
          });
        } catch (emitErr) {
          // Observability emission itself failed — stderr is the last resort.
          // Never rethrow; cost tracking is strictly best-effort.
          console.warn(
            '[CostTracking] Failed to emit cost_insert_failed event:',
            emitErr,
          );
        }
      }
    }
  } else if (trackingId) {
    // Clean up tracking if the call failed
    try {
      costTracker.endTracking(trackingId);
    } catch (error) {
      console.warn('[CostTracking] Failed to clean up tracking after error:', error);
    }
  }

  if (result) return result;
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

interface OmnirouteCallContext {
  model: string;
  promptChars: number;
  timeoutMs: number;
}

function normalizeOmnirouteTransportError(
  err: unknown,
  url: string,
  ctx?: OmnirouteCallContext,
): Error {
  if (!isOmnirouteTransportError(err)) {
    return err instanceof Error ? err : new Error(String(err));
  }
  const message = err instanceof Error ? err.message : String(err);
  const isTimeout =
    err instanceof Error &&
    (err.name === 'TimeoutError' ||
      err.name === 'AbortError' ||
      /\bETIMEDOUT\b/i.test(err.message));

  // D-H2.078: timeout errors get a contextual, actionable message. Operators
  // pasting large plans + hitting a deadline need to know (a) how big their
  // prompt was, (b) what timeout fired, (c) what to do about it — without
  // having to dig into env vars or model docs.
  if (isTimeout && ctx) {
    const seconds = Math.round(ctx.timeoutMs / 1000);
    const kchars = Math.round(ctx.promptChars / 1024);
    return new Error(
      `Omniroute request timed out after ${seconds}s (model=${ctx.model}, prompt≈${kchars}K chars). ` +
        'Options: (1) switch to a faster model (haiku/sonnet instead of opus), ' +
        '(2) split the objective into sub-objectives, ' +
        `(3) raise the floor with OMNIROUTE_TIMEOUT_MS=600000 (current effective: ${ctx.timeoutMs}ms — already includes prompt-size scaling).`,
    );
  }

  return new Error(
    `Omniroute request failed for ${url}: ${message}. ` +
      'Check OMNIROUTE_URL and make sure Omniroute is running.',
  );
}

function isOmnirouteTransportError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err instanceof TypeError) return true;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
  return /\b(ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|fetch failed)\b/i.test(err.message);
}

/**
 * Compose multiple AbortSignals into one — the resulting signal aborts as
 * soon as ANY of the inputs aborts.
 *
 * Prefers the Node 22+ built-in `AbortSignal.any` when available; falls back
 * to a manual implementation that mirrors its semantics for older runtimes
 * still on the supported matrix.
 */
function composeAbortSignals(...signals: AbortSignal[]): AbortSignal {
  // Node 22 ships AbortSignal.any. If it's present, defer to it — its
  // listener-cleanup story is well-tested.
  const anySignal = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof anySignal === 'function') {
    return anySignal(signals);
  }
  // Manual fallback: a controller that aborts on the first input abort.
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      ctrl.abort(s.reason);
      return ctrl.signal;
    }
    s.addEventListener('abort', () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}

function extractContent(json: unknown): string | null {
  const data = json as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content ?? null;
}

function extractModelUsed(json: unknown): string | null {
  const data = json as { model?: string };
  return typeof data.model === 'string' && data.model.trim() !== '' ? data.model : null;
}

function extractUsage(json: unknown): OmnirouteUsage | null {
  const data = json as {
    usage?: {
      prompt_tokens?: number;
      input_tokens?: number;
      completion_tokens?: number;
      output_tokens?: number;
      total_cost_usd?: number;
      cost_usd?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  if (!data.usage) return null;
  const u = data.usage;
  const usage: OmnirouteUsage = {
    ...(typeof (u.input_tokens ?? u.prompt_tokens) === 'number'
      ? { input_tokens: u.input_tokens ?? u.prompt_tokens }
      : {}),
    ...(typeof (u.output_tokens ?? u.completion_tokens) === 'number'
      ? { output_tokens: u.output_tokens ?? u.completion_tokens }
      : {}),
    ...(typeof (u.total_cost_usd ?? u.cost_usd) === 'number'
      ? { total_cost_usd: u.total_cost_usd ?? u.cost_usd }
      : {}),
    ...(typeof u.cache_creation_input_tokens === 'number'
      ? { cache_creation_input_tokens: u.cache_creation_input_tokens }
      : {}),
    ...(typeof u.cache_read_input_tokens === 'number'
      ? { cache_read_input_tokens: u.cache_read_input_tokens }
      : {}),
  };
  return Object.keys(usage).length > 0 ? usage : null;
}

/**
 * F-LIVE-2 helper — Omniroute v3.x returns per-call cost in the
 * `x-omniroute-response-cost` HTTP header (and surfaces token counts in
 * `x-omniroute-tokens-in` / `-tokens-out`). When the JSON body's `usage`
 * is missing fields, fall back to the headers so the model_calls ledger
 * captures real cost numbers.
 *
 * The header value is a plain number (USD); we coerce defensively because
 * stray scientific notation or commas are not impossible at the proxy
 * layer.
 */
function mergeUsageWithResponseHeaders(
  fromJson: OmnirouteUsage | null,
  headers: Record<string, string>,
): OmnirouteUsage | null {
  if (!headers || typeof headers !== 'object') return fromJson;

  const headerCost = parseFloat(headers['x-omniroute-response-cost'] ?? '');
  const headerTokensIn = parseInt(headers['x-omniroute-tokens-in'] ?? '', 10);
  const headerTokensOut = parseInt(headers['x-omniroute-tokens-out'] ?? '', 10);
  const headerCacheHit = headers['x-omniroute-cache-hit'];

  const usage: OmnirouteUsage = { ...(fromJson ?? {}) };
  if (
    (usage.total_cost_usd === undefined || usage.total_cost_usd === 0) &&
    Number.isFinite(headerCost) &&
    headerCost > 0
  ) {
    usage.total_cost_usd = headerCost;
  }
  if (usage.input_tokens === undefined && Number.isFinite(headerTokensIn) && headerTokensIn > 0) {
    usage.input_tokens = headerTokensIn;
  }
  if (usage.output_tokens === undefined && Number.isFinite(headerTokensOut) && headerTokensOut > 0) {
    usage.output_tokens = headerTokensOut;
  }
  if (headerCacheHit === 'true') {
    (usage as OmnirouteUsage & { cache_hit?: boolean }).cache_hit = true;
  }
  return Object.keys(usage).length > 0 ? usage : null;
}
