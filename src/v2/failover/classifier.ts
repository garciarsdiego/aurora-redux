import { FailoverError, type FailoverReason } from "./error.js";
import { MAX_RETRY_AFTER_MS } from "./policy.js";
import { getUsePersonas } from '../../utils/config.js';
import { runAgent, type AgentInvoker } from '../agents/runner.js';
import type { AgentContext } from '../agents/types.js';
import {
  FAILOVER_CLASSIFIER_PERSONA,
  type FailoverClassifierInput,
  type FailoverClassifierOutput,
} from '../agents/personas/failover_classifier.js';
import { callOmnirouteWithUsage } from '../../utils/omniroute-call.js';
import { getHealthStatus } from '../omniroute-bridge/health-cache.js';
import { backupFilesForRetry } from '../agents/validators/workspace.js';

// Port fiel of Hermes agent/error_classifier.py 7-step pipeline
// + OpenClaw session_expired extension.

// --- Pattern dictionaries -------------------------------------------------

const CONTEXT_OVERFLOW_PATTERNS: RegExp[] = [
  /context.{0,5}length.{0,20}exceed/i,
  /context_length_exceeded/i,
  /maximum.{0,5}context.{0,5}(length|window|tokens)/i,
  /context.{0,5}window.{0,20}(exceed|too\s*long)/i,
  /token.{0,5}limit.{0,10}(exceed|reached)/i,
  /context.{0,5}overflow/i,
  /exceeds?.{0,5}max_model_len/i, // vLLM
  /context\s*length\s*exceeded/i, // Ollama
  /超过最大长度/, // Chinese — exceeds maximum length
  /上下文长度/, // Chinese — context length
  /prompt.{0,5}is.{0,5}too.{0,5}long/i,
];

const LONG_CONTEXT_TIER_PATTERNS: RegExp[] = [
  /long[_\s-]?context[_\s-]?tier/i,
  /tier.{0,10}does.{0,5}not.{0,5}support/i,
  /1m.{0,5}context.{0,10}(tier|not.{0,5}enabled)/i,
  /anthropic-beta.*output.*1m/i,
];

const THINKING_SIGNATURE_PATTERNS: RegExp[] = [
  /thinking.?signature/i,
  /signature.{0,10}mismatch/i,
  /invalid.{0,5}thinking.{0,5}block/i,
];

const USAGE_LIMIT_PATTERNS: RegExp[] = [
  /usage.{0,5}limit/i,
  /quota.{0,5}(exceed|reached)/i,
  /\bquota\b/i,
  /\bbilling\b/i,
  /insufficient.{0,10}credits?/i,
  /account.{0,10}(expired|suspended|delinquent)/i,
  /payment.{0,5}required/i,
  /out.{0,5}of.{0,5}credits?/i,
];

const USAGE_LIMIT_TRANSIENT_SIGNALS: RegExp[] = [
  /try\s*again/i,
  /retry.{0,10}later/i,
  /temporarily/i,
  /queued/i,
  /concurrent/i,
  /rate.{0,5}limit/i,
];

const INJECTION_PATTERNS: RegExp[] = [
  /prompt.{0,5}injection/i,
  /detected.{0,10}injection/i,
  /ignore.{0,10}previous.{0,10}instructions/i,
  /malicious.{0,5}prompt/i,
];

const PAYLOAD_TOO_LARGE_PATTERNS: RegExp[] = [
  /payload.{0,10}too.{0,5}large/i,
  /request.{0,10}entity.{0,10}too.{0,5}large/i,
  /request.{0,10}body.{0,10}too.{0,5}large/i,
];

// Example smoke test 2026-04-30 — AETHER α-init bug: a `cli:codex + model=
// cc/claude-sonnet-4-6` mismatch caused Codex CLI to error with "Unknown
// model: claude-sonnet-4-6" (or similar wording per CLI). The classifier
// had no pattern for that — it landed in `unknown`, which is RETRYABLE,
// so the executor looped 4 times with the same broken combo.
//
// Adding explicit message patterns so future mismatches classify as
// `model_not_found` (which triggers `shouldFallback`, not blind retry).
// The cli.ts isModelCompatibleWithCli check is the primary defence; this
// is the safety net for unknown CLIs / new providers we did not anticipate.
const MODEL_NOT_FOUND_MESSAGE_PATTERNS: RegExp[] = [
  /unknown\s+model/i,
  /invalid\s+model/i,
  /model\s+not\s+(?:found|recognized|recognised|available|supported)/i,
  /not\s+a\s+valid\s+model(?:\s+id)?/i,
  /model\s+does\s+not\s+exist/i,
  /no\s+such\s+model/i,
  /model\s+(?:[\w./-]+\s+)?is\s+not\s+(?:available|supported|recognized)/i,
  /unsupported\s+model/i,
  /unrecognized\s+model/i,
];

