import { z } from 'zod';
import { initDb } from '../../db/client.js';
import { getDbPath } from '../../utils/config.js';
import { VALID_WORKSPACE_RE } from '../../utils/workspace.js';
import {
  createVersionedDefinition,
  VersionedDefinitionKindSchema,
  VersionedDefinitionStatusSchema,
} from '../../v2/governance/versioned-registry.js';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/;

export const RegisterVersionedDefinitionSchema = z.object({
  workspace: z.string().regex(VALID_WORKSPACE_RE, 'Invalid workspace name').default('global'),
  kind: VersionedDefinitionKindSchema,
  name: z.string().regex(NAME_RE, 'Invalid definition name'),
  version: z.string().regex(VERSION_RE, 'Version must be semver-like, e.g. 1.0.0'),
  status: VersionedDefinitionStatusSchema.optional().default('draft'),
  spec: z.unknown(),
  created_by: z.string().max(120).optional(),
  supersedes_id: z.string().optional(),
  notes: z.string().max(2_000).optional(),
});

export async function registerVersionedDefinitionTool(raw: unknown): Promise<string> {
  const input = RegisterVersionedDefinitionSchema.parse(raw);
  const db = initDb(getDbPath());
  try {
    const definition = createVersionedDefinition(db, {
      workspace: input.workspace,
      kind: input.kind,
      name: input.name,
      version: input.version,
      status: input.status,
      spec: input.spec,
      createdBy: input.created_by,
      supersedesId: input.supersedes_id,
      notes: input.notes,
    });
    return JSON.stringify(definition);
  } finally {
    db.close();
  }
}
