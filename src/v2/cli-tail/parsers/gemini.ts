/**
 * Tail parser for gemini-cli session logs.
 *
 * Source format (per discovery.findGeminiSession):
 *   `~/.gemini/history/<YYYYMMDD-HHMMSS>/`  — discovery returns a *directory*.
 *
 * gemini-cli does not currently publish a stable, versioned schema for its
 * on-disk history layout (as of early 2026). The empirically observed shapes
 * are a mix of:
 *   - `chats.json` / `messages.json`     — one JSON document per session
 *       { messages: [ { role, parts: [ { text }, ... ] } ] }
 *   - `events.jsonl`                     — newline-delimited events with
 *       { ts, role, text } or { ts, type: "tool_call", name, args }
 *   - plain `.log` files                 — fallback, rendered as raw text
 *
 * Strategy:
 *   1. Resolve the input path. If a file, parse it directly.
 *   2. If a directory, walk all `.json`, `.jsonl`, `.ndjson` and `.log` files
 *      ordered by mtime; concatenate the resulting events.
 *   3. For each file:
 *        a. Try captured CLI transcript from `scripts/repro-cli-failures.mjs`.
 *        b. Try NDJSON (multi-line stream).
 *        c. Fall back to a single JSON document (object with `messages: []`).
 *        d. Fall back to plain text (whole file as one `message` event).
 */

import type { TailEvent, TailParser } from '../types.js';
import {
  asRole,
  eventsFromCapturedCliTranscript,
  eventsFromRecordArray,
  flattenText,
  isRecord,
  maybeParseJson,
  parseSessionFiles,
  toEpochMs,
  warnParse,
} from './shared.js';

const PARSER_ID = 'gemini';

// ---------------------------------------------------------------------------
// Per-line / per-record extractors
// ---------------------------------------------------------------------------

function eventFromMessageRecord(
  rec: Record<string, unknown>,
  fallbackTs: number,
): TailEvent[] {
  const recTs = toEpochMs(rec['ts'] ?? rec['timestamp'] ?? rec['time'], fallbackTs);

  // tool_call shape
  if (rec['type'] === 'tool_call' || (typeof rec['name'] === 'string' && 'args' in rec)) {
    return [
      {
        ts: recTs,
        kind: 'tool_call',
        toolName: typeof rec['name'] === 'string' ? rec['name'] : undefined,
        toolInput: maybeParseJson(rec['args'] ?? rec['input'] ?? rec['arguments']),
      },
    ];
  }
  // tool_result shape
  if (rec['type'] === 'tool_result' || rec['type'] === 'tool_response') {
    return [
      {
        ts: recTs,
        kind: 'tool_result',
        toolOutput: rec['output'] ?? rec['result'] ?? rec['content'],
      },
    ];
  }
  // Generic message — { role, text } or { role, parts: [...] }
  const role = asRole(rec['role']);
  const text =
    typeof rec['text'] === 'string'
      ? rec['text']
      : flattenText(rec['parts']) ?? flattenText(rec['content']);
  if (text === undefined) return [];

  return [{ ts: recTs, kind: 'message', role, text }];
}

function eventsFromMessagesArray(
  messages: unknown[],
  fallbackTs: number,
): TailEvent[] {
  return eventsFromRecordArray(messages, fallbackTs, eventFromMessageRecord);
}

function eventsFromSingleDocument(
  doc: Record<string, unknown>,
  fallbackTs: number,
): TailEvent[] {
  if (Array.isArray(doc['messages'])) {
    return eventsFromMessagesArray(doc['messages'] as unknown[], fallbackTs);
  }
  if (Array.isArray(doc['events'])) {
    return eventsFromMessagesArray(doc['events'] as unknown[], fallbackTs);
  }
  if (Array.isArray(doc['turns'])) {
    return eventsFromMessagesArray(doc['turns'] as unknown[], fallbackTs);
  }
  // The doc itself looks like a single message record.
  return eventFromMessageRecord(doc, fallbackTs);
}

function eventsFromBuffer(buffer: string, fallbackTs: number): TailEvent[] {
  const trimmed = buffer.trim();
  if (!trimmed) return [];

  const capturedEvents = eventsFromCapturedCliTranscript(PARSER_ID, buffer, fallbackTs);
  if (capturedEvents !== null) return capturedEvents;

  // Try NDJSON if the buffer has multiple newline-separated JSON objects.
  if (trimmed.includes('\n') && !trimmed.startsWith('[') && !trimmed.startsWith('{\n')) {
    const lines = trimmed.split(/\r?\n/);
    const looksNdjson = lines.every((line) => {
      const t = line.trim();
      return t.length === 0 || t.startsWith('{') || t.startsWith('[');
    });
    if (looksNdjson) {
      const out: TailEvent[] = [];
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          warnParse(PARSER_ID, `skipping malformed NDJSON line (${line.length} chars)`);
          continue;
        }
        if (!isRecord(parsed)) continue;
        out.push(...eventFromMessageRecord(parsed, fallbackTs));
      }
      if (out.length > 0) return out;
    }
  }

  // Try single JSON document.
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const doc: unknown = JSON.parse(trimmed);
      if (Array.isArray(doc)) {
        return eventsFromMessagesArray(doc, fallbackTs);
      }
      if (isRecord(doc)) {
        return eventsFromSingleDocument(doc, fallbackTs);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnParse(PARSER_ID, `single-document parse failed: ${msg}`);
    }
  }

  // Last resort: treat the file as plain text.
  return [{ ts: fallbackTs, kind: 'message', text: trimmed }];
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const HISTORY_FILE_RX = /\.(json|jsonl|ndjson|log|txt)$/i;

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const geminiParser: TailParser = {
  parse(filePath: string): TailEvent[] {
    return parseSessionFiles(PARSER_ID, filePath, HISTORY_FILE_RX, undefined, () => Date.now(), eventsFromBuffer);
  },
};

export default geminiParser;
