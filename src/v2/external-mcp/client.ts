/**
 * External MCP client + connection manager (Mission 5).
 *
 * The `ExternalMcpClient` class wraps a single `@modelcontextprotocol/sdk`
 * `Client` instance against one server. `ExternalMcpManager` owns a pool
 * of those clients keyed by server name, with lazy connect-on-demand so
 * a registered-but-unused server pays no spawn/network cost until first
 * call.
 *
 * Why a manager?
 *   - The executor's tool-call dispatcher needs `mcp:<server>:<tool>` to
 *     route to a long-lived connection. Reconnecting on every call would
 *     be unacceptable latency for stdio (~50–200 ms cold start) and
 *     would also lose per-server session state.
 *   - The manager exposes `disconnectAll()` so the daemon can clean up
 *     on shutdown.
 *
 * Bearer encryption envelope
 *   bearer_enc is stored as `<iv-hex>:<authTag-hex>:<ciphertext-hex>`.
 *   This is local to external-mcp; we deliberately do NOT reuse the
 *   secrets table because the registry is a separate object lifecycle.
 *   The master key (`data/secrets.key`) is shared via `secrets-vault.ts`.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Database } from 'better-sqlite3';

import { initDb } from '../../db/client.js';
import { getDbPath } from '../../utils/config.js';
import { listServers, getServer } from './registry.js';
import {
  type ExternalMcpServer,
  type ExternalMcpConnection,
  type ExternalMcpTool,
  type ExternalMcpCallResult,
  prefixToolName,
  parsePrefixedToolName,
} from './types.js';

// ---------------------------------------------------------------------------
// AES-256-GCM bearer envelope.
// Shares the master key file with `secrets-vault.ts` so a single rotation
// point covers both subsystems. Format chosen to keep the column a single
// TEXT cell (vs the 3-BLOB layout used for `secrets`).
// ---------------------------------------------------------------------------

const AES_ALGORITHM = 'aes-256-gcm';
const MASTER_KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

function masterKeyPath(): string {
  return resolve(process.cwd(), 'data', 'secrets.key');
}

function readOrCreateMasterKey(): Buffer {
  const path = masterKeyPath();
  if (existsSync(path)) {
    const key = readFileSync(path);
    if (key.length !== MASTER_KEY_BYTES) {
      throw new Error(
        `invalid secrets master key length: expected ${MASTER_KEY_BYTES} bytes`,
      );
    }
    return key;
  }
  const key = randomBytes(MASTER_KEY_BYTES);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, key, { mode: 0o600 });
  chmodSync(path, 0o600);
  return key;
}

/**
 * Encrypt a plaintext bearer token. Returns `<iv-hex>:<tag-hex>:<ct-hex>`.
 * The function is exported so `registry.ts` can encrypt during insert
 * without owning the crypto knowledge.
 */
export function encryptBearer(plaintext: string): string {
  const key = readOrCreateMasterKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(AES_ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_BYTES,
  });
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

/** Decrypt a `bearer_enc` envelope produced by `encryptBearer()`. */
export function decryptBearer(envelope: string): string {
  const parts = envelope.split(':');
  if (parts.length !== 3) {
    throw new Error('invalid bearer_enc envelope (expected iv:tag:ct hex)');
  }
  const [ivHex, tagHex, ctHex] = parts;
  const key = readOrCreateMasterKey();
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const ct = Buffer.from(ctHex, 'hex');
  const decipher = createDecipheriv(AES_ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_BYTES,
  });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// ---------------------------------------------------------------------------
// ExternalMcpClient — stateless wrapper that knows how to build transports
// and run the connect/listTools/callTool/disconnect lifecycle for one
// server. `ExternalMcpManager` reuses a single instance.
// ---------------------------------------------------------------------------

const CLIENT_IMPLEMENTATION = {
  name: 'omniforge-external-mcp',
  version: '0.1.0',
};

