/**
 * Meta-Workflow Routes — HTTP endpoints for meta-workflow operations.
 *
 * Provides REST API endpoints for:
 * - Running meta-workflows (parallel multi-agent execution)
 * - Getting meta-workflow schema
 * - Viewing consolidation results
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { decompose } from '../../brain/decomposer.js';
import { executeWorkflow } from '../../brain/executor.js';
import { initDb } from '../../db/client.js';
import { getDbPath } from '../../utils/config.js';
import { loadWorkspaceEnv } from '../../utils/workspace.js';
import {
  runMetaWorkflow,
  type MetaWorkflowSpec,
} from '../../v2/meta-orchestrator/index.js';
import type { Router } from './types.js';
import { badRequest, jsonOk, readJsonBody } from './_shared.js';

interface RunMetaWorkflowBody {
  specs: Array<{
    id: string;
    workspace: string;
    objective: string;
    patternId?: string;
  }>;
  maxConcurrency?: number;
  consolidate?: boolean;
  workspaceDir?: string;
}

export const dashboardMetaWorkflowsRouter: Router = async (req, url, res, ctx) => {
  // POST /api/meta-workflows/run — Run a meta-workflow
  if (url.pathname === '/api/meta-workflows/run') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed', allowed: ['POST'] }));
      return true;
    }

    try {
      const body = await readJsonBody(req) as RunMetaWorkflowBody;
      const { specs, maxConcurrency = 3, consolidate = true, workspaceDir } = body;

      if (!Array.isArray(specs) || specs.length === 0) {
        badRequest(res, 'Invalid request: specs must be a non-empty array');
        return true;
      }

      // Validate specs
      for (const spec of specs) {
        if (!spec.id || !spec.workspace || !spec.objective) {
          badRequest(res, 'Invalid spec: each spec must have id, workspace, and objective');
          return true;
        }
      }

      const metaWorkflowSpecs: readonly MetaWorkflowSpec[] = specs.map((s) => ({
        id: s.id,
        workspace: s.workspace,
        objective: s.objective,
        patternId: s.patternId,
      }));

      const result = await runMetaWorkflow(metaWorkflowSpecs, {
        maxConcurrency,
        consolidate,
        workspaceDir,
        runWorkflow: async (spec) => {
          loadWorkspaceEnv(spec.workspace);
          const db = initDb(getDbPath());
          try {
            const dag = await decompose(spec.objective);
            return await executeWorkflow(db, dag, spec.workspace, spec.objective, {
              autoApprove: true,
              pattern_id: spec.patternId,
            });
          } finally {
            db.close();
          }
        },
      });

      jsonOk(res, {
        success: true,
        result,
      });
      return true;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      badRequest(res, `Meta-workflow execution failed: ${error}`);
      return true;
    }
  }

  // GET /api/meta-workflows/schema — Get the meta-workflow input schema
  if (url.pathname === '/api/meta-workflows/schema') {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed', allowed: ['GET'] }));
      return true;
    }

    jsonOk(res, {
      schema: {
        type: 'object',
        properties: {
          specs: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Unique identifier for this workflow' },
                workspace: { type: 'string', description: 'Workspace name' },
                objective: { type: 'string', description: 'Workflow objective' },
                patternId: { type: 'string', description: 'Optional pattern ID' },
              },
              required: ['id', 'workspace', 'objective'],
            },
          },
          maxConcurrency: {
            type: 'number',
            description: 'Maximum concurrent workflows (default: 3)',
            default: 3,
          },
          consolidate: {
            type: 'boolean',
            description: 'Whether to consolidate results (default: true)',
            default: true,
          },
          workspaceDir: {
            type: 'string',
            description: 'Optional workspace directory for file validation',
          },
        },
        required: ['specs'],
      },
    });
    return true;
  }

  return false;
};