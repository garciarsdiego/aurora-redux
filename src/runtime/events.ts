import { applySecretPatterns } from '../v2/security/patterns.js';

export type RuntimeEventType =
  | 'runtime.session.started'
  | 'runtime.turn.started'
  | 'assistant.delta'
  | 'assistant.message'
  | 'assistant.reasoning'
  | 'tool.call.started'
  | 'tool.call.completed'
  | 'permission.request'
  | 'runtime.result'
  | 'runtime.error'
  | 'runtime.meta';

export interface RuntimeStructuredError {
  code: string;
  origin: string;
  message: string;
  suggestedAction: string;
  safeContext?: Record<string, unknown>;
}

export interface RuntimeRunEvent {
  type: RuntimeEventType;
  ts: number;
  executorId: string;
  sessionId?: string;
  turnId?: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  permissionAction?: string;
  result?: unknown;
  error?: RuntimeStructuredError;
  raw?: unknown;
}

export function redactRuntimeValue(value: unknown): unknown {
  if (typeof value === 'string') return applySecretPatterns(value);
  if (Array.isArray(value)) return value.map(redactRuntimeValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = redactRuntimeValue(nested);
    }
    return out;
  }
  return value;
}

export function runtimeError(
  executorId: string,
  code: string,
  message: string,
  suggestedAction: string,
  safeContext?: Record<string, unknown>,
): RuntimeRunEvent {
  return {
    type: 'runtime.error',
    ts: Date.now(),
    executorId,
    error: {
      code,
      origin: `executor:${executorId}`,
      message,
      suggestedAction,
      safeContext: safeContext ? redactRuntimeValue(safeContext) as Record<string, unknown> : undefined,
    },
  };
}
