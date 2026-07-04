/**
 * Tail parser for opencode session logs.
 *
 * Source format (primary, since opencode 1.14+):
 *   ACP (Agent Client Protocol) framed NDJSON over stdio. The opencode probe
 *   artifact captured 2026-05-10 confirms the wire shape:
 *
 *     {"jsonrpc":"2.0","method":"session/update","params":{
 *        "sessionId":"ses_...",
 *        "update":{"sessionUpdate":"<subtype>", ...subtype fields}
 *     }}
 *
 *   plus request/response frames:
 *     {"jsonrpc":"2.0","id":N,"result":{...}}
 *     {"jsonrpc":"2.0","id":N,"method":"<name>","params":{...}}
 *
 *   Discriminator is `params.update.sessionUpdate`. Mapping to Aurora's
 *   `TailEvent` model:
 *
 *     ACP `sessionUpdate`             → TailEvent kind
 *     ─────────────────────────────────────────────────────────────────────
 *     agent_message_chunk             → message (role=assistant, streamed)
 *     message_chunk                   → message (role per chunk role)
 *     agent_message_completed         → message (full snapshot, assistant)
 *     agent_thought_chunk             → reasoning
 *     thought_chunk                   → reasoning
 *     tool_call (started)             → tool_call (toolName + toolInput)
 *     tool_call_result                → tool_result (toolOutput)
 *     tool_call.completed             → tool_result (toolOutput)
 *     plan                            → meta (text="plan: <summary>")
 *     available_commands_update       → (skipped — informational)
 *     usage_update                    → (skipped — informational)
 *     session_cancelled / session_done→ meta (text marker, end of stream)
 *     <unknown>                       → message fallback w/ stringified update
 *
 *   Top-level frames that are not `session/update` notifications (e.g.
 *   responses, server-to-client requests) are NOT decoded into TailEvents
 *   — only the streaming session updates are tail-relevant.
 *
 * Source format (fallback, for older / non-ACP logs):
 *   The original NDJSON / single-document / plain-text fallbacks are kept
 *   intact so any log file that pre-dates the ACP migration (or is hand-fed
 *   by a sidecar shim) still parses without regression.
 */

import type { TailEvent, TailParser } from '../types.js';
import {
  asRole,
  flattenText,
  isDir,
  isFile,
  isRecord,
  maybeParseJson,
  safeReadFile,
  toEpochMs,
  walkFilesByMtime,
  warnParse,
} from './shared.js';

const PARSER_ID = 'opencode';

const READABLE_FILE_RX = /\.(json|jsonl|ndjson|log|txt)$/i;

// ---------------------------------------------------------------------------
// ACP frame detection + extraction
// ---------------------------------------------------------------------------

/** Quick sniff: does the buffer look like ACP framed NDJSON? */
function looksLikeAcp(trimmed: string): boolean {
  // Cheap front-of-buffer check; avoids parsing huge files just to classify.
  return trimmed.startsWith('{"jsonrpc"') || trimmed.includes('\n{"jsonrpc"');
}

/**
 * Pull the streaming `update` payload out of a `session/update` notification.
 * Returns null for any frame that is NOT a `session/update` notification, so
 * callers can simply skip request/response frames and other methods.
 */
function extractSessionUpdate(frame: Record<string, unknown>): {
  sessionId: string | undefined;
  update: Record<string, unknown>;
} | null {
  if (frame['jsonrpc'] !== '2.0') return null;
  if (frame['method'] !== 'session/update') return null;
  const params = frame['params'];
  if (!isRecord(params)) return null;
  const update = params['update'];
  if (!isRecord(update)) return null;
  const sessionId = typeof params['sessionId'] === 'string' ? params['sessionId'] : undefined;
  return { sessionId, update };
}

// ---------------------------------------------------------------------------
// Per-subtype handlers (one per ACP `sessionUpdate` value)
// ---------------------------------------------------------------------------