export class ExternalMcpClient {
  /**
   * Open an MCP connection to `server`, list its tools, and return a
   * runtime handle. Caller (the manager) is responsible for caching the
   * result and calling `disconnect()` on shutdown.
   *
   * Failure modes
   *   - stdio: process spawn errors (ENOENT, EACCES) surface from
   *     `transport.start()` inside `client.connect()`.
   *   - http-sse: network/auth errors surface the same way.
   *   - tools/list errors are rethrown after `disconnect()` so we don't
   *     leak the transport.
   */
  async connect(server: ExternalMcpServer): Promise<ExternalMcpConnection> {
    const client = new Client(CLIENT_IMPLEMENTATION, { capabilities: {} });
    const transport = this.buildTransport(server);

    try {
      await client.connect(transport);
    } catch (err) {
      // The SDK closes the transport on connect failure, but we still
      // re-wrap the error with the server name to aid operator debugging.
      const wrapped = new Error(
        `external MCP connect failed for "${server.name}": ${err instanceof Error ? err.message : String(err)}`,
      );
      (wrapped as Error & { cause?: unknown }).cause = err;
      throw wrapped;
    }

    let tools: ExternalMcpTool[];
    try {
      tools = await this.fetchTools(client, server.name);
    } catch (err) {
      // Avoid leaking the transport if tools/list throws.
      try {
        await client.close();
      } catch {
        // Already failing — best-effort cleanup.
      }
      throw err;
    }

    return { server, client, tools };
  }

  /** Return the tools that were fetched at connect time. Cheap accessor. */
  listTools(conn: ExternalMcpConnection): ExternalMcpTool[] {
    return conn.tools;
  }

  /**
   * Invoke a remote tool by its **server-local** name (not the prefixed
   * `mcp:<server>:<tool>` form — the manager strips the prefix before
   * delegating here).
   */
  async callTool(
    conn: ExternalMcpConnection,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ExternalMcpCallResult> {
    const result = await conn.client.callTool({
      name: toolName,
      arguments: args,
    });

    // The SDK union returns either { content, isError? } or { toolResult }.
    // Normalise both into our flat shape.
    if ('content' in result && Array.isArray(result.content)) {
      return {
        content: result.content,
        isError: result.isError === true,
      };
    }
    if ('toolResult' in result) {
      return { content: result.toolResult, isError: false };
    }
    return { content: result, isError: false };
  }

  /** Close the underlying SDK client. Idempotent. */
  async disconnect(conn: ExternalMcpConnection): Promise<void> {
    try {
      await conn.client.close();
    } catch {
      // Best-effort: SDK may have already closed if the remote went away.
    }
  }

  // -------------------------------------------------------------------------

  private buildTransport(
    server: ExternalMcpServer,
  ): StdioClientTransport | SSEClientTransport {
    if (server.transport === 'stdio') {
      if (!server.command) {
        throw new Error(
          `stdio server "${server.name}" has no command configured`,
        );
      }
      return new StdioClientTransport({
        command: server.command,
        args: server.args ?? [],
        env: server.env ?? undefined,
      });
    }

    if (!server.url) {
      throw new Error(`http-sse server "${server.name}" has no url configured`);
    }
    const opts: ConstructorParameters<typeof SSEClientTransport>[1] = {};
    if (server.bearerEnc) {
      const bearer = decryptBearer(server.bearerEnc);
      opts.requestInit = {
        headers: { Authorization: `Bearer ${bearer}` },
      };
      opts.eventSourceInit = {
        // Forward Authorization on the GET that opens the SSE stream.
        // EventSource doesn't allow custom headers by default; the SDK
        // honours `fetch` overrides on its internal request flow.
        fetch: (input, init) =>
          fetch(input, {
            ...init,
            headers: {
              ...(init?.headers ?? {}),
              Authorization: `Bearer ${bearer}`,
            },
          }),
      };
    }
    return new SSEClientTransport(new URL(server.url), opts);
  }

  private async fetchTools(
    client: Client,
    serverName: string,
  ): Promise<ExternalMcpTool[]> {
    const response = await client.listTools();
    const remoteTools = response.tools ?? [];
    return remoteTools.map((tool) => ({
      serverName,
      serverToolName: tool.name,
      prefixedName: prefixToolName(serverName, tool.name),
      description: tool.description ?? null,
      inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
    }));
  }
}

// ---------------------------------------------------------------------------
// ExternalMcpManager — process-wide singleton that owns the active
// connection pool. Built around lazy connect: the first call to
// `getConnection(name)` (or the implicit one via `listAllTools()`) opens
// the transport; subsequent calls reuse it.
// ---------------------------------------------------------------------------

export class ExternalMcpManager {
  private static instance: ExternalMcpManager | null = null;

  private readonly client = new ExternalMcpClient();
  private readonly connections = new Map<string, ExternalMcpConnection>();
  /**
   * In-flight connect promises so concurrent callers for the same server
   * share one connect attempt instead of spawning duplicates.
   */
  private readonly pending = new Map<string, Promise<ExternalMcpConnection>>();

  private constructor() {}

