import { z } from 'zod';
import { initDb } from '../../db/client.js';
import { getDbPath } from '../../utils/config.js';
import { VALID_WORKSPACE_RE } from '../../utils/workspace.js';
import {
  getActiveVersionedDefinition,
  pinVersionedDefinition,
  VersionedDefinitionKindSchema,
} from '../../v2/governance/versioned-registry.js';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export const PinVersionedDefinitionSchema = z.object({
  workspace: z.string().regex(VALID_WORKSPACE_RE, 'Invalid workspace name').default('global'),
  kind: VersionedDefinitionKindSchema,
  name: z.string().regex(NAME_RE, 'Invalid definition name'),
  version_id: z.string().min(1),
  pinned_by: z.string().max(120).optional(),
});

export async function pinVersionedDefinitionTool(raw: unknown): Promise<string> {
  const input = PinVersionedDefinitionSchema.parse(raw);
  const db = initDb(getDbPath());
  try {
    pinVersionedDefinition(db, {
      workspace: input.workspace,
      kind: input.kind,
      name: input.name,
      versionId: input.version_id,
      pinnedBy: input.pinned_by,
    });
    const active = getActiveVersionedDefinition(db, {
      workspace: input.workspace,
      kind: input.kind,
      name: input.name,
    });
    return JSON.stringify({ active });
  } finally {
    db.close();
  }
}
