ALTER TABLE hitl_gates ADD COLUMN task_id TEXT REFERENCES tasks(id);
