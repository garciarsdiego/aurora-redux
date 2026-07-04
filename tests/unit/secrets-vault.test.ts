import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSecret,
  deleteSecret,
  getSecret,
  listSecrets,
} from '../../src/v2/security/secrets-vault.js';

function createSecretsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE secrets (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      key TEXT NOT NULL,
      value_encrypted BLOB NOT NULL,
      iv BLOB NOT NULL,
      auth_tag BLOB NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(workspace, key)
    );
    CREATE INDEX idx_secrets_workspace ON secrets(workspace);
  `);
}

describe('secrets vault', () => {
  let db: Database.Database;
  let cwd: string;
  let previousCwd: string;

  beforeEach(() => {
    db = new Database(':memory:');
    createSecretsTable(db);
    previousCwd = process.cwd();
    cwd = mkdtempSync(join(tmpdir(), 'omniforge-secrets-vault-'));
    process.chdir(cwd);
  });

  afterEach(() => {
    db.close();
    process.chdir(previousCwd);
    rmSync(cwd, { recursive: true, force: true });
  });

  it('stores encrypted values, returns decrypted values, and never lists values', () => {
    const created = createSecret(db, 'internal', 'SLACK_WEBHOOK', 'https://hooks.example/secret');

    expect(created.key).toBe('SLACK_WEBHOOK');
    expect(created.id).toMatch(/^sec_/);
    expect(getSecret(db, 'internal', 'SLACK_WEBHOOK')).toBe('https://hooks.example/secret');

    const raw = db.prepare('SELECT value_encrypted, iv, auth_tag FROM secrets WHERE workspace = ? AND key = ?')
      .get('internal', 'SLACK_WEBHOOK') as { value_encrypted: Buffer; iv: Buffer; auth_tag: Buffer };
    expect(raw.value_encrypted.equals(Buffer.from('https://hooks.example/secret'))).toBe(false);
    expect(raw.iv).toHaveLength(12);
    expect(raw.auth_tag).toHaveLength(16);

    const listed = listSecrets(db, 'internal');
    expect(listed).toEqual([{
      id: created.id,
      key: 'SLACK_WEBHOOK',
      created_at: created.created_at,
      updated_at: created.updated_at,
    }]);
    expect(listed[0]?.id.startsWith('sec_')).toBe(true);
    expect(JSON.stringify(listed)).not.toContain('hooks.example');
    expect(JSON.stringify(listed)).not.toContain('value');
  });

  it('upserts by workspace and key, then deletes secrets', () => {
    createSecret(db, 'internal', 'API_TOKEN', 'first');
    const updated = createSecret(db, 'internal', 'API_TOKEN', 'second');

    expect(listSecrets(db, 'internal')).toHaveLength(1);
    expect(getSecret(db, 'internal', 'API_TOKEN')).toBe('second');
    expect(updated.updated_at).toBeGreaterThanOrEqual(updated.created_at);

    expect(deleteSecret(db, 'internal', 'API_TOKEN')).toBe(true);
    expect(getSecret(db, 'internal', 'API_TOKEN')).toBeNull();
    expect(deleteSecret(db, 'internal', 'API_TOKEN')).toBe(false);
  });
});
