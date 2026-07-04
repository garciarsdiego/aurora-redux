// tests/fixtures/acp-stdio-client.ts
//
// Wave 2 Agent L — shared ACP JSON-RPC stdio client helper.
//
// This is a TypeScript port of the JSON-RPC client logic embedded in
// `scripts/runtime-resume-harness/opencode-acp-probe.mjs`. The probe spawns
// a real `opencode acp` subprocess; tests use this same client against the
// in-process mock server (`mock-opencode-acp-server.ts`). Behavior must match
// the harness probe so that the mock is canonical enough that the same
// client logic works against both real opencode AND the mock.
//
// Design notes:
//
// - Uses ONLY `Writable`/`Readable` interfaces (not `ChildProcess`), so
//   PassThrough/Duplex streams from the mock server can be plugged in
//   identically to real `child.stdin`/`child.stdout`.
// - Line-delimited JSON over stdio (LF-terminated frames).
// - Pending request map keyed by integer id; `request()` returns the parsed
//   `result` and rejects with a `JsonRpcRequestError` on `error` responses
//   or timeout.
// - `notify()` sends a no-id JSON-RPC notification (fire-and-forget).
// - Server-to-client requests are recorded into `requestsToServer` and the
//   caller may register a `onServerRequest` handler to respond manually.
//   No auto-reply is emitted by default — tests want full control over
//   permission-flow assertions.

import type { Readable, Writable } from 'node:stream';

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 message shapes
// ---------------------------------------------------------------------------

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcResponseSuccess {
  jsonrpc: '2.0';
  id: number | string;
  result: unknown;
}

export interface JsonRpcResponseError {
  jsonrpc: '2.0';
  id: number | string | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcResponseSuccess
  | JsonRpcResponseError;

export interface CapturedNotification {
  method: string;
  params: unknown;
  receivedAt: number;
}

export interface CapturedResponse {
  id: number | string;
  method: string;
  result?: unknown;
  error?: JsonRpcResponseError['error'];
  receivedAt: number;
  latencyMs: number;
}

export interface CapturedServerRequest {
  id: number | string;
  method: string;
  params: unknown;
  receivedAt: number;
}

export class JsonRpcRequestError extends Error {
  override readonly name = 'JsonRpcRequestError';
  constructor(
    public readonly method: string,
    public readonly jsonRpcError: JsonRpcResponseError['error'] | { message: string },
  ) {
    super(
      typeof (jsonRpcError as { message?: unknown })?.message === 'string'
        ? `${method}: ${(jsonRpcError as { message: string }).message}`
        : `${method}: jsonrpc error`,
    );
  }
}

export type ServerRequestHandler = (
  req: CapturedServerRequest,
) => Promise<JsonRpcResponseSuccess | JsonRpcResponseError> | JsonRpcResponseSuccess | JsonRpcResponseError | undefined;

interface PendingRequest {
  method: string;
  sentAt: number;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface AcpStdioClientOptions {
  /**
   * Default timeout per `request()` call. Individual calls can override.
   * @default 5000
   */
  defaultTimeoutMs?: number;
  /**
   * Optional debug logger — receives raw inbound + outbound frames.
   */
  onTrace?: (event: { dir: 'in' | 'out'; raw: string }) => void;
}

/**
 * Minimal ACP JSON-RPC 2.0 client that talks line-delimited JSON over
 * Writable/Readable stream pairs. Works against:
 *   - real `child.stdin` / `child.stdout` (production opencode subprocess)
 *   - in-process PassThrough streams exposed by the mock server fixture
 */
export class AcpStdioClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly opts: Required<Pick<AcpStdioClientOptions, 'defaultTimeoutMs'>> & AcpStdioClientOptions;
  private stdoutBuffer = '';
  private closed = false;
  private notificationHandlers = new Set<(notif: CapturedNotification) => void>();
  private serverRequestHandler: ServerRequestHandler | null = null;

  readonly notifications: CapturedNotification[] = [];
  readonly responses: CapturedResponse[] = [];
  readonly requestsToServer: CapturedServerRequest[] = [];

  constructor(
    private readonly stdin: Writable,
    private readonly stdout: Readable,
    options: AcpStdioClientOptions = {},
  ) {
    this.opts = { defaultTimeoutMs: 5_000, ...options };
    stdout.on('data', (chunk: Buffer | string) => this.onStdoutChunk(chunk));
    stdout.on('end', () => this.handleClosed('end'));
    stdout.on('close', () => this.handleClosed('close'));
    stdout.on('error', (err: Error) => this.handleErrored(err));
  }

