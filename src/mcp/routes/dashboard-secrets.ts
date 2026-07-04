// Sprint Onda-1-E (Cluster E): secrets vault REST API.
//
// Routes (all Bearer-auth, managed by http-server.ts gate):
//   GET    /api/dashboard/secrets?workspace=X  → list without values
//   POST   /api/dashboard/secrets              → create / upsert
//   DELETE /api/dashboard/secrets/:id          → delete by id

import type { ServerResponse, IncomingMessage } from 'node:http';
import { initDb } from '../../db/client.js';
import { getDbPath } from '../../utils/config.js';
import {
  createSecret,
  deleteSecretById,
  listSecrets,
  resolveSecrets as vaultResolveSecrets,
} from '../../v2/security/secrets-vault.js';
import type { Router } from './types.js';
import { badRequest, jsonOk, notFound, readJsonBody } from './_shared.js';

const VALID_KEY_RE = /^[A-Z0-9_]+$/;

function handleList(url: URL, res: ServerResponse): void {
  const workspace = url.searchParams.get('workspace') ?? '';
  if (!workspace) {
    badRequest(res, 'workspace query param is required');
    return;
  }
  const db = initDb(getDbPath());
  try {
    jsonOk(res, { secrets: listSecrets(db, workspace) });
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  } finally {
    db.close();
  }
}

async function handleCreate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    badRequest(res, (err as Error).message);
    return;
  }
  const input = body as {
    workspace?: string;
    key?: string;
    value?: string;
  };
  if (!input.workspace || !input.key || !input.value) {
    badRequest(res, 'workspace, key and value are required');
    return;
  }
  if (!VALID_KEY_RE.test(input.key)) {
    badRequest(res, 'key must match [A-Z0-9_]+');
    return;
  }
  const db = initDb(getDbPath());
  try {
    const item = createSecret(db, input.workspace, input.key, input.value);
    jsonOk(res, item, 201);
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  } finally {
    db.close();
  }
}

function handleDelete(url: URL, res: ServerResponse): void {
  const match = url.pathname.match(/^\/api\/dashboard\/secrets\/([^/]+)$/);
  const id = match ? decodeURIComponent(match[1] ?? '') : '';
  if (!id) {
    notFound(res);
    return;
  }
  const db = initDb(getDbPath());
  try {
    const ok = deleteSecretById(db, id);
    if (!ok) {
      notFound(res, 'secret not found');
      return;
    }
    jsonOk(res, { deleted: true });
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  } finally {
    db.close();
  }
}

export const dashboardSecretsRouter: Router = async (req, url, res) => {
  if (req.method === 'GET' && url.pathname === '/api/dashboard/secrets') {
    handleList(url, res);
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/dashboard/secrets') {
    await handleCreate(req, res);
    return true;
  }
  if (req.method === 'DELETE' && url.pathname.startsWith('/api/dashboard/secrets/')) {
    handleDelete(url, res);
    return true;
  }
  return false;
};

/** Re-export for callers that already have a DB connection (executor hot path). */
export { vaultResolveSecrets as resolveSecrets };
