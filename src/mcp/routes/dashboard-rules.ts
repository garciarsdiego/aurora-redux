// Handler for governance / action-gate rules CRUD.
//
// Manages rows in the `agent_action_policies` table (migration 041), which
// controls per-agent dispositions for 5 action categories. The __default__
// agent row acts as the global baseline — per-agent rows override it.
//
// All routes are Bearer-auth gated by http-server.ts upstream.
//
// Response shapes are UNWRAPPED to match the dashboard's request<T> helper
// (which does no envelope unwrapping):
//   - list   → BARE ARRAY of PolicyRow
//   - create → BARE PolicyRow (201)
//   - patch  → BARE PolicyRow
//   - delete → { ok, deleted_id } (FE ignores the body)
//
// Routes:
//   GET    /api/dashboard/rules          — list rules (?limit=50&offset=0 supported)
//   POST   /api/dashboard/rules          — upsert a rule row
//   PATCH  /api/dashboard/rules/:id      — update disposition for existing rule
//   DELETE /api/dashboard/rules/:id      — delete rule (blocks __default__ deletion)

import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { initDb } from '../../db/client.js';
import { getDbPath } from '../../utils/config.js';
import { withSqliteRetrySync } from '../../db/sqlite-retry.js';
import type { Router } from './types.js';
import { badRequest, jsonOk, notFound, readJsonBody } from './_shared.js';

// ── Path pattern ─────────────────────────────────────────────────────────────

const RULE_ID_RE = /^\/api\/dashboard\/rules\/(\d+)$/;

// ── Constants ─────────────────────────────────────────────────────────────────

const CATEGORIES = ['git_write', 'file_write_delete', 'command_execution', 'network_api', 'task_agent_mutation'] as const;
const DISPOSITIONS = ['allow', 'block', 'require-approval'] as const;
const PAGINATION_LIMIT_MAX = 200;
const PAGINATION_LIMIT_DEFAULT = 50;

// ── Zod schemas ───────────────────────────────────────────────────────────────

const CreateBodySchema = z.object({
  agent_id: z.string().min(1).max(128),
  category: z.enum(CATEGORIES),
  disposition: z.enum(DISPOSITIONS).default('allow'),
});

const PatchBodySchema = z.object({
  disposition: z.enum(DISPOSITIONS),
});

const PaginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(PAGINATION_LIMIT_MAX).default(PAGINATION_LIMIT_DEFAULT),
  offset: z.coerce.number().int().min(0).default(0),
});

// ── Row shape returned to callers ─────────────────────────────────────────────

interface PolicyRow {
  id: number;
  agent_id: string;
  category: string;
  disposition: string;
  created_at: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Emit a 400 with the full Zod issues array under `details`. */
function zodBadRequest(res: ServerResponse, err: z.ZodError): void {
  badRequest(res, err.issues[0]?.message ?? 'invalid body', { details: err.issues });
}

/** Parse and validate the :id segment; returns null and emits 400 if invalid. */
function parseRuleId(raw: string | undefined, res: ServerResponse): number | null {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n) || n < 1) {
    badRequest(res, 'rule id must be a positive integer');
    return null;
  }
  return n;
}

// ── Handlers ──────────────────────────────────────────────────────────────────

