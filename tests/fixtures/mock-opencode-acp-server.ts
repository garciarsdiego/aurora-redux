// tests/fixtures/mock-opencode-acp-server.ts
//
// Wave 2 Agent L — in-process canonical mock for the opencode ACP JSON-RPC
// stdio surface.
//
// Wave 3's `src/runtime/adapters/acp.ts` rewrite needs deterministic
// fixtures to test:
//   - the lifecycle (initialize -> session/new -> session/prompt -> session/cancel -> session/close)
//   - error paths (no-models, auth-error, transport-error)
//   - server->client request flows (session/request_permission)
//   - streaming notifications (session/update.message_chunk + completed/cancelled)
//
// This module exposes ONE entry point — `startMockOpencodeAcpServer()` — that
// returns a handle whose `stdin`/`stdout` look exactly like a child process's
// stdio (PassThrough Duplex pipes). The included `tests/fixtures/acp-stdio-client.ts`
// works against this handle the same way `scripts/runtime-resume-harness/opencode-acp-probe.mjs`
// works against real opencode — same wire format, same lifecycle.
//
// Behavior is CANONICAL with `_artifacts/runtime-resume-harness/opencode-acp-2026-05-10T04-02-40-044Z.md`:
//   - initialize result includes protocolVersion=1, agentCapabilities (loadSession,
//     mcpCapabilities, promptCapabilities, sessionCapabilities), authMethods, agentInfo
//   - session/new error follows the observed shape:
//     `{code:-32603, message:'Internal error', data:{details:'No models available'}}`
//   - session/* notifications use the documented `session/update` method with a
//     discriminator field (`type` for chunks, `completed`/`cancelled` for terminal)
//
// Constraints (from task brief):
//   - Pure in-process (no real subprocess, no real ports unless `port` is given)
//   - Deterministic (sessionId derived from a counter — `mock-ses-{n}`)
//   - No external deps (only `node:stream`, `node:events`)
//   - ESM TypeScript
//
// HTTP transport (`port` option) is intentionally NOT implemented in this build.
// Wave 3 tests are stdio-only; if/when HTTP becomes needed we'll add a tiny
// `node:http` server here. We throw an explicit error rather than failing
// silently so the gap is loud.

import { PassThrough, type Readable, type Writable } from 'node:stream';
import { EventEmitter } from 'node:events';

import type { JsonRpcMessage } from './acp-stdio-client.js';

// ---------------------------------------------------------------------------
// Public API surface (matches task brief verbatim)
// ---------------------------------------------------------------------------

export type InitializeScenario = 'success' | 'error';
export type SessionNewScenario = 'success' | 'no-models' | 'auth-error';
export type SessionPromptScenario =
  | 'stream-3-then-complete'
  | 'stream-then-cancel'
  | 'permission-request'
  | 'transport-error';

export interface MockServerScenarios {
  initialize: InitializeScenario;
  sessionNew: SessionNewScenario;
  sessionPrompt: SessionPromptScenario;
}

export interface MockServerOptions {
  /** If set, attempt to bind an HTTP transport on this port. NOT IMPLEMENTED — throws. */
  port?: number;
  /** ACP protocol version returned in `initialize`. @default 1 */
  protocolVersion?: number;
  /** Per-method scenario selection. Unset entries fall back to defaults. */
  scenarios?: Partial<MockServerScenarios>;
}

export interface MockServerHandle {
  /** Synthetic pid — purely cosmetic (not a real OS pid). */
  pid: number;
  /** Tests write JSON-RPC frames here (LF-terminated, one frame per line). */
  stdin: Writable;
  /** Tests read JSON-RPC frames from here (LF-terminated, one frame per line). */
  stdout: Readable;
  /** Graceful shutdown — flushes any in-flight notifications then ends streams. */
  stop(): Promise<void>;
  /** All inbound + outbound JSON-RPC frames captured in chronological order. */
  history: HistoryEntry[];
}

export interface HistoryEntry {
  dir: 'in' | 'out';
  at: number;
  message: JsonRpcMessage;
}

export function startMockOpencodeAcpServer(opts: MockServerOptions = {}): Promise<MockServerHandle> {
  if (opts.port !== undefined) {
    return Promise.reject(
      new Error(
        `mock-opencode-acp-server: HTTP transport (port=${opts.port}) is not implemented in this build. ` +
          'Use the default in-process stdio transport for unit tests.',
      ),
    );
  }
  const server = new MockOpencodeAcpServer(opts);
  return Promise.resolve(server.handle());
}

// ---------------------------------------------------------------------------
// Defaults — keep close to what real opencode emitted in the captured artifact
// ---------------------------------------------------------------------------

const DEFAULT_SCENARIOS: MockServerScenarios = {
  initialize: 'success',
  sessionNew: 'success',
  sessionPrompt: 'stream-3-then-complete',
};

