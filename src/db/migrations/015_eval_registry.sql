-- Local eval registry and golden task harness.

CREATE TABLE IF NOT EXISTS eval_cases (
  id            TEXT PRIMARY KEY,
  workspace     TEXT NOT NULL,
  name          TEXT NOT NULL,
  input_json    TEXT NOT NULL,
  expected_json TEXT NOT NULL,
  tags_json     TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  UNIQUE(workspace, name)
);

CREATE INDEX IF NOT EXISTS idx_eval_cases_workspace
  ON eval_cases(workspace, created_at);

CREATE TABLE IF NOT EXISTS eval_runs (
  id            TEXT PRIMARY KEY,
  workspace     TEXT NOT NULL,
  suite_name    TEXT NOT NULL,
  status        TEXT NOT NULL,
  score         REAL NOT NULL DEFAULT 0,
  case_count    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  completed_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_eval_runs_workspace
  ON eval_runs(workspace, created_at DESC);

CREATE TABLE IF NOT EXISTS eval_results (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES eval_runs(id),
  case_id       TEXT NOT NULL REFERENCES eval_cases(id),
  status        TEXT NOT NULL,
  score         REAL NOT NULL DEFAULT 0,
  output_json   TEXT,
  feedback      TEXT,
  error         TEXT,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_eval_results_run
  ON eval_results(run_id, created_at);
