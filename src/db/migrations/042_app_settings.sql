-- Migration 024: App settings key-value store (D-H2.076)
-- Persistent runtime settings editable via Dashboard > Settings panel.
-- key: namespaced string e.g. "models.decomposer", "models.task"
-- value_json: JSON-encoded value (string, number, boolean, object)
-- updated_at: Unix epoch ms

CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT    PRIMARY KEY,
  value_json TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);
