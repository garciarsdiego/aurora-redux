import { z } from 'zod';
import { initDb } from '../../db/client.js';
import { decompose } from '../../brain/decomposer.js';
import { executeWorkflow, HitlModifyError, type WorkflowProgressEvent } from '../../brain/executor.js';
import { matchPattern } from '../../brain/patternMatcher.js';
import { listPatterns, bumpPatternUsage } from '../../patterns/store.js';
import {
  newWorkflowId,
  insertWorkflow,
  insertEvent,
  findExecutingWorkflow,
  loadWorkflowTasks,
  setWorkflowDone,
} from '../../db/persist.js';
import { recordWorkflowCliPermissionMode } from '../../db/workflow-cli-permission.js';
import { getDbPath, getMaxPlanModifications } from '../../utils/config.js';
import { loadWorkspaceEnv, VALID_WORKSPACE_RE } from '../../utils/workspace.js';
import type { Dag, Workflow } from '../../types/index.js';
import { notifyTelegram } from '../../utils/telegram-notify.js';
import { redactContextText } from '../../context/redaction.js';
import { scanForInjection } from '../../v2/injection-scan/index.js';
import { loadSkillsFromDir } from '../../v2/skills/registry.js';
import { applyBestSkillExecutionMode } from '../../v2/skills/apply-to-dag.js';
import { runSkillsPreflight, type PermissionAction } from '../../v2/skills/preflight.js';
import { detectTriggers, suggestSpecialistAdvisor } from '../../v2/triggers/auto-route.js';
import { resolve as resolvePath } from 'node:path';
import { withCliPermissionMode, type CliPermissionMode } from '../../executors/cli.js';
import { eventBroker } from '../event-broker.js';
import {
  applyExistingCodeFeatureModeToDag,
  buildArchitectureContractFromProjectRoot,
  existingCodePlanningInstruction,
  recordArchitectureContract,
  type WorkflowMode,
} from '../../workflow-modes/existing-code-feature.js';

// Keeps background promises alive so they are not GC'd before finishing.
const bgExecutions = new Map<string, Promise<void>>();

// M1 Wave 2 (2026-05-12): test-only accessor for the in-flight map.
// The pickup loop module (src/quality/remediation-pickup.ts) does NOT use
// this directly — it dispatches via `continueWorkflowExecution` against a
// child workflow whose tasks already exist in DB. We keep the export
// available for callers that need fire-and-forget execution of a
// freshly-decomposed DAG without going through the MCP request shape.
export function getInFlightBackgroundExecutions(): ReadonlyMap<string, Promise<void>> {
  return bgExecutions;
}

// FASE 1B Bloco A.3 wire-up — load SKILL.md files from disk once per process
// so the skill matcher has a corpus to choose from. Idempotent.
let _skillsLoaded = false;
function ensureSkillsLoaded(): void {
  if (_skillsLoaded) return;
  const dir = process.env.OMNIFORGE_SKILLS_DIR ?? 'hermes/skills';
  loadSkillsFromDir(dir);
  _skillsLoaded = true;
}

function findHitlModifyError(err: unknown): HitlModifyError | null {
  if (err instanceof HitlModifyError) return err;
  if (err instanceof Error && err.cause) return findHitlModifyError(err.cause);
  return null;
}

function onWorkflowEvent(event: WorkflowProgressEvent): void {
  const wfId = event.workflow_id;
  eventBroker.publish(wfId, event);
  let text: string;
  switch (event.type) {
    case 'workflow_started': {
      const total = event.payload.total as number;
      text = `▶ Workflow \`${wfId}\` iniciado — *${total}* tarefas enfileiradas`;
      break;
    }
    case 'batch_completed': {
      const done = event.payload.completed_tasks as string[];
      const remaining = event.payload.remaining as number;
      if (done.length === 0) return;
      const doneList = done.map((n) => `_${n}_`).join(', ');
      text = remaining > 0
        ? `✅ ${doneList} — faltam *${remaining}*`
        : `✅ ${doneList} — todas concluídas`;
      break;
    }
    case 'workflow_completed': {
      const total = event.payload.total as number;
      text = `🎉 Workflow \`${wfId}\` concluído! *${total}* tarefas executadas`;
      break;
    }
    default:
      return;
  }
  void notifyTelegram(text); // Result is fire-and-forget, error is logged internally
}

