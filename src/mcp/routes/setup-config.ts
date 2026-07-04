// Sprint F (setup persistence): /api/setup/* routes.
//
// Backs the four new affordances on the dashboard Setup screen:
//   1. Providers tab        → /api/setup/providers (toggle on/off)
//   2. Models tab            → /api/setup/role-models (per-role model picks)
//   3. Fallback tab          → /api/setup/fallback (chain editor)
//   4. Limits tab            → /api/setup/limits (max_sequential_tasks etc.)
//
// M1 Wave 2 (2026-05-12, gap B4): adds per-workspace tool enable toggles:
//   5. Tools tab → POST /api/dashboard/setup/tools/:toolId/toggle (body
//      { workspace, enabled }) → row in workspace_tool_overrides (mig 047)
//      → consulted by `src/v2/tools/core/index.ts` at each exec entry.
//
// All endpoints are Bearer-authenticated (post-auth router chain) and persist
// to `data/setup-config.json` via src/utils/setup-config.ts (or SQLite for
// workspace_tool_overrides).

import type { ServerResponse } from 'node:http';

import { loadCatalog as loadOmnirouteCatalog } from '../../repl/services/modelCatalog.js';
import {
  loadSetupConfig,
  setFallbackConfig,
  setLimitsConfig,
  setProviderDisabled,
  setRoleModels,
  type FallbackConfig,
  type LimitsConfig,
  type RoleModels,
} from '../../utils/setup-config.js';
import { initDb } from '../../db/client.js';
import { getDbPath } from '../../utils/config.js';

import type { Router } from './types.js';
import { badRequest, jsonOk, readJsonBody } from './_shared.js';

// ── Provider listing (catalog × disabled flag) ────────────────────────────

interface ProviderListEntry {
  id: string;
  display_name: string;
  model_count: number;
  disabled: boolean;
}

async function buildProviderList(): Promise<ProviderListEntry[]> {
  const catalog = await loadOmnirouteCatalog({ force: false });
  const disabled = new Set(loadSetupConfig().disabled_providers);
  const counts = new Map<string, number>();
  for (const m of catalog.models) {
    counts.set(m.provider, (counts.get(m.provider) ?? 0) + 1);
  }
  // Use the catalog's `providers` array as the canonical source of display
  // names. Some providers might be in `providers` but absent from `models`
  // (rare); we still include them with model_count: 0 so the operator can
  // pre-emptively disable them.
  const result: ProviderListEntry[] = [];
  for (const p of catalog.providers) {
    result.push({
      id: p.id,
      display_name: p.displayName,
      model_count: counts.get(p.id) ?? 0,
      disabled: disabled.has(p.id),
    });
  }
  // Surface disabled-but-orphaned ids so the toggle remains visible even if
  // the underlying provider has dropped out of the catalog.
  for (const id of disabled) {
    if (!result.some((r) => r.id === id)) {
      result.push({ id, display_name: id, model_count: 0, disabled: true });
    }
  }
  return result.sort((a, b) => a.display_name.localeCompare(b.display_name));
}

async function handleProvidersList(res: ServerResponse): Promise<void> {
  try {
    jsonOk(res, { providers: await buildProviderList() });
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  }
}

async function handleProviderToggle(
  providerId: string,
  body: unknown,
  res: ServerResponse,
): Promise<void> {
  try {
    const input = (body as { disabled?: unknown }) ?? {};
    if (typeof input.disabled !== 'boolean') {
      badRequest(res, 'body.disabled must be boolean');
      return;
    }
    const updated = setProviderDisabled(providerId, input.disabled);
    jsonOk(res, {
      provider_id: providerId,
      disabled: input.disabled,
      disabled_providers: updated.disabled_providers,
    });
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  }
}

// ── Role-model picker ─────────────────────────────────────────────────────

function handleRoleModelsGet(res: ServerResponse): void {
  try {
    jsonOk(res, { role_models: loadSetupConfig().role_models });
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  }
}

function isStringOrEmpty(v: unknown): v is string {
  return typeof v === 'string';
}

