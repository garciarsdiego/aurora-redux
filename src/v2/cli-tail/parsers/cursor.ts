/**
 * Tail parser for cursor agent session logs.
 *
 * Source format (per discovery.findCursorSession):
 *   `~/.cursor/chats/<chat-id>/`  — discovery returns a *directory*.
 *
 * cursor-agent's chat directory typically contains:
 *   - `messages.json` or `chat.json`  — single document with conversation
 *       { messages: [ { role, content, ... } ] }
 *   - `events.jsonl`                   — append-only event stream when the
 *       agent runs in `--output-format stream-json` mode (different schema
 *       from Claude's stream-json, see executors/cli.ts notes).
 *
 * Cursor stream-json events we recognise (best-effort, since the schema isn't
 * fully documented):
 *   { type: "message",       role, content }
 *   { type: "tool_use",      name, args | input }
 *   { type: "tool_result",   tool_use_id, output }
 *   { type: "assistant_text", text }
 *
 * Strategy mirrors gemini/kimi: walk `.json`/`.jsonl` files in the chat dir,
 * try captured CLI transcript → NDJSON → single document → plain text fallback.
 */

import type { TailEvent, TailParser } from '../types.js';
import {
  asRole,
  eventsFromCapturedCliTranscript,
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

const PARSER_ID = 'cursor';

const READABLE_FILE_RX = /\.(json|jsonl|ndjson|log)$/i;
const SKIP_FILE_NAMES = new Set(['metadata.json', 'config.json', 'state.json']);

// ---------------------------------------------------------------------------
// Record → TailEvent
// ---------------------------------------------------------------------------

function eventFromRecord(rec: Record<string, unknown>, fallbackTs: number): TailEvent[] {
  const ts = toEpochMs(rec['ts'] ?? rec['timestamp'] ?? rec['createdAt'], fallbackTs);
  const type = rec['type'];

  if (type === 'tool_use' || type === 'tool_call') {
    return [
      {
        ts,
        kind: 'tool_call',
        toolName: typeof rec['name'] === 'string' ? rec['name'] : undefined,
        toolInput: maybeParseJson(rec['args'] ?? rec['input'] ?? rec['arguments']),
      },
    ];
  }

  if (type === 'tool_result') {
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

  if (type === 'assistant_text' && typeof rec['text'] === 'string') {
    return [{ ts, kind: 'message', role: 'assistant', text: rec['text'] }];
  }

  // Generic message / chat-history record.
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

function eventsFromArray(arr: unknown[], fallbackTs: number): TailEvent[] {
  const out: TailEvent[] = [];
  for (const item of arr) {
    if (!isRecord(item)) continue;
    out.push(...eventFromRecord(item, fallbackTs));
  }
  return out;
}

function eventsFromBuffer(buffer: string, fallbackTs: number): TailEvent[] {
  const trimmed = buffer.trim();
  if (!trimmed) return [];

  const capturedEvents = eventsFromCapturedCliTranscript(PARSER_ID, buffer, fallbackTs);
  if (capturedEvents !== null) return capturedEvents;

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
          tryNdjson.push(...eventFromRecord(parsed, fallbackTs));
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
      if (Array.isArray(doc)) return eventsFromArray(doc, fallbackTs);
      if (isRecord(doc)) {
        if (Array.isArray(doc['messages'])) {
          return eventsFromArray(doc['messages'] as unknown[], fallbackTs);
        }
        if (Array.isArray(doc['events'])) {
          return eventsFromArray(doc['events'] as unknown[], fallbackTs);
        }
        if (Array.isArray(doc['turns'])) {
          return eventsFromArray(doc['turns'] as unknown[], fallbackTs);
        }
        return eventFromRecord(doc, fallbackTs);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnParse(PARSER_ID, `single-document parse failed: ${msg}`);
    }
  }

  // Plain text fallback
  return [{ ts: fallbackTs, kind: 'message', text: trimmed }];
}

function resolveFilesToParse(input: string): string[] {
  if (isFile(input)) return [input];
  if (isDir(input)) {
    return walkFilesByMtime(input, (entry) => {
      if (SKIP_FILE_NAMES.has(entry.toLowerCase())) return false;
      return READABLE_FILE_RX.test(entry);
    });
  }
  return [];
}

const cursorParser: TailParser = {
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

export default cursorParser;