const SYNTHETIC_PID_BASE = 90_000;
let syntheticPidCounter = 0;

// Three deterministic chunks for the `stream-3-then-complete` scenario.
// Tokens are stable so test assertions can match exact substrings.
const STREAM_CHUNK_TOKENS = ['mock ', 'response ', 'OK'] as const;

// Server-side error templates that mirror what opencode produced (or would
// produce) in the canonical artifact + reasonable extrapolations.
const ERROR_INTERNAL_NO_MODELS = {
  code: -32603,
  message: 'Internal error',
  data: { details: 'No models available' },
} as const;

const ERROR_AUTH_REQUIRED = {
  code: -32001,
  message: 'Authentication required',
  data: { details: 'No valid API key configured for the active provider', kind: 'auth_error' },
} as const;

const ERROR_INITIALIZE_REJECTED = {
  code: -32603,
  message: 'Initialization failed',
  data: { details: 'Mock initialize scenario set to error' },
} as const;

// ---------------------------------------------------------------------------
// Server implementation
// ---------------------------------------------------------------------------

interface PendingPermissionRequest {
  serverRequestId: number;
  promptRequestId: number | string;
  sessionId: string;
}

class MockOpencodeAcpServer {
  private readonly stdinPipe: PassThrough;     // tests WRITE here -> we READ
  private readonly stdoutPipe: PassThrough;    // we WRITE here -> tests READ
  private readonly history: HistoryEntry[] = [];
  private readonly scenarios: MockServerScenarios;
  private readonly protocolVersion: number;
  private readonly pid: number;

  private inboundBuffer = '';
  private nextSessionCounter = 1;
  private nextServerRequestId = 1_000;
  private readonly knownSessions = new Set<string>();
  private readonly emitter = new EventEmitter();
  private stopped = false;

  // Track an in-flight session/prompt that is awaiting a permission reply.
  private pendingPermission: PendingPermissionRequest | null = null;
  // Track an in-flight session/prompt that is awaiting `session/cancel`.
  private pendingCancellable: { promptRequestId: number | string; sessionId: string } | null = null;

  constructor(opts: MockServerOptions) {
    this.protocolVersion = opts.protocolVersion ?? 1;
    this.scenarios = { ...DEFAULT_SCENARIOS, ...opts.scenarios };

    syntheticPidCounter += 1;
    this.pid = SYNTHETIC_PID_BASE + syntheticPidCounter;

    this.stdinPipe = new PassThrough();
    this.stdoutPipe = new PassThrough();

    this.stdinPipe.on('data', (chunk: Buffer) => this.onInbound(chunk));
    // If the client closes their write side we should still drain whatever
    // is buffered, then end our read side.
    this.stdinPipe.on('end', () => {
      this.flushInboundBuffer();
    });
  }

  handle(): MockServerHandle {
    return {
      pid: this.pid,
      stdin: this.stdinPipe,
      stdout: this.stdoutPipe,
      stop: () => this.stop(),
      history: this.history,
    };
  }

  // ---- inbound parsing ---------------------------------------------------

  private onInbound(chunk: Buffer): void {
    this.inboundBuffer += chunk.toString('utf8');
    let nl: number;
    while ((nl = this.inboundBuffer.indexOf('\n')) !== -1) {
      const line = this.inboundBuffer.slice(0, nl);
      this.inboundBuffer = this.inboundBuffer.slice(nl + 1);
      const trimmed = line.replace(/\r$/, '').trim();
      if (!trimmed) continue;
      this.dispatchLine(trimmed);
    }
  }

  private flushInboundBuffer(): void {
    const tail = this.inboundBuffer.trim();
    this.inboundBuffer = '';
    if (tail) this.dispatchLine(tail);
  }

  private dispatchLine(line: string): void {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      // Mirror opencode: a non-JSON line on the JSON-RPC channel is just dropped.
      // We don't emit a parse-error response because there's no `id` to bind to.
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if ((msg as JsonRpcMessage).jsonrpc !== '2.0') {
      // Per JSON-RPC 2.0 §4.4 we *should* emit an error with id=null. Real
      // opencode is lax — it just drops these. We follow opencode.
      return;
    }
    this.history.push({ dir: 'in', at: Date.now(), message: msg });

    const hasId = 'id' in msg && (msg as { id?: unknown }).id !== null && (msg as { id?: unknown }).id !== undefined;
    const method = (msg as { method?: string }).method;

    // Response from client (to a previously-issued server-to-client request)
    if (hasId && typeof method !== 'string') {
      this.handleClientResponse(msg as { id: number | string; result?: unknown; error?: unknown });
      return;
    }
    if (typeof method !== 'string') return;

    if (hasId) {
      const reqId = (msg as { id: number | string }).id;
      const params = (msg as { params?: unknown }).params;
      // Don't await — handler scheduling happens via setImmediate below.
      void this.handleClientRequest(method, reqId, params);
    } else {
      const params = (msg as { params?: unknown }).params;
      this.handleClientNotification(method, params);
    }
  }

