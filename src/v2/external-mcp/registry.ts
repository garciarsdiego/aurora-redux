/**
 * External MCP server registry — CRUD against the `external_mcp_servers`
 * table (migration 048).
 *
 * Design notes
 * ────────────
 * - All SQL is parameterised. Identifiers are static; values pass through
 *   `stmt.run(params)` / `stmt.get(params)` so SQL injection is impossible.
 * - `bearer` plaintext supplied by callers is encrypted via
 *   `encryptBearer()` in `client.ts` (AES-256-GCM, hex envelope) before
 *   being persisted as `bearer_enc`. Plaintext never reaches the DB and
 *   never leaves this module unless `decryptBearer()` is called explicitly
 *   by the connection layer.
 * - Lookup helpers (`getServer`, `updateServer`, `deleteServer`,
 *   `setServerActive`) accept either the `id` or the `name` so HTTP route
 *   handlers can stay terse.
 * - Cross-field validation (stdio vs http-sse pair invariants) is
 *   enforced by the Zod schemas in `types.ts`; the DB CHECK constraint on
 *   `transport` is a defence-in-depth backstop.
 */

import type { Database } from 'better-sqlite3';
import { randomBytes } from 'node:crypto';

import {
  type ExternalMcpServer,
  type ExternalMcpServerInput,
  type ExternalMcpServerPatch,
  type ExternalMcpTransport,
  ExternalMcpServerInputSchema,
  ExternalMcpServerPatchSchema,
} from './types.js';
import { encryptBearer } from './client.js';

// ---------------------------------------------------------------------------
// Row shape as stored. `args`/`env` are JSON-encoded strings; `active` is
// the SQLite integer 0/1; timestamps are ISO strings produced by the
// migration default `datetime('now')` or by `nowIso()` on update.
// ---------------------------------------------------------------------------

interface ExternalMcpServerRow {
  id: string;
  name: string;
  transport: string;
  command: string | null;
  args: string | null;
  env: string | null;
  url: string | null;
  bearer_enc: string | null;
  active: number;
  created_at: string;
  updated_at: string;
}

const SELECT_COLUMNS = `id, name, transport, command, args, env, url, bearer_enc, active, created_at, updated_at`;

function nowIso(): string {
  return new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

function makeId(): string {
  // 8 bytes hex matches the migration default (lower(hex(randomblob(8)))).
  return randomBytes(8).toString('hex');
}

function parseJsonField<T>(raw: string | null): T | null {
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // Defensive: a corrupt row should not crash the listing. The operator
    // can re-edit via the API. Surface as null so callers can detect it.
    return null;
  }
}

