import type { TailEvent } from '../v2/cli-tail/types.js';
import {
  redactRuntimeValue,
  runtimeError,
  type RuntimeRunEvent,
} from './events.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textFromContent(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  const parts: string[] = [];
  for (const part of value) {
    if (typeof part === 'string') {
      parts.push(part);
    } else if (isRecord(part) && typeof part['text'] === 'string') {
      parts.push(part['text']);
    }
  }
  const joined = parts.join('');
  return joined.length > 0 ? joined : undefined;
}

export function normalizeTailEvent(
  executorId: string,
  event: TailEvent,
): RuntimeRunEvent[] {
  const ts = event.ts;
  switch (event.kind) {
    case 'message':
      if (event.role === 'assistant') {
        return [{
          type: 'assistant.message',
          ts,
          executorId,
          text: event.text ?? '',
        }];
      }
      return [{
        type: 'runtime.meta',
        ts,
        executorId,
        text: event.text ?? '',
        raw: redactRuntimeValue(event),
      }];
    case 'reasoning':
      return [{
        type: 'assistant.reasoning',
        ts,
        executorId,
        text: event.text ?? '',
      }];
    case 'tool_call':
      return [{
        type: 'tool.call.started',
        ts,
        executorId,
        toolName: event.toolName,
        toolInput: redactRuntimeValue(event.toolInput),
      }];
    case 'tool_result':
      return [{
        type: 'tool.call.completed',
        ts,
        executorId,
        toolOutput: redactRuntimeValue(event.toolOutput),
      }];
    case 'meta':
      return [{
        type: 'runtime.meta',
        ts,
        executorId,
        text: event.text ?? '',
        raw: redactRuntimeValue(event),
      }];
    default:
      return [runtimeError(
        executorId,
        'runtime_parser_unknown_tail_event',
        `Unknown tail event kind: ${(event as { kind?: unknown }).kind}`,
        'Inspect the CLI parser fixture and add a normalizer branch.',
        { event: redactRuntimeValue(event) },
      )];
  }
}

export function normalizeTailEvents(
  executorId: string,
  events: TailEvent[],
): RuntimeRunEvent[] {
  return events.flatMap((event) => normalizeTailEvent(executorId, event));
}

export function normalizeRuntimeJsonLine(
  executorId: string,
  line: string,
): RuntimeRunEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return [runtimeError(
      executorId,
      'runtime_parser_malformed_json',
      'Malformed JSON line from CLI stream.',
      'Keep the raw terminal output as fallback and capture a fixture for this executor.',
      { preview: trimmed.slice(0, 240) },
    )];
  }
  if (!isRecord(parsed)) {
    return [runtimeError(
      executorId,
      'runtime_parser_non_object_json',
      'CLI JSON line was not an object.',
      'Capture a fixture and update the parser for this executor.',
      { value: redactRuntimeValue(parsed) },
    )];
  }
  return normalizeRuntimeJsonObject(executorId, parsed);
}

export function normalizeRuntimeJsonObject(
  executorId: string,
  value: Record<string, unknown>,
): RuntimeRunEvent[] {
  const ts = typeof value['ts'] === 'number' ? value['ts'] : Date.now();
  const payload = isRecord(value['payload']) ? value['payload'] : value;
  const type = payload['type'];

  if (type === 'assistant' && isRecord(payload['message'])) {
    const message = payload['message'];
    const content = message['content'];
    if (!Array.isArray(content)) return [];
    const out: RuntimeRunEvent[] = [];
    for (const part of content) {
      if (!isRecord(part)) continue;
      if (part['type'] === 'text' && typeof part['text'] === 'string') {
        out.push({ type: 'assistant.message', ts, executorId, text: part['text'] });
      } else if (part['type'] === 'thinking' && typeof part['thinking'] === 'string') {
        out.push({ type: 'assistant.reasoning', ts, executorId, text: part['thinking'] });
      } else if (part['type'] === 'tool_use') {
        out.push({
          type: 'tool.call.started',
          ts,
          executorId,
          toolCallId: typeof part['id'] === 'string' ? part['id'] : undefined,
          toolName: typeof part['name'] === 'string' ? part['name'] : undefined,
          toolInput: redactRuntimeValue(part['input']),
        });
      }
    }
    return out;
  }

  if (type === 'message') {
    const text = textFromContent(payload['content']);
    return text
      ? [{ type: 'assistant.message', ts, executorId, text }]
      : [{ type: 'runtime.meta', ts, executorId, raw: redactRuntimeValue(payload) }];
  }

  if (type === 'reasoning') {
    const text = textFromContent(payload['summary']);
    return [{ type: 'assistant.reasoning', ts, executorId, text: text ?? '' }];
  }

  if (type === 'function_call') {
    let toolInput: unknown = payload['arguments'];
    if (typeof toolInput === 'string') {
      try { toolInput = JSON.parse(toolInput) as unknown; } catch { /* keep string */ }
    }
    return [{
      type: 'tool.call.started',
      ts,
      executorId,
      toolName: typeof payload['name'] === 'string' ? payload['name'] : undefined,
      toolInput: redactRuntimeValue(toolInput),
    }];
  }

  if (type === 'function_call_output') {
    return [{
      type: 'tool.call.completed',
      ts,
      executorId,
      toolOutput: redactRuntimeValue(payload['output']),
    }];
  }

  if (type === 'permission_request') {
    return [{
      type: 'permission.request',
      ts,
      executorId,
      permissionAction: typeof payload['action'] === 'string' ? payload['action'] : 'unknown',
      raw: redactRuntimeValue(payload),
    }];
  }

  if (type === 'result') {
    return [{
      type: 'runtime.result',
      ts,
      executorId,
      result: redactRuntimeValue(payload),
    }];
  }

  if (type === 'error') {
    return [runtimeError(
      executorId,
      'runtime_cli_error',
      typeof payload['message'] === 'string' ? payload['message'] : 'CLI emitted an error event.',
      'Open the task terminal and inspect the previous runtime events.',
      { payload: redactRuntimeValue(payload) },
    )];
  }

  return [{
    type: 'runtime.meta',
    ts,
    executorId,
    raw: redactRuntimeValue(payload),
  }];
}