const DISCONNECT_PATTERNS: RegExp[] = [
  /ECONNRESET/i,
  /socket\s+hang\s+up/i,
  /EPIPE/i,
  /server.{0,10}disconnect/i,
  /connection.{0,10}(reset|closed)/i,
  /\bEOF\b/,
];

const LARGE_SESSION_HINTS: RegExp[] = [
  /large.{0,10}session/i,
  /large.{0,10}context/i,
  /long.{0,10}conversation/i,
  /many.{0,10}tokens/i,
];

const TRANSPORT_TIMEOUT_PATTERNS: RegExp[] = [
  /ETIMEDOUT/i,
  /\btimeout\b/i,
  /\btimed\s+out\b/i,
  /request.{0,10}timed?\s*out/i,
];

const TRANSPORT_UNREACHABLE_PATTERNS: RegExp[] = [
  /ENETUNREACH/i,
  /ECONNREFUSED/i,
  /EAI_AGAIN/i,
  /network.{0,10}unreachable/i,
];

const AUTH_PERMANENT_MESSAGE_HINTS: RegExp[] = [
  /revoked/i,
  /invalid.{0,5}api.{0,5}key/i,
  /api.{0,5}key.{0,5}not.{0,5}found/i,
  /key.{0,5}disabled/i,
];

const AUTH_TRANSIENT_MESSAGE_HINTS: RegExp[] = [
  /try\s*again/i,
  /temporarily/i,
  /retry.{0,10}later/i,
];

// --- Normalisation --------------------------------------------------------

interface ErrContext {
  message: string;
  status?: number;
  bodyCode?: string;
  /** Server-provided retry window (ms), parsed from the Retry-After header. */
  retryAfterMs?: number;
}

function extractContext(err: unknown): ErrContext {
  if (err instanceof Error) {
    const anyErr = err as unknown as Record<string, unknown>;
    const status = typeof anyErr['status'] === 'number' ? (anyErr['status'] as number) : undefined;
    return {
      message: err.message,
      status,
      bodyCode: extractBodyCode(anyErr),
      retryAfterMs: extractRetryAfterMs(anyErr),
    };
  }
  if (typeof err === 'object' && err !== null) {
    const anyErr = err as Record<string, unknown>;
    const rawMessage = anyErr['message'];
    const message = typeof rawMessage === 'string' ? rawMessage : JSON.stringify(anyErr);
    const status = typeof anyErr['status'] === 'number' ? (anyErr['status'] as number) : undefined;
    return {
      message,
      status,
      bodyCode: extractBodyCode(anyErr),
      retryAfterMs: extractRetryAfterMs(anyErr),
    };
  }
  return { message: String(err) };
}

/**
 * Parse the HTTP `Retry-After` family of headers into a faithful millisecond
 * delay. This is NOT clamped — the safety ceiling (MAX_RETRY_AFTER_MS) is
 * applied by `extractRetryAfterMs` before the value reaches a FailoverError,
 * and again by `selectBackoffMs` before it drives a sleep (defense in depth).
 *
 * Precedence:
 *   1. `retry-after-ms` — OpenAI's millisecond header (most precise).
 *   2. `retry-after` as delta-seconds (integer or lenient fractional).
 *   3. `retry-after` as an HTTP-date → delta from `nowMs`, floored at 0.
 *
 * Returns `0` when the server explicitly says "retry now" (`0` or a past date);
 * callers MUST treat a non-positive result as "no usable delay" and fall back
 * to their own default (selectBackoffMs does exactly that via its `> 0` guard).
 * Returns undefined when no parseable value is present, including a non-string
 * header value (e.g. an array produced by a repeated header). Pure — `nowMs`
 * is injected so the HTTP-date branch is deterministically testable.
 */
