-- Tier 1 S12 hotfix: file_scope declared in TypeScript types but never in schema.
-- Runtime scheduler (orchestrate.ts:215) always got [] after DB round-trip,
-- silently defeating file-scope overlap detection between concurrent tasks.
ALTER TABLE tasks ADD COLUMN file_scope_json TEXT;