/**
 * M1 Wave 2 (2026-05-12) — extracted named export.
 *
 * Background workflow execution. Owns:
 *   - Opening its own DB handle (callers do not pass one in — keeping the
 *     handle private avoids races with whatever DB the caller uses).
 *   - The HITL `modify` retry loop (re-decompose and re-execute up to
 *     `maxPlanModifications` times).
 *   - Persisting `workflow_background_error` + `setWorkflowDone(failed)`
 *     on terminal failure so the workflow row never stays stuck in
 *     'executing'.
 *   - Sending success / failure Telegram notifications.
 *   - Registering the in-flight promise on `bgExecutions` so the daemon
 *     can wait for in-flight work during graceful shutdown.
 *   - Closing the background DB handle in `.finally` regardless of outcome.
 *
 * Callers (current):
 *   - `runWorkflowTool` (MCP `omniforge_run_workflow`) — primary user.
 *   - `pickupPendingRemediationWorkflows` (daemon startup pickup) — uses
 *     this for parity but typically calls `continueWorkflowExecution`
 *     directly because the child's tasks already exist in DB. The export
 *     is kept available for future callers that DO want to dispatch a
 *     freshly-decomposed DAG without re-implementing the lifecycle.
 *
 * Errors: caught and audited. Never throws to the caller.
 */
export interface ExecuteWorkflowInBackgroundOptions {
  /** Workflow id — must already exist in the workflows table. */
  wfId: string;
  /** DAG to execute. */
  dag: Dag;
  /** Workspace name. */
  workspace: string;
  /** Original objective string (preserved across HITL modify retries). */
  objective: string;
  /** Whether to auto-approve all HITL gates. */
  autoApprove: boolean;
  /** Pattern id to bump on success. */
  patternId: string | undefined;
  /** Workflow-level cost cap. */
  maxTotalCostUsd: number | null;
  /** Wall-clock workflow timeout in seconds. */
  maxDurationSeconds: number | null;
  /** CLI permission mode toggle ('safe' | 'autonomous'). */
  cliPermissionMode: CliPermissionMode | undefined;
  /** Streaming event handler invoked for each WorkflowProgressEvent. */
  onEvent: (event: WorkflowProgressEvent) => void;
}

export function executeWorkflowInBackground(
  opts: ExecuteWorkflowInBackgroundOptions,
): Promise<void> {
  const {
    wfId,
    dag,
    workspace,
    objective,
    autoApprove,
    patternId,
    maxTotalCostUsd,
    maxDurationSeconds,
    cliPermissionMode,
    onEvent,
  } = opts;

  const bgDb = initDb(getDbPath());

  const run = async (): Promise<void> => {
    const maxPlanModifications = getMaxPlanModifications();
    let modCount = 0;
    let currentDag = dag;
    let currentObjective = objective;

    for (;;) {
      try {
        const wf = await executeWorkflow(bgDb, currentDag, workspace, currentObjective, {
          pre_workflow_id: modCount === 0 ? wfId : undefined,
          pattern_id: patternId,
          autoApprove,
          max_total_cost_usd: maxTotalCostUsd,
          max_duration_seconds: maxDurationSeconds,
          onEvent,
        });
        if (patternId) bumpPatternUsage(bgDb, patternId);
        void notifyTelegram(`🎉 Workflow \`${wf.id}\` concluído!`); // Result is fire-and-forget, error is logged internally
        break;
      } catch (err) {
        const modifyErr = findHitlModifyError(err);
        if (modifyErr && modCount < maxPlanModifications) {
          modCount++;
          currentObjective = `${objective}\n\n---\nMODIFICAÇÃO SOLICITADA (iteração ${modCount}):\n${modifyErr.feedback}`;
          currentDag = await decompose(currentObjective, { workspace, db: bgDb, workflowId: wfId });
          continue;
        }
        insertEvent(bgDb, {
          workflow_id: wfId,
          type: 'workflow_background_error',
          payload: {
            error: err instanceof Error ? err.message : String(err),
            modification_count: modCount,
          },
        });
        setWorkflowDone(bgDb, wfId, 'failed');
        // A4: redact + length-cap err.message before sending to external
        // Telegram server. Raw LLM API errors commonly echo back the
        // request prompt, which can contain secrets/PII.
        const rawMsg = err instanceof Error ? err.message : String(err);
        const safeMsg = redactContextText(rawMsg).slice(0, 400);
        void notifyTelegram(`❌ Workflow \`${wfId}\` falhou em background: ${safeMsg}`); // Result is fire-and-forget, error is logged internally
        break;
      }
    }
  };

  const bgPromise = (
    cliPermissionMode
      ? withCliPermissionMode(cliPermissionMode, run)
      : run()
  ).finally(() => {
    // A6 — wrap bgDb.close() so a throwing close never leaks the
    // bgExecutions map entry. Delete is unconditional; the close error is
    // best-effort logged to stderr to preserve observability.
    try {
      bgDb.close();
    } catch (closeErr) {
      const closeMsg = closeErr instanceof Error ? closeErr.message : String(closeErr);
      process.stderr.write(`[run_workflow] bgDb.close failed for ${wfId}: ${closeMsg}\n`);
    }
    bgExecutions.delete(wfId);
  });

  bgExecutions.set(wfId, bgPromise);
  return bgPromise;
}

