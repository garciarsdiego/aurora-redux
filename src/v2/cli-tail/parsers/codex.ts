import type { TailEvent, TailParser } from '../types.js';
import { asRole, isRecord, maybeParseJson, safeReadFile, warnParse } from './shared.js';

const PARSER_ID = 'codex';

function textFromParts(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;

  const text = value
    .map((part) => {
      if (typeof part === 'string') return part;
      if (isRecord(part) && typeof part['text'] === 'string') return part['text'];
      return null;
    })
    .filter((part): part is string => part !== null)
    .join('');

  return text.length > 0 ? text : undefined;
}

function payloadFromLine(line: string): { ts: number; payload: Record<string, unknown> } | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed)) return null;

    const payload = isRecord(parsed['payload']) ? parsed['payload'] : parsed;
    const ts = typeof parsed['ts'] === 'number' ? parsed['ts'] : Date.now();
    return { ts, payload };
  } catch {
    return null;
  }
}

function eventFromPayload(ts: number, payload: Record<string, unknown>): TailEvent | null {
  switch (payload['type']) {
    case 'message':
      return {
        ts,
        kind: 'message',
        role: asRole(payload['role']),
        text: textFromParts(payload['content']),
      };
    case 'reasoning':
      return {
        ts,
        kind: 'reasoning',
        text: textFromParts(payload['summary']),
      };
    case 'function_call':
      return {
        ts,
        kind: 'tool_call',
        toolName: typeof payload['name'] === 'string' ? payload['name'] : undefined,
        toolInput: maybeParseJson(payload['arguments']),
      };
    case 'function_call_output':
      return {
        ts,
        kind: 'tool_result',
        toolOutput: payload['output'],
      };
    default:
      return null;
  }
}

const codexParser: TailParser = {
  parse(filePath: string): TailEvent[] {
    const content = safeReadFile(filePath);
    if (content === null) {
      warnParse(PARSER_ID, `unable to read ${filePath}`);
      return [];
    }
    const events: TailEvent[] = [];

    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const parsed = payloadFromLine(trimmed);
      if (!parsed) continue;

      const event = eventFromPayload(parsed.ts, parsed.payload);
      if (event) events.push(event);
    }

    return events;
  },
};

export default codexParser;
