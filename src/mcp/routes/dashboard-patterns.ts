// Wave 2 M1-W2-E (gap-closure 2026-05-12): patterns HTTP REST API.
//
// Mirrors the four `omniforge_*_pattern*` MCP tools so the dashboard SPA
// can hit the daemon directly instead of re-implementing pattern lookup
// against the same SQLite store. Each handler delegates straight into
// the existing `src/patterns/store.ts` + `src/db/persist.ts` primitives,
// keeping the surface area perfectly aligned with the MCP tools.
//
// All routes are Bearer-auth gated by http-server.ts upstream.
//
// Routes:
//   GET    /api/dashboard/patterns?workspace=X&limit=N   → list (mirrors omniforge_list_patterns)
//   POST   /api/dashboard/patterns                       → create from completed workflow (mirrors omniforge_save_pattern)
//   GET    /api/dashboard/patterns/:id/export            → export with parsed DAG (mirrors omniforge_export_pattern)
//   POST   /api/dashboard/patterns/import                → import DAG into pattern (mirrors omniforge_import_pattern)
//   DELETE /api/dashboard/dags/:id                       → delete pattern (Wave 2 Agent M1-W2-C, B5)
//
// Wire-format parity with the MCP tools is deliberate: the MCP tools
// return JSON strings; the HTTP wrappers return the same shape as
// `application/json` bodies so the dashboard does not need a second
// adapter layer.

import type { ServerResponse, IncomingMessage } from 'node:http';
import { z } from 'zod';
import { initDb } from '../../db/client.js';
import { getDbPath } from '../../utils/config.js';
import {
  deletePatternById,
  insertPattern,
  listPatternsByWorkspace,
  loadPatternById,
} from '../../db/persist.js';
import { loadPattern, saveWorkflowAsPattern } from '../../patterns/store.js';
import { DagSchema } from '../../types/schemas.js';
import type { Pattern } from '../../types/index.js';
import { VALID_WORKSPACE_RE } from '../../utils/workspace.js';
import type { Router } from './types.js';
import { badRequest, jsonOk, notFound, readJsonBody } from './_shared.js';

const ListQuerySchema = z.object({
  workspace: z.string().regex(VALID_WORKSPACE_RE, 'Invalid workspace name (alphanumeric/underscore/hyphen only)'),
  limit: z.number().int().min(1).max(50),
});

const SaveBodySchema = z.object({
  workflow_id: z.string().min(1),
  name: z.string().min(1),
});

const ImportBodySchema = z.object({
  workspace: z.string().regex(VALID_WORKSPACE_RE, 'Invalid workspace name (alphanumeric/underscore/hyphen only)'),
  name: z.string().min(1),
  dag: z.unknown(),
  objective_sample: z.string().optional(),
});

const ID_PATH_RE = /^\/api\/dashboard\/patterns\/([^/]+)\/export$/;

function parseLimit(raw: string | null): number {
  if (!raw) return 20;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 20;
  return Math.min(Math.max(parsed, 1), 50);
}

function handleList(url: URL, res: ServerResponse): void {
  const workspace = url.searchParams.get('workspace') ?? '';
  const limit = parseLimit(url.searchParams.get('limit'));
  const parsed = ListQuerySchema.safeParse({ workspace, limit });
  if (!parsed.success) {
    badRequest(res, parsed.error.issues[0]?.message ?? 'invalid query');
    return;
  }
  const db = initDb(getDbPath());
  try {
    const items = listPatternsByWorkspace(db, parsed.data.workspace).slice(0, parsed.data.limit);
    jsonOk(res, {
      patterns: items.map((p) => ({
        id: p.id,
        name: p.name,
        workspace: p.workspace,
        objective_sample: p.objective_sample,
        usage_count: p.usage_count,
        success_count: p.success_count,
        last_used_at: p.last_used_at,
      })),
    });
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  } finally {
    db.close();
  }
}

async function handleSave(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
    return;
  }
  const parsed = SaveBodySchema.safeParse(body);
  if (!parsed.success) {
    badRequest(res, parsed.error.issues[0]?.message ?? 'invalid body');
    return;
  }
  const db = initDb(getDbPath());
  try {
    const pattern = saveWorkflowAsPattern(db, parsed.data.workflow_id, parsed.data.name);
    jsonOk(
      res,
      { pattern_id: pattern.id, name: pattern.name, workspace: pattern.workspace },
      201,
    );
  } catch (err) {
    // saveWorkflowAsPattern throws when workflow is missing OR not completed.
    // Surface both as 400 (operator-correctable) rather than 500.
    badRequest(res, err instanceof Error ? err.message : String(err));
  } finally {
    db.close();
  }
}

