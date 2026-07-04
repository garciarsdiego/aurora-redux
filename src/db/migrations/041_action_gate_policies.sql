-- Migration 041: action gate policies table
-- Stores per-agent disposition for each action category.
-- '__default__' agent provides the baseline preset (unrestricted = all allow).
--
-- Adapted from Runfusion/Fusion (MIT) — packages/engine/src/agent-action-gate.ts
-- @ 5f6d998cb2e94ac90f6c204911c82c08e2640e05
--
-- The gate classifies every tool call into one of 5 categories and looks up
-- whether the calling agent is allowed, blocked, or requires approval for that
-- category. A missing row (no agent-specific record AND no __default__ record)
-- is treated as 'allow' by the Aurora gate runtime to preserve backwards
-- compatibility for daemons that have not yet applied this migration.
--
-- Category semantics:
--   git_write         — git mutation commands
--   file_write_delete — writes or deletes workspace files
--   command_execution — shell/system execution (bash, file-read, knowledge-search)
--   network_api       — outbound HTTP/network calls
--   task_agent_mutation — workflow dispatch, agent control, policy changes
--
-- Disposition semantics:
--   allow            — execute immediately
--   block            — reject with error
--   require-approval — reserved for future HITL gate integration (Tier 2);
--                      currently treated as allow by the runtime (observe-only mode)

CREATE TABLE IF NOT EXISTS agent_action_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('git_write','file_write_delete','command_execution','network_api','task_agent_mutation')),
  disposition TEXT NOT NULL DEFAULT 'allow' CHECK(disposition IN ('allow','block','require-approval')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(agent_id, category)
);

CREATE INDEX IF NOT EXISTS idx_aap_agent ON agent_action_policies(agent_id);

-- Seed: '__default__' agent = unrestricted preset (all allow).
-- Operators may UPDATE these rows or INSERT agent-specific overrides at runtime.
INSERT OR IGNORE INTO agent_action_policies (agent_id, category, disposition) VALUES
  ('__default__', 'git_write',           'allow'),
  ('__default__', 'file_write_delete',   'allow'),
  ('__default__', 'command_execution',   'allow'),
  ('__default__', 'network_api',         'allow'),
  ('__default__', 'task_agent_mutation', 'allow');