export function parseRetryAfterMs(
  headers: Record<string, string> | undefined,
  nowMs: number = Date.now(),
): number | undefined {
  if (!headers || typeof headers !== 'object') return undefined;

  const rawMs = headers['retry-after-ms'];
  if (typeof rawMs === 'string') {
    const ms = Number(rawMs);
    if (Number.isFinite(ms) && ms >= 0) return Math.round(ms);
    // garbage / negative → fall through to the delta-seconds / date header
  }

  const raw = headers['retry-after'];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;

  // delta-seconds (RFC 9110 allows a non-negative integer; we accept a
  // fractional value leniently since some providers emit it). A multi-valued
  // header flattened to "30, 60" fails this regex AND Date.parse below →
  // undefined, the safe "no guidance" degradation. (We deliberately do NOT
  // split on comma first: a legitimate HTTP-date contains commas.)
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? Math.round(seconds * 1000) : undefined;
  }

  // HTTP-date — e.g. "Wed, 21 Oct 2015 07:28:00 GMT". Date.parse handles the
  // comma-bearing RFC format directly.
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - nowMs);

  return undefined;
}

/**
 * Resolve a server retry window off an error and apply the safety ceiling: a
 * caller may attach a pre-parsed numeric `retryAfterMs`, otherwise parse the
 * `responseHeaders` map that omniroute-call attaches alongside `status` on a
 * non-OK HTTP response. The result is clamped to MAX_RETRY_AFTER_MS so a
 * hostile/misbehaving gateway can never make FailoverError.retryAfterMs (also
 * surfaced in the `task_retrying` event) carry an unbounded value.
 */
function extractRetryAfterMs(obj: Record<string, unknown>): number | undefined {
  const direct = obj['retryAfterMs'];
  if (typeof direct === 'number' && Number.isFinite(direct) && direct >= 0) {
    return Math.min(direct, MAX_RETRY_AFTER_MS);
  }
  const headers = obj['responseHeaders'];
  if (headers && typeof headers === 'object') {
    const parsed = parseRetryAfterMs(headers as Record<string, string>);
    return parsed === undefined ? undefined : Math.min(parsed, MAX_RETRY_AFTER_MS);
  }
  return undefined;
}

function extractBodyCode(obj: Record<string, unknown>): string | undefined {
  const paths: (string[])[] = [
    ['body', 'error', 'code'],
    ['error', 'code'],
    ['response', 'data', 'error', 'code'],
    ['data', 'error', 'code'],
  ];
  for (const path of paths) {
    let cur: unknown = obj;
    for (const key of path) {
      if (cur && typeof cur === 'object' && key in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[key];
      } else {
        cur = undefined;
        break;
      }
    }
    if (typeof cur === 'string' && cur.length > 0) return cur;
  }
  return undefined;
}

function make(reason: FailoverReason, ctx: ErrContext): FailoverError {
  return new FailoverError(reason, ctx.message, ctx.status, ctx.retryAfterMs);
}

function anyMatch(patterns: RegExp[], text: string): boolean {
  return patterns.some((p) => p.test(text));
}

// --- 7-step pipeline ------------------------------------------------------

export function classifyError(err: unknown): FailoverError {
  if (err instanceof FailoverError) return err;

  const ctx = extractContext(err);
  const { message, status, bodyCode } = ctx;

  // Step 1 — Provider-specific signatures (Anthropic)
  if (anyMatch(THINKING_SIGNATURE_PATTERNS, message)) {
    return make('thinking_signature', ctx);
  }
  if (anyMatch(LONG_CONTEXT_TIER_PATTERNS, message)) {
    return make('long_context_tier', ctx);
  }

  // Step 2 — HTTP status + message refinement
  if (typeof status === 'number') {
    const resolved = classifyByStatus(status, ctx);
    if (resolved) return resolved;
  }

  // Step 3 — Error code in body (JSON `{error:{code}}`)
  if (bodyCode) {
    const resolved = classifyByBodyCode(bodyCode, ctx);
    if (resolved) return resolved;
  }

  // Step 4 — Message pattern matching
  if (anyMatch(CONTEXT_OVERFLOW_PATTERNS, message)) {
    return make('context_overflow', ctx);
  }
  if (anyMatch(INJECTION_PATTERNS, message)) {
    return make('format', ctx);
  }
  if (anyMatch(PAYLOAD_TOO_LARGE_PATTERNS, message)) {
    return make('payload_too_large', ctx);
  }
  // Step 4.5 — Model-not-found by stderr message (covers CLI-emitted errors
  // when a model arg is foreign to that CLI). HTTP-status path already covers
  // OpenAI/Anthropic 404 + body code `model_not_found`; this catches plain
  // text from CLI binaries which do not return structured HTTP errors.
  if (anyMatch(MODEL_NOT_FOUND_MESSAGE_PATTERNS, message)) {
    return make('model_not_found', ctx);
  }
  if (anyMatch(USAGE_LIMIT_PATTERNS, message)) {
    return anyMatch(USAGE_LIMIT_TRANSIENT_SIGNALS, message)
      ? make('rate_limit', ctx)
      : make('billing', ctx);
  }

  // Step 5 — Server disconnect + large-session hint → context_overflow
  // (runs BEFORE transport fallback — Hermes rule)
  if (anyMatch(DISCONNECT_PATTERNS, message) && anyMatch(LARGE_SESSION_HINTS, message)) {
    return make('context_overflow', ctx);
  }

  // Step 6 — Transport heuristics
  if (anyMatch(DISCONNECT_PATTERNS, message) || anyMatch(TRANSPORT_TIMEOUT_PATTERNS, message)) {
    return make('timeout', ctx);
  }
  if (anyMatch(TRANSPORT_UNREACHABLE_PATTERNS, message)) {
    return make('overloaded', ctx);
  }

  // Step 7 — Fallback
  return make('unknown', ctx);
}

