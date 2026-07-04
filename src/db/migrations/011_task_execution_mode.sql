-- FASE 1B Bloco A.2 — execution mode per task.
-- See docs/09-H2-ROADMAP-DETAILED.md sec FASE 1B Bloco A.3.
ALTER TABLE tasks ADD COLUMN execution_mode TEXT DEFAULT 'ephemeral';