export const RunWorkflowSchema = z.object({
  workspace: z.string().regex(VALID_WORKSPACE_RE, 'Invalid workspace name (alphanumeric/underscore/hyphen only)'),
  objective: z.string().min(1),
  auto_approve: z.boolean().optional().default(false),
  precomputed_dag: z.string().optional(),
  workflow_mode: z.enum(['standard', 'existing_code_feature']).optional().default('standard'),
  cli_permission_mode: z.enum(['safe', 'autonomous']).optional(),
  max_total_cost_usd: z.number().nonnegative().nullable().optional(),
  /** Wall-clock timeout for the entire workflow in seconds (60–86400). null = no limit. */
  max_duration_seconds: z.number().int().min(60).max(86400).nullable().optional(),
  /**
   * Optional list of skills the workflow REQUIRES. Each must exist under
   * <workspaceDir>/skills/<name>/SKILL.md (or one level up for global) and pass
   * frontmatter validation. The matched skill from pattern matching is added
   * automatically. See src/v2/skills/preflight.ts for the discovery rules.
   */
  skills_required: z.array(z.string()).optional(),
  /**
   * Optional per-skill permission map: skill name → 'allow' | 'ask' | 'deny'.
   * Use '*' as the catch-all default. 'deny' aborts the workflow during
   * preflight; 'ask' surfaces in events for an operator UI to resolve.
   */
  skills_permission_map: z.record(z.string(), z.enum(['allow', 'ask', 'deny'])).optional(),
});

export type RunWorkflowInput = z.infer<typeof RunWorkflowSchema>;

