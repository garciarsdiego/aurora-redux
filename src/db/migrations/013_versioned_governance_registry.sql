-- Versioned governance registry.
-- Supports local versioning for agents, tools and policies without turning
-- Omniforge into a multi-tenant SaaS. The active pin table makes replay and
-- rollback explicit: a workflow can record exactly which version influenced it.

CREATE TABLE IF NOT EXISTS versioned_definitions (
  id              TEXT PRIMARY KEY,
  workspace       TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('agent', 'tool', 'policy')),
  name            TEXT NOT NULL,
  version         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'active', 'deprecated', 'archived')),
  spec_json       TEXT NOT NULL,
  checksum_sha256 TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  created_by      TEXT,
  supersedes_id   TEXT REFERENCES versioned_definitions(id),
  notes           TEXT,
  UNIQUE(workspace, kind, name, version)
);

CREATE INDEX IF NOT EXISTS idx_versioned_definitions_lookup
  ON versioned_definitions(workspace, kind, name, version);
CREATE INDEX IF NOT EXISTS idx_versioned_definitions_kind_status
  ON versioned_definitions(kind, status, created_at DESC);

CREATE TABLE IF NOT EXISTS active_version_pins (
  workspace   TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('agent', 'tool', 'policy')),
  name        TEXT NOT NULL,
  version_id  TEXT NOT NULL REFERENCES versioned_definitions(id),
  pinned_at   INTEGER NOT NULL,
  pinned_by   TEXT,
  PRIMARY KEY (workspace, kind, name)
);

CREATE INDEX IF NOT EXISTS idx_active_version_pins_version
  ON active_version_pins(version_id);

CREATE TABLE IF NOT EXISTS versioned_definition_usages (
  id            TEXT PRIMARY KEY,
  workflow_id   TEXT NOT NULL REFERENCES workflows(id),
  task_id       TEXT REFERENCES tasks(id),
  definition_id TEXT NOT NULL REFERENCES versioned_definitions(id),
  role          TEXT NOT NULL,
  reason        TEXT,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_versioned_definition_usages_workflow
  ON versioned_definition_usages(workflow_id, created_at);
CREATE INDEX IF NOT EXISTS idx_versioned_definition_usages_definition
  ON versioned_definition_usages(definition_id);