// Track unknown subtypes so we warn once per process per shape, not once per
// event. The dashboard's tail can flood otherwise.
const warnedUnknownSubtypes = new Set<string>();

function handleMessageChunk(
  ts: number,
  update: Record<string, unknown>,
  defaultRole: 'assistant' | 'user' = 'assistant',
): TailEvent[] {
  // Per ACP spec the chunk content is in `update.content` (array of content
  // blocks) or directly in `update.text`. We try several shapes for safety.
  const role = asRole(update['role']) ?? defaultRole;
  const text =
    typeof update['text'] === 'string'
      ? update['text']
      : flattenText(update['content']) ?? flattenText(update['delta']);
  if (text === undefined || text.length === 0) return [];
  return [{ ts, kind: 'message', role, text }];
}

function handleThoughtChunk(ts: number, update: Record<string, unknown>): TailEvent[] {
  const text =
    typeof update['text'] === 'string'
      ? update['text']
      : typeof update['thinking'] === 'string'
        ? update['thinking']
        : flattenText(update['content']) ?? flattenText(update['delta']);
  if (text === undefined || text.length === 0) return [];
  return [{ ts, kind: 'reasoning', text }];
}

function handleToolCall(ts: number, update: Record<string, unknown>): TailEvent[] {
  // ACP shape: `update.tool` is a record with `name` + `arguments`/`input`,
  // OR they sit at the top of update directly. Handle both.
  const tool = isRecord(update['tool']) ? (update['tool'] as Record<string, unknown>) : update;
  const toolName =
    typeof tool['name'] === 'string'
      ? tool['name']
      : typeof tool['toolName'] === 'string'
        ? tool['toolName']
        : undefined;
  const toolInput = maybeParseJson(
    tool['arguments'] ?? tool['args'] ?? tool['input'] ?? tool['parameters'],
  );
  return [
    {
      ts,
      kind: 'tool_call',
      toolName,
      toolInput,
    },
  ];
}

function handleToolResult(ts: number, update: Record<string, unknown>): TailEvent[] {
  const result = isRecord(update['result']) ? (update['result'] as Record<string, unknown>) : null;
  const toolOutput =
    update['output'] ?? update['result'] ?? update['content'] ?? result?.['output'];
  return [{ ts, kind: 'tool_result', toolOutput }];
}

function handlePlan(ts: number, update: Record<string, unknown>): TailEvent[] {
  // Plan events are informational summaries — surface as `meta` so the tail
  // shows them without confusing the message timeline.
  const summary =
    typeof update['summary'] === 'string'
      ? update['summary']
      : typeof update['text'] === 'string'
        ? update['text']
        : flattenText(update['content']);
  return [
    {
      ts,
      kind: 'meta',
      text: summary !== undefined ? `plan: ${summary}` : 'plan',
    },
  ];
}

function handleSessionDone(ts: number, subtype: string): TailEvent[] {
  return [{ ts, kind: 'meta', text: `opencode: ${subtype}` }];
}

function handleUnknownSubtype(
  ts: number,
  subtype: string,
  update: Record<string, unknown>,
): TailEvent[] {
  if (!warnedUnknownSubtypes.has(subtype)) {
    warnedUnknownSubtypes.add(subtype);
    warnParse(PARSER_ID, `unknown sessionUpdate subtype "${subtype}" — emitting fallback message`);
  }
  // Best-effort text dump so the operator still sees *something*.
  let serialized: string;
  try {
    serialized = JSON.stringify(update);
  } catch {
    serialized = '[unserialisable update]';
  }
  return [{ ts, kind: 'message', text: `${subtype}: ${serialized}` }];
}

