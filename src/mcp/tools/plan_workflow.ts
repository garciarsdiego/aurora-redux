import { z } from 'zod';
import { initDb } from '../../db/client.js';
import { decompose } from '../../brain/decomposer.js';
import { matchPattern } from '../../brain/patternMatcher.js';
import { listPatterns } from '../../patterns/store.js';
import { getDbPath } from '../../utils/config.js';
import { loadWorkspaceEnv, VALID_WORKSPACE_RE } from '../../utils/workspace.js';
import type { Dag, DagTask } from '../../types/index.js';
import { scanForInjection } from '../../v2/injection-scan/index.js';
import { applyBestSkillExecutionMode } from '../../v2/skills/apply-to-dag.js';
import {
  applyExistingCodeFeatureModeToDag,
  existingCodePlanningInstruction,
} from '../../workflow-modes/existing-code-feature.js';
// FASE 1B Bloco A.3 — shared with run_workflow.ts so plan_workflow returns a
// DAG that already reflects the skill's execution_mode (caller sees it before
// approval).
import { ensureSkillsLoaded } from './ensure-skills.js';

const PlanWorkflowSchema = z.object({
  workspace: z.string().regex(VALID_WORKSPACE_RE, 'Invalid workspace name (alphanumeric/underscore/hyphen only)'),
  objective: z.string().min(1),
  workflow_mode: z.enum(['standard', 'existing_code_feature']).optional().default('standard'),
  // Sprint F4 (model picker): optional operator-selected model id. When set,
  // the decomposer biases task model assignment toward this id. See
  // src/brain/decomposer.ts buildDecomposerSystemPromptWithTaskModel for the
  // override semantics.
  task_model: z.string().min(1).max(200).optional(),
  max_total_cost_usd: z.number().nonnegative().nullable().optional(),
});

interface PlanTask {
  id: string;
  name: string;
  kind: string;
  model: string | null;
  depends_on: string[];
  hitl: boolean;
  executor_hint: string | null;
}

function formatTask(t: DagTask): PlanTask {
  return {
    id: t.id,
    name: t.name,
    kind: t.kind,
    model: t.model ?? null,
    depends_on: t.depends_on ?? [],
    hitl: t.hitl ?? false,
    executor_hint: t.executor_hint ?? null,
  };
}

export async function planWorkflowTool(raw: unknown): Promise<string> {
  const { workspace, objective, workflow_mode, task_model, max_total_cost_usd } = PlanWorkflowSchema.parse(raw);
  const planningObjective = workflow_mode === 'existing_code_feature'
    ? existingCodePlanningInstruction(objective)
    : objective;

  // Pre-decomposition injection scan — same gate as run_workflow.
  if (process.env.INJECTION_SCAN_OBJECTIVE !== 'false') {
    const objScan = scanForInjection(planningObjective);
    if (!objScan.safe) {
      return JSON.stringify({
        error: `Objective rejected by injection scanner (score=${objScan.score.toFixed(2)})`,
        flags: objScan.flags.map((f) => f.pattern),
      });
    }
  }

  loadWorkspaceEnv(workspace);
  const db = initDb(getDbPath());

  try {
    const patterns = listPatterns(db, workspace);
    const match = await matchPattern(planningObjective, patterns);

    let dag: Dag;
    let patternUsed: string | null = null;

    if (match.action === 'use') {
      dag = JSON.parse(match.pattern.dag_json) as Dag;
      patternUsed = match.pattern.name;
    } else {
      // Wave 5A #1: pass workspace so the decomposer can resolve its
      // persona.decomposer pin (versioned-defs registry) against the
      // operator's workspace, not the cwd-derived fallback.
      dag = await decompose(planningObjective, {
        ...(task_model ? { taskModelHint: task_model } : {}),
        workspace,
        db,
      });
    }
    if (workflow_mode === 'existing_code_feature') {
      dag = applyExistingCodeFeatureModeToDag(dag);
    }

    // FASE 1B Bloco A.3 — propagate skill execution_mode to the DAG.
    ensureSkillsLoaded();
    const skillResult = applyBestSkillExecutionMode(dag, planningObjective);
    dag = skillResult.dag;

    return JSON.stringify({
      status: 'plan_ready',
      workspace,
      objective,
      workflow_mode,
      max_total_cost_usd: max_total_cost_usd ?? null,
      task_count: dag.tasks.length,
      pattern_used: patternUsed,
      skill_applied: skillResult.matchedSkill?.name ?? null,
      execution_mode_source: skillResult.matchedSkill ? 'skill' : 'default',
      plan: dag.tasks.map(formatTask),
      dag_json: JSON.stringify(dag),
    });
  } finally {
    db.close();
  }
}
