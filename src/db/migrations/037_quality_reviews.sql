CREATE TABLE IF NOT EXISTS quality_reviews (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  scope TEXT NOT NULL CHECK (scope IN ('task','workflow_final')),
  reviewer_kind TEXT NOT NULL CHECK (reviewer_kind IN ('heuristic','light_ai','robust_ai','browser_harness')),
  reviewer_model TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('passed','needs_fixes','blocked','skipped')),
  score REAL,
  issues_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  fix_tasks_json TEXT NOT NULL DEFAULT '[]',
  approval_status TEXT NOT NULL DEFAULT 'not_required'
    CHECK (approval_status IN ('not_required','pending','approved','rejected')),
  audit_status TEXT NOT NULL DEFAULT 'recorded'
    CHECK (audit_status IN ('not_required','pending','recorded','failed')),
  run_mode TEXT NOT NULL DEFAULT 'dry-run'
    CHECK (run_mode IN ('dry-run','approved-run')),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_quality_reviews_workflow
  ON quality_reviews(workflow_id, scope, created_at);

CREATE INDEX IF NOT EXISTS idx_quality_reviews_task
  ON quality_reviews(task_id, created_at);
