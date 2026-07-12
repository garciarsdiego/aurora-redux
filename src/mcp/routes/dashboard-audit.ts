// Sprint F4-6 (D-H2.066): unified audit timeline endpoint.
//
// GET /api/dashboard/audit aggregates rows from the four audit-relevant
// tables behind a single human-readable timeline:
//   - permission_decisions   (kind = 'permission')
//   - quality_reviews        (kind = 'quality')
//   - workflow_control_state (kind = 'workflow_control')
//   - versioned_definitions  (kind = 'governance')
//
// Each per-table SELECT is normalised (column aliases) so the results can be
// UNION ALL-ed without per-row branching in TypeScript. After union the rows
// are filtered (workspace/actor/kind/limit/since), parsed into the
// AuditEntry shape, and `details` is run through redactContextJson before
// being returned to the client.
//
// Auth + error handling mirror dashboard-data.ts: Bearer is enforced by the
// http-server router chain (this file is reached only after auth passes),
// and any thrown error converts to badRequest(400).

import type { ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';

import { redactContextJson } from '../../context/redaction.js';
import type { Router } from './types.js';
import { jsonOk, withDb } from './_shared.js';

// ── Public types ──────────────────────────────────────────────────────────

export type AuditKind = 'permission' | 'quality' | 'workflow_control' | 'governance';

export interface AuditEntry {
  id: string;
  ts: number;
  kind: AuditKind;
  actor: string | null;
  workflow_id: string | null;
  workspace: string | null;
  summary: string;
  details: Record<string, unknown>;
  outcome?: string;
}

interface AuditQueryParams {
  workspace?: string;
  actor?: string;
  kinds?: AuditKind[];
  limit: number;
  since?: number;
}

// ── Internal raw-row shape (one column set for all four sub-queries) ──────

interface RawAuditRow {
  id: string;
  ts: number;
  kind: AuditKind;
  actor: string | null;
  workflow_id: string | null;
  workspace: string | null;
  summary: string;
  details_json: string;
  outcome: string | null;
}

// ── Param parsing ─────────────────────────────────────────────────────────

const VALID_KINDS = new Set<AuditKind>(['permission', 'quality', 'workflow_control', 'governance']);

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function parseLimit(raw: string | null): number {
  if (!raw) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

function parseSince(raw: string | null): number | undefined {
  if (!raw) return undefined;
  // Accept either ISO-8601 timestamps or unix-ms integers; reject anything
  // that doesn't parse to a finite number to avoid silently widening the
  // window when callers send a typo.
  const numericTry = Number.parseInt(raw, 10);
  if (Number.isFinite(numericTry) && String(numericTry) === raw.trim()) {
    return numericTry;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseKinds(raw: string | null): AuditKind[] | undefined {
  if (!raw) return undefined;
  const list = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part): part is AuditKind => VALID_KINDS.has(part as AuditKind));
  return list.length > 0 ? list : undefined;
}

function parseQuery(url: URL): AuditQueryParams {
  const workspace = url.searchParams.get('workspace')?.trim() || undefined;
  const actor = url.searchParams.get('actor')?.trim() || undefined;
  const kinds = parseKinds(url.searchParams.get('kind'));
  const limit = parseLimit(url.searchParams.get('limit'));
  const since = parseSince(url.searchParams.get('since'));
  return {
    ...(workspace ? { workspace } : {}),
    ...(actor ? { actor } : {}),
    ...(kinds ? { kinds } : {}),
    limit,
    ...(since !== undefined ? { since } : {}),
  };
}

// ── Per-source SELECT builders ────────────────────────────────────────────
//
// Each builder returns the SQL fragment + bound params; the union step
// stitches them together. All fragments emit the same column set so the
// result is parseable as RawAuditRow.
//
// Column alias contract (in order):
//   id, ts, kind, actor, workflow_id, workspace, summary, details_json, outcome

function permissionSelect(): { sql: string } {
  return {
    sql: `SELECT
        pd.ask_id                                              AS id,
        COALESCE(pd.decided_at, pd.asked_at)                   AS ts,
        'permission'                                           AS kind,
        pd.decided_by                                          AS actor,
        pd.workflow_id                                         AS workflow_id,
        wf.workspace                                           AS workspace,
        ('Tool ' || pd.tool || ' '
          || COALESCE(pd.decision, 'pending')
          || ' for agent ' || pd.agent_id)                     AS summary,
        json_object(
          'ask_id',     pd.ask_id,
          'agent_id',   pd.agent_id,
          'tool',       pd.tool,
          'task_id',    pd.task_id,
          'asked_at',   pd.asked_at,
          'decided_at', pd.decided_at
        )                                                      AS details_json,
        pd.decision                                            AS outcome
      FROM permission_decisions pd
      LEFT JOIN workflows wf ON wf.id = pd.workflow_id`,
  };
}

function qualitySelect(): { sql: string } {
  return {
    sql: `SELECT
        qr.id                                                  AS id,
        qr.created_at                                          AS ts,
        'quality'                                              AS kind,
        qr.reviewer_model                                      AS actor,
        qr.workflow_id                                         AS workflow_id,
        wf.workspace                                           AS workspace,
        ('Quality review (' || qr.scope || ', '
          || qr.reviewer_kind || ') -> ' || qr.outcome)        AS summary,
        json_object(
          'review_id',         qr.id,
          'scope',             qr.scope,
          'reviewer_kind',     qr.reviewer_kind,
          'reviewer_model',    qr.reviewer_model,
          'task_id',           qr.task_id,
          'score',             qr.score,
          'approval_status',   qr.approval_status,
          'audit_status',      qr.audit_status,
          'run_mode',          qr.run_mode,
          'issues_json',       qr.issues_json,
          'evidence_json',     qr.evidence_json,
          'fix_tasks_json',    qr.fix_tasks_json
        )                                                      AS details_json,
        qr.outcome                                             AS outcome
      FROM quality_reviews qr
      LEFT JOIN workflows wf ON wf.id = qr.workflow_id`,
  };
}

function workflowControlSelect(): { sql: string } {
  return {
    sql: `SELECT
        ('wfctl_' || wcs.workflow_id)                          AS id,
        wcs.updated_at                                         AS ts,
        'workflow_control'                                     AS kind,
        wcs.requested_by                                       AS actor,
        wcs.workflow_id                                        AS workflow_id,
        wf.workspace                                           AS workspace,
        ('Workflow ' || wcs.workflow_id || ' -> ' || wcs.state) AS summary,
        json_object(
          'workflow_id', wcs.workflow_id,
          'state',       wcs.state,
          'reason',      wcs.reason,
          'created_at',  wcs.created_at,
          'updated_at',  wcs.updated_at
        )                                                      AS details_json,
        wcs.state                                              AS outcome
      FROM workflow_control_state wcs
      LEFT JOIN workflows wf ON wf.id = wcs.workflow_id`,
  };
}

function governanceSelect(): { sql: string } {
  return {
    sql: `SELECT
        vd.id                                                  AS id,
        vd.created_at                                          AS ts,
        'governance'                                           AS kind,
        vd.created_by                                          AS actor,
        NULL                                                   AS workflow_id,
        vd.workspace                                           AS workspace,
        (vd.kind || ' ' || vd.name || ' v' || vd.version
          || ' (' || vd.status || ')')                         AS summary,
        json_object(
          'definition_id', vd.id,
          'kind',          vd.kind,
          'name',          vd.name,
          'version',       vd.version,
          'status',        vd.status,
          'checksum',      vd.checksum_sha256,
          'supersedes_id', vd.supersedes_id,
          'notes',         vd.notes
        )                                                      AS details_json,
        vd.status                                              AS outcome
      FROM versioned_definitions vd`,
  };
}

// ── Aggregation ──────────────────────────────────────────────────────────

function buildUnionSql(kinds: AuditKind[] | undefined): string {
  // Filter source SELECTs by the requested kinds (defaults to all four).
  // We keep the SELECT shape stable so the outer ORDER BY / LIMIT works no
  // matter which subset is unioned.
  const wanted = kinds ?? Array.from(VALID_KINDS);
  const parts: string[] = [];
  for (const kind of wanted) {
    if (kind === 'permission') parts.push(permissionSelect().sql);
    else if (kind === 'quality') parts.push(qualitySelect().sql);
    else if (kind === 'workflow_control') parts.push(workflowControlSelect().sql);
    else if (kind === 'governance') parts.push(governanceSelect().sql);
  }
  if (parts.length === 0) return '';
  return parts.join('\n      UNION ALL\n      ');
}

function applyFilters(
  unionSql: string,
  params: AuditQueryParams,
): { sql: string; binds: Array<string | number> } {
  // Wrap the union as a sub-query so WHERE / ORDER BY / LIMIT only see the
  // normalised column shape (no need to know which source produced a row).
  const where: string[] = [];
  const binds: Array<string | number> = [];
  if (params.workspace) {
    where.push('workspace = ?');
    binds.push(params.workspace);
  }
  if (params.actor) {
    where.push('actor = ?');
    binds.push(params.actor);
  }
  if (params.since !== undefined) {
    where.push('ts >= ?');
    binds.push(params.since);
  }
  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const sql = `
    SELECT id, ts, kind, actor, workflow_id, workspace, summary, details_json, outcome
      FROM (
        ${unionSql}
      ) AS audit_union
      ${whereClause}
      ORDER BY ts DESC
      LIMIT ?`;
  binds.push(params.limit);
  return { sql, binds };
}

function rowToEntry(row: RawAuditRow): AuditEntry {
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(row.details_json) as unknown;
  } catch {
    // SQLite json_object always emits valid JSON, but defend the boundary
    // anyway — we'd rather return an empty details object than crash the
    // whole timeline because of one malformed row.
    parsed = {};
  }
  const safeDetails = redactContextJson(
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {},
  );
  const entry: AuditEntry = {
    id: row.id,
    ts: row.ts,
    kind: row.kind,
    actor: row.actor,
    workflow_id: row.workflow_id,
    workspace: row.workspace,
    summary: row.summary,
    details: safeDetails,
  };
  if (row.outcome != null) entry.outcome = row.outcome;
  return entry;
}

export function listAuditEntries(
  db: Database.Database,
  params: AuditQueryParams,
): AuditEntry[] {
  const unionSql = buildUnionSql(params.kinds);
  if (!unionSql) return [];
  const { sql, binds } = applyFilters(unionSql, params);
  const rows = db.prepare(sql).all(...binds) as RawAuditRow[];
  return rows.map(rowToEntry);
}

// ── Route handler ────────────────────────────────────────────────────────

function handleAudit(url: URL, res: ServerResponse): void {
  const params = parseQuery(url);
  withDb(res, (db) => {
    const entries = listAuditEntries(db, params);
    jsonOk(res, { entries });
  });
}

export const dashboardAuditRouter: Router = async (req, url, res) => {
  if (req.method === 'GET' && url.pathname === '/api/dashboard/audit') {
    handleAudit(url, res);
    return true;
  }
  return false;
};
