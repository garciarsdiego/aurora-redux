import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { VALID_WORKSPACE_RE } from '../../utils/workspace.js';

export const VersionedDefinitionKindSchema = z.enum(['agent', 'tool', 'policy']);
export const VersionedDefinitionStatusSchema = z.enum([
  'draft',
  'active',
  'deprecated',
  'archived',
]);

export type VersionedDefinitionKind = z.infer<typeof VersionedDefinitionKindSchema>;
export type VersionedDefinitionStatus = z.infer<typeof VersionedDefinitionStatusSchema>;

const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

const CreateDefinitionSchema = z.object({
  workspace: z.string().regex(VALID_WORKSPACE_RE).default('global'),
  kind: VersionedDefinitionKindSchema,
  name: z.string().regex(NAME_RE, 'Invalid definition name'),
  version: z.string().regex(VERSION_RE, 'Version must be semver-like, e.g. 1.0.0'),
  status: VersionedDefinitionStatusSchema.optional().default('draft'),
  spec: z.unknown(),
  createdBy: z.string().max(120).optional(),
  supersedesId: z.string().optional(),
  notes: z.string().max(2_000).optional(),
});

const LookupSchema = z.object({
  workspace: z.string().regex(VALID_WORKSPACE_RE).default('global'),
  kind: VersionedDefinitionKindSchema,
  name: z.string().regex(NAME_RE),
  version: z.string().regex(VERSION_RE),
});

const PinSchema = z.object({
  workspace: z.string().regex(VALID_WORKSPACE_RE).default('global'),
  kind: VersionedDefinitionKindSchema,
  name: z.string().regex(NAME_RE),
  versionId: z.string().min(1),
  pinnedBy: z.string().max(120).optional(),
});

const UsageSchema = z.object({
  workflowId: z.string().min(1),
  taskId: z.string().min(1).optional(),
  definitionId: z.string().min(1),
  role: z.string().min(1).max(120),
  reason: z.string().max(1_000).optional(),
});

export interface VersionedDefinitionRow {
  id: string;
  workspace: string;
  kind: VersionedDefinitionKind;
  name: string;
  version: string;
  status: VersionedDefinitionStatus;
  spec_json: string;
  checksum_sha256: string;
  created_at: number;
  created_by: string | null;
  supersedes_id: string | null;
  notes: string | null;
}

export interface VersionedDefinition extends Omit<VersionedDefinitionRow, 'spec_json'> {
  spec: unknown;
}

export interface VersionedDefinitionUsage {
  id: string;
  workflow_id: string;
  task_id: string | null;
  definition_id: string;
  role: string;
  reason: string | null;
  created_at: number;
}

export function newVersionedDefinitionId(): string {
  return `vd_${randomUUID()}`;
}

export function newVersionedDefinitionUsageId(): string {
  return `vdu_${randomUUID()}`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalize(record[key])]),
    );
  }
  return value;
}

function stableStringify(value: unknown): string {
  const text = JSON.stringify(canonicalize(value));
  if (text === undefined) {
    throw new Error('Versioned definition spec must be JSON-serializable');
  }
  return text;
}

function checksumSpec(specJson: string): string {
  return createHash('sha256').update(specJson).digest('hex');
}

function rowToDefinition(row: VersionedDefinitionRow): VersionedDefinition {
  return {
    id: row.id,
    workspace: row.workspace,
    kind: row.kind,
    name: row.name,
    version: row.version,
    status: row.status,
    spec: JSON.parse(row.spec_json) as unknown,
    checksum_sha256: row.checksum_sha256,
    created_at: row.created_at,
    created_by: row.created_by,
    supersedes_id: row.supersedes_id,
    notes: row.notes,
  };
}

