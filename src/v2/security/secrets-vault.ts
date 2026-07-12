import type Database from 'better-sqlite3';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

// The repo is "type": "module" — bare `require()` isn't defined when the
// source runs under ESM (tsx, vitest). It only worked in the shipped bundle
// because tsup injects a require shim. createRequire keeps the lazy,
// synchronous require() semantics without relying on that shim.
const require = createRequire(import.meta.url);

const AES_ALGORITHM = 'aes-256-gcm';
const MASTER_KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export interface SecretListItem {
  id: string;
  key: string;
  created_at: number;
  updated_at: number;
}

interface SecretRow {
  id: string;
  workspace: string;
  key: string;
  value_encrypted: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  created_at: number;
  updated_at: number;
}

function makeId(): string {
  return `sec_${randomBytes(10).toString('hex')}`;
}

function masterKeyPath(): string {
  return resolve(process.cwd(), 'data', 'secrets.key');
}

function readOrCreateMasterKey(): Buffer {
  const path = masterKeyPath();
  if (existsSync(path)) {
    const key = readFileSync(path);
    if (key.length !== MASTER_KEY_BYTES) {
      throw new Error(`invalid secrets master key length: expected ${MASTER_KEY_BYTES} bytes`);
    }
    return key;
  }

  const key = randomBytes(MASTER_KEY_BYTES);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, key, { mode: 0o600 });
  chmodSync(path, 0o600);
  return key;
}

export function encryptValue(value: string): { value_encrypted: Buffer; iv: Buffer; auth_tag: Buffer } {
  const key = readOrCreateMasterKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(AES_ALGORITHM, key, iv, { authTagLength: AUTH_TAG_BYTES });
  const valueEncrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    value_encrypted: valueEncrypted,
    iv,
    auth_tag: cipher.getAuthTag(),
  };
}

export function decryptValue(input: { value_encrypted: Buffer; iv: Buffer; auth_tag: Buffer }): string {
  const key = readOrCreateMasterKey();
  const decipher = createDecipheriv(AES_ALGORITHM, key, input.iv, { authTagLength: AUTH_TAG_BYTES });
  decipher.setAuthTag(input.auth_tag);
  return Buffer.concat([
    decipher.update(input.value_encrypted),
    decipher.final(),
  ]).toString('utf8');
}

function toListItem(row: Pick<SecretRow, 'id' | 'key' | 'created_at' | 'updated_at'>): SecretListItem {
  return {
    id: row.id,
    key: row.key,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function createSecret(
  db: Database.Database,
  workspace: string,
  key: string,
  value: string,
): SecretListItem {
  const now = Date.now();
  const encrypted = encryptValue(value);
  db.prepare(`
    INSERT INTO secrets
      (id, workspace, key, value_encrypted, iv, auth_tag, created_at, updated_at)
    VALUES
      (@id, @workspace, @key, @value_encrypted, @iv, @auth_tag, @created_at, @updated_at)
    ON CONFLICT(workspace, key) DO UPDATE SET
      value_encrypted = excluded.value_encrypted,
      iv = excluded.iv,
      auth_tag = excluded.auth_tag,
      updated_at = excluded.updated_at
  `).run({
    id: makeId(),
    workspace,
    key,
    value_encrypted: encrypted.value_encrypted,
    iv: encrypted.iv,
    auth_tag: encrypted.auth_tag,
    created_at: now,
    updated_at: now,
  });

  const row = db.prepare(`
    SELECT id, key, created_at, updated_at
      FROM secrets
     WHERE workspace = ? AND key = ?
  `).get(workspace, key) as SecretListItem | undefined;
  if (!row) throw new Error('secret was not persisted');
  return toListItem(row);
}

export function getSecret(db: Database.Database, workspace: string, key: string): string | null {
  const row = db.prepare(`
    SELECT id, workspace, key, value_encrypted, iv, auth_tag, created_at, updated_at
      FROM secrets
     WHERE workspace = ? AND key = ?
  `).get(workspace, key) as SecretRow | undefined;
  if (!row) return null;
  return decryptValue(row);
}

export function listSecrets(db: Database.Database, workspace: string): SecretListItem[] {
  const rows = db.prepare(`
    SELECT id, key, created_at, updated_at
      FROM secrets
     WHERE workspace = ?
     ORDER BY key ASC
  `).all(workspace) as Pick<SecretRow, 'id' | 'key' | 'created_at' | 'updated_at'>[];
  return rows.map(toListItem);
}

export function deleteSecret(db: Database.Database, workspace: string, key: string): boolean {
  const result = db.prepare(`
    DELETE FROM secrets
     WHERE workspace = ? AND key = ?
  `).run(workspace, key);
  return result.changes > 0;
}

export function deleteSecretById(db: Database.Database, id: string): boolean {
  const result = db.prepare(`
    DELETE FROM secrets
     WHERE id = ?
  `).run(id);
  return result.changes > 0;
}

const SECRET_PLACEHOLDER_RE = /\{\{secret:([A-Z0-9_]+)\}\}/g;

function resolveSecretsInString(str: string, workspace: string, db: Database.Database): string {
  const matches = [...str.matchAll(SECRET_PLACEHOLDER_RE)];
  if (matches.length === 0) return str;

  const keys = [...new Set(matches.map((m) => m[1]))];
  const values = new Map<string, string>();
  for (const key of keys) {
    const value = getSecret(db, workspace, key);
    if (value !== null) values.set(key, value);
  }

  return str.replace(SECRET_PLACEHOLDER_RE, (_, key) =>
    values.has(key) ? values.get(key)! : `{{secret:${key}}}`,
  );
}

function deepResolveSecrets(value: unknown, workspace: string, db: Database.Database): unknown {
  if (typeof value === 'string') return resolveSecretsInString(value, workspace, db);
  if (Array.isArray(value)) return value.map((v) => deepResolveSecrets(v, workspace, db));
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = deepResolveSecrets(v, workspace, db);
    }
    return result;
  }
  return value;
}

/**
 * Run `fn` against a db connection: reuses the caller-supplied `db` when
 * given, otherwise opens a short-lived connection and closes it afterwards.
 * Shared by resolveSecrets() here and redactSecrets() in redact.ts so the
 * "own a connection or borrow one" bookkeeping lives in one place.
 */
export function withDbConnection<T>(
  db: Database.Database | undefined,
  fn: (conn: Database.Database) => T,
): T {
  if (db !== undefined) {
    return fn(db);
  }
  const { initDb } = require('../../db/client.js') as typeof import('../../db/client.js');
  const { getDbPath } = require('../../utils/config.js') as typeof import('../../utils/config.js');
  const conn = initDb(getDbPath());
  try {
    return fn(conn);
  } finally {
    conn.close();
  }
}

/**
 * Replace {{secret:KEY}} placeholders in a prompt (JSON or plain text) with
 * decrypted values from the vault.  If the prompt is valid JSON the replacement
 * is done recursively inside string values so secret values containing quotes
 * or newlines are safely re-encoded.
 */
export function resolveSecrets(prompt: string, workspace: string, db?: Database.Database): string {
  return withDbConnection(db, (conn) => {
    try {
      const parsed = JSON.parse(prompt);
      const resolved = deepResolveSecrets(parsed, workspace, conn);
      return JSON.stringify(resolved);
    } catch {
      return resolveSecretsInString(prompt, workspace, conn);
    }
  });
}
