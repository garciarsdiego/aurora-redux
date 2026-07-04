import { readFileSync } from 'node:fs';

import type { TailEvent, TailParser } from '../types.js';

type TailRole = NonNullable<TailEvent['role']>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asRole(value: unknown): TailRole | undefined {
  return value === 'user' || value === 'assistant' || value === 'system' || value === 'developer'
    ? value
    : undefined;
}

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

function parseToolInput(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
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
        toolInput: parseToolInput(payload['arguments']),
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
    const content = readFileSync(filePath, 'utf8');
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
