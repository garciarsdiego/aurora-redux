// src/runtime/adapters/acp.ts
//
// Wave 3 / Wave C Agent N — production ACP JSON-RPC stdio adapter.
//
// This module replaces the Wave 1 stub. It now provides a real JSON-RPC 2.0
// client over line-delimited stdio for talking to ACP-speaking CLI agents
// (currently opencode; gemini/kimi gated until probe).
//
// Wire-level behavior is GROUND-TRUTHED against the live opencode probe in
// `_artifacts/runtime-resume-harness/opencode-acp-2026-05-10T05-46-40-054Z.md`
// (probe driver: `scripts/runtime-resume-harness/opencode-acp-probe.mjs`):
//
//   - `initialize` returns `{protocolVersion, agentCapabilities, agentInfo, authMethods}`.
//   - `session/new` returns `{sessionId, configOptions, models, modes, _meta}`
//     — adapter only consumes `sessionId` (the rest is opaque).
//   - `session/prompt` returns `{stopReason, usage, _meta}`.
//   - `session/cancel` is a NOTIFICATION (no id, no response).
//   - `session/close` is the documented session shutdown — `session/end` returns
//     `-32601 Method not found` against opencode 1.14.46 and MUST NOT be used.
//   - `session/update` notifications carry `{sessionId, update: {sessionUpdate, ...}}`
//     where `sessionUpdate` discriminates: `available_commands_update`,
//     `usage_update`, `message_chunk`, `tool_call`, `completed`, `cancelled`.
//
// Backwards compatibility:
//   - `parseAcpJsonRpcLine` and `unsupportedAcpAdapter` (and their helper types)
//     are exported UNCHANGED. The Wave 1 probe-harness tests
//     (`runtime-adapter-probes.test.ts`) depend on them and must keep passing.
//
// New exports:
//   - `AcpAdapterTransport` — minimal duplex contract (Writable stdin /
//     Readable stdout). Lets tests inject the in-process mock from
//     `tests/fixtures/mock-opencode-acp-server.ts` instead of spawning a real
//     opencode subprocess.
//   - `AcpStdioClient` — the JSON-RPC client (request/notify/server-request).
//   - `AcpAdapter` — the high-level FSM (init -> session_open -> prompting ->
//     completed | cancelled | errored -> closed).
//   - `createAcpAdapter` — factory that takes a transport plus options.
//   - `acpEventToRuntimeEvents` — pure mapping from `session/update` payloads
//     to `RuntimeRunEvent[]` (consumed by the runtime manager).

import type { Readable, Writable } from 'node:stream';

import {
  redactRuntimeValue,
  runtimeError,
  type RuntimeRunEvent,
} from '../events.js';

// ---------------------------------------------------------------------------
// Backwards-compatible exports (DO NOT MODIFY without updating
// tests/unit/runtime-adapter-probes.test.ts).
// ---------------------------------------------------------------------------

export interface AcpJsonRpcMessage {
  jsonrpc: '2.0';
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

export interface RuntimeAdapterStructuredError {
  code: string;
  origin: string;
  message: string;
  suggestedAction: string;
  safeContext?: Record<string, unknown>;
}

export interface AcpParseResult {
  ok: boolean;
  message?: AcpJsonRpcMessage;
  structuredError?: RuntimeAdapterStructuredError;
}

export function parseAcpJsonRpcLine(line: string): AcpParseResult {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return acpParseError('runtime_acp_invalid_message', 'ACP message is not a JSON object.');
    }
    const message = parsed as Partial<AcpJsonRpcMessage>;
    if (message.jsonrpc !== '2.0') {
      return acpParseError('runtime_acp_invalid_jsonrpc', 'ACP stdout did not contain a JSON-RPC 2.0 message.');
    }
    return { ok: true, message: message as AcpJsonRpcMessage };
  } catch (err) {
    return acpParseError(
      'runtime_acp_non_json_stdout',
      'ACP transport emitted non-JSON stdout.',
      { parse_error: err instanceof Error ? err.message : String(err) },
    );
  }
}

export function unsupportedAcpAdapter(executorId: string, reason: string): RuntimeAdapterStructuredError {
  return {
    code: 'runtime_acp_adapter_unverified',
    origin: `runtime.adapter.acp:${executorId}`,
    message: `ACP adapter is not enabled for ${executorId}: ${reason}`,
    suggestedAction:
      'Run scripts/probe-runtime-adapters.ts against this executor and only mark ACP verified after JSON-RPC stdio initialize/turn/cancel evidence exists.',
    safeContext: { executorId, protocol: 'acp-stdio' },
  };
}

function acpParseError(
  code: string,
  message: string,
  safeContext: Record<string, unknown> = {},
): AcpParseResult {
  return {
    ok: false,
    structuredError: {
      code,
      origin: 'runtime.adapter.acp',
      message,
      suggestedAction:
        'Treat ACP as JSON-RPC over stdio. Disable the adapter or isolate stdout noise before using it for workflow execution.',
      safeContext,
    },
  };
}

// ---------------------------------------------------------------------------
// Error taxonomy — every documented failure surface for the ACP adapter.
//
// Codes are stable string literals so dashboard/operator runbooks can grep
// them. New codes append-only; do NOT renumber/rename existing entries.
// ---------------------------------------------------------------------------