function classifyByStatus(status: number, ctx: ErrContext): FailoverError | undefined {
  const { message } = ctx;

  if (status === 401) {
    if (anyMatch(AUTH_PERMANENT_MESSAGE_HINTS, message)) return make('auth_permanent', ctx);
    return make('auth', ctx);
  }
  if (status === 403) {
    if (anyMatch(AUTH_TRANSIENT_MESSAGE_HINTS, message)) return make('auth', ctx);
    return make('auth_permanent', ctx);
  }
  if (status === 429) {
    const usage = anyMatch(USAGE_LIMIT_PATTERNS, message);
    const transient = anyMatch(USAGE_LIMIT_TRANSIENT_SIGNALS, message);
    if (usage && !transient) return make('billing', ctx);
    return make('rate_limit', ctx);
  }
  if (status === 402) {
    const usage = anyMatch(USAGE_LIMIT_PATTERNS, message);
    const transient = anyMatch(USAGE_LIMIT_TRANSIENT_SIGNALS, message);
    if (usage && transient) return make('rate_limit', ctx);
    return make('billing', ctx);
  }
  if (status === 503 || status === 529) return make('overloaded', ctx);
  if (status === 404) return make('model_not_found', ctx);
  if (status === 413) return make('payload_too_large', ctx);
  if (status === 408) return make('timeout', ctx);
  if (status === 410) return make('session_expired', ctx);
  if (status === 500 || status === 502 || status === 504) return make('server_error', ctx);
  if (status === 400) {
    if (anyMatch(PAYLOAD_TOO_LARGE_PATTERNS, message)) return make('payload_too_large', ctx);
    if (anyMatch(CONTEXT_OVERFLOW_PATTERNS, message)) return make('context_overflow', ctx);
    return make('format', ctx);
  }
  return undefined;
}