export async function runWorkflowTool(raw: unknown): Promise<string> {
  const input = RunWorkflowSchema.parse(raw);
  const { workspace, objective, auto_approve, precomputed_dag, workflow_mode, cli_permission_mode, max_total_cost_usd, max_duration_seconds, skills_required, skills_permission_map } = input;
  const workflowMode = workflow_mode as WorkflowMode;
  const planningObjective = workflowMode === 'existing_code_feature'
    ? existingCodePlanningInstruction(objective)
    : objective;
  if (
    auto_approve
    && cli_permission_mode !== 'autonomous'
    && process.env.OMNIFORGE_MCP_ALLOW_AUTO_APPROVE !== 'true'
  ) {
    return JSON.stringify({
      error: 'auto_approve is disabled for MCP run_workflow. Set OMNIFORGE_MCP_ALLOW_AUTO_APPROVE=true to allow it explicitly.',
    });
  }

  // Pre-decomposition injection scan on raw objective. Cheap defense before
  // the LLM ever sees the input. Opt-out via INJECTION_SCAN_OBJECTIVE=false.
  if (process.env.INJECTION_SCAN_OBJECTIVE !== 'false') {
    const objScan = scanForInjection(objective);
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
    // Idempotency applies only to free-form objectives. Explicit DAG execution
    // from the dashboard (import/run/retry) must create a fresh workflow even
    // when the objective text is intentionally similar to the source run.
    if (!precomputed_dag) {
      const existing = findExecutingWorkflow(db, workspace, objective);
      if (existing) {
        const existingTasks = loadWorkflowTasks(db, existing.id);
        return JSON.stringify({
          workflow_id: existing.id,
          status: existing.status,
          task_count: existingTasks.length,
          pattern_used: existing.pattern_id ?? null,
          already_running: true,
          message: 'Use omniforge_get_workflow_status to monitor progress.',
        });
      }
    }

    let dag: Dag;
    let patternId: string | undefined;

    if (precomputed_dag) {
      dag = JSON.parse(precomputed_dag) as Dag;
    } else {
      const patterns = listPatterns(db, workspace);
      const match = await matchPattern(planningObjective, patterns);

      if (match.action === 'use') {
        dag = JSON.parse(match.pattern.dag_json) as Dag;
        patternId = match.pattern.id;
      } else {
        // Wave 5A #1: thread workspace so persona.decomposer pin resolves
        // against the right scope.
        dag = await decompose(planningObjective, { workspace, db });
      }
    }

    if (workflowMode === 'existing_code_feature') {
      dag = applyExistingCodeFeatureModeToDag(dag);
    }

    // FASE 1B Bloco A.3 — apply matched skill's execution_mode to the DAG
    // before persistence. Conservative: only fires when a SKILL.md scores
    // ≥3 token-overlap with the objective. Returns original DAG otherwise.
    ensureSkillsLoaded();
    const skillResult = applyBestSkillExecutionMode(dag, objective);
    dag = skillResult.dag;

    // Skills preflight — validate every required skill (matched + explicit)
    // exists on disk, has valid frontmatter, and is permitted. Aborts the
    // workflow synchronously when any required skill is missing/invalid/denied.
    // Per-workflow permission overrides come from skills_permission_map.
    let preflightResult: Awaited<ReturnType<typeof runSkillsPreflight>> | null = null;
    const skillsToPreflight = new Set<string>(skills_required ?? []);
    if (skillResult.matchedSkill) skillsToPreflight.add(skillResult.matchedSkill.name);

    if (skillsToPreflight.size > 0) {
      const workspaceDir = resolvePath('workspaces', workspace);
      preflightResult = await runSkillsPreflight({
        skillsRequired: Array.from(skillsToPreflight),
        workspaceDir,
        permissionMap: (skills_permission_map ?? {}) as Record<string, PermissionAction>,
      });

      if (!preflightResult.ok) {
        return JSON.stringify({
          error: 'Skills preflight failed — workflow aborted before execution.',
          reasons: preflightResult.errors,
          skills: preflightResult.skills.map((s) => ({
            name: s.name,
            status: s.status,
            permission: s.permission,
            errors: s.errors ?? [],
          })),
        });
      }
    }

    // Camada D: when the DAG contains cli_spawn tasks, the workspace MUST
    // have a usable project_root before we accept the run. Camada C
    // bootstraps a default at boot, but if the operator deleted or
    // misconfigured the workspace metadata, we want a clear up-front error
    // instead of a silent task_worktree_skipped chain mid-flight.
    const hasCliSpawn = dag.tasks.some((t) => t.kind === 'cli_spawn');
    let softwareProjectRoot: string | null = null;
    if (hasCliSpawn || workflowMode === 'existing_code_feature') {
      const wsRow = db.prepare(
        `SELECT metadata_json FROM dashboard_workspaces WHERE name = ?`,
      ).get(workspace) as { metadata_json: string | null } | undefined;
      let metadata: Record<string, unknown> = {};
      try {
        if (wsRow?.metadata_json) {
          const parsed = JSON.parse(wsRow.metadata_json) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            metadata = parsed as Record<string, unknown>;
          }
        }
      } catch { /* malformed metadata — treated as missing */ }
      const target = metadata['software_target'];
      const projectRoot =
        target && typeof target === 'object'
          ? (target as { project_root?: unknown }).project_root
          : undefined;
      softwareProjectRoot = typeof projectRoot === 'string' && projectRoot.length > 0
        ? projectRoot
        : null;
      if (hasCliSpawn && !softwareProjectRoot) {
        return JSON.stringify({
          error:
            'Workspace lacks a valid software_target.project_root — cli_spawn tasks need a git-able project root. ' +
            'Restart the daemon to auto-provision a default, or update the workspace via /api/dashboard/workspaces.',
          workspace,
        });
      }
    }

    // Pre-insert the workflow record so the idempotency check catches retries
    // even before the background execution has a chance to insert it.
    const wfId = newWorkflowId();
    const now = Date.now();
    const workflowRecord: Workflow = {
      id: wfId,
      workspace,
      objective,
      pattern_id: patternId ?? null,
      status: 'executing',
      started_at: now,
      completed_at: null,
      created_at: now,
      created_by: null,
      estimated_cost_usd: null,
      actual_cost_usd: null,
      max_total_cost_usd: max_total_cost_usd ?? null,
      max_duration_seconds: max_duration_seconds ?? null,
      metadata: workflowMode === 'existing_code_feature'
        ? JSON.stringify({ workflow_mode: workflowMode })
        : null,
    };
    insertWorkflow(db, workflowRecord);

    if (workflowMode === 'existing_code_feature' && softwareProjectRoot) {
      try {
        const architectureContract = buildArchitectureContractFromProjectRoot({
          runId: wfId,
          projectRoot: softwareProjectRoot,
          objective,
        });
        recordArchitectureContract(db, {
          runId: wfId,
          contract: architectureContract,
        });
        insertEvent(db, {
          workflow_id: wfId,
          type: 'architecture_contract_recorded',
          payload: {
            workflow_mode: workflowMode,
            app_type: architectureContract.appType,
            project_root: architectureContract.projectRoot,
            state_store_count: architectureContract.existingStateStores.length,
            ui_surface_count: architectureContract.existingUiSurfaces.length,
          },
        });
      } catch (err) {
        insertEvent(db, {
          workflow_id: wfId,
          type: 'architecture_contract_error',
          payload: {
            workflow_mode: workflowMode,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }

    // Telemetry for the skill match (after workflow row exists so FK holds).
    if (skillResult.matchedSkill) {
      insertEvent(db, {
        workflow_id: wfId,
        type: 'skill_execution_mode_applied',
        payload: {
          skill: skillResult.matchedSkill.name,
          execution_mode: skillResult.matchedSkill.execution_mode,
          match_score: skillResult.matchScore ?? null,
        },
      });
    }
    // Telemetry for skills preflight (FK now satisfied — wfId exists in DB).
    if (preflightResult) {
      insertEvent(db, {
        workflow_id: wfId,
        type: 'skills_preflight',
        payload: {
          ok: preflightResult.ok,
          skills: preflightResult.skills.map((s) => ({
            name: s.name,
            status: s.status,
            permission: s.permission,
            source: s.source ?? null,
          })),
          errors: preflightResult.errors,
        },
      });
    }

    // Auto-route triggers — detect content cues in the objective (code blocks,
    // URLs, image/PDF attachments) and surface them as an event so the operator
    // can see which specialist advisor would be relevant. Does NOT alter the
    // DAG; this is observability + future HITL nudge material.
    // See src/v2/triggers/auto-route.ts.
    const triggers = detectTriggers(objective);
    if (triggers.length > 0) {
      const advisorHint = suggestSpecialistAdvisor(triggers);
      insertEvent(db, {
        workflow_id: wfId,
        type: 'triggers_detected',
        payload: {
          count: triggers.length,
          kinds: Array.from(new Set(triggers.map((t) => t.kind))),
          advisor_hint: advisorHint,
          // Cap the per-trigger payload to keep the event row small.
          samples: triggers.slice(0, 5).map((t) => ({
            kind: t.kind,
            payload: t.payload.slice(0, 120),
            specialist_persona_hint: t.specialist_persona_hint ?? null,
          })),
        },
      });
    }
    if (cli_permission_mode) {
      recordWorkflowCliPermissionMode(db, wfId, cli_permission_mode as CliPermissionMode, 'run_workflow');
    }

    // Launch execution in background — returns immediately so MCP never times out.
    // Delegated to the named export below so other callers (e.g. the
    // remediation pickup loop, or a future trigger-based dispatcher) can
    // launch a workflow in background without re-implementing the
    // promise lifecycle (DB handle close + bgExecutions map cleanup + the
    // HITL modify retry loop).
    executeWorkflowInBackground({
      wfId,
      dag,
      workspace,
      objective,
      autoApprove: auto_approve,
      patternId,
      maxTotalCostUsd: max_total_cost_usd ?? null,
      maxDurationSeconds: max_duration_seconds ?? null,
      cliPermissionMode: cli_permission_mode,
      onEvent: onWorkflowEvent,
    });

    return JSON.stringify({
      workflow_id: wfId,
      status: 'started',
      task_count: dag.tasks.length,
      pattern_used: patternId ?? null,
      message: 'Workflow iniciado em background. Use omniforge_get_workflow_status para acompanhar.',
    });
  } finally {
    db.close();
  }
}
