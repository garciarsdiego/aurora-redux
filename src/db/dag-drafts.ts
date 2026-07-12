import type Database from 'better-sqlite3';
import type { Dag } from '../types/index.js';
import { DagSchema } from '../types/schemas.js';
import { redactSecrets } from '../v2/security/redact.js';
import { withSqliteRetrySync } from './sqlite-retry.js';

export type DagDraftStatus = 'draft' | 'archived' | 'started';

export interface DagDraft {
  id: string;
  workspace: string;
  title: string;
  objective: string;
  dag: Dag;
  status: DagDraftStatus;
  source: string;
  started_workflow_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface CreateDagDraftInput {
  workspace: string;
  title?: string;
  objective: string;
  dag: unknown;
  source?: string;
}

export interface PatchDagDraftInput {
  title?: string;
  objective?: string;
  dag?: unknown;
  status?: DagDraftStatus;
  started_workflow_id?: string | null;
}

interface DagDraftRow {
  id: string;
  workspace: string;
  title: string;
  objective: string;
  dag_json: string;
  status: DagDraftStatus;
  source: string;
  started_workflow_id: string | null;
  created_at: number;
  updated_at: number;
}

const DAG_DRAFT_COLUMNS = `id, workspace, title, objective, dag_json, status, source,
              started_workflow_id, created_at, updated_at`;

const SECRET_TOKEN_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\b(?:ghp|github_pat|glpat|xox[baprs]?)-[A-Za-z0-9_-]{12,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi,
];

function newDagDraftId(): string {
  return `draft_${crypto.randomUUID()}`;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function sanitizeText(value: string, workspace: string, db: Database.Database): string {
  let redacted = redactSecrets(value, workspace, db);
  for (const pattern of SECRET_TOKEN_PATTERNS) {
    redacted = redacted.replace(pattern, '***REDACTED***');
  }
  return redacted;
}

function sanitizeDagJson(dag: Dag, workspace: string, db: Database.Database): string {
  return sanitizeText(JSON.stringify(dag), workspace, db);
}

function parseDag(input: unknown): Dag {
  const result = DagSchema.safeParse(input);
  if (!result.success) {
    throw new Error(`invalid DAG draft: ${result.error.issues.map((issue) => issue.message).join('; ')}`);
  }
  return result.data;
}

function rowToDagDraft(row: DagDraftRow): DagDraft {
  return {
    id: row.id,
    workspace: row.workspace,
    title: row.title,
    objective: row.objective,
    dag: JSON.parse(row.dag_json) as Dag,
    status: row.status,
    source: row.source,
    started_workflow_id: row.started_workflow_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function createDagDraft(db: Database.Database, input: CreateDagDraftInput): DagDraft {
  const workspace = requiredString(input.workspace, 'workspace');
  const objective = sanitizeText(requiredString(input.objective, 'objective'), workspace, db);
  const titleInput = typeof input.title === 'string' && input.title.trim()
    ? input.title.trim()
    : objective.slice(0, 80);
  const title = sanitizeText(titleInput, workspace, db);
  const source = typeof input.source === 'string' && input.source.trim()
    ? input.source.trim().slice(0, 80)
    : 'planner';
  const dag = parseDag(input.dag);
  const dagJson = sanitizeDagJson(dag, workspace, db);
  const now = Date.now();
  const id = newDagDraftId();

  withSqliteRetrySync(() =>
    db.prepare(
      `INSERT INTO dag_drafts
       (id, workspace, title, objective, dag_json, status, source,
        started_workflow_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'draft', ?, NULL, ?, ?)`,
    ).run(id, workspace, title, objective, dagJson, source, now, now),
  );

  return loadDagDraftOrThrow(db, id);
}

function loadDagDraftOrThrow(db: Database.Database, id: string): DagDraft {
  const draft = loadDagDraft(db, id);
  if (!draft) throw new Error(`DAG draft not found after write: ${id}`);
  return draft;
}

export function loadDagDraft(db: Database.Database, id: string): DagDraft | null {
  const row = db
    .prepare(
      `SELECT ${DAG_DRAFT_COLUMNS}
         FROM dag_drafts
        WHERE id = ?`,
    )
    .get(id) as DagDraftRow | undefined;
  return row ? rowToDagDraft(row) : null;
}

export function listDagDrafts(
  db: Database.Database,
  opts: { workspace?: string; status?: DagDraftStatus } = {},
): DagDraft[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts.workspace) {
    clauses.push('workspace = ?');
    params.push(opts.workspace);
  }
  if (opts.status) {
    clauses.push('status = ?');
    params.push(opts.status);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT ${DAG_DRAFT_COLUMNS}
         FROM dag_drafts
        ${where}
        ORDER BY updated_at DESC, created_at DESC`,
    )
    .all(...params) as DagDraftRow[];
  return rows.map(rowToDagDraft);
}

export function patchDagDraft(
  db: Database.Database,
  id: string,
  patch: PatchDagDraftInput,
): DagDraft {
  const existing = loadDagDraft(db, id);
  if (!existing) throw new Error(`DAG draft not found: ${id}`);

  const title = patch.title !== undefined
    ? sanitizeText(requiredString(patch.title, 'title'), existing.workspace, db)
    : existing.title;
  const objective = patch.objective !== undefined
    ? sanitizeText(requiredString(patch.objective, 'objective'), existing.workspace, db)
    : existing.objective;
  const dag = patch.dag !== undefined ? parseDag(patch.dag) : existing.dag;
  const dagJson = sanitizeDagJson(dag, existing.workspace, db);
  const status = patch.status ?? existing.status;
  const startedWorkflowId = patch.started_workflow_id !== undefined
    ? patch.started_workflow_id
    : existing.started_workflow_id;
  const updatedAt = Date.now();

  withSqliteRetrySync(() =>
    db.prepare(
      `UPDATE dag_drafts
        SET title = ?,
            objective = ?,
            dag_json = ?,
            status = ?,
            started_workflow_id = ?,
            updated_at = ?
      WHERE id = ?`,
    ).run(title, objective, dagJson, status, startedWorkflowId, updatedAt, id),
  );

  return loadDagDraftOrThrow(db, id);
}

export function deleteDagDraft(db: Database.Database, id: string): boolean {
  const result = withSqliteRetrySync(() =>
    db.prepare('DELETE FROM dag_drafts WHERE id = ?').run(id),
  );
  return result.changes > 0;
}