function handleExport(url: URL, res: ServerResponse): void {
  const match = url.pathname.match(ID_PATH_RE);
  const id = match ? decodeURIComponent(match[1] ?? '') : '';
  if (!id) {
    notFound(res, 'pattern id missing');
    return;
  }
  const db = initDb(getDbPath());
  try {
    const pattern = loadPattern(db, id);
    if (!pattern) {
      notFound(res, `Pattern not found: ${id}`);
      return;
    }
    // dag_json is written by saveWorkflowAsPattern and importPattern. Both
    // paths re-stringify a DAG that previously round-tripped through Zod,
    // so the parse here is safe — but we still guard against a malformed
    // row to avoid returning a 500 on stale dev data.
    let dag: unknown;
    try {
      dag = JSON.parse(pattern.dag_json);
    } catch (err) {
      badRequest(res, `pattern dag_json malformed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    jsonOk(res, {
      pattern_id: pattern.id,
      name: pattern.name,
      workspace: pattern.workspace,
      objective_sample: pattern.objective_sample,
      dag,
    });
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  } finally {
    db.close();
  }
}

async function handleImport(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
    return;
  }
  const parsed = ImportBodySchema.safeParse(body);
  if (!parsed.success) {
    badRequest(res, parsed.error.issues[0]?.message ?? 'invalid body');
    return;
  }
  const dagValidated = DagSchema.safeParse(parsed.data.dag);
  if (!dagValidated.success) {
    badRequest(res, `Invalid DAG: ${JSON.stringify(dagValidated.error.issues).slice(0, 300)}`);
    return;
  }
  const db = initDb(getDbPath());
  try {
    const pattern: Pattern = {
      id: `pt_${crypto.randomUUID()}`,
      workspace: parsed.data.workspace,
      name: parsed.data.name,
      source: 'imported',
      objective_sample: parsed.data.objective_sample ?? '',
      dag_json: JSON.stringify(dagValidated.data),
      usage_count: 0,
      success_count: 0,
      avg_duration_ms: null,
      last_used_at: null,
      created_at: Date.now(),
    };
    insertPattern(db, pattern);
    jsonOk(
      res,
      { pattern_id: pattern.id, name: pattern.name, workspace: pattern.workspace },
      201,
    );
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  } finally {
    db.close();
  }
}

// Wave 2 Agent M1-W2-C (B5): wire the trash button on PatternDetail.tsx.
// The dashboard library is exposed at GET /api/dashboard/dags (rows are
// `patterns` table reshaped as DAG items), and the SPA referred to those
// rows as "dags" since the merge — so DELETE keeps that path shape rather
// than re-creating a /patterns/:id route. Cascade is handled by FK ON
// DELETE CASCADE on `pattern_usage.pattern_id` (migration 038, FK backfill).
async function handleDashboardDagDelete(
  patternId: string,
  res: ServerResponse,
): Promise<void> {
  if (!patternId || patternId.trim() === '') {
    badRequest(res, 'pattern id is required');
    return;
  }
  const db = initDb(getDbPath());
  try {
    const pattern = loadPatternById(db, patternId);
    if (!pattern) {
      notFound(res, `Pattern not found: ${patternId}`);
      return;
    }
    const deleted = deletePatternById(db, patternId);
    if (!deleted) {
      // Race with another concurrent delete — loadPatternById said "exists"
      // but deletePatternById returned 0 changes. Surface as 404 so the UI
      // converges instead of looping a stale optimistic update.
      notFound(res, `Pattern not found: ${patternId}`);
      return;
    }
    // Audit trail — events.workflow_id is FK-bound to workflows(id) so we
    // can't fabricate a "pattern_lifecycle" workflow row just for audit.
    // Emit a structured stderr line (operators tail daemon.log) and trust
    // the client-side response for state convergence.
    process.stderr.write(
      `[daemon] pattern_deleted id=${pattern.id} name=${JSON.stringify(pattern.name)} ` +
      `workspace=${pattern.workspace} source=${pattern.source} usage_count=${pattern.usage_count}\n`,
    );
    jsonOk(res, {
      ok: true,
      deleted_id: pattern.id,
      name: pattern.name,
      workspace: pattern.workspace,
    });
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  } finally {
    db.close();
  }
}

export const dashboardPatternsRouter: Router = async (req, url, res) => {
  // GET /api/dashboard/patterns?workspace=X
  if (req.method === 'GET' && url.pathname === '/api/dashboard/patterns') {
    handleList(url, res);
    return true;
  }
  // POST /api/dashboard/patterns (save from workflow)
  if (req.method === 'POST' && url.pathname === '/api/dashboard/patterns') {
    await handleSave(req, res);
    return true;
  }
  // POST /api/dashboard/patterns/import (import DAG)
  // Must come BEFORE the generic /:id/export matcher so 'import' is not
  // misread as a pattern id.
  if (req.method === 'POST' && url.pathname === '/api/dashboard/patterns/import') {
    await handleImport(req, res);
    return true;
  }
  // GET /api/dashboard/patterns/:id/export
  if (req.method === 'GET' && ID_PATH_RE.test(url.pathname)) {
    handleExport(url, res);
    return true;
  }
  // DELETE /api/dashboard/dags/:id — Wave 2 M1-W2-C (B5).
  const dagDeleteMatch = url.pathname.match(/^\/api\/dashboard\/dags\/([^/]+)$/);
  if (req.method === 'DELETE' && dagDeleteMatch) {
    await handleDashboardDagDelete(decodeURIComponent(dagDeleteMatch[1] ?? ''), res);
    return true;
  }
  return false;
};
