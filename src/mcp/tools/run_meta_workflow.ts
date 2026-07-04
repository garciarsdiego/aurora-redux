import { z } from 'zod';

import { decompose } from '../../brain/decomposer.js';
import { executeWorkflow } from '../../brain/executor.js';
import { initDb } from '../../db/client.js';
import { getDbPath } from '../../utils/config.js';
import { loadWorkspaceEnv, VALID_WORKSPACE_RE } from '../../utils/workspace.js';
import { DagSchema } from '../../types/schemas.js';
import {
  runMetaWorkflow,
  type MetaWorkflowSpec,
} from '../../v2/meta-orchestrator/index.js';

export const toolName = 'omniforge_run_meta_workflow';

export const inputSchema = z.object({
  specs: z
    .array(
      z.object({
        id: z.string().min(1),
        workspace: z.string().regex(VALID_WORKSPACE_RE, 'Invalid workspace name'),
        objective: z.string().min(1),
        dag: DagSchema.optional(),
        patternId: z.string().min(1).optional(),
      }),
    )
    .min(1),
  maxConcurrency: z.number().int().min(1).optional().default(3),
  consolidate: z.boolean().optional().default(true),
  workspaceDir: z.string().optional(),
});

export async function handler(raw: unknown): Promise<string> {
  const input = inputSchema.parse(raw);
  const result = await runMetaWorkflow(input.specs satisfies readonly MetaWorkflowSpec[], {
    maxConcurrency: input.maxConcurrency,
    consolidate: input.consolidate,
    workspaceDir: input.workspaceDir,
    runWorkflow: async (spec) => {
      loadWorkspaceEnv(spec.workspace);
      const db = initDb(getDbPath());
      try {
        const dag = spec.dag ?? await decompose(spec.objective);
        return await executeWorkflow(db, dag, spec.workspace, spec.objective, {
          autoApprove: true,
          pattern_id: spec.patternId,
        });
      } finally {
        db.close();
      }
    },
  });

  return JSON.stringify(result);
}

export const runMetaWorkflowTool = handler;
