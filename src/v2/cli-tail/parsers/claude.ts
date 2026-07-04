/**
 * Tail parser for claude-code session logs.
 *
 * Source format: `~/.claude/projects/<sanitized-cwd>/<session-id>.jsonl`
 *   One JSON object per line. Each object has a top-level `type` plus
 *   ISO-8601 `timestamp`. The shapes we care about:
 *
 *   { type: "user",      message: { role, content: string|array }, timestamp }
 *   { type: "assistant", message: { role, content: array of blocks }, timestamp }
 *   { type: "attachment", attachment: { type: "skill_listing"|"deferred_tools_delta"|... }, timestamp }
 *   { type: "queue-operation", operation: "enqueue"|"dequeue", timestamp }
 *   { type: "ai-title", aiTitle: "...", sessionId: "..." }              (no ts)
 *   { type: "summary",  summary: "...", leafUuid: "..." }              (no ts)
 *
 * Assistant `content` is an array of:
 *   { type: "text",      text: string }
 *   { type: "thinking",  thinking: string, signature: string }
 *   { type: "tool_use",  id, name, input }
 *
 * User `content` (when array) carries `tool_result` entries:
 *   { type: "tool_result", tool_use_id, content: string|array, is_error?: boolean }
 *
 * Notes:
 *  - We surface `text` blocks as `kind: 'message'` and `thinking` blocks as
 *    `kind: 'reasoning'` so the dashboard can render them differently.
 *  - Multiple blocks in one assistant entry produce multiple TailEvents.
 *  - Meta entries (queue-operation, attachment, ai-title, summary) are
 *    intentionally dropped — the dashboard's "live tail" cares about user
 *    turns, model output, and tool activity, not housekeeping rows.
 */

import type { TailEvent, TailParser } from '../types.js';
import {
  flattenText,
  isRecord,
  iterateNdjson,
  safeReadFile,
  toEpochMs,
  warnParse,
} from './shared.js';

const PARSER_ID = 'claude';

function eventsFromAssistant(ts: number, message: Record<string, unknown>): TailEvent[] {
  const content = message['content'];
  if (!Array.isArray(content)) return [];

  const out: TailEvent[] = [];
  for (const raw of content) {
    if (!isRecord(raw)) continue;
    const type = raw['type'];

    if (type === 'text' && typeof raw['text'] === 'string' && raw['text'].length > 0) {
      out.push({ ts, kind: 'message', role: 'assistant', text: raw['text'] });
      continue;
    }
    if (type === 'thinking' && typeof raw['thinking'] === 'string' && raw['thinking'].length > 0) {
      out.push({ ts, kind: 'reasoning', text: raw['thinking'] });
      continue;
    }
    if (type === 'tool_use') {
      const name = typeof raw['name'] === 'string' ? raw['name'] : undefined;
      out.push({
        ts,
        kind: 'tool_call',
        toolName: name,
        toolInput: raw['input'],
      });
      continue;
    }
    // Other Anthropic block types (server_tool_use, etc.) — silently ignored.
  }
  return out;
}

function eventsFromUser(ts: number, message: Record<string, unknown>): TailEvent[] {
  const content = message['content'];

  // String-only user message → single message event.
  if (typeof content === 'string') {
    if (content.length === 0) return [];
    return [{ ts, kind: 'message', role: 'user', text: content }];
  }
  if (!Array.isArray(content)) return [];

  const out: TailEvent[] = [];
  for (const raw of content) {
    if (typeof raw === 'string') {
      if (raw.length > 0) out.push({ ts, kind: 'message', role: 'user', text: raw });
      continue;
    }
    if (!isRecord(raw)) continue;

    if (raw['type'] === 'tool_result') {
      const text = flattenText(raw['content']);
      out.push({
        ts,
        kind: 'tool_result',
        toolOutput: text ?? raw['content'],
      });
      continue;
    }
    if (raw['type'] === 'text' && typeof raw['text'] === 'string') {
      if (raw['text'].length > 0) {
        out.push({ ts, kind: 'message', role: 'user', text: raw['text'] });
      }
      continue;
    }
    // Image / other multimodal blocks — currently dropped.
  }
  return out;
}

function eventsFromLine(line: Record<string, unknown>): TailEvent[] {
  const type = line['type'];
  const ts = toEpochMs(line['timestamp'], Date.now());

  if (type === 'assistant') {
    const message = isRecord(line['message']) ? line['message'] : null;
    if (!message) return [];
    return eventsFromAssistant(ts, message);
  }
  if (type === 'user') {
    const message = isRecord(line['message']) ? line['message'] : null;
    if (!message) return [];
    return eventsFromUser(ts, message);
  }
  // queue-operation / ai-title / attachment / summary / system / etc. — ignored.
  return [];
}

const claudeParser: TailParser = {
  parse(filePath: string): TailEvent[] {
    const buffer = safeReadFile(filePath);
    if (buffer === null) {
      warnParse(PARSER_ID, `unable to read ${filePath}`);
      return [];
    }

    const events: TailEvent[] = [];
    for (const line of iterateNdjson(PARSER_ID, buffer)) {
      try {
        events.push(...eventsFromLine(line));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnParse(PARSER_ID, `event extraction failed: ${msg}`);
      }
    }
    return events;
  },
};

export default claudeParser;