function handleRoleModelsPost(body: unknown, res: ServerResponse): void {
  try {
    const input = (body as Partial<RoleModels>) ?? {};
    const accepted: RoleModels = {};
    for (const key of ['decomposer', 'task', 'reviewer', 'consolidator', 'summarizer'] as const) {
      const v = input[key];
      // Accept undefined (skip), '' (clear), or non-empty string (set).
      if (v === undefined) continue;
      if (!isStringOrEmpty(v)) {
        badRequest(res, `role_models.${key} must be string`);
        return;
      }
      accepted[key] = v;
    }
    const updated = setRoleModels(accepted);
    jsonOk(res, { role_models: updated.role_models });
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  }
}

// ── Fallback chain ────────────────────────────────────────────────────────

function handleFallbackGet(res: ServerResponse): void {
  try {
    jsonOk(res, { fallback: loadSetupConfig().fallback });
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  }
}

function handleFallbackPost(body: unknown, res: ServerResponse): void {
  try {
    const input = (body as Partial<FallbackConfig>) ?? {};
    if (typeof input.enabled !== 'boolean') {
      badRequest(res, 'body.enabled must be boolean');
      return;
    }
    if (!Array.isArray(input.chain)) {
      badRequest(res, 'body.chain must be array');
      return;
    }
    const cleanChain = [];
    for (const entry of input.chain) {
      if (
        !entry ||
        typeof entry !== 'object' ||
        typeof (entry as { provider: unknown }).provider !== 'string' ||
        typeof (entry as { model: unknown }).model !== 'string'
      ) {
        badRequest(res, 'chain entries must be {provider: string, model: string}');
        return;
      }
      cleanChain.push({
        provider: (entry as { provider: string }).provider,
        model: (entry as { model: string }).model,
      });
    }
    const updated = setFallbackConfig({ enabled: input.enabled, chain: cleanChain });
    jsonOk(res, { fallback: updated.fallback });
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  }
}

// ── Limits ────────────────────────────────────────────────────────────────

function handleLimitsGet(res: ServerResponse): void {
  try {
    jsonOk(res, { limits: loadSetupConfig().limits });
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  }
}

function handleLimitsPost(body: unknown, res: ServerResponse): void {
  try {
    const input = (body as Partial<LimitsConfig>) ?? {};
    const accepted: LimitsConfig = {};
    if (input.max_sequential_tasks !== undefined) {
      const n = Number(input.max_sequential_tasks);
      if (!Number.isFinite(n) || n < 1 || n > 100) {
        badRequest(res, 'max_sequential_tasks must be integer 1..100');
        return;
      }
      accepted.max_sequential_tasks = Math.floor(n);
    }
    const updated = setLimitsConfig(accepted);
    jsonOk(res, { limits: updated.limits });
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  }
}

// ── Aggregate config (handy for dashboard initial load) ───────────────────

function handleConfigGet(res: ServerResponse): void {
  try {
    jsonOk(res, { config: loadSetupConfig() });
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  }
}

// ── Tool overrides (M1 Wave 2, gap B4) ───────────────────────────────────
//
// Per-workspace tool enable toggles. Migration 047 owns the table; the
// executor's tool-call entry point in `src/v2/tools/core/index.ts` reads
// `workspace_tool_overrides` and throws `ToolDisabledError` when a row is
// `enabled = 0`.
//
// Tool ids accepted here are the registry names from
// `src/v2/tools/core/index.ts` (bash, file-write, file-read, http-request,
// current-time, calculator, knowledge-search). We don't validate against the
// live registry — the registry is mutable across deployments — but we cap
// the id length and reject obvious garbage so the table doesn't accumulate
// dead rows.

const TOOL_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const WORKSPACE_RE = /^[A-Za-z0-9_-]{1,64}$/;

