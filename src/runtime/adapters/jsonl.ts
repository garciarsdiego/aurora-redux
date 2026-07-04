import type { RuntimeAdapterStructuredError } from './acp.js';

export interface JsonlParseEvent {
  type: string;
  raw: unknown;
}

export interface JsonlParseResult {
  events: JsonlParseEvent[];
  errors: RuntimeAdapterStructuredError[];
}

export function parseJsonlRuntimeOutput(text: string, origin = 'runtime.adapter.jsonl'): JsonlParseResult {
  const events: JsonlParseEvent[] = [];
  const errors: RuntimeAdapterStructuredError[] = [];
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      const eventType =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof (parsed as Record<string, unknown>)['type'] === 'string'
          ? String((parsed as Record<string, unknown>)['type'])
          : 'runtime.raw';
      events.push({ type: eventType, raw: parsed });
    } catch (err) {
      errors.push({
        code: 'runtime_jsonl_malformed_line',
        origin,
        message: 'JSONL runtime output contained a malformed line.',
        suggestedAction:
          'Keep parsing subsequent lines, mark this event as structured error, and inspect the executor stream format before enabling structured mode.',
        safeContext: {
          line: index + 1,
          parse_error: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  return { events, errors };
}