function rowToServer(row: ExternalMcpServerRow): ExternalMcpServer {
  return {
    id: row.id,
    name: row.name,
    transport: row.transport as ExternalMcpTransport,
    command: row.command,
    args: parseJsonField<string[]>(row.args),
    env: parseJsonField<Record<string, string>>(row.env),
    url: row.url,
    bearerEnc: row.bearer_enc,
    active: row.active !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * List registered external MCP servers, ordered by name.
 *
 * @param activeOnly  When true, only rows with `active = 1` are returned.
 */
export function listServers(
  db: Database,
  activeOnly = false,
): ExternalMcpServer[] {
  const sql = activeOnly
    ? `SELECT ${SELECT_COLUMNS} FROM external_mcp_servers WHERE active = 1 ORDER BY name ASC`
    : `SELECT ${SELECT_COLUMNS} FROM external_mcp_servers ORDER BY name ASC`;
  const rows = db.prepare(sql).all() as ExternalMcpServerRow[];
  return rows.map(rowToServer);
}

/**
 * Fetch a server by primary key (id) or unique name.
 * Returns `undefined` when the row does not exist.
 */
export function getServer(
  db: Database,
  nameOrId: string,
): ExternalMcpServer | undefined {
  const row = db
    .prepare(
      `SELECT ${SELECT_COLUMNS}
         FROM external_mcp_servers
        WHERE id = @key OR name = @key
        LIMIT 1`,
    )
    .get({ key: nameOrId }) as ExternalMcpServerRow | undefined;
  return row ? rowToServer(row) : undefined;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Insert a new external MCP server.
 *
 * Accepts either:
 *   - validated `ExternalMcpServerInput` (typed shape from Zod), or
 *   - a raw `Record<string, unknown>` from an HTTP body — parsed via Zod
 *     here so route handlers can pass the body through unchanged.
 *
 * Throws on:
 *   - schema/cross-field validation failure
 *   - SQLITE_CONSTRAINT (duplicate name) — surface as an Error with a
 *     stable `code` field so callers can map to 409.
 */
export function addServer(
  db: Database,
  rawInput: ExternalMcpServerInput | Record<string, unknown>,
): ExternalMcpServer {
  const input = ExternalMcpServerInputSchema.parse(rawInput);

  // Resolve bearer ciphertext. Plaintext is encrypted with the project's
  // master key (see secrets-vault.ts). bearerEnc passes through verbatim
  // for callers (e.g. import flows) that already hold the envelope.
  const bearerEnc =
    input.transport === 'http-sse'
      ? input.bearerEnc ?? (input.bearer ? encryptBearer(input.bearer) : null)
      : null;

  const id = makeId();
  const now = nowIso();
  const active = input.active === false ? 0 : 1;

  try {
    db.prepare(
      `INSERT INTO external_mcp_servers
         (id, name, transport, command, args, env, url, bearer_enc, active, created_at, updated_at)
       VALUES (@id, @name, @transport, @command, @args, @env, @url, @bearerEnc, @active, @createdAt, @updatedAt)`,
    ).run({
      id,
      name: input.name,
      transport: input.transport,
      command: input.transport === 'stdio' ? input.command ?? null : null,
      args:
        input.transport === 'stdio' && input.args
          ? JSON.stringify(input.args)
          : null,
      env:
        input.transport === 'stdio' && input.env
          ? JSON.stringify(input.env)
          : null,
      url: input.transport === 'http-sse' ? input.url ?? null : null,
      bearerEnc,
      active,
      createdAt: now,
      updatedAt: now,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/UNIQUE constraint failed/i.test(message)) {
      const dup = new Error(
        `external MCP server name already taken: ${input.name}`,
      ) as Error & { code?: string };
      dup.code = 'DUPLICATE_NAME';
      throw dup;
    }
    throw err;
  }

  const inserted = getServer(db, id);
  if (!inserted) {
    // Should be unreachable: we just inserted with this id.
    throw new Error('failed to read back inserted external_mcp_servers row');
  }
  return inserted;
}

/**
 * Patch fields on an existing server. Use Zod-validated patch shape OR
 * pass a raw HTTP body — `updateServer` will re-parse via
 * `ExternalMcpServerPatchSchema`.
 *
 * Throws when the server does not exist.
 *
 * Behaviour notes
 *   - Passing `bearer` re-encrypts; passing `bearerEnc` stores the
 *     supplied envelope verbatim; passing `bearer: null` clears the
 *     stored ciphertext.
 *   - Transport changes are allowed but the merged row must still satisfy
 *     the stdio/http-sse pair invariants. We validate by re-running the
 *     full input schema over the merged record.
 */
export function updateServer(
  db: Database,
  nameOrId: string,
  rawPatch: ExternalMcpServerPatch | Record<string, unknown>,
): ExternalMcpServer {
  const patch = ExternalMcpServerPatchSchema.parse(rawPatch);
  const existing = getServer(db, nameOrId);
  if (!existing) {
    throw new Error(`external MCP server not found: ${nameOrId}`);
  }

  // Merge patch over existing values. The `'field' in patch` checks
  // distinguish "user passed null to clear" from "user did not mention
  // this field".
  const merged = {
    name: patch.name ?? existing.name,
    transport: patch.transport ?? existing.transport,
    command:
      'command' in patch ? patch.command ?? null : existing.command,
    args: 'args' in patch ? patch.args ?? null : existing.args,
    env: 'env' in patch ? patch.env ?? null : existing.env,
    url: 'url' in patch ? patch.url ?? null : existing.url,
    bearerEnc:
      'bearerEnc' in patch
        ? patch.bearerEnc ?? null
        : 'bearer' in patch
          ? patch.bearer
            ? encryptBearer(patch.bearer)
            : null
          : existing.bearerEnc,
    active: patch.active ?? existing.active,
  };

  // Re-validate merged row against the input schema's cross-field rules.
  // This rejects e.g. transport='stdio' with url set.
  ExternalMcpServerInputSchema.parse({
    name: merged.name,
    transport: merged.transport,
    command: merged.command,
    args: merged.args,
    env: merged.env,
    url: merged.url,
    bearerEnc: merged.bearerEnc,
    active: merged.active,
  });

  const now = nowIso();

  try {
    db.prepare(
      `UPDATE external_mcp_servers
          SET name        = @name,
              transport   = @transport,
              command     = @command,
              args        = @args,
              env         = @env,
              url         = @url,
              bearer_enc  = @bearerEnc,
              active      = @active,
              updated_at  = @updatedAt
        WHERE id = @id`,
    ).run({
      id: existing.id,
      name: merged.name,
      transport: merged.transport,
      command: merged.command,
      args: merged.args ? JSON.stringify(merged.args) : null,
      env: merged.env ? JSON.stringify(merged.env) : null,
      url: merged.url,
      bearerEnc: merged.bearerEnc,
      active: merged.active ? 1 : 0,
      updatedAt: now,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/UNIQUE constraint failed/i.test(message)) {
      const dup = new Error(
        `external MCP server name already taken: ${merged.name}`,
      ) as Error & { code?: string };
      dup.code = 'DUPLICATE_NAME';
      throw dup;
    }
    throw err;
  }

  const updated = getServer(db, existing.id);
  if (!updated) {
    throw new Error('failed to read back updated external_mcp_servers row');
  }
  return updated;
}

/**
 * Delete a server by id or name. Returns true when a row was removed.
 */
export function deleteServer(db: Database, nameOrId: string): boolean {
  const result = db
    .prepare(
      `DELETE FROM external_mcp_servers WHERE id = @key OR name = @key`,
    )
    .run({ key: nameOrId });
  return result.changes > 0;
}

/**
 * Set the `active` flag without touching other columns. No-op when the
 * server already has the requested state (still bumps `updated_at`).
 *
 * Throws when the server does not exist so callers can return 404.
 */
export function setServerActive(
  db: Database,
  nameOrId: string,
  active: boolean,
): void {
  const existing = getServer(db, nameOrId);
  if (!existing) {
    throw new Error(`external MCP server not found: ${nameOrId}`);
  }
  db.prepare(
    `UPDATE external_mcp_servers
        SET active = @active, updated_at = @updatedAt
      WHERE id = @id`,
  ).run({
    id: existing.id,
    active: active ? 1 : 0,
    updatedAt: nowIso(),
  });
}
