CREATE TABLE IF NOT EXISTS context_channels (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('project','run','debug','approvals','artifacts','agents','custom')),
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  project_id TEXT,
  run_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(workspace, name)
);

CREATE TABLE IF NOT EXISTS context_threads (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES context_channels(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('run','task','artifact','approval','error','decision','advisor','custom')),
  title TEXT NOT NULL,
  project_id TEXT,
  work_item_id TEXT,
  run_id TEXT,
  task_id TEXT,
  artifact_id TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','archived')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS context_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES context_threads(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('human','agent','advisor','reviewer','system','tool')),
  sender_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('note','event','log','handoff','context_packet','decision','error','advisor_review')),
  body TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  UNIQUE(thread_id, seq)
);

CREATE TABLE IF NOT EXISTS context_packets (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  thread_id TEXT REFERENCES context_threads(id) ON DELETE SET NULL,
  packet_json TEXT NOT NULL,
  rendered_prompt TEXT NOT NULL,
  included_handoffs_json TEXT NOT NULL DEFAULT '[]',
  excluded_items_json TEXT NOT NULL DEFAULT '[]',
  token_estimate INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(run_id, task_id, attempt)
);

CREATE TABLE IF NOT EXISTS task_handoffs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  thread_id TEXT REFERENCES context_threads(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'summary' CHECK (kind IN ('summary','artifact','diff','decision','error','instruction','mixed')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  artifacts_json TEXT NOT NULL DEFAULT '[]',
  files_touched_json TEXT NOT NULL DEFAULT '[]',
  decisions_json TEXT NOT NULL DEFAULT '[]',
  safe_context_json TEXT NOT NULL DEFAULT '{}',
  token_estimate INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES work_items(id) ON DELETE CASCADE,
  workspace TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('project','epic','milestone','batch','task','subtask','atomic_task')),
  title TEXT NOT NULL,
  objective TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','ready','running','blocked','review','done','failed','canceled')),
  run_id TEXT,
  task_id TEXT,
  order_index INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS context_decisions (
  id TEXT PRIMARY KEY,
  thread_id TEXT REFERENCES context_threads(id) ON DELETE SET NULL,
  run_id TEXT,
  task_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('approve','reject','retry','cancel','pause','resume','audit','note')),
  status TEXT NOT NULL DEFAULT 'recorded' CHECK (status IN ('proposed','recorded','applied','superseded')),
  rationale TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_context_threads_run
  ON context_threads(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_context_threads_task
  ON context_threads(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_context_messages_thread
  ON context_messages(thread_id, seq);
CREATE INDEX IF NOT EXISTS idx_context_packets_task_attempt
  ON context_packets(run_id, task_id, attempt);
CREATE INDEX IF NOT EXISTS idx_task_handoffs_run_task
  ON task_handoffs(run_id, task_id, attempt);
CREATE INDEX IF NOT EXISTS idx_work_items_parent
  ON work_items(parent_id, order_index);
CREATE INDEX IF NOT EXISTS idx_context_decisions_run_task
  ON context_decisions(run_id, task_id, created_at);
