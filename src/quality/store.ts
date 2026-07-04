import type Database from 'better-sqlite3';
import { withSqliteRetrySync } from '../db/sqlite-retry.js';
import { redactContextJson } from '../context/redaction.js';
import type {
  CreateQualityReviewInput,
  QualityEvidenceRef,
  QualityFixTaskDraft,
  QualityIssue,
  QualityReviewRow,
} from './types.js';

function newQualityReviewId(): string {
  return `qr_${crypto.randomUUID()}`;
}

function safeJson(value: unknown): string {
  return JSON.stringify(redactContextJson(value ?? []));
}

function normalizeScore(score: number | null | undefined): number | null {
  if (typeof score !== 'number' || !Number.isFinite(score)) return null;
  if (score < 0) return 0;
  if (score > 1) return 1;
  return score;
}

export function saveQualityReview(
  db: Database.Database,
  input: CreateQualityReviewInput,
): QualityReviewRow {
  const id = newQualityReviewId();
  const createdAt = input.createdAt ?? Date.now();
  const issues = input.issues ?? [];
  const evidence = input.evidence ?? [];
  const fixTasks = input.fixTasks ?? [];

  withSqliteRetrySync(() =>
    db.prepare(
      `INSERT INTO quality_reviews
       (id, workflow_id, task_id, scope, reviewer_kind, reviewer_model,
        outcome, score, issues_json, evidence_json, fix_tasks_json,
        approval_status, audit_status, run_mode, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.workflowId,
      input.taskId ?? null,
      input.scope,
      input.reviewerKind,
      input.reviewerModel ?? null,
      input.outcome,
      normalizeScore(input.score),
      safeJson(issues),
      safeJson(evidence),
      safeJson(fixTasks),
      input.approvalStatus ?? 'not_required',
      input.auditStatus ?? 'recorded',
      input.runMode ?? 'dry-run',
      createdAt,
    ),
  );

  return loadQualityReview(db, id)!;
}

export function loadQualityReview(
  db: Database.Database,
  id: string,
): QualityReviewRow | null {
  const row = db.prepare(`SELECT * FROM quality_reviews WHERE id = ?`).get(id) as
    | QualityReviewRow
    | undefined;
  return row ?? null;
}

export function listQualityReviewsForWorkflow(
  db: Database.Database,
  workflowId: string,
): QualityReviewRow[] {
  return db
    .prepare(`SELECT * FROM quality_reviews WHERE workflow_id = ? ORDER BY created_at ASC, id ASC`)
    .all(workflowId) as QualityReviewRow[];
}

export function listQualityReviewsForTask(
  db: Database.Database,
  taskId: string,
): QualityReviewRow[] {
  return db
    .prepare(`SELECT * FROM quality_reviews WHERE task_id = ? ORDER BY created_at ASC, id ASC`)
    .all(taskId) as QualityReviewRow[];
}

export function latestFinalQualityReview(
  db: Database.Database,
  workflowId: string,
): QualityReviewRow | null {
  const row = db
    .prepare(
      `SELECT * FROM quality_reviews
       WHERE workflow_id = ? AND scope = 'workflow_final'
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    )
    .get(workflowId) as QualityReviewRow | undefined;
  return row ?? null;
}

export function parseQualityIssues(row: QualityReviewRow): QualityIssue[] {
  return JSON.parse(row.issues_json) as QualityIssue[];
}

export function parseQualityEvidence(row: QualityReviewRow): QualityEvidenceRef[] {
  return JSON.parse(row.evidence_json) as QualityEvidenceRef[];
}

export function parseQualityFixTasks(row: QualityReviewRow): QualityFixTaskDraft[] {
  return JSON.parse(row.fix_tasks_json) as QualityFixTaskDraft[];
}