  // ---- public API --------------------------------------------------------

  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error(`AcpStdioClient: cannot request '${method}' — transport closed`));
    }
    const id = this.nextId++;
    const sentAt = Date.now();
    const ms = timeoutMs ?? this.opts.defaultTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`AcpStdioClient: request '${method}' timed out after ${ms}ms`));
        }
      }, ms);
      this.pending.set(id, {
        method,
        sentAt,
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      this.writeRaw({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.writeRaw({ jsonrpc: '2.0', method, params });
  }

  /**
   * Reply to a server-to-client request that was previously captured via
   * `onServerRequest()`. Echoes the same `id` back with `result` or `error`.
   */
  respondToServerRequest(
    id: number | string,
    body: { result: unknown } | { error: JsonRpcResponseError['error'] },
  ): void {
    if (this.closed) return;
    if ('result' in body) {
      this.writeRaw({ jsonrpc: '2.0', id, result: body.result });
    } else {
      this.writeRaw({ jsonrpc: '2.0', id, error: body.error });
    }
  }

  onNotification(handler: (notif: CapturedNotification) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onServerRequest(handler: ServerRequestHandler): void {
    this.serverRequestHandler = handler;
  }

  /**
   * Wait for the first notification matching `predicate`. Resolves with the
   * captured notification or rejects if `timeoutMs` elapses first. Already-
   * captured notifications are checked before subscribing.
   */
  async waitForNotification(
    predicate: (notif: CapturedNotification) => boolean,
    timeoutMs = 5_000,
  ): Promise<CapturedNotification> {
    for (const existing of this.notifications) {
      if (predicate(existing)) return existing;
    }
    return new Promise<CapturedNotification>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`AcpStdioClient: waitForNotification timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const unsubscribe = this.onNotification((notif) => {
        if (predicate(notif)) {
          clearTimeout(timer);
          unsubscribe();
          resolve(notif);
        }
      });
    });
  }

  isClosed(): boolean {
    return this.closed;
  }

  // ---- internals ---------------------------------------------------------

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
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return; // ignore non-JSON noise
    }
    if (!msg || typeof msg !== 'object') return;
    if ((msg as JsonRpcMessage).jsonrpc !== '2.0') return;
    this.opts.onTrace?.({ dir: 'in', raw: line });

    const receivedAt = Date.now();
    const hasMethod = typeof (msg as { method?: unknown }).method === 'string';
    const hasId =
      'id' in msg && (msg as { id?: unknown }).id !== null && (msg as { id?: unknown }).id !== undefined;

    // Response (id + (result | error), no method)
    if (hasId && !hasMethod) {
      const id = (msg as JsonRpcResponseSuccess | JsonRpcResponseError).id as number;
      const pend = this.pending.get(id);
      if (!pend) return;
      const latencyMs = receivedAt - pend.sentAt;
      const errorPayload = (msg as JsonRpcResponseError).error;
      const resultPayload = (msg as JsonRpcResponseSuccess).result;
      this.responses.push({
        id,
        method: pend.method,
        result: resultPayload,
        error: errorPayload,
        receivedAt,
        latencyMs,
      });
      this.pending.delete(id);
      clearTimeout(pend.timer);
      if (errorPayload) {
        pend.reject(new JsonRpcRequestError(pend.method, errorPayload));
      } else {
        pend.resolve(resultPayload);
      }
      return;
    }

    // Notification (method, no id)
    if (hasMethod && !hasId) {
      const notif: CapturedNotification = {
        method: (msg as JsonRpcNotification).method,
        params: (msg as JsonRpcNotification).params,
        receivedAt,
      };
      this.notifications.push(notif);
      for (const h of this.notificationHandlers) {
        try { h(notif); } catch { /* swallow handler errors */ }
      }
      return;
    }

    // Server-to-client request (method + id)
    if (hasMethod && hasId) {
      const req: CapturedServerRequest = {
        id: (msg as JsonRpcRequest).id,
        method: (msg as JsonRpcRequest).method,
        params: (msg as JsonRpcRequest).params,
        receivedAt,
      };
      this.requestsToServer.push(req);
      const handler = this.serverRequestHandler;
      if (handler) {
        Promise.resolve()
          .then(() => handler(req))
          .then((reply) => {
            if (!reply) return;
            this.writeRaw(reply);
          })
          .catch(() => {
            // handler threw — emit method-not-found so the server doesn't hang
            this.writeRaw({
              jsonrpc: '2.0',
              id: req.id,
              error: { code: -32601, message: `client handler threw for ${req.method}` },
            });
          });
      }
    }
  }

  private writeRaw(obj: JsonRpcMessage): void {
    if (this.closed) return;
    const line = `${JSON.stringify(obj)}\n`;
    this.opts.onTrace?.({ dir: 'out', raw: line.trim() });
    try {
      this.stdin.write(line);
    } catch {
      // best effort — surfacing through pending rejection on close
    }
  }

  private handleClosed(_reason: 'end' | 'close'): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, pend] of this.pending) {
      clearTimeout(pend.timer);
      pend.reject(new Error(`AcpStdioClient: transport closed before response (method=${pend.method}, id=${id})`));
    }
    this.pending.clear();
  }

  private handleErrored(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, pend] of this.pending) {
      clearTimeout(pend.timer);
      pend.reject(new Error(`AcpStdioClient: transport error (method=${pend.method}, id=${id}): ${err.message}`));
    }
    this.pending.clear();
  }
}