export const ACP_ERROR_CODES = {
  /** Spawned transport never returned an `initialize` response within the deadline. */
  INITIALIZE_TIMEOUT: 'runtime_acp_initialize_timeout',
  /** `initialize` rejected with a JSON-RPC error from the server. */
  INITIALIZE_REJECTED: 'runtime_acp_initialize_rejected',
  /** Server returned `protocolVersion` we cannot speak. */
  PROTOCOL_MISMATCH: 'runtime_acp_protocol_mismatch',
  /** `session/new` rejected — most commonly because no model is configured. */
  NO_MODEL_AVAILABLE: 'runtime_acp_no_model_available',
  /** `session/new` rejected because of authentication failure. */
  AUTH_REQUIRED: 'runtime_acp_auth_required',
  /** `session/new` rejected for any other reason. */
  SESSION_NEW_REJECTED: 'runtime_acp_session_new_rejected',
  /** `session/load` (resume) rejected — caller may fall back to `session/new`. */
  SESSION_LOAD_REJECTED: 'runtime_acp_session_load_rejected',
  /** `session/prompt` returned an error response mid-stream. */
  PROMPT_REJECTED: 'runtime_acp_prompt_rejected',
  /** `session/prompt` did not resolve before the timeout. */
  PROMPT_TIMEOUT: 'runtime_acp_prompt_timeout',
  /** Stream stopped because the client called `cancel()`. */
  CANCELLED: 'runtime_acp_cancelled',
  /** Underlying transport (stdin/stdout) emitted an error event. */
  TRANSPORT_ERROR: 'runtime_acp_transport_error',
  /** Underlying transport closed before the in-flight request resolved. */
  TRANSPORT_CLOSED: 'runtime_acp_transport_closed',
  /** Child process exited mid-prompt. */
  CHILD_EXITED: 'runtime_acp_child_exited',
  /** Server-to-client `session/request_permission` waited longer than the deadline. */
  PERMISSION_TIMEOUT: 'runtime_acp_permission_timeout',
  /** Caller invoked an FSM-violating action (e.g. concurrent prompts on one session). */
  FSM_VIOLATION: 'runtime_acp_fsm_violation',
  /** Server emitted a `session/update` for an unknown session — defensively dropped. */
  FOREIGN_SESSION: 'runtime_acp_foreign_session',
  /** Adapter is not yet wired up for the requested executor (`unsupportedAcpAdapter` companion). */
  ADAPTER_UNVERIFIED: 'runtime_acp_adapter_unverified',
} as const;

export type AcpErrorCode = (typeof ACP_ERROR_CODES)[keyof typeof ACP_ERROR_CODES];

