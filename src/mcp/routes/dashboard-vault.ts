// Sprint post-audit B7.5 (2026-05-05): vault REST API for dashboard.
//
// The MCP-side `omniforge_vault_*` tools (src/mcp/tools/vault.ts) cover
// programmatic access for workers; this surface gives the operator a
// browser-side editor. All routes are Bearer-auth gated upstream by
// http-server.ts.
//
// Routes:
//   GET    /api/dashboard/vault?workspace=X[&glob=*.md]  → list entries
//   GET    /api/dashboard/vault/:workspace/:vaultPath    → read content
//   PUT    /api/dashboard/vault/:workspace/:vaultPath    → write/overwrite
//   DELETE /api/dashboard/vault/:workspace/:vaultPath    → delete
//
// `:vaultPath` is URL-encoded and may contain forward slashes (e.g.
// `notes%2Frfc.md` → `notes/rfc.md`). Path traversal is rejected by
// Vault.write/read/delete itself.

import type { ServerResponse, IncomingMessage } from 'node:http';
import path from 'node:path';
import { Vault } from '../../v2/vault/store.js';
import type { Router } from './types.js';
import { badRequest, jsonOk, notFound, readJsonBody } from './_shared.js';

const VAULT_ROOT = path.resolve('data', 'vault');
let vaultInstance: Vault | null = null;
function getVault(): Vault {
  vaultInstance ??= new Vault(VAULT_ROOT);
  return vaultInstance;
}

function parseVaultPathFromUrl(pathname: string): { workspace: string; vaultPath: string } | null {
  // /api/dashboard/vault/<workspace>/<vaultPath...>
  const match = pathname.match(/^\/api\/dashboard\/vault\/([^/]+)\/(.+)$/);
  if (!match) return null;
  const workspace = decodeURIComponent(match[1] ?? '');
  const vaultPath = decodeURIComponent(match[2] ?? '');
  if (!workspace || !vaultPath) return null;
  return { workspace, vaultPath };
}

async function handleList(url: URL, res: ServerResponse): Promise<void> {
  const workspace = url.searchParams.get('workspace') ?? '';
  if (!workspace) {
    badRequest(res, 'workspace query param is required');
    return;
  }
  const glob = url.searchParams.get('glob') ?? undefined;
  try {
    const entries = await getVault().list(workspace, glob);
    jsonOk(res, { workspace, entries });
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  }
}

async function handleRead(parsed: { workspace: string; vaultPath: string }, res: ServerResponse): Promise<void> {
  try {
    const content = await getVault().read(parsed.workspace, parsed.vaultPath);
    jsonOk(res, { workspace: parsed.workspace, path: parsed.vaultPath, content });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/not found|ENOENT/i.test(msg)) {
      notFound(res, `Vault entry not found: ${parsed.vaultPath}`);
      return;
    }
    badRequest(res, msg);
  }
}

async function handleWrite(
  req: IncomingMessage,
  parsed: { workspace: string; vaultPath: string },
  res: ServerResponse,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    badRequest(res, (err as Error).message);
    return;
  }
  const input = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const content = typeof input['content'] === 'string' ? input['content'] : null;
  if (content === null) {
    badRequest(res, 'body must include `content` (string)');
    return;
  }
  try {
    const entry = await getVault().write(parsed.workspace, parsed.vaultPath, content);
    jsonOk(res, { workspace: parsed.workspace, path: parsed.vaultPath, entry }, 200);
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  }
}

async function handleDelete(parsed: { workspace: string; vaultPath: string }, res: ServerResponse): Promise<void> {
  try {
    await getVault().delete(parsed.workspace, parsed.vaultPath);
    jsonOk(res, { deleted: true, workspace: parsed.workspace, path: parsed.vaultPath });
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  }
}

export const dashboardVaultRouter: Router = async (req, url, res) => {
  if (req.method === 'GET' && url.pathname === '/api/dashboard/vault') {
    await handleList(url, res);
    return true;
  }

  const parsed = parseVaultPathFromUrl(url.pathname);
  if (!parsed) return false;

  if (req.method === 'GET') {
    await handleRead(parsed, res);
    return true;
  }
  if (req.method === 'PUT') {
    await handleWrite(req, parsed, res);
    return true;
  }
  if (req.method === 'DELETE') {
    await handleDelete(parsed, res);
    return true;
  }
  return false;
};