  // ---- request dispatcher ------------------------------------------------

  private async handleClientRequest(method: string, id: number | string, params: unknown): Promise<void> {
    switch (method) {
      case 'initialize':
        return this.handleInitialize(id, params);
      case 'session/new':
        return this.handleSessionNew(id, params);
      case 'session/prompt':
        return this.handleSessionPrompt(id, params);
      case 'session/cancel':
        // Some implementations send cancel as a request-with-id; we handle either.
        this.handleCancel(params);
        this.sendResult(id, { cancelled: true });
        return;
      case 'session/close':
        this.handleSessionClose(params);
        this.sendResult(id, { closed: true });
        // Schedule a graceful shutdown after the response is flushed.
        setImmediate(() => void this.stop());
        return;
      default:
        this.sendError(id, {
          code: -32601,
          message: `Method not found: ${method}`,
        });
        return;
    }
  }

  private handleClientNotification(method: string, params: unknown): void {
    switch (method) {
      case 'session/cancel':
        this.handleCancel(params);
        return;
      case 'session/end':
        // Fire-and-forget shutdown signal observed in the harness probe.
        this.handleSessionClose(params);
        setImmediate(() => void this.stop());
        return;
      default:
        // Unknown notifications are silently dropped — JSON-RPC 2.0 §4.1.
        return;
    }
  }

  private handleClientResponse(msg: { id: number | string; result?: unknown; error?: unknown }): void {
    // The only server->client request we currently issue is `session/request_permission`.
    if (!this.pendingPermission || msg.id !== this.pendingPermission.serverRequestId) {
      return;
    }
    const pending = this.pendingPermission;
    this.pendingPermission = null;

    // Inspect the client's reply. ACP convention is `{ outcome: { type: 'cancelled' | 'selected', ... } }`.
    const outcome = (msg.result as { outcome?: { type?: string } } | undefined)?.outcome;
    const allowed = outcome?.type === 'selected';
    void this.continuePromptAfterPermission(pending, allowed);
  }

  // ---- initialize --------------------------------------------------------