function acpStructuredError(
  executorId: string,
  code: AcpErrorCode,
  message: string,
  suggestedAction: string,
  safeContext: Record<string, unknown> = {},
): RuntimeAdapterStructuredError {
  return {
    code,
    origin: `runtime.adapter.acp:${executorId}`,
    message,
    suggestedAction,
    safeContext: redactRuntimeValue(safeContext) as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 types over the wire (kept private — callers consume the
// AcpStdioClient/AcpAdapter API instead).
// ---------------------------------------------------------------------------

interface JsonRpcRequestFrame {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcNotificationFrame {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

interface JsonRpcResponseSuccessFrame {
  jsonrpc: '2.0';
  id: number | string;
  result: unknown;
}

interface JsonRpcResponseErrorFrame {
  jsonrpc: '2.0';
  id: number | string | null;
  error: { code: number; message: string; data?: unknown };
}

type JsonRpcFrame =
  | JsonRpcRequestFrame
  | JsonRpcNotificationFrame
  | JsonRpcResponseSuccessFrame
  | JsonRpcResponseErrorFrame;

// ---------------------------------------------------------------------------
// AcpAdapterTransport — minimal duplex contract.
//
// In production this is satisfied by a real `ChildProcess` (stdin / stdout
// piped). In tests the in-process mock from
// `tests/fixtures/mock-opencode-acp-server.ts` exposes the same shape via
// `PassThrough` streams.
// ---------------------------------------------------------------------------

export interface AcpAdapterTransport {
  /** Writable side: the adapter writes JSON-RPC frames here. */
  readonly stdin: Writable;
  /** Readable side: the adapter parses line-delimited JSON-RPC frames from here. */
  readonly stdout: Readable;
  /** Optional pid for diagnostics. Mock servers may use a synthetic pid. */
  readonly pid?: number;
  /** Best-effort termination. Adapter calls this on `close()` if the transport is still alive. */
  kill?(signal?: NodeJS.Signals | number): void;
  /** Subscribe to child exit. Returns an unsubscribe handle. Optional — the adapter falls back to listening on `stdout` `close`. */
  onExit?(handler: (code: number | null, signal: NodeJS.Signals | null) => void): () => void;
}

// ---------------------------------------------------------------------------
// Client error class.
// ---------------------------------------------------------------------------

export class AcpJsonRpcError extends Error {
  override readonly name = 'AcpJsonRpcError';
  constructor(
    public readonly method: string,
    public readonly jsonRpcError: { code: number; message: string; data?: unknown },
  ) {
    super(`${method}: ${jsonRpcError.message}`);
  }
}

// ---------------------------------------------------------------------------
// AcpStdioClient — JSON-RPC 2.0 line-delimited stdio client.
//
// This is the productionised version of the inline client used in
// `scripts/runtime-resume-harness/opencode-acp-probe.mjs`. Logic is identical
// in spirit (line buffering + pending request map + notification fan-out + a
// pluggable server-to-client request handler) but typed and stripped of probe
// concerns (debug logging, redaction sampling).
// ---------------------------------------------------------------------------

export interface AcpClientOptions {
  /** Default per-`request()` timeout. Individual calls may override. @default 30000 */
  defaultRequestTimeoutMs?: number;
  /** Optional trace tap — invoked once per inbound + outbound frame. */
  onTrace?: (event: { dir: 'in' | 'out'; raw: string }) => void;
}

export interface AcpServerRequest {
  id: number | string;
  method: string;
  params: unknown;
  receivedAt: number;
}

export interface AcpNotification {
  method: string;
  params: unknown;
  receivedAt: number;
}

export type AcpServerRequestHandler = (
  req: AcpServerRequest,
) =>
  | Promise<{ result: unknown } | { error: { code: number; message: string; data?: unknown } }>
  | { result: unknown }
  | { error: { code: number; message: string; data?: unknown } };

interface PendingRequest {
  method: string;
  sentAt: number;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export class AcpStdioClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Set<(notif: AcpNotification) => void>();
  private serverRequestHandler: AcpServerRequestHandler | null = null;
  private stdoutBuffer = '';
  private closed = false;
  private readonly defaultTimeoutMs: number;
  private readonly onTrace?: (event: { dir: 'in' | 'out'; raw: string }) => void;

  constructor(
    private readonly stdin: Writable,
    stdout: Readable,
    options: AcpClientOptions = {},
  ) {
    this.defaultTimeoutMs = options.defaultRequestTimeoutMs ?? 30_000;
    this.onTrace = options.onTrace;
    stdout.on('data', (chunk: Buffer | string) => this.onStdoutChunk(chunk));
    stdout.on('end', () => this.handleClosed('end'));
    stdout.on('close', () => this.handleClosed('close'));
    stdout.on('error', (err: Error) => this.handleErrored(err));
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error(`AcpStdioClient: cannot request '${method}' — transport closed`));
    }
    const id = this.nextId++;
    const sentAt = Date.now();
    const ms = timeoutMs ?? this.defaultTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer = ms > 0
        ? setTimeout(() => {
            if (this.pending.has(id)) {
              this.pending.delete(id);
              reject(new Error(`AcpStdioClient: request '${method}' timed out after ${ms}ms`));
            }
          }, ms)
        : null;
      this.pending.set(id, {
        method,
        sentAt,
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      this.writeFrame({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.writeFrame({ jsonrpc: '2.0', method, params });
  }

  onNotification(handler: (notif: AcpNotification) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  /**
   * Replace the server-to-client request handler. Whatever the handler returns
   * is sent back as a JSON-RPC response on the same id. If the handler throws
   * we emit a `-32603` so the server doesn't hang.
   */
  onServerRequest(handler: AcpServerRequestHandler): void {
    this.serverRequestHandler = handler;
  }

  isClosed(): boolean {
    return this.closed;
  }

  /**
   * Force-close the client. In-flight requests reject. Notification handlers
   * are detached. Best-effort writes after this point are no-ops.
   */
  close(): void {
    this.handleClosed('close');
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private onStdoutChunk(chunk: Buffer | string): void {
    this.stdoutBuffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let nl: number;
    while ((nl = this.stdoutBuffer.indexOf('\n')) !== -1) {
      const line = this.stdoutBuffer.slice(0, nl);
      this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
      const trimmed = line.replace(/\r$/, '').trim();
      if (!trimmed) continue;
      this.handleLine(trimmed);
    }
  }

  private handleLine(line: string): void {
    let msg: JsonRpcFrame;
    try {
      msg = JSON.parse(line) as JsonRpcFrame;
    } catch {
      // Mirror opencode: non-JSON noise is dropped rather than producing
      // a bound parse error (no id to attach it to).
      return;
    }
    if (!msg || typeof msg !== 'object' || (msg as { jsonrpc?: unknown }).jsonrpc !== '2.0') {
      return;
    }
    this.onTrace?.({ dir: 'in', raw: line });
    const receivedAt = Date.now();
    const hasMethod = typeof (msg as { method?: unknown }).method === 'string';
    const hasId =
      'id' in msg && (msg as { id?: unknown }).id !== null && (msg as { id?: unknown }).id !== undefined;

    // Response
    if (hasId && !hasMethod) {
      const id = (msg as JsonRpcResponseSuccessFrame | JsonRpcResponseErrorFrame).id as number;
      const pend = this.pending.get(id);
      if (!pend) return;
      const errorPayload = (msg as JsonRpcResponseErrorFrame).error;
      this.pending.delete(id);
      if (pend.timer) clearTimeout(pend.timer);
      if (errorPayload) {
        pend.reject(new AcpJsonRpcError(pend.method, errorPayload));
      } else {
        pend.resolve((msg as JsonRpcResponseSuccessFrame).result);
      }
      return;
    }

    // Notification
    if (hasMethod && !hasId) {
      const notif: AcpNotification = {
        method: (msg as JsonRpcNotificationFrame).method,
        params: (msg as JsonRpcNotificationFrame).params,
        receivedAt,
      };
      for (const h of this.notificationHandlers) {
        try {
          h(notif);
        } catch {
          // never let a handler throw out of the dispatch loop
        }
      }
      return;
    }

    // Server-to-client request
    if (hasMethod && hasId) {
      const req: AcpServerRequest = {
        id: (msg as JsonRpcRequestFrame).id,
        method: (msg as JsonRpcRequestFrame).method,
        params: (msg as JsonRpcRequestFrame).params,
        receivedAt,
      };
      const handler = this.serverRequestHandler;
      if (!handler) {
        // No handler installed — return method-not-found so the server doesn't
        // hang. Real handlers SHOULD always be installed before any prompt
        // that might trigger a permission request.
        this.writeFrame({
          jsonrpc: '2.0',
          id: req.id,
          error: { code: -32601, message: `client has no handler for ${req.method}` },
        });
        return;
      }
      Promise.resolve()
        .then(() => handler(req))
        .then((reply) => {
          if (this.closed) return;
          if ('result' in reply) {
            this.writeFrame({ jsonrpc: '2.0', id: req.id, result: reply.result });
          } else {
            this.writeFrame({ jsonrpc: '2.0', id: req.id, error: reply.error });
          }
        })
        .catch((err: unknown) => {
          if (this.closed) return;
          this.writeFrame({
            jsonrpc: '2.0',
            id: req.id,
            error: {
              code: -32603,
              message: `client handler threw for ${req.method}: ${err instanceof Error ? err.message : String(err)}`,
            },
          });
        });
    }
  }

  private writeFrame(frame: JsonRpcFrame): void {
    if (this.closed) return;
    const line = `${JSON.stringify(frame)}\n`;
    this.onTrace?.({ dir: 'out', raw: line.trim() });
    try {
      this.stdin.write(line);
    } catch {
      // best-effort — surface via pending rejection on close
    }
  }

  private handleClosed(_reason: 'end' | 'close'): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, pend] of this.pending) {
      if (pend.timer) clearTimeout(pend.timer);
      pend.reject(new Error(`AcpStdioClient: transport closed before response (method=${pend.method}, id=${id})`));
    }
    this.pending.clear();
    this.notificationHandlers.clear();
  }

  private handleErrored(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, pend] of this.pending) {
      if (pend.timer) clearTimeout(pend.timer);
      pend.reject(new Error(`AcpStdioClient: transport error (method=${pend.method}, id=${id}): ${err.message}`));
    }
    this.pending.clear();
    this.notificationHandlers.clear();
  }
}

// ---------------------------------------------------------------------------
// AcpAdapter — high-level FSM around AcpStdioClient.
//
// State machine:
//
//   created -> initializing -> ready -> session_open -> prompting
//                                                        |
//                                            +---------- + ----------+
//                                            |           |           |
//                                       completed   cancelled    errored
//                                            \___________|___________/
//                                                        |
//                                                     closed
//
// Transitions are guarded — invoking `prompt()` while `prompting` raises an
// FSM violation rather than queuing a second prompt, because the underlying
// ACP protocol does NOT support concurrent prompts on a single session.
// ---------------------------------------------------------------------------

export type AcpAdapterState =
  | 'created'
  | 'initializing'
  | 'ready'
  | 'session_open'
  | 'prompting'
  | 'completed'
  | 'cancelled'
  | 'errored'
  | 'closed';

export interface AcpAdapterOptions {
  /** Executor id used for all emitted events (e.g. `cli:opencode`). */
  executorId: string;
  /** Working directory passed to `session/new` (forwarded as `cwd`). */
  cwd: string;
  /** MCP servers config to forward to `session/new`. Defaults to `[]`. */
  mcpServers?: unknown[];
  /** Highest protocol version we can speak. @default 1 */
  protocolVersion?: number;
  /** Per-`prompt()` timeout. @default 60000 */
  promptTimeoutMs?: number;
  /** `initialize` timeout. @default 15000 */
  initializeTimeoutMs?: number;
  /** `session/new` and `session/load` timeout. @default 15000 */
  sessionTimeoutMs?: number;
  /** `session/close` timeout. @default 5000 */
  closeTimeoutMs?: number;
  /** Permission-request handler timeout. @default 300000 (5 minutes) */
  permissionTimeoutMs?: number;
  /**
   * Server-to-client request handler. The adapter only ever calls this for
   * `session/request_permission`. The handler must resolve to either:
   *   - `{ result: { outcome: { type: 'selected', id: string } } }` to allow
   *   - `{ result: { outcome: { type: 'cancelled' } } }` to deny
   *
   * If unset the adapter installs a default handler that returns `cancelled`
   * after `permissionTimeoutMs` elapses (Wave 3 placeholder — Wave E will
   * replace this with a real HITL bridge).
   */
  permissionHandler?: AcpServerRequestHandler;
  /**
   * Optional consumer of normalized `RuntimeRunEvent` instances emitted while
   * a prompt is streaming. Mirrors the existing runtime-manager `emit` shape.
   */
  onRuntimeEvent?: (event: RuntimeRunEvent) => void;
  /** Optional client-info reported in `initialize`. */
  clientInfo?: { name: string; version: string };
  /** Optional client-capabilities reported in `initialize`. */
  clientCapabilities?: Record<string, unknown>;
  /** Optional trace tap forwarded to the underlying client. */
  onTrace?: (event: { dir: 'in' | 'out'; raw: string }) => void;
}

export interface AcpInitializeResult {
  protocolVersion: number;
  agentCapabilities?: {
    loadSession?: boolean;
    sessionCapabilities?: Record<string, unknown>;
    promptCapabilities?: Record<string, unknown>;
    mcpCapabilities?: Record<string, unknown>;
  };
  authMethods?: unknown[];
  agentInfo?: { name?: string; version?: string };
  raw: unknown;
}

export interface AcpSessionResult {
  sessionId: string;
  raw: unknown;
}

export interface AcpPromptResult {
  stopReason: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null;
  raw: unknown;
}

export class AcpFsmViolationError extends Error {
  override readonly name = 'AcpFsmViolationError';
  constructor(
    message: string,
    public readonly structuredError: RuntimeAdapterStructuredError,
  ) {
    super(message);
  }
}

export class AcpProtocolError extends Error {
  override readonly name = 'AcpProtocolError';
  constructor(
    message: string,
    public readonly structuredError: RuntimeAdapterStructuredError,
  ) {
    super(message);
  }
}

export class AcpAdapter {
  private state: AcpAdapterState = 'created';
  private initializeResult: AcpInitializeResult | null = null;
  private sessionId: string | null = null;
  /** Whether the most recent active prompt was cancelled by the caller. */
  private currentPromptCancelled = false;
  private readonly client: AcpStdioClient;
  private readonly transport: AcpAdapterTransport;
  private readonly options: Required<
    Pick<
      AcpAdapterOptions,
      'executorId' | 'cwd' | 'protocolVersion' | 'promptTimeoutMs' | 'initializeTimeoutMs' |
      'sessionTimeoutMs' | 'closeTimeoutMs' | 'permissionTimeoutMs'
    >
  > & AcpAdapterOptions;
  private offNotification: (() => void) | null = null;
  private offTransportExit: (() => void) | null = null;
  private childExited: { code: number | null; signal: NodeJS.Signals | null } | null = null;

  constructor(transport: AcpAdapterTransport, options: AcpAdapterOptions) {
    this.transport = transport;
    this.options = {
      mcpServers: [],
      ...options,
      protocolVersion: options.protocolVersion ?? 1,
      promptTimeoutMs: options.promptTimeoutMs ?? 60_000,
      initializeTimeoutMs: options.initializeTimeoutMs ?? 15_000,
      sessionTimeoutMs: options.sessionTimeoutMs ?? 15_000,
      closeTimeoutMs: options.closeTimeoutMs ?? 5_000,
      permissionTimeoutMs: options.permissionTimeoutMs ?? 5 * 60_000,
    };
    this.client = new AcpStdioClient(transport.stdin, transport.stdout, {
      defaultRequestTimeoutMs: this.options.promptTimeoutMs,
      onTrace: this.options.onTrace,
    });
    this.client.onServerRequest(this.makePermissionHandler());
    this.offNotification = this.client.onNotification((notif) => this.onSessionUpdate(notif));
    if (typeof transport.onExit === 'function') {
      this.offTransportExit = transport.onExit((code, signal) => {
        this.childExited = { code, signal };
      });
    }
  }

  // -------------------------------------------------------------------------
  // FSM accessors
  // -------------------------------------------------------------------------

  getState(): AcpAdapterState {
    return this.state;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  getInitializeResult(): AcpInitializeResult | null {
    return this.initializeResult;
  }

  // -------------------------------------------------------------------------
  // Lifecycle methods
  // -------------------------------------------------------------------------

  /**
   * Send `initialize` and capture the server's protocolVersion + capabilities.
   * Validates protocol compatibility — anything other than the version we
   * declared is treated as a hard `protocol_mismatch` error.
   */
  async initialize(): Promise<AcpInitializeResult> {
    this.assertState(['created'], 'initialize');
    this.state = 'initializing';
    try {
      const params = {
        protocolVersion: this.options.protocolVersion,
        clientInfo: this.options.clientInfo ?? { name: 'aurora-acp-adapter', version: '0.1.0' },
        clientCapabilities: this.options.clientCapabilities ?? {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      };
      const result = await this.client.request<unknown>('initialize', params, this.options.initializeTimeoutMs);
      const parsed = this.parseInitializeResult(result);
      // Protocol negotiation: server may accept a lower protocolVersion.
      // We only support exact match for now (matches opencode 1.14.46 behavior).
      if (parsed.protocolVersion !== this.options.protocolVersion) {
        const err = acpStructuredError(
          this.options.executorId,
          ACP_ERROR_CODES.PROTOCOL_MISMATCH,
          `ACP server returned protocolVersion=${parsed.protocolVersion}; client requested ${this.options.protocolVersion}.`,
          'Upgrade the ACP adapter to the negotiated version, or pin the executor to a compatible release.',
          {
            requested: this.options.protocolVersion,
            received: parsed.protocolVersion,
          },
        );
        this.transitionToErrored();
        throw new AcpProtocolError(err.message, err);
      }
      this.initializeResult = parsed;
      this.state = 'ready';
      return parsed;
    } catch (err) {
      if (err instanceof AcpProtocolError) throw err;
      const structured = this.classifyError(err, ACP_ERROR_CODES.INITIALIZE_REJECTED, 'initialize');
      this.transitionToErrored();
      throw new AcpProtocolError(structured.message, structured);
    }
  }

  /**
   * Open a new session via `session/new`. Returns the opaque sessionId.
   * The full server payload (configOptions/models/modes/_meta) is exposed
   * via `raw` for callers that want to surface it but is otherwise ignored.
   */
  async newSession(): Promise<AcpSessionResult> {
    this.assertState(['ready'], 'newSession');
    try {
      const result = await this.client.request<unknown>(
        'session/new',
        { cwd: this.options.cwd, mcpServers: this.options.mcpServers ?? [] },
        this.options.sessionTimeoutMs,
      );
      const sessionId = extractSessionId(result);
      if (!sessionId) {
        const err = acpStructuredError(
          this.options.executorId,
          ACP_ERROR_CODES.SESSION_NEW_REJECTED,
          'session/new returned a result without a sessionId field.',
          'Inspect the executor probe artifact and confirm the server populates sessionId in session/new responses.',
          { resultKeys: topLevelKeys(result) },
        );
        this.transitionToErrored();
        throw new AcpProtocolError(err.message, err);
      }
      this.sessionId = sessionId;
      this.state = 'session_open';
      return { sessionId, raw: result };
    } catch (err) {
      if (err instanceof AcpProtocolError) throw err;
      const structured = this.classifySessionNewError(err);
      this.transitionToErrored();
      throw new AcpProtocolError(structured.message, structured);
    }
  }

  /**
   * Resume a previous session via `session/load`. Returns the original
   * sessionId on success, or rejects with `runtime_acp_session_load_rejected`
   * — caller may then fall back to `newSession()`.
   *
   * Only valid when the server's initialize result advertised
   * `agentCapabilities.loadSession === true`.
   */
  async loadSession(sessionId: string): Promise<AcpSessionResult> {
    this.assertState(['ready'], 'loadSession');
    if (!this.initializeResult?.agentCapabilities?.loadSession) {
      const err = acpStructuredError(
        this.options.executorId,
        ACP_ERROR_CODES.SESSION_LOAD_REJECTED,
        'ACP server did not advertise loadSession capability — resume is not available.',
        'Fall back to AcpAdapter#newSession() instead of resuming.',
        { sessionId },
      );
      throw new AcpProtocolError(err.message, err);
    }
    try {
      const result = await this.client.request<unknown>(
        'session/load',
        { sessionId, cwd: this.options.cwd, mcpServers: this.options.mcpServers ?? [] },
        this.options.sessionTimeoutMs,
      );
      this.sessionId = sessionId;
      this.state = 'session_open';
      return { sessionId, raw: result };
    } catch (err) {
      const structured = this.classifyError(
        err,
        ACP_ERROR_CODES.SESSION_LOAD_REJECTED,
        'session/load',
        { sessionId },
      );
      throw new AcpProtocolError(structured.message, structured);
    }
  }

  /**
   * Send a single user prompt and stream `session/update` notifications back
   * to the caller via `onRuntimeEvent`. Resolves once the server returns the
   * terminal `session/prompt` response (or rejects on cancel/error/timeout).
   */
  async prompt(content: Array<{ type: 'text'; text: string } | Record<string, unknown>>): Promise<AcpPromptResult> {
    this.assertState(['session_open'], 'prompt');
    if (!this.sessionId) {
      const err = acpStructuredError(
        this.options.executorId,
        ACP_ERROR_CODES.FSM_VIOLATION,
        'prompt called without a live session.',
        'Call newSession() or loadSession() before prompt().',
      );
      throw new AcpFsmViolationError(err.message, err);
    }
    this.state = 'prompting';
    this.currentPromptCancelled = false;
    const sessionId = this.sessionId;
    try {
      const result = await this.client.request<unknown>(
        'session/prompt',
        { sessionId, prompt: content },
        this.options.promptTimeoutMs,
      );
      const parsed = this.parsePromptResult(result);
      // If the caller requested cancel mid-prompt, surface a CANCELLED error
      // even when the server resolves with `stopReason='cancelled'`. The mock
      // server (and real opencode under cancel) returns the prompt as a
      // successful response carrying `stopReason='cancelled'`, but caller
      // intent should override the server's resolution for state transitions
      // so the workflow can distinguish "we cancelled" from "permission
      // denied" (the latter resolves normally).
      if (this.currentPromptCancelled) {
        this.state = 'session_open';
        const cancelledErr = acpStructuredError(
          this.options.executorId,
          ACP_ERROR_CODES.CANCELLED,
          'session/prompt cancelled by caller.',
          'No action required — cancellation was requested via AcpAdapter#cancel().',
          { sessionId, stopReason: parsed.stopReason },
        );
        throw new AcpProtocolError(cancelledErr.message, cancelledErr);
      }
      // After a successful prompt the session is open for another turn.
      this.state = 'session_open';
      return parsed;
    } catch (err) {
      // The caller-cancel-but-server-rejected case: same outcome as the
      // success branch above — re-throw a CANCELLED protocol error and keep
      // the session open for re-use.
      if (err instanceof AcpProtocolError && err.structuredError.code === ACP_ERROR_CODES.CANCELLED) {
        throw err;
      }
      if (this.currentPromptCancelled) {
        const cancelledErr = acpStructuredError(
          this.options.executorId,
          ACP_ERROR_CODES.CANCELLED,
          'session/prompt cancelled by caller.',
          'No action required — cancellation was requested via AcpAdapter#cancel().',
          { sessionId },
        );
        this.state = 'session_open';
        throw new AcpProtocolError(cancelledErr.message, cancelledErr);
      }
      const structured = this.classifyPromptError(err);
      // Honor child-exit observation: a child that exited mid-prompt overrides
      // generic transport-error code.
      if (this.childExited && (structured.code === ACP_ERROR_CODES.TRANSPORT_CLOSED || structured.code === ACP_ERROR_CODES.TRANSPORT_ERROR)) {
        const child = acpStructuredError(
          this.options.executorId,
          ACP_ERROR_CODES.CHILD_EXITED,
          `ACP child process exited mid-prompt (code=${this.childExited.code ?? 'null'}, signal=${this.childExited.signal ?? 'null'}).`,
          'Inspect the executor stderr and restart the runtime session before retrying the workflow.',
          { exitCode: this.childExited.code, exitSignal: this.childExited.signal, sessionId },
        );
        this.transitionToErrored();
        throw new AcpProtocolError(child.message, child);
      }
      this.transitionToErrored();
      throw new AcpProtocolError(structured.message, structured);
    }
  }

  /**
   * Send `session/cancel` (notification — fire-and-forget). The active
   * `prompt()` call rejects with `runtime_acp_cancelled` once the server
   * acknowledges the cancellation by terminating the prompt request.
   */
  cancel(): void {
    if (this.state !== 'prompting') {
      // No active prompt — silently ignore. We don't raise an error because
      // race conditions between cancel and prompt completion are normal.
      return;
    }
    if (!this.sessionId) return;
    this.currentPromptCancelled = true;
    this.client.notify('session/cancel', { sessionId: this.sessionId });
  }

  /**
   * Close the active session via `session/close`. Idempotent — calling close
   * multiple times is safe. After this method resolves the adapter is in the
   * `closed` state and cannot be reused.
   *
   * Crucially this uses `session/close`, NOT `session/end` — opencode 1.14.46
   * returns `-32601 Method not found` for `session/end`.
   */
  async close(): Promise<void> {
    if (this.state === 'closed') return;
    if (this.sessionId && !this.client.isClosed()) {
      try {
        await this.client.request<unknown>(
          'session/close',
          { sessionId: this.sessionId },
          this.options.closeTimeoutMs,
        );
      } catch {
        // Best-effort: server may have already torn down on its own.
      }
    }
    this.transitionToClosed();
  }

  // -------------------------------------------------------------------------
  // Notification dispatch — converts session/update payloads to runtime events.
  // -------------------------------------------------------------------------

  private onSessionUpdate(notif: AcpNotification): void {
    if (notif.method !== 'session/update') return;
    const params = notif.params as { sessionId?: unknown; update?: unknown } | undefined;
    if (!params || typeof params !== 'object') return;
    const sessionIdField = typeof params.sessionId === 'string' ? params.sessionId : null;
    if (!sessionIdField) return;
    if (this.sessionId && sessionIdField !== this.sessionId) {
      // Defensive: drop notifications for sessions we do not own.
      return;
    }
    const events = acpEventToRuntimeEvents(this.options.executorId, sessionIdField, params.update);
    if (!events.length) return;
    const handler = this.options.onRuntimeEvent;
    if (handler) {
      for (const event of events) {
        try {
          handler(event);
        } catch {
          // never throw out of the dispatch loop
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Permission handler — default returns `cancelled` after the deadline.
  // Wave E will swap this for a real HITL bridge.
  // -------------------------------------------------------------------------

  private makePermissionHandler(): AcpServerRequestHandler {
    if (this.options.permissionHandler) return this.options.permissionHandler;
    const timeoutMs = this.options.permissionTimeoutMs;
    return (_req) =>
      new Promise<{ result: unknown }>((resolve) => {
        setTimeout(() => {
          resolve({ result: { outcome: { type: 'cancelled' } } });
        }, timeoutMs);
      });
  }

  // -------------------------------------------------------------------------
  // FSM helpers
  // -------------------------------------------------------------------------

  private assertState(allowed: AcpAdapterState[], operation: string): void {
    if (!allowed.includes(this.state)) {
      const err = acpStructuredError(
        this.options.executorId,
        ACP_ERROR_CODES.FSM_VIOLATION,
        `Cannot call ${operation} from state '${this.state}'. Expected one of [${allowed.join(', ')}].`,
        'Wait for the previous operation to finish or close the adapter and create a new instance.',
        { state: this.state, allowed: allowed.join(','), operation },
      );
      throw new AcpFsmViolationError(err.message, err);
    }
  }

  private transitionToErrored(): void {
    this.state = 'errored';
  }

  private transitionToClosed(): void {
    if (this.offNotification) {
      this.offNotification();
      this.offNotification = null;
    }
    if (this.offTransportExit) {
      this.offTransportExit();
      this.offTransportExit = null;
    }
    if (!this.client.isClosed()) {
      this.client.close();
    }
    if (typeof this.transport.kill === 'function') {
      try {
        this.transport.kill();
      } catch {
        // best-effort
      }
    }
    this.state = 'closed';
  }

  // -------------------------------------------------------------------------
  // Error classification
  // -------------------------------------------------------------------------

  private parseInitializeResult(raw: unknown): AcpInitializeResult {
    const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
    const protocolVersion = typeof r.protocolVersion === 'number' ? r.protocolVersion : NaN;
    return {
      protocolVersion,
      agentCapabilities: (r.agentCapabilities as AcpInitializeResult['agentCapabilities']) ?? undefined,
      authMethods: Array.isArray(r.authMethods) ? r.authMethods : undefined,
      agentInfo: (r.agentInfo as AcpInitializeResult['agentInfo']) ?? undefined,
      raw,
    };
  }

  private parsePromptResult(raw: unknown): AcpPromptResult {
    const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
    const stopReason = typeof r.stopReason === 'string' ? r.stopReason : 'unknown';
    const usage = (r.usage && typeof r.usage === 'object' && !Array.isArray(r.usage)) ? (r.usage as AcpPromptResult['usage']) : null;
    return { stopReason, usage, raw };
  }

  private classifyError(
    err: unknown,
    fallbackCode: AcpErrorCode,
    method: string,
    extraContext: Record<string, unknown> = {},
  ): RuntimeAdapterStructuredError {
    if (err instanceof AcpJsonRpcError) {
      return acpStructuredError(
        this.options.executorId,
        fallbackCode,
        `${method}: ${err.jsonRpcError.message}`,
        'Inspect the JSON-RPC error code and message; consult the executor probe artifact for examples.',
        {
          method,
          rpcCode: err.jsonRpcError.code,
          rpcMessage: err.jsonRpcError.message,
          rpcData: err.jsonRpcError.data,
          ...extraContext,
        },
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    if (/timed out/i.test(message)) {
      return acpStructuredError(
        this.options.executorId,
        method === 'initialize' ? ACP_ERROR_CODES.INITIALIZE_TIMEOUT : ACP_ERROR_CODES.PROMPT_TIMEOUT,
        `${method} did not complete in time: ${message}`,
        'Increase the corresponding timeout in AcpAdapterOptions or investigate why the executor stalled.',
        { method, ...extraContext },
      );
    }
    if (/transport closed/i.test(message)) {
      return acpStructuredError(
        this.options.executorId,
        ACP_ERROR_CODES.TRANSPORT_CLOSED,
        `${method} aborted because transport closed: ${message}`,
        'Restart the executor process and retry. Confirm the binary did not crash.',
        { method, ...extraContext },
      );
    }
    if (/transport error/i.test(message)) {
      return acpStructuredError(
        this.options.executorId,
        ACP_ERROR_CODES.TRANSPORT_ERROR,
        `${method} aborted because transport errored: ${message}`,
        'Inspect the executor stderr and restart the process before retrying.',
        { method, ...extraContext },
      );
    }
    return acpStructuredError(
      this.options.executorId,
      fallbackCode,
      `${method} failed: ${message}`,
      'Inspect the executor stderr and structured error context for more detail.',
      { method, ...extraContext },
    );
  }

  private classifySessionNewError(err: unknown): RuntimeAdapterStructuredError {
    if (err instanceof AcpJsonRpcError) {
      const data = err.jsonRpcError.data;
      const details = (data && typeof data === 'object' && !Array.isArray(data))
        ? (data as Record<string, unknown>).details
        : undefined;
      const detailsStr = typeof details === 'string' ? details : '';
      if (/no models? available/i.test(detailsStr) || /no model/i.test(err.jsonRpcError.message)) {
        return acpStructuredError(
          this.options.executorId,
          ACP_ERROR_CODES.NO_MODEL_AVAILABLE,
          `session/new rejected — no model available: ${detailsStr || err.jsonRpcError.message}`,
          'Configure a default model in the executor (e.g. `~/.config/opencode/opencode.json` `model` field) or pass model in `session/new` extension params.',
          {
            rpcCode: err.jsonRpcError.code,
            rpcMessage: err.jsonRpcError.message,
            rpcData: err.jsonRpcError.data,
          },
        );
      }
      if (
        /auth/i.test(detailsStr) ||
        /auth/i.test(err.jsonRpcError.message) ||
        err.jsonRpcError.code === -32001
      ) {
        return acpStructuredError(
          this.options.executorId,
          ACP_ERROR_CODES.AUTH_REQUIRED,
          `session/new rejected — authentication required: ${detailsStr || err.jsonRpcError.message}`,
          'Re-authenticate the executor (e.g. opencode login) and ensure the relevant API key is exported in the environment.',
          {
            rpcCode: err.jsonRpcError.code,
            rpcMessage: err.jsonRpcError.message,
            rpcData: err.jsonRpcError.data,
          },
        );
      }
    }
    return this.classifyError(err, ACP_ERROR_CODES.SESSION_NEW_REJECTED, 'session/new');
  }

  private classifyPromptError(err: unknown): RuntimeAdapterStructuredError {
    return this.classifyError(err, ACP_ERROR_CODES.PROMPT_REJECTED, 'session/prompt', {
      sessionId: this.sessionId,
    });
  }
}

// ---------------------------------------------------------------------------
// Factory.
// ---------------------------------------------------------------------------

export function createAcpAdapter(transport: AcpAdapterTransport, options: AcpAdapterOptions): AcpAdapter {
  return new AcpAdapter(transport, options);
}

// ---------------------------------------------------------------------------
// Pure mapping from a `session/update` payload to RuntimeRunEvent[].
//
// Exposed independently so callers can unit-test event normalization without
// standing up a full adapter.
//
// `sessionUpdate` discriminator values observed from the live opencode probe:
//   - available_commands_update — runtime.meta with the commands payload
//   - usage_update             — runtime.meta with cost/usage delta
//   - message_chunk            — assistant.delta (streamed text)
//   - tool_call                — tool.call.started
//   - tool_call_update         — tool.call.completed (when status=completed)
//   - completed                — runtime.result with stopReason
//   - cancelled                — runtime.meta noting cancellation
// Unknown discriminators are kept as runtime.meta so we never silently drop.
// ---------------------------------------------------------------------------

export function acpEventToRuntimeEvents(
  executorId: string,
  sessionId: string,
  update: unknown,
): RuntimeRunEvent[] {
  if (!update || typeof update !== 'object' || Array.isArray(update)) return [];
  const u = update as Record<string, unknown>;
  // The probe captured a `sessionUpdate` discriminator; the mock fixture uses
  // `type` for backwards compat. Both are honored.
  const kind = (typeof u.sessionUpdate === 'string' ? u.sessionUpdate : null) ??
    (typeof u.type === 'string' ? u.type : null);
  const ts = Date.now();
  if (kind === 'message_chunk') {
    const text = typeof u.text === 'string' ? u.text : (typeof (u as { delta?: unknown }).delta === 'string' ? (u as { delta: string }).delta : '');
    return [{
      type: 'assistant.delta',
      ts,
      executorId,
      sessionId,
      text,
    }];
  }
  if (kind === 'tool_call') {
    return [{
      type: 'tool.call.started',
      ts,
      executorId,
      sessionId,
      toolCallId: typeof u.toolCallId === 'string' ? u.toolCallId : (typeof u.id === 'string' ? u.id : undefined),
      toolName: typeof u.toolName === 'string' ? u.toolName : (typeof u.name === 'string' ? u.name : undefined),
      toolInput: redactRuntimeValue(u.input ?? u.toolInput),
    }];
  }
  if (kind === 'tool_call_update') {
    return [{
      type: 'tool.call.completed',
      ts,
      executorId,
      sessionId,
      toolCallId: typeof u.toolCallId === 'string' ? u.toolCallId : (typeof u.id === 'string' ? u.id : undefined),
      toolOutput: redactRuntimeValue(u.output ?? u.toolOutput),
    }];
  }
  if (kind === 'available_commands_update') {
    return [{
      type: 'runtime.meta',
      ts,
      executorId,
      sessionId,
      raw: redactRuntimeValue({ kind: 'available_commands_update', commands: u.availableCommands ?? u.commands }),
    }];
  }
  if (kind === 'usage_update') {
    return [{
      type: 'runtime.meta',
      ts,
      executorId,
      sessionId,
      raw: redactRuntimeValue({ kind: 'usage_update', usage: u.usage ?? u }),
    }];
  }
  if (kind === 'completed') {
    return [{
      type: 'runtime.result',
      ts,
      executorId,
      sessionId,
      result: redactRuntimeValue({
        stopReason: u.stopReason ?? null,
        usage: u.usage ?? null,
      }),
    }];
  }
  if (kind === 'cancelled') {
    return [{
      type: 'runtime.meta',
      ts,
      executorId,
      sessionId,
      raw: redactRuntimeValue({ kind: 'cancelled', reason: u.reason ?? 'unknown' }),
    }];
  }
  if (kind === 'error') {
    return [runtimeError(
      executorId,
      'runtime_acp_stream_error',
      typeof u.message === 'string' ? u.message : 'ACP session/update emitted an error event.',
      'Open the executor stderr and inspect the runtime stream events.',
      { sessionId, raw: redactRuntimeValue(u) },
    )];
  }
  return [{
    type: 'runtime.meta',
    ts,
    executorId,
    sessionId,
    raw: redactRuntimeValue({ kind: kind ?? 'unknown', payload: u }),
  }];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractSessionId(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const sessionId = obj.sessionId ?? obj.session_id ?? obj.id;
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
}

function topLevelKeys(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value as Record<string, unknown>).sort();
}