export function createVersionedDefinition(
  db: Database.Database,
  raw: z.input<typeof CreateDefinitionSchema>,
): VersionedDefinition {
  const params = CreateDefinitionSchema.parse(raw);
  const specJson = stableStringify(params.spec);
  const id = newVersionedDefinitionId();

  try {
    db.prepare(
      `INSERT INTO versioned_definitions
         (id, workspace, kind, name, version, status, spec_json, checksum_sha256,
          created_at, created_by, supersedes_id, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      params.workspace,
      params.kind,
      params.name,
      params.version,
      params.status,
      specJson,
      checksumSpec(specJson),
      Date.now(),
      params.createdBy ?? null,
      params.supersedesId ?? null,
      params.notes ?? null,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/unique constraint/i.test(msg)) {
      throw new Error(
        `Versioned definition already exists: ${params.workspace}/${params.kind}/${params.name}@${params.version}`,
      );
    }
    throw err;
  }

  const row = getDefinitionById(db, id);
  if (!row) throw new Error(`Versioned definition insert failed: ${id}`);
  return row;
}

export function getDefinitionById(
  db: Database.Database,
  id: string,
): VersionedDefinition | null {
  const row = db
    .prepare(`SELECT * FROM versioned_definitions WHERE id = ?`)
    .get(id) as VersionedDefinitionRow | undefined;
  return row ? rowToDefinition(row) : null;
}

export function findVersionedDefinition(
  db: Database.Database,
  raw: z.input<typeof LookupSchema>,
): VersionedDefinition | null {
  const params = LookupSchema.parse(raw);
  const row = db
    .prepare(
      `SELECT * FROM versioned_definitions
        WHERE workspace = ? AND kind = ? AND name = ? AND version = ?`,
    )
    .get(params.workspace, params.kind, params.name, params.version) as
    | VersionedDefinitionRow
    | undefined;
  return row ? rowToDefinition(row) : null;
}

export function listVersionedDefinitions(
  db: Database.Database,
  filter: {
    workspace?: string;
    kind?: VersionedDefinitionKind;
    name?: string;
    status?: VersionedDefinitionStatus;
    limit?: number;
  } = {},
): VersionedDefinition[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (filter.workspace) {
    z.string().regex(VALID_WORKSPACE_RE).parse(filter.workspace);
    conditions.push('workspace = ?');
    params.push(filter.workspace);
  }
  if (filter.kind) {
    VersionedDefinitionKindSchema.parse(filter.kind);
    conditions.push('kind = ?');
    params.push(filter.kind);
  }
  if (filter.name) {
    z.string().regex(NAME_RE).parse(filter.name);
    conditions.push('name = ?');
    params.push(filter.name);
  }
  if (filter.status) {
    VersionedDefinitionStatusSchema.parse(filter.status);
    conditions.push('status = ?');
    params.push(filter.status);
  }

  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  params.push(limit);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = db
    .prepare(
      `SELECT * FROM versioned_definitions
       ${where}
       ORDER BY workspace ASC, kind ASC, name ASC, created_at ASC
       LIMIT ?`,
    )
    .all(...params) as VersionedDefinitionRow[];
  return rows.map(rowToDefinition);
}

export function pinVersionedDefinition(
  db: Database.Database,
  raw: z.input<typeof PinSchema>,
): VersionedDefinition {
  const params = PinSchema.parse(raw);
  const definition = getDefinitionById(db, params.versionId);
  if (!definition) throw new Error(`Versioned definition not found: ${params.versionId}`);
  if (definition.kind !== params.kind || definition.name !== params.name) {
    throw new Error(
      `Pin mismatch: ${params.kind}/${params.name} cannot point at ${definition.kind}/${definition.name}`,
    );
  }
  if (definition.workspace !== params.workspace && definition.workspace !== 'global') {
    throw new Error(
      `Pin workspace mismatch: ${params.workspace} cannot pin definition from ${definition.workspace}`,
    );
  }

  db.prepare(
    `INSERT INTO active_version_pins
       (workspace, kind, name, version_id, pinned_at, pinned_by)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace, kind, name)
     DO UPDATE SET version_id = excluded.version_id,
                   pinned_at = excluded.pinned_at,
                   pinned_by = excluded.pinned_by`,
  ).run(
    params.workspace,
    params.kind,
    params.name,
    params.versionId,
    Date.now(),
    params.pinnedBy ?? null,
  );

  return definition;
}

export function getActiveVersionedDefinition(
  db: Database.Database,
  params: {
    workspace: string;
    kind: VersionedDefinitionKind;
    name: string;
  },
): VersionedDefinition | null {
  const parsed = z.object({
    workspace: z.string().regex(VALID_WORKSPACE_RE),
    kind: VersionedDefinitionKindSchema,
    name: z.string().regex(NAME_RE),
  }).parse(params);

  const row = db
    .prepare(
      `SELECT d.*
         FROM active_version_pins p
         JOIN versioned_definitions d ON d.id = p.version_id
        WHERE p.workspace = ? AND p.kind = ? AND p.name = ?`,
    )
    .get(parsed.workspace, parsed.kind, parsed.name) as VersionedDefinitionRow | undefined;
  if (row) return rowToDefinition(row);

  if (parsed.workspace !== 'global') {
    return getActiveVersionedDefinition(db, {
      workspace: 'global',
      kind: parsed.kind,
      name: parsed.name,
    });
  }
  return null;
}

export function recordVersionedDefinitionUsage(
  db: Database.Database,
  raw: z.input<typeof UsageSchema>,
): VersionedDefinitionUsage {
  const params = UsageSchema.parse(raw);
  const id = newVersionedDefinitionUsageId();
  db.prepare(
    `INSERT INTO versioned_definition_usages
       (id, workflow_id, task_id, definition_id, role, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    params.workflowId,
    params.taskId ?? null,
    params.definitionId,
    params.role,
    params.reason ?? null,
    Date.now(),
  );

  return db
    .prepare(`SELECT * FROM versioned_definition_usages WHERE id = ?`)
    .get(id) as VersionedDefinitionUsage;
}
