import { z } from 'zod';
import { initDb } from '../../db/client.js';
import { getDbPath } from '../../utils/config.js';
import { VALID_WORKSPACE_RE } from '../../utils/workspace.js';
import {
  listVersionedDefinitions,
  VersionedDefinitionKindSchema,
  VersionedDefinitionStatusSchema,
} from '../../v2/governance/versioned-registry.js';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export const ListVersionedDefinitionsSchema = z.object({
  workspace: z.string().regex(VALID_WORKSPACE_RE, 'Invalid workspace name').optional(),
  kind: VersionedDefinitionKindSchema.optional(),
  name: z.string().regex(NAME_RE, 'Invalid definition name').optional(),
  status: VersionedDefinitionStatusSchema.optional(),
  limit: z.number().int().min(1).max(500).optional().default(100),
});

export async function listVersionedDefinitionsTool(raw: unknown): Promise<string> {
  const input = ListVersionedDefinitionsSchema.parse(raw);
  const db = initDb(getDbPath());
  try {
    const rows = listVersionedDefinitions(db, input);
    return JSON.stringify(rows);
  } finally {
    db.close();
  }
}