function classifyByBodyCode(code: string, ctx: ErrContext): FailoverError | undefined {
  if (/context_length_exceeded|context_overflow/i.test(code)) return make('context_overflow', ctx);
  if (/model_not_found/i.test(code)) return make('model_not_found', ctx);
  if (/invalid_request_error|invalid_request/i.test(code)) return make('format', ctx);
  if (/rate_limit/i.test(code)) return make('rate_limit', ctx);
  if (/overloaded/i.test(code)) return make('overloaded', ctx);
  if (/payload_too_large|request_too_large/i.test(code)) return make('payload_too_large', ctx);
  if (/insufficient_quota|billing/i.test(code)) return make('billing', ctx);
  if (/session_expired/i.test(code)) return make('session_expired', ctx);
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Persona wire — FAILOVER_CLASSIFIER_PERSONA integration
// Gated by OMNIFORGE_USE_PERSONAS feature flag; falls back to legacy on error.
// ─────────────────────────────────────────────────────────────────────────────

/** Context a caller may provide to enrich the FailoverClassifierInput. */
export interface FailoverClassifyContext {
  taskId?: string;
  workflowId?: string;
  /** Full DagTask being remediated. When omitted a minimal stub is built. */
  task?: FailoverClassifierInput['task'];
  retryCount?: number;
  priorFailures?: Array<{ type: string; feedback?: string; mode?: string }>;
  workspaceDir?: string;
}

/** Mutable task context updated by applyClassifierMutations. */
export interface MutableTaskContext {
  model?: string;
  promptPrefix?: string;
  workspaceDir?: string;
  /**
   * Relative-to-workspace paths the prior attempt wrote that should be backed
   * up on a `workspace` mutation. Optional — when absent the workspace-clean
   * mutation is a safe no-op (the classifier layer often cannot enumerate them).
   */
  priorAttemptFiles?: readonly string[];
  /** Retry attempt index used to name the `.attempt_N.bak` backups. */
  retryCount?: number;
}

const omnirouteInvoker: AgentInvoker = async (args) => {
  const result = await callOmnirouteWithUsage({
    systemPrompt: args.systemPrompt,
    userPrompt: args.userPrompt ?? 'Respond per the system contract above.',
    model: args.model,
  });
  return result.content;
};

/**
 * Move prior-attempt artefacts out of the way before a `retry_with_workspace_clean`
 * remediation so the next attempt sees ENOENT and is forced to actually write
 * (the "described_without_writing" failure mode — see validators/workspace.ts).
 *
 * SAFE-08 fix: this was previously a documented no-op, which silently skipped
 * cleanup when SAFE-01 wired the persona path. It now delegates to
 * `backupFilesForRetry` for real cleanup, while staying fully fail-safe:
 *   - No-op (no throw) when `dir` is undefined OR no `relPaths` are supplied —
 *     the classifier layer often cannot enumerate which files the prior attempt
 *     wrote, so the safe behaviour is to skip rather than guess.
 *   - `backupFilesForRetry` is itself best-effort and never throws.
 *
 * Never throws — workspace hygiene must not inject a new error type into the
 * retry loop (it is invoked from inside applyClassifierMutations on the failure
 * path).
 */
export async function cleanWorkspace(
  dir: string | undefined,
  relPaths: readonly string[] = [],
  retryCount = 0,
): Promise<void> {
  if (!dir || relPaths.length === 0) return;
  try {
    backupFilesForRetry(dir, relPaths, { retryCount });
  } catch {
    // Best-effort hygiene — swallow so the retry loop is never broken by a
    // workspace-clean failure. backupFilesForRetry already silences per-file
    // errors; this guards the unlikely top-level throw (e.g. invalid dir).
  }
}

/**
 * Apply mutations from a FailoverClassifierOutput to a mutable task context.
 * - field=='model'         → swap taskCtx.model
 * - field=='prompt_prefix' → prepend to taskCtx.promptPrefix
 * - field=='workspace'     → call cleanWorkspace(taskCtx.workspaceDir)
 */
export async function applyClassifierMutations(
  output: FailoverClassifierOutput,
  taskCtx: MutableTaskContext,
): Promise<void> {
  for (const mutation of output.mutations) {
    switch (mutation.field) {
      case 'model':
        taskCtx.model = String(mutation.new_value ?? '');
        break;
      case 'prompt_prefix': {
        const prefix = String(mutation.new_value ?? '');
        taskCtx.promptPrefix = taskCtx.promptPrefix
          ? `${prefix}\n\n${taskCtx.promptPrefix}`
          : prefix;
        break;
      }
      case 'workspace':
        await cleanWorkspace(
          taskCtx.workspaceDir,
          taskCtx.priorAttemptFiles ?? [],
          taskCtx.retryCount ?? 0,
        );
        break;
      // Other fields (executor_hint, timeout_seconds) passed through to caller.
    }
  }
}

/** Map a legacy FailoverReason to one of the 7 RemediationStrategy values. */
function mapReasonToStrategy(reason: FailoverReason): FailoverClassifierOutput['strategy'] {
  switch (reason) {
    case 'rate_limit':
    case 'overloaded':
    case 'server_error':
    case 'timeout':
    case 'auth':
      return 'retry_as_is';
    case 'context_overflow':
    case 'long_context_tier':
    case 'thinking_signature':
    case 'session_expired':
      return 'retry_with_workspace_clean';
    case 'model_not_found':
      return 'retry_with_different_model';
    case 'format':
      return 'retry_with_stronger_prompt';
    case 'auth_permanent':
    case 'billing':
    case 'payload_too_large':
      return 'escalate_to_operator';
    case 'unknown':
    default:
      return 'soft_fail';
  }
}

function failoverErrorToOutput(fe: FailoverError): FailoverClassifierOutput {
  return {
    strategy: mapReasonToStrategy(fe.reason),
    mutations: [],
    reasoning: `Legacy classifier: ${fe.reason} — ${fe.message}`,
    confidence: 'high',
  };
}

/**
 * Classify an error using the FAILOVER_CLASSIFIER_PERSONA.
 * Exported for testing; production entry-point is classifyErrorWithPersona.
 */
export async function classifyViaPersona(
  err: unknown,
  context: FailoverClassifyContext = {},
  agentCtx?: AgentContext,
  invoker?: AgentInvoker,
): Promise<FailoverClassifierOutput> {
  const errCtx = extractContext(err);

  const input: FailoverClassifierInput = {
    task_id: context.taskId ?? 'unknown',
    workflow_id: context.workflowId ?? 'unknown',
    failure_event: {
      type: errCtx.message,
      feedback: errCtx.message,
    },
    retry_count: context.retryCount ?? 0,
    prior_failures: context.priorFailures,
    task: context.task ?? {
      id: context.taskId ?? 'unknown',
      name: context.taskId ?? 'unknown',
      kind: 'llm_call',
      depends_on: [],
    },
    available_models: [],
    available_clis: [],
  };

  const ctx: AgentContext = agentCtx ?? {
    retryCount: context.retryCount ?? 0,
    taskId: context.taskId,
    workflowId: context.workflowId,
    workspaceDir: context.workspaceDir,
    emit: () => {},
    warn: () => {},
    log: () => {},
  };

  return runAgent(FAILOVER_CLASSIFIER_PERSONA, input, ctx, {
    invoke: invoker ?? omnirouteInvoker,
    parseJson: true,
  });
}

/**
 * Classify an error and return a FailoverClassifierOutput regardless of path.
 *
 * When OMNIFORGE_USE_PERSONAS=true: runs FAILOVER_CLASSIFIER_PERSONA.
 * On any persona failure, or when flag is off: runs legacy classifyError and
 * maps the FailoverReason to a strategy + empty mutations.
 */
export async function classifyErrorWithPersona(
  err: unknown,
  context: FailoverClassifyContext = {},
): Promise<FailoverClassifierOutput> {
  if (getUsePersonas()) {
    try {
      return await classifyViaPersona(err, context);
    } catch (personaErr) {
      console.warn('[failover-classifier] persona path failed, falling back to legacy', {
        error: personaErr instanceof Error ? personaErr.message : String(personaErr),
      });
    }
  }
  return failoverErrorToOutput(classifyError(err));
}

/**
 * Check if a specific provider is healthy based on OmniRoute health status
 * 
 * @param providerName - Provider name (e.g., 'claude', 'openai')
 * @returns true if provider is healthy, false otherwise
 */
export async function isProviderHealthy(providerName: string): Promise<boolean> {
  try {
    const healthResult = await getHealthStatus();
    
    if (!healthResult.ok || !healthResult.data) {
      // If we can't get health status, assume provider might be healthy
      // to avoid false positives
      return true;
    }
    
    const providerHealth = healthResult.data.providers[providerName];
    if (!providerHealth) {
      // Provider not found in health status - assume healthy
      return true;
    }
    
    // Provider is healthy if status is 'healthy'
    return providerHealth.status === 'healthy';
  } catch (err) {
    // On error, assume healthy to avoid false positives
    console.warn('[failover-classifier] Failed to check provider health', {
      error: err instanceof Error ? err.message : String(err),
      provider: providerName,
    });
    return true;
  }
}

/**
 * Extract provider name from model ID
 * 
 * @param modelId - Model ID (e.g., 'cc/claude-sonnet-4-6', 'gpt-4o')
 * @returns Provider name or null if not found
 */
export function extractProviderFromModel(modelId: string): string | null {
  if (!modelId) return null;

  // Handle model IDs with provider prefix (e.g., 'cc/claude-sonnet-4-6').
  // Returns the raw prefix verbatim (cc, openai, google, etc.); upstream
  // callers map it to a canonical provider if needed.
  const slashIndex = modelId.indexOf('/');
  if (slashIndex > -1) {
    return modelId.slice(0, slashIndex);
  }

  // Handle common bare model ID patterns
  if (modelId.startsWith('claude-')) return 'claude';
  if (modelId.startsWith('gpt-')) return 'openai';
  if (modelId.startsWith('gemini-')) return 'google';

  return null;
}