/** Dispatch one `session/update` payload to the right handler. */
function eventsFromSessionUpdate(
  update: Record<string, unknown>,
  fallbackTs: number,
): TailEvent[] {
  const subtypeRaw = update['sessionUpdate'];
  const subtype = typeof subtypeRaw === 'string' ? subtypeRaw : '';
  const ts = toEpochMs(update['ts'] ?? update['timestamp'] ?? update['time'], fallbackTs);

  switch (subtype) {
    // Streaming assistant text
    case 'agent_message_chunk':
    case 'agent_message_completed':
    case 'message_chunk':
      return handleMessageChunk(ts, update);

    // Streaming user-side message echoes (rare but possible for replays)
    case 'user_message_chunk':
      return handleMessageChunk(ts, update, 'user');

    // Streaming reasoning / chain-of-thought
    case 'agent_thought_chunk':
    case 'thought_chunk':
      return handleThoughtChunk(ts, update);

    // Tool invocation lifecycle
    case 'tool_call':
    case 'tool_call_started':
      return handleToolCall(ts, update);
    case 'tool_call_result':
    case 'tool_call_completed':
    case 'tool_call.completed':
      return handleToolResult(ts, update);

    // Plan event
    case 'plan':
      return handlePlan(ts, update);

    // End-of-stream markers
    case 'session_cancelled':
    case 'session_done':
    case 'session_completed':
      return handleSessionDone(ts, subtype);

    // Informational — explicitly skipped (no TailEvent emitted)
    case 'available_commands_update':
    case 'usage_update':
    case 'mode_update':
    case 'current_mode_update':
    case 'configuration_update':
      return [];

    // Empty / missing discriminator — corrupt frame, skip
    case '':
      return [];

    // Anything else: fallback to message + warn once
    default:
      return handleUnknownSubtype(ts, subtype, update);
  }
}

// ---------------------------------------------------------------------------
// ACP buffer parser (NDJSON of jsonrpc frames)
// ---------------------------------------------------------------------------

