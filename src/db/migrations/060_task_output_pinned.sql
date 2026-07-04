-- Aurora-parity Wave 2 — pin/freeze upstream outputs. When a task is pinned AND
-- it has a stored output_json, a re-run (resume / replay / fork) reuses that
-- output instead of re-executing — zero model spend. This is the substrate the
-- Wave-3 rewind/fork work builds on. Additive + defaulted so existing rows read
-- as not-pinned. The executor short-circuit lives in run-task/index.ts.
ALTER TABLE tasks ADD COLUMN output_pinned INTEGER DEFAULT 0;
