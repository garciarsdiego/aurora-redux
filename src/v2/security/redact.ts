import type Database from 'better-sqlite3';
import { listSecrets, getSecret } from './secrets-vault.js';

/**
 * Replace known secret values in `text` with `***REDACTED***`.
 * Secrets are looked up for the given `workspace`.  If `db` is omitted a
 * short-lived connection is opened and closed automatically.
 */
export function redactSecrets(
  text: string,
  workspace: string,
  db?: Database.Database,
): string {
  if (!text || !workspace) return text;

  const ownDb = db === undefined;
  const conn = ownDb
    ? (() => {
        const { initDb } = require('../../db/client.js') as typeof import('../../db/client.js');
        const { getDbPath } = require('../../utils/config.js') as typeof import('../../utils/config.js');
        return initDb(getDbPath());
      })()
    : db!;

  try {
    const secrets = listSecrets(conn, workspace);
    let redacted = text;
    for (const secret of secrets) {
      const value = getSecret(conn, workspace, secret.key);
      if (value && redacted.includes(value)) {
        redacted = redacted.split(value).join('***REDACTED***');
      }
    }
    return redacted;
  } finally {
    if (ownDb) conn.close();
  }
}
