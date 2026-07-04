/**
 * Tail parser for kimi-for-coding session logs.
 *
 * Source format (per discovery.findKimiSession):
 *   `~/.kimi/sessions/<workspace>/<session>/`  — discovery returns a *directory*.
 *
 * kimi-cli does not currently expose a stream-json equivalent, so its on-disk
 * format is observed empirically. Common shapes encountered:
 *   - `transcript.jsonl`               — newline-delimited turns:
 *       { ts, role, content }                 // simple
 *       { ts, role, content: [...] }          // OpenAI-style parts
 *       { ts, type: "tool_call", name, args }
 *       { ts, type: "tool_result", output }
 *   - `messages.json`                  — single JSON document with
 *       { messages: [ ... ] }
 *   - `metadata.json`                  — sidecar; ignored.
 *
 * The parser walks every NDJSON / JSON file in the session dir, normalising
 * each record into a `TailEvent`. Files are visited in mtime order so a
 * partially-written transcript stays in chronological order.
 *
 * TODO: confirm against real captured output. Per worker_cli_spawn notes,
 *       Kimi writes paths relative to its work-dir (which Omniforge pins to
 *       the repo root) — that means tool_call payloads carry repo-relative
 *       paths even when the run dir is elsewhere. We surface them as-is.
 */

import * as path from 'node:path';

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

const PARSER_ID = 'kimi';

// Sidecars we know we should skip — preserves "transcript-only" semantics.
const SKIP_FILE_NAMES = new Set(['metadata.json', 'config.json', 'session.json']);

const READABLE_FILE_RX = /\.(json|jsonl|ndjson|log)$/i;

// ---------------------------------------------------------------------------
// Record → TailEvent
// ---------------------------------------------------------------------------

function eventFromRecord(rec: Record<string, unknown>, fallbackTs: number): TailEvent[] {
  const ts = toEpochMs(rec['ts'] ?? rec['timestamp'] ?? rec['time'], fallbackTs);

  // Tool call
  if (rec['type'] === 'tool_call' || rec['type'] === 'function_call') {
    return [
      {
        ts,
        kind: 'tool_call',
        toolName:
          typeof rec['name'] === 'string'
            ? rec['name']
            : typeof rec['tool'] === 'string'
              ? rec['tool']
              : undefined,
        toolInput: maybeParseJson(rec['args'] ?? rec['arguments'] ?? rec['input']),
      },
    ];
  }

  // Tool result
  if (
    rec['type'] === 'tool_result' ||
    rec['type'] === 'tool_response' ||
    rec['type'] === 'function_call_output'
  ) {
    return [
      {
        ts,
        kind: 'tool_result',
        toolOutput: rec['output'] ?? rec['result'] ?? rec['content'],
      },
    ];
  }

  // Reasoning / thinking
  if (rec['type'] === 'thinking' || rec['type'] === 'reasoning') {
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
    typeof rec['content'] === 'string'
      ? rec['content']
      : typeof rec['text'] === 'string'
        ? rec['text']
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

  // Try NDJSON first (most common for transcript.jsonl).
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

  // Try single JSON document.
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const doc: unknown = JSON.parse(trimmed);
      if (Array.isArray(doc)) return eventsFromArray(doc, fallbackTs);
      if (isRecord(doc)) {
        if (Array.isArray(doc['messages'])) {
          return eventsFromArray(doc['messages'] as unknown[], fallbackTs);
        }
        if (Array.isArray(doc['turns'])) {
          return eventsFromArray(doc['turns'] as unknown[], fallbackTs);
        }
        if (Array.isArray(doc['events'])) {
          return eventsFromArray(doc['events'] as unknown[], fallbackTs);
        }
        return eventFromRecord(doc, fallbackTs);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnParse(PARSER_ID, `single-document parse failed: ${msg}`);
    }
  }

  // Plain-text fallback.
  return [{ ts: fallbackTs, kind: 'message', text: trimmed }];
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const kimiParser: TailParser = {
  parse(filePath: string): TailEvent[] {
    const files = resolveFilesToParse(filePath);
    if (files.length === 0) {
      warnParse(PARSER_ID, `no readable session files at ${filePath}`);
      return [];
    }

    const out: TailEvent[] = [];
    for (const file of files) {
      // Skip the well-known sidecar files when nested deeper than the root.
      if (SKIP_FILE_NAMES.has(path.basename(file).toLowerCase())) continue;
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

export default kimiParser;