  private handleInitialize(id: number | string, _params: unknown): void {
    if (this.scenarios.initialize === 'error') {
      this.sendError(id, ERROR_INITIALIZE_REJECTED);
      return;
    }
    // Shape mirrors the captured artifact's top-level keys:
    //   agentCapabilities, agentInfo, authMethods, protocolVersion
    this.sendResult(id, {
      protocolVersion: this.protocolVersion,
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: {
          http: true,
          sse: true,
        },
        promptCapabilities: {
          embeddedContext: true,
          image: true,
        },
        sessionCapabilities: {
          close: {},
          fork: {},
          list: {},
          resume: {},
        },
      },
      agentInfo: {
        name: 'mock-opencode-acp',
        version: '0.0.0-mock',
      },
      authMethods: [],
    });
  }

  // ---- session/new -------------------------------------------------------

  private handleSessionNew(id: number | string, _params: unknown): void {
    switch (this.scenarios.sessionNew) {
      case 'no-models':
        this.sendError(id, ERROR_INTERNAL_NO_MODELS);
        return;
      case 'auth-error':
        this.sendError(id, ERROR_AUTH_REQUIRED);
        return;
      case 'success':
      default: {
        const sessionId = `mock-ses-${this.nextSessionCounter++}`;
        this.knownSessions.add(sessionId);
        this.sendResult(id, { sessionId });
        return;
      }
    }
  }

  // ---- session/prompt ----------------------------------------------------

  private async handleSessionPrompt(id: number | string, params: unknown): Promise<void> {
    const sessionId = extractSessionId(params);
    if (!sessionId || !this.knownSessions.has(sessionId)) {
      this.sendError(id, {
        code: -32602,
        message: 'Invalid session id',
        data: { details: `Unknown sessionId: ${sessionId ?? '(missing)'}` },
      });
      return;
    }

    switch (this.scenarios.sessionPrompt) {
      case 'transport-error':
        // Simulate a server-side fault during streaming. Send a partial chunk
        // then an error response (terminating the request promise on the client).
        await delay(5);
        this.sendUpdate(sessionId, { type: 'message_chunk', text: 'partial...' });
        await delay(5);
        this.sendError(id, {
          code: -32099,
          message: 'Transport error',
          data: { details: 'Mock prompt scenario set to transport-error' },
        });
        return;

      case 'stream-then-cancel':
        // Send 1 chunk and then PARK waiting for `session/cancel`. When cancel
        // arrives, emit a cancelled update + resolve the prompt request with
        // a cancellation result (the canonical ACP convention).
        this.pendingCancellable = { promptRequestId: id, sessionId };
        await delay(5);
        this.sendUpdate(sessionId, { type: 'message_chunk', text: STREAM_CHUNK_TOKENS[0] });
        // Parked — `handleCancel()` will finish the response.
        return;

      case 'permission-request':
        // Open a server->client request and wait for the reply. When the
        // reply arrives, `continuePromptAfterPermission()` resolves the
        // prompt request with either a completed or cancelled response.
        this.pendingPermission = {
          serverRequestId: this.nextServerRequestId++,
          promptRequestId: id,
          sessionId,
        };
        await delay(5);
        this.sendServerRequest(this.pendingPermission.serverRequestId, 'session/request_permission', {
          sessionId,
          tool: { name: 'mock-tool', input: {} },
          options: [
            { id: 'allow', label: 'Allow', kind: 'allow' },
            { id: 'deny', label: 'Deny', kind: 'reject' },
          ],
        });
        // Parked — `handleClientResponse()` finishes the response.
        return;

      case 'stream-3-then-complete':
      default: {
        // Emit 3 message_chunk notifications then a completed notification +
        // a successful response. Order of completion is:
        //   chunk, chunk, chunk, completed-notification, response.
        for (const token of STREAM_CHUNK_TOKENS) {
          await delay(2);
          this.sendUpdate(sessionId, { type: 'message_chunk', text: token });
        }
        await delay(2);
        this.sendUpdate(sessionId, { type: 'completed', stopReason: 'end_turn' });
        this.sendResult(id, {
          stopReason: 'end_turn',
          usage: {
            inputTokens: 0,
            outputTokens: STREAM_CHUNK_TOKENS.join('').length,
          },
        });
        return;
      }
    }
  }

  private async continuePromptAfterPermission(
    pending: PendingPermissionRequest,
    allowed: boolean,
  ): Promise<void> {
    if (allowed) {
      // Stream a single chunk then complete.
      await delay(5);
      this.sendUpdate(pending.sessionId, { type: 'message_chunk', text: 'permitted' });
      await delay(2);
      this.sendUpdate(pending.sessionId, { type: 'completed', stopReason: 'end_turn' });
      this.sendResult(pending.promptRequestId, { stopReason: 'end_turn' });
    } else {
      await delay(5);
      this.sendUpdate(pending.sessionId, { type: 'cancelled', reason: 'permission_denied' });
      this.sendResult(pending.promptRequestId, { stopReason: 'cancelled' });
    }
  }

  // ---- session/cancel ----------------------------------------------------

  private handleCancel(params: unknown): void {
    const sessionId = extractSessionId(params);
    if (!this.pendingCancellable) return;
    if (sessionId && sessionId !== this.pendingCancellable.sessionId) return;
    const pending = this.pendingCancellable;
    this.pendingCancellable = null;
    // Emit cancelled update then resolve the parked prompt request.
    setImmediate(() => {
      this.sendUpdate(pending.sessionId, { type: 'cancelled', reason: 'client_cancelled' });
      this.sendResult(pending.promptRequestId, { stopReason: 'cancelled' });
    });
  }

  // ---- session/close -----------------------------------------------------

  private handleSessionClose(params: unknown): void {
    const sessionId = extractSessionId(params);
    if (sessionId) this.knownSessions.delete(sessionId);
  }

  // ---- outbound helpers --------------------------------------------------

  private sendResult(id: number | string, result: unknown): void {
    this.writeFrame({ jsonrpc: '2.0', id, result });
  }

  private sendError(id: number | string, error: { code: number; message: string; data?: unknown }): void {
    this.writeFrame({ jsonrpc: '2.0', id, error });
  }

  private sendUpdate(sessionId: string, update: Record<string, unknown>): void {
    this.writeFrame({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId, update },
    });
  }

  private sendServerRequest(id: number, method: string, params: unknown): void {
    this.writeFrame({ jsonrpc: '2.0', id, method, params });
  }

  private writeFrame(msg: JsonRpcMessage): void {
    if (this.stopped) return;
    this.history.push({ dir: 'out', at: Date.now(), message: msg });
    const line = `${JSON.stringify(msg)}\n`;
    this.stdoutPipe.write(line);
  }

  // ---- shutdown ----------------------------------------------------------

  private async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    // Allow any pending stream microtasks to flush before ending the pipe.
    await delay(0);
    try { this.stdoutPipe.end(); } catch { /* best effort */ }
    try { this.stdinPipe.end(); } catch { /* best effort */ }
    this.emitter.emit('stopped');
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractSessionId(params: unknown): string | null {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  const id = (params as { sessionId?: unknown }).sessionId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}
