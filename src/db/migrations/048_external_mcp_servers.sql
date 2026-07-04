-- Migration 048 (Phase 2 hardening, Mission 5):
-- External MCP server registry.
--
-- Tracks stdio and HTTP SSE MCP servers that the Omniforge executor can
-- connect to. Tools exposed by those servers become available to tasks
-- with the namespaced name `mcp:<server-name>:<tool-name>` so they cannot
-- collide with the core tools registered in `src/v2/tools/core/index.ts`.
--
-- Columns are nullable in pairs depending on transport:
--   - `transport = 'stdio'`    → `command` required, `args`/`env` optional
--                                JSON-encoded; `url`/`bearer_enc` MUST be NULL
--   - `transport = 'http-sse'` → `url` required, `bearer_enc` optional
--                                (AES-256-GCM ciphertext via secrets-vault);
--                                `command`/`args`/`env` MUST be NULL
--
-- The CHECK on `transport` is a defence-in-depth guard; the application layer
-- in `src/v2/external-mcp/registry.ts` is the authoritative validator.
--
-- `active = 0` lets the operator pause a server without losing its config
-- (preserves bearer ciphertext and env overrides for a re-enable later).

CREATE TABLE IF NOT EXISTS external_mcp_servers (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  name        TEXT NOT NULL UNIQUE,
  transport   TEXT NOT NULL CHECK(transport IN ('stdio', 'http-sse')),
  -- stdio: command to run
  command     TEXT,
  args        TEXT,  -- JSON array
  env         TEXT,  -- JSON object (key:value env overrides)
  -- http-sse: URL + optional bearer token (encrypted with secrets key)
  url         TEXT,
  bearer_enc  TEXT,  -- AES-256-GCM encrypted bearer, null if no auth
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_external_mcp_servers_active
  ON external_mcp_servers(active);