function eventsFromAcpBuffer(buffer: string, fallbackTs: number): TailEvent[] {
  const out: TailEvent[] = [];
  for (const rawLine of buffer.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // ACP framing requires line-delimited JSON. Any non-JSON line is noise
      // (likely interleaved stderr in a captured log). Skip silently — too
      // common to warn about.
      continue;
    }
    if (!isRecord(parsed)) continue;
    const extracted = extractSessionUpdate(parsed);
    if (!extracted) {
      // Not a session/update notification — could be a request/response or
      // a different method. Either way, not tail-relevant.
      continue;
    }
    try {
      out.push(...eventsFromSessionUpdate(extracted.update, fallbackTs));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnParse(PARSER_ID, `update dispatch failed: ${msg}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Legacy fallback parser (pre-ACP NDJSON / single-doc / plain text)
// ---------------------------------------------------------------------------

function eventFromLegacyRecord(rec: Record<string, unknown>, fallbackTs: number): TailEvent[] {
  const ts = toEpochMs(rec['ts'] ?? rec['timestamp'] ?? rec['time'], fallbackTs);
  const type = rec['type'];

  if (type === 'tool_call' || type === 'function_call' || type === 'tool_use') {
    return [
      {
        ts,
        kind: 'tool_call',
        toolName: typeof rec['name'] === 'string' ? rec['name'] : undefined,
        toolInput: maybeParseJson(rec['args'] ?? rec['arguments'] ?? rec['input']),
      },
    ];
  }

  if (type === 'tool_result' || type === 'function_call_output' || type === 'tool_response') {
    return [
      {
        ts,
        kind: 'tool_result',
        toolOutput: rec['output'] ?? rec['result'] ?? rec['content'],
      },
    ];
  }

  if (type === 'reasoning' || type === 'thinking') {
    const text =
      typeof rec['text'] === 'string'
        ? rec['text']
        : typeof rec['thinking'] === 'string'
          ? rec['thinking']
          : flattenText(rec['content']);
    if (text === undefined) return [];
    return [{ ts, kind: 'reasoning', text }];
  }

  // Generic message
  const role = asRole(rec['role']);
  const text =
    typeof rec['text'] === 'string'
      ? rec['text']
      : typeof rec['content'] === 'string'
        ? rec['content']
        : flattenText(rec['content']) ?? flattenText(rec['parts']);
  if (text === undefined) return [];
  return [{ ts, kind: 'message', role, text }];
}

function eventsFromLegacyArray(arr: unknown[], fallbackTs: number): TailEvent[] {
  const out: TailEvent[] = [];
  for (const item of arr) {
    if (!isRecord(item)) continue;
    out.push(...eventFromLegacyRecord(item, fallbackTs));
  }
  return out;
}

function eventsFromLegacyBuffer(trimmed: string, fallbackTs: number): TailEvent[] {
  // NDJSON path
  if (trimmed.includes('\n')) {
    const lines = trimmed.split(/\r?\n/);
    const tryNdjson: TailEvent[] = [];
    let everyLineIsJson = true;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isRecord(parsed)) {
          tryNdjson.push(...eventFromLegacyRecord(parsed, fallbackTs));
        }
      } catch {
        everyLineIsJson = false;
        break;
      }
    }
    if (everyLineIsJson && tryNdjson.length > 0) return tryNdjson;
  }

  // Single-document JSON
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const doc: unknown = JSON.parse(trimmed);
      if (Array.isArray(doc)) return eventsFromLegacyArray(doc, fallbackTs);
      if (isRecord(doc)) {
        if (Array.isArray(doc['messages'])) {
          return eventsFromLegacyArray(doc['messages'] as unknown[], fallbackTs);
        }
        if (Array.isArray(doc['events'])) {
          return eventsFromLegacyArray(doc['events'] as unknown[], fallbackTs);
        }
        if (Array.isArray(doc['turns'])) {
          return eventsFromLegacyArray(doc['turns'] as unknown[], fallbackTs);
        }
        return eventFromLegacyRecord(doc, fallbackTs);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnParse(PARSER_ID, `single-document parse failed: ${msg}`);
    }
  }

  // Plain text fallback
  return [{ ts: fallbackTs, kind: 'message', text: trimmed }];
}

// ---------------------------------------------------------------------------
// Top-level buffer dispatcher
// ---------------------------------------------------------------------------

function eventsFromBuffer(buffer: string, fallbackTs: number): TailEvent[] {
  const trimmed = buffer.trim();
  if (!trimmed) return [];

  if (looksLikeAcp(trimmed)) {
    const acpEvents = eventsFromAcpBuffer(trimmed, fallbackTs);
    // If ACP detection was a false positive (e.g. the file starts with one
    // jsonrpc frame and then degenerates into legacy lines), fall through to
    // legacy when no events came out. Otherwise return what we got.
    if (acpEvents.length > 0) return acpEvents;
  }

  return eventsFromLegacyBuffer(trimmed, fallbackTs);
}

// ---------------------------------------------------------------------------
// File / directory resolution
// ---------------------------------------------------------------------------

function resolveFilesToParse(input: string): string[] {
  if (isFile(input)) return [input];
  if (isDir(input)) {
    return walkFilesByMtime(input, (entry) => READABLE_FILE_RX.test(entry));
  }
  return [];
}

const opencodeParser: TailParser = {
  parse(filePath: string): TailEvent[] {
    const files = resolveFilesToParse(filePath);
    if (files.length === 0) {
      warnParse(PARSER_ID, `no readable session files at ${filePath}`);
      return [];
    }

    const out: TailEvent[] = [];
    for (const file of files) {
      const buffer = safeReadFile(file);
      if (buffer === null) {
        warnParse(PARSER_ID, `unable to read ${file}`);
        continue;
      }
      try {
        out.push(...eventsFromBuffer(buffer, Date.now()));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnParse(PARSER_ID, `event extraction failed (${file}): ${msg}`);
      }
    }
    return out;
  },
};

export default opencodeParser;
