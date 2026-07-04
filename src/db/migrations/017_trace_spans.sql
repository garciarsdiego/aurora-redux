-- Exportable OTel-like trace spans for workflow/task/model/tool observability.

CREATE TABLE IF NOT EXISTS trace_spans (
  id              TEXT PRIMARY KEY,
  workflow_id     TEXT NOT NULL REFERENCES workflows(id),
  task_id         TEXT REFERENCES tasks(id),
  parent_span_id  TEXT REFERENCES trace_spans(id),
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'running',
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  duration_ms     INTEGER,
  attributes_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_trace_spans_workflow
  ON trace_spans(workflow_id, started_at);

