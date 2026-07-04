CREATE TABLE IF NOT EXISTS context_packets_v2 (
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

INSERT OR IGNORE INTO context_packets_v2
  (id, run_id, task_id, attempt, thread_id, packet_json, rendered_prompt,
   included_handoffs_json, excluded_items_json, token_estimate, truncated, created_at)
SELECT
  id, run_id, task_id, attempt, thread_id, packet_json, rendered_prompt,
  included_handoffs_json, excluded_items_json, token_estimate, truncated, created_at
FROM context_packets
ORDER BY created_at ASC, id ASC;

DROP TABLE context_packets;

ALTER TABLE context_packets_v2 RENAME TO context_packets;

CREATE INDEX IF NOT EXISTS idx_context_packets_task_attempt
  ON context_packets(run_id, task_id, attempt);