function handleList(url: URL, res: ServerResponse): void {
  const paginationResult = PaginationSchema.safeParse({
    limit: url.searchParams.get('limit') ?? undefined,
    offset: url.searchParams.get('offset') ?? undefined,
  });
  if (!paginationResult.success) {
    zodBadRequest(res, paginationResult.error);
    return;
  }
  const { limit, offset } = paginationResult.data;

  const db = initDb(getDbPath());
  try {
    const rows = db
      .prepare(
        `SELECT id, agent_id, category, disposition, created_at
           FROM agent_action_policies
          ORDER BY agent_id ASC, category ASC
          LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as PolicyRow[];

    // BARE ARRAY (no envelope) — the FE request<T> helper does NOT unwrap, and
    // the dashboard GovernanceRule consumer expects a plain array of rows.
    // The previous { rules, total, limit, offset } envelope was dropped; the FE
    // never read total/limit/offset.
    jsonOk(res, rows);
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  } finally {
    db.close();
  }
}

async function handleCreate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let rawBody: unknown;
  try {
    rawBody = await readJsonBody(req);
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
    return;
  }

  const parsed = CreateBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    zodBadRequest(res, parsed.error);
    return;
  }

  const { agent_id, category, disposition } = parsed.data;
  const db = initDb(getDbPath());
  try {
    withSqliteRetrySync(() =>
      db
        .prepare(
          `INSERT INTO agent_action_policies (agent_id, category, disposition, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(agent_id, category) DO UPDATE SET disposition = excluded.disposition`,
        )
        .run(agent_id, category, disposition, Date.now()),
    );

    const row = db
      .prepare(
        `SELECT id, agent_id, category, disposition, created_at
           FROM agent_action_policies
          WHERE agent_id = ? AND category = ?`,
      )
      .get(agent_id, category) as PolicyRow | undefined;

    if (!row) {
      // The upsert above should always leave a row; a missing one is a server
      // fault, not a client error in the request shape.
      badRequest(res, 'rule upsert did not return a row');
      return;
    }

    // BARE row object (no envelope) at 201 — FE createRule pushes the returned
    // row straight into state, so the envelope was unwrapped.
    jsonOk(res, row, 201);
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  } finally {
    db.close();
  }
}

async function handlePatch(
  ruleId: number,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let rawBody: unknown;
  try {
    rawBody = await readJsonBody(req);
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
    return;
  }

  const parsed = PatchBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    zodBadRequest(res, parsed.error);
    return;
  }

  const db = initDb(getDbPath());
  try {
    const existing = db
      .prepare(`SELECT id, agent_id, category, disposition, created_at FROM agent_action_policies WHERE id = ?`)
      .get(ruleId) as PolicyRow | undefined;

    if (!existing) {
      notFound(res, `Rule not found: ${ruleId}`);
      return;
    }

    withSqliteRetrySync(() =>
      db
        .prepare(`UPDATE agent_action_policies SET disposition = ? WHERE id = ?`)
        .run(parsed.data.disposition, ruleId),
    );

    // BARE row object (no envelope) — FE updateRule expects the updated row.
    jsonOk(res, { ...existing, disposition: parsed.data.disposition });
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  } finally {
    db.close();
  }
}

function handleDelete(ruleId: number, res: ServerResponse): void {
  const db = initDb(getDbPath());
  try {
    const existing = db
      .prepare(`SELECT id, agent_id, category, disposition, created_at FROM agent_action_policies WHERE id = ?`)
      .get(ruleId) as PolicyRow | undefined;

    if (!existing) {
      notFound(res, `Rule not found: ${ruleId}`);
      return;
    }

    if (existing.agent_id === '__default__') {
      badRequest(res, 'Cannot delete __default__ agent rules — update disposition instead');
      return;
    }

    withSqliteRetrySync(() =>
      db.prepare(`DELETE FROM agent_action_policies WHERE id = ?`).run(ruleId),
    );

    jsonOk(res, { ok: true, deleted_id: ruleId });
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  } finally {
    db.close();
  }
}

// ── Router export ─────────────────────────────────────────────────────────────

export const dashboardRulesRouter: Router = async (req, url, res) => {
  // GET /api/dashboard/rules[?limit=&offset=]
  if (req.method === 'GET' && url.pathname === '/api/dashboard/rules') {
    handleList(url, res);
    return true;
  }

  // POST /api/dashboard/rules
  if (req.method === 'POST' && url.pathname === '/api/dashboard/rules') {
    await handleCreate(req, res);
    return true;
  }

  // PATCH /api/dashboard/rules/:id  or  DELETE /api/dashboard/rules/:id
  const idMatch = url.pathname.match(RULE_ID_RE);
  if (idMatch) {
    const ruleId = parseRuleId(idMatch[1], res);
    if (ruleId === null) return true;   // parseRuleId already sent 400

    if (req.method === 'PATCH') {
      await handlePatch(ruleId, req, res);
      return true;
    }

    if (req.method === 'DELETE') {
      handleDelete(ruleId, res);
      return true;
    }
  }

  return false;
};