  static getInstance(): ExternalMcpManager {
    ExternalMcpManager.instance ??= new ExternalMcpManager();
    return ExternalMcpManager.instance;
  }

  /**
   * Reset the singleton — test-only escape hatch. Production code should
   * never call this; manager state is process-scoped.
   */
  static resetForTests(): void {
    if (ExternalMcpManager.instance) {
      void ExternalMcpManager.instance.disconnectAll();
    }
    ExternalMcpManager.instance = null;
  }

  /**
   * Return (and lazily open) the connection for `name`. Throws if the
   * server is not registered or is currently inactive.
   *
   * Pass an explicit `db` when calling from a request handler that
   * already has one open; otherwise the manager opens its own.
   */
  async getConnection(
    name: string,
    db?: Database,
  ): Promise<ExternalMcpConnection> {
    const existing = this.connections.get(name);
    if (existing) return existing;

    const inFlight = this.pending.get(name);
    if (inFlight) return inFlight;

    const promise = this.openConnection(name, db).finally(() => {
      this.pending.delete(name);
    });
    this.pending.set(name, promise);
    return promise;
  }

  /**
   * Aggregate tools from every active server. Connects on demand.
   * Failures for individual servers are swallowed so one broken
   * registration doesn't take down the listing — the failure is surfaced
   * to stderr for operator visibility.
   */
  async listAllTools(db?: Database): Promise<ExternalMcpTool[]> {
    const { servers, ownsDb, dbHandle } = this.resolveServers(db);
    try {
      const result: ExternalMcpTool[] = [];
      for (const server of servers) {
        try {
          const conn = await this.getConnection(server.name, dbHandle);
          result.push(...conn.tools);
        } catch (err) {
          process.stderr.write(
            `[external-mcp] listAllTools: server "${server.name}" failed: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
      return result;
    } finally {
      if (ownsDb) dbHandle.close();
    }
  }

  /**
   * Invoke a tool by its prefixed name. Returns the normalised result
   * shape from `ExternalMcpClient.callTool()`.
   *
   * @param prefixed `mcp:<server>:<tool>` form. Plain `<tool>` is rejected.
   */
  async callPrefixedTool(
    prefixed: string,
    args: Record<string, unknown>,
    db?: Database,
  ): Promise<ExternalMcpCallResult> {
    const parsed = parsePrefixedToolName(prefixed);
    if (!parsed) {
      throw new Error(
        `invalid external MCP tool name: "${prefixed}" (expected mcp:<server>:<tool>)`,
      );
    }
    const conn = await this.getConnection(parsed.serverName, db);
    return this.client.callTool(conn, parsed.toolName, args);
  }

  /**
   * Close one server's connection and forget it. The next call will
   * re-open. Safe to call on a never-connected name (no-op).
   */
  async disconnect(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (!conn) return;
    this.connections.delete(name);
    await this.client.disconnect(conn);
  }

  /** Close every active connection. Run by the daemon on shutdown. */
  async disconnectAll(): Promise<void> {
    const conns = [...this.connections.values()];
    this.connections.clear();
    await Promise.all(conns.map((c) => this.client.disconnect(c)));
  }

  // -------------------------------------------------------------------------

  private async openConnection(
    name: string,
    db?: Database,
  ): Promise<ExternalMcpConnection> {
    const { ownsDb, dbHandle } = this.resolveDb(db);
    try {
      const server = getServer(dbHandle, name);
      if (!server) {
        throw new Error(`external MCP server not registered: "${name}"`);
      }
      if (!server.active) {
        throw new Error(`external MCP server "${name}" is inactive`);
      }
      const conn = await this.client.connect(server);
      this.connections.set(name, conn);
      return conn;
    } finally {
      if (ownsDb) dbHandle.close();
    }
  }

  /**
   * Open (or reuse) a DB handle without listing servers. Used by
   * openConnection, which only needs a single row via getServer() —
   * listServers() would run a full SELECT of every active server just to
   * obtain a handle.
   */
  private resolveDb(db?: Database): { ownsDb: boolean; dbHandle: Database } {
    if (db) return { ownsDb: false, dbHandle: db };
    return { ownsDb: true, dbHandle: initDb(getDbPath()) };
  }

  private resolveServers(db?: Database): {
    servers: ExternalMcpServer[];
    ownsDb: boolean;
    dbHandle: Database;
  } {
    const { ownsDb, dbHandle } = this.resolveDb(db);
    return { servers: listServers(dbHandle, true), ownsDb, dbHandle };
  }
}
