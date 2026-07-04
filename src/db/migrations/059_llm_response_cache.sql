-- Aurora-parity Wave 2: exact-match LLM response cache.
-- Byte-identical calls (same model + FULL system prompt [which includes the
-- injected reflection block + active decomposer variant] + user prompt +
-- temperature) replay at $0 instead of re-paying the provider. Opt-in via
-- OMNIFORGE_LLM_CACHE=true (default off) so a stale entry can never silently
-- defeat the reflection flywheel before the key-sensitivity test is trusted.
CREATE TABLE IF NOT EXISTS llm_response_cache (
  cache_key   TEXT PRIMARY KEY,
  model       TEXT NOT NULL,
  content     TEXT NOT NULL,
  usage_json  TEXT,
  created_at  INTEGER NOT NULL,
  hit_count   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_llm_response_cache_created
  ON llm_response_cache(created_at);
