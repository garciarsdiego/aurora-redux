-- Onda 1 / Cluster E: replay debugger.
--
-- Adds a replay_of column to tasks so that replayed tasks carry a pointer
-- back to the original task they were derived from. The column is nullable
-- for all pre-existing tasks. A simple index supports the common query
-- "find all replays of task X" used by the Aurora ReplayModal.

ALTER TABLE tasks ADD COLUMN replay_of TEXT REFERENCES tasks(id);

CREATE INDEX IF NOT EXISTS idx_tasks_replay_of ON tasks(replay_of)
  WHERE replay_of IS NOT NULL;
