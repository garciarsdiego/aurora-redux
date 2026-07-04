-- AETHER γ-2: stepwise advisor conversation memory.
--
-- Stepwise advisors (consensus, codereview, debug, precommit, thinkdeep,
-- planner) iterate over multiple rounds within a single task — each step
-- builds on findings from the previous one. The Python PAL kept this in
-- memory via continuation_id; the TypeScript port persists it so steps
-- survive daemon restarts and can be inspected by the operator.
--
-- A conversation lives for the lifetime of one stepwise task. The history
-- column stores the ordered step trace (input args + LLM output + findings
-- + nextStep request) as a single JSON array — small enough to fit (a 5-
-- step consensus tops out around ~20 KB), and faster to read/write atomically
-- than a per-step row.
--
-- Example smoke test 2026-04-30 / 2026-05-01 (manual port — wf_2ffeb4d5 cli:codex
-- task ran into the stale-MCP-server-cache issue and could not produce this
-- migration via Omniforge dispatch).

CREATE TABLE IF NOT EXISTS advisor_conversations (
  id            TEXT PRIMARY KEY,
  advisor_name  TEXT NOT NULL,
  workflow_id   TEXT NOT NULL,
  task_id       TEXT NOT NULL,
  started_at    INTEGER NOT NULL,
  completed_at  INTEGER,
  history_json  TEXT NOT NULL DEFAULT '[]',
  status        TEXT NOT NULL DEFAULT 'in_progress'
);

CREATE INDEX IF NOT EXISTS idx_advisor_conversations_task
  ON advisor_conversations(workflow_id, task_id);

CREATE INDEX IF NOT EXISTS idx_advisor_conversations_advisor
  ON advisor_conversations(advisor_name, started_at DESC);