function handleToolToggle(
  toolId: string,
  body: unknown,
  res: ServerResponse,
): void {
  if (!TOOL_ID_RE.test(toolId)) {
    badRequest(res, `tool_id must match ${TOOL_ID_RE.source}`);
    return;
  }
  const input = (body as { workspace?: unknown; enabled?: unknown }) ?? {};
  if (typeof input.workspace !== 'string' || !WORKSPACE_RE.test(input.workspace)) {
    badRequest(res, `body.workspace must match ${WORKSPACE_RE.source}`);
    return;
  }
  if (typeof input.enabled !== 'boolean') {
    badRequest(res, 'body.enabled must be boolean');
    return;
  }
  try {
    const db = initDb(getDbPath());
    try {
      db.prepare(
        `INSERT INTO workspace_tool_overrides (workspace, tool_id, enabled, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(workspace, tool_id) DO UPDATE SET
           enabled = excluded.enabled,
           updated_at = excluded.updated_at`,
      ).run(input.workspace, toolId, input.enabled ? 1 : 0, Date.now());
    } finally {
      db.close();
    }
    jsonOk(res, {
      tool_id: toolId,
      workspace: input.workspace,
      enabled: input.enabled,
    });
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  }
}

function handleToolListForWorkspace(workspace: string, res: ServerResponse): void {
  if (!WORKSPACE_RE.test(workspace)) {
    badRequest(res, `workspace must match ${WORKSPACE_RE.source}`);
    return;
  }
  try {
    const db = initDb(getDbPath());
    try {
      const rows = db
        .prepare(
          `SELECT tool_id, enabled, updated_at
             FROM workspace_tool_overrides
            WHERE workspace = ?
            ORDER BY tool_id`,
        )
        .all(workspace) as Array<{ tool_id: string; enabled: number; updated_at: number }>;
      jsonOk(res, {
        workspace,
        overrides: rows.map((r) => ({
          tool_id: r.tool_id,
          enabled: r.enabled === 1,
          updated_at: r.updated_at,
        })),
      });
    } finally {
      db.close();
    }
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  }
}

// ── Router ────────────────────────────────────────────────────────────────

export const setupConfigRouter: Router = async (req, url, res, _ctx) => {
  // GETs ----------------------------------------------------------------
  if (req.method === 'GET') {
    if (url.pathname === '/api/setup/config') { handleConfigGet(res); return true; }
    if (url.pathname === '/api/setup/providers') { await handleProvidersList(res); return true; }
    if (url.pathname === '/api/setup/role-models') { handleRoleModelsGet(res); return true; }
    if (url.pathname === '/api/setup/fallback') { handleFallbackGet(res); return true; }
    if (url.pathname === '/api/setup/limits') { handleLimitsGet(res); return true; }

    // M1 Wave 2 (B4): list per-workspace tool overrides for the Setup → Tools pane.
    if (url.pathname === '/api/dashboard/setup/tools') {
      const ws = url.searchParams.get('workspace') ?? 'internal';
      handleToolListForWorkspace(ws, res);
      return true;
    }
  }

  // POSTs ---------------------------------------------------------------
  if (req.method === 'POST') {
    const providerToggle = url.pathname.match(/^\/api\/setup\/providers\/([^/]+)\/toggle$/);
    if (providerToggle) {
      let body: unknown;
      try { body = await readJsonBody(req); } catch (err) { badRequest(res, (err as Error).message); return true; }
      await handleProviderToggle(decodeURIComponent(providerToggle[1] ?? ''), body, res);
      return true;
    }

    if (url.pathname === '/api/setup/role-models') {
      let body: unknown;
      try { body = await readJsonBody(req); } catch (err) { badRequest(res, (err as Error).message); return true; }
      handleRoleModelsPost(body, res);
      return true;
    }

    if (url.pathname === '/api/setup/fallback') {
      let body: unknown;
      try { body = await readJsonBody(req); } catch (err) { badRequest(res, (err as Error).message); return true; }
      handleFallbackPost(body, res);
      return true;
    }

    if (url.pathname === '/api/setup/limits') {
      let body: unknown;
      try { body = await readJsonBody(req); } catch (err) { badRequest(res, (err as Error).message); return true; }
      handleLimitsPost(body, res);
      return true;
    }

    // M1 Wave 2 (B4): per-workspace tool enable toggle.
    const toolToggle = url.pathname.match(
      /^\/api\/dashboard\/setup\/tools\/([^/]+)\/toggle$/,
    );
    if (toolToggle) {
      let body: unknown;
      try { body = await readJsonBody(req); } catch (err) { badRequest(res, (err as Error).message); return true; }
      handleToolToggle(decodeURIComponent(toolToggle[1] ?? ''), body, res);
      return true;
    }
  }

  return false;
};
