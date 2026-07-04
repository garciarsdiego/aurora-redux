import type Database from 'better-sqlite3';
import type { Task, Workflow } from '../../types/index.js';
import { classifyError } from '../../v2/failover/classifier.js';
import {
  insertEvent,
  loadWorkflowById,
  loadWorkflowTasks,
  setWorkflowMetadata,
} from '../../db/persist.js';
import { existsSync } from 'node:fs';
import { detectProjectType, inferProjectDir, type DetectedProject } from '../projectDetector.js';
import { runFinalValidation, runTestValidation } from '../validator.js';
import { deriveTaskWorktreeRoot } from './upstream.js';
import { getValidator, type ValidatorProfile, type ValidatorResult } from '../../v2/validators/index.js';
import { getMaxConsolidateTimeMs } from '../../utils/config.js';
import { withTimeout } from './internal-utils.js';
import { callOmniroute } from '../../utils/omniroute-call.js';

/**
 * OPP-C1 (H-FINDING-5, 2026-05-23) — Map-reduce consolidation parameters.
 *
 * When a workflow has more than MAP_REDUCE_THRESHOLD completed upstream
 * outputs feeding the consolidator, the legacy single-stage path
 * concatenates everything into one prompt and routinely TIMEOUTs at 600s
 * (T4/T5 tasks in the 2026-05-23 harness eval). Solution: run a MAP step
 * that summarizes each upstream output in parallel using a cheap model,
 * then a REDUCE step using the original consolidator.
 */
const MAP_REDUCE_THRESHOLD = 4;
const MAP_TOKEN_BUDGET = 800;
const MAP_PER_CALL_TIMEOUT_MS = 30_000;
const MAP_MAX_CONCURRENCY = 8;
const DEFAULT_MAP_MODEL = 'cc/claude-haiku-4-5-20251001';

function getMapModel(): string {
  const env = process.env['CONSOLIDATOR_MAP_MODEL'];
  return env && env.trim().length > 0 ? env.trim() : DEFAULT_MAP_MODEL;
}

const MAP_SYSTEM_PROMPT =
  `You are a summarizer. Given a single task output, produce a tight, faithful summary in under ${MAP_TOKEN_BUDGET} tokens. ` +
  'Preserve concrete facts, numbers, decisions, file paths, and any quoted text the next stage will need. ' +
  'Do not editorialize. Do not add a preamble. Just output the summary.';

function buildMapUserPrompt(task: Task): string {
  return [
    `TASK NAME: ${task.name}`,
    `TASK KIND: ${task.kind}`,
    '',
    'TASK OUTPUT:',
    task.output_json ?? '',
    '',
    `Summarize the above for downstream synthesis (<= ${MAP_TOKEN_BUDGET} tokens).`,
  ].join('\n');
}

/**
 * Run a single MAP call with timeout + one retry. On terminal failure,
 * returns a placeholder so the REDUCE step can still proceed (graceful
 * degradation — never let a single map call break consolidation).
 */
async function runMapForTask(task: Task, model: string): Promise<string> {
  const attempt = async (): Promise<string> =>
    withTimeout(
      (signal) =>
        callOmniroute({
          systemPrompt: MAP_SYSTEM_PROMPT,
          userPrompt: buildMapUserPrompt(task),
          model,
          signal,
        }),
      MAP_PER_CALL_TIMEOUT_MS,
      `consolidation_map_${task.id}`,
    );

  try {
    return await attempt();
  } catch (firstErr) {
    try {
      return await attempt();
    } catch (secondErr) {
      const reason =
        secondErr instanceof Error
          ? secondErr.message
          : String(secondErr ?? firstErr ?? 'unknown');
      return `[map-step-failed: ${reason}]`;
    }
  }
}

/**
 * Run MAP calls in parallel with a concurrency cap. Returns an array of
 * summary strings positionally aligned with the input `completed` array.
 */
async function runMapStepBounded(
  completed: Task[],
  model: string,
): Promise<string[]> {
  const results: string[] = new Array(completed.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = nextIndex++;
      if (i >= completed.length) return;
      results[i] = await runMapForTask(completed[i]!, model);
    }
  }

  const workerCount = Math.min(MAP_MAX_CONCURRENCY, completed.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/**
 * Build a new `tasks` array where each completed task's `output_json` is
 * replaced by its MAP summary. Non-completed tasks pass through unchanged
 * so downstream consolidators that inspect status counts still see truth.
 */
function applyMapSummariesToTasks(tasks: Task[], summaries: Map<string, string>): Task[] {
  return tasks.map((t) => {
    const summary = summaries.get(t.id);
    if (summary === undefined) return t;
    return { ...t, output_json: summary };
  });
}

/**
 * Tier 0 Wave 4 (0.10) — Safely merge a new metadata fragment into the
 * existing workflow.metadata JSON blob. Callers that previously called
 * `setWorkflowMetadata(db, id, JSON.stringify({ key: value }))` clobbered
 * unrelated metadata fields. This helper preserves them.
 *
 * Reads the current row from the DB (NOT the in-memory `workflow` arg,
 * which may have stale metadata from when executeWorkflow built it).
 *
 * Returns the merged object so callers can keep their in-memory copy in sync.
 */
function mergeWorkflowMetadata(
  db: Database.Database,
  workflow: Workflow,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const current = loadWorkflowById(db, workflow.id);
  const sourceMetadata: string | null = current?.metadata ?? workflow.metadata;
  const existing = (() => {
    if (!sourceMetadata) return {};
    try {
      const parsed = JSON.parse(sourceMetadata) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch (err) {
      // Malformed metadata — start fresh. Emit a low-noise event so this
      // failure is enumerable (F-D1-2). Never let observability break the
      // metadata merge.
      try {
        insertEvent(db, {
          workflow_id: workflow.id,
          type: 'consolidation_metadata_parse_failed',
          payload: {
            error: (err as Error).message ?? String(err),
            site: 'validation_metadata_merge',
          },
        });
      } catch {
        /* observability failure must not break metadata merge */
      }
      return {};
    }
  })();
  const merged = { ...existing, ...patch };
  const mergedJson = JSON.stringify(merged);
  setWorkflowMetadata(db, workflow.id, mergedJson);
  // Best-effort: keep the caller-supplied workflow object roughly in sync.
  (workflow as { metadata: string | null }).metadata = mergedJson;
  return merged;
}

/**
 * Build a single string by concatenating completed task outputs. Used as
 * input to the v2 validators (which are heuristic and accept a flat string).
 * Only `completed` tasks are considered — failed/skipped contribute nothing.
 */
function assembleCompletedTaskOutputs(tasks: Task[]): string {
  return tasks
    .filter((t) => t.status === 'completed' && typeof t.output_json === 'string' && t.output_json.length > 0)
    .map((t) => t.output_json!)
    .join('\n\n');
}

// Runs the consolidator, persists result in workflow.metadata, emits events.
// Non-fatal: errors are logged as workflow_consolidation_error and the workflow
// still completes. Single-task workflows still record metadata but do not call the LLM.
export async function runConsolidation(
  db: Database.Database,
  workflow: Workflow,
  tasks: Task[],
  doConsolidate: (workflow: Workflow, tasks: Task[]) => Promise<string>,
): Promise<void> {
  // D34.5 Bug A — hung consolidator blocks setWorkflowDone from firing.
  const maxConsolidateTimeMs = getMaxConsolidateTimeMs();

  // OPP-C1 / H-FINDING-5 — two-stage map-reduce for high-fan-in consolidation.
  // When more than MAP_REDUCE_THRESHOLD completed upstream tasks feed the
  // consolidator, summarize each in parallel via a cheap model FIRST, then
  // hand the slimmed task list to the original consolidator. Single-stage
  // path preserved for low-fan-in workflows (no extra cost / latency).
  const completedWithOutput = tasks.filter(
    (t) => t.status === 'completed' && typeof t.output_json === 'string' && t.output_json.length > 0,
  );

  let effectiveTasks: Task[] = tasks;
  if (completedWithOutput.length > MAP_REDUCE_THRESHOLD) {
    const mapModel = getMapModel();
    insertEvent(db, {
      workflow_id: workflow.id,
      type: 'consolidation_map_started',
      payload: {
        upstream_count: completedWithOutput.length,
        threshold: MAP_REDUCE_THRESHOLD,
        map_model: mapModel,
        token_budget: MAP_TOKEN_BUDGET,
        per_call_timeout_ms: MAP_PER_CALL_TIMEOUT_MS,
        max_concurrency: MAP_MAX_CONCURRENCY,
      },
    });

    const summaryMap = new Map<string, string>();
    for (const task of completedWithOutput) {
      // Emit one map_started per task so trace UIs can render per-task progress.
      insertEvent(db, {
        workflow_id: workflow.id,
        task_id: task.id,
        type: 'consolidation_map_started',
        payload: {
          task_id: task.id,
          task_name: task.name,
          map_model: mapModel,
        },
      });
    }

    const mapStart = Date.now();
    const summaries = await runMapStepBounded(completedWithOutput, mapModel);

    let failedCount = 0;
    completedWithOutput.forEach((task, i) => {
      const summary = summaries[i] ?? '';
      const failed = summary.startsWith('[map-step-failed:');
      if (failed) failedCount++;
      summaryMap.set(task.id, summary);
      insertEvent(db, {
        workflow_id: workflow.id,
        task_id: task.id,
        type: 'consolidation_map_completed',
        payload: {
          task_id: task.id,
          task_name: task.name,
          summary_length: summary.length,
          failed,
        },
      });
    });

    insertEvent(db, {
      workflow_id: workflow.id,
      type: 'consolidation_map_completed',
      payload: {
        upstream_count: completedWithOutput.length,
        failed_count: failedCount,
        duration_ms: Date.now() - mapStart,
      },
    });

    effectiveTasks = applyMapSummariesToTasks(tasks, summaryMap);

    insertEvent(db, {
      workflow_id: workflow.id,
      type: 'consolidation_reduce_started',
      payload: {
        upstream_count: completedWithOutput.length,
      },
    });
  }

  const reduceStart = Date.now();
  let output: string;
  try {
    output = await withTimeout(
      (_signal) => doConsolidate(workflow, effectiveTasks),
      maxConsolidateTimeMs,
      `consolidate_${workflow.id}`,
    );
  } catch (err) {
    const classified = classifyError(err);
    const isTimeout = classified.reason === 'timeout';
    insertEvent(db, {
      workflow_id: workflow.id,
      type: isTimeout ? 'workflow_consolidation_timeout' : 'workflow_consolidation_error',
      payload: {
        error: classified.message,
        reason: classified.reason,
        status: classified.status,
        timeout_ms: isTimeout ? maxConsolidateTimeMs : undefined,
      },
    });
    return;
  }

  // OPP-C1 — emit reduce_completed only when the map-reduce branch ran.
  if (completedWithOutput.length > MAP_REDUCE_THRESHOLD) {
    insertEvent(db, {
      workflow_id: workflow.id,
      type: 'consolidation_reduce_completed',
      payload: {
        upstream_count: completedWithOutput.length,
        output_length: output.length,
        duration_ms: Date.now() - reduceStart,
      },
    });
  }

  // Tier 0 Wave 4 (0.10) — merge so a prior validation summary stored on
  // workflow.metadata (e.g. `validation`, `v2_validation`) is preserved.
  mergeWorkflowMetadata(db, workflow, { consolidated_output: output });
  insertEvent(db, {
    workflow_id: workflow.id,
    type: 'workflow_consolidated',
    payload: { output_length: output.length },
  });
}

/**
 * D35 / Tier 0 Wave 4 (0.10) — Orchestrator for the post-execution
 * validation stage. Two layers run here:
 *
 *   1) **v2 profile validator** — always runs for any profile other than
 *      'none' (code/content/data/analysis). Heuristic, fast, off-line:
 *      inspects assembled task outputs against rules per profile
 *      (see src/v2/validators).
 *
 *   2) **Legacy build check (`runFinalValidation`)** — runs only for the
 *      'code' profile AND only when a project path can be detected in
 *      the objective. Spawns claude-code to run `tsc --noEmit` /
 *      `node --check` / `python -m compileall` and self-fix.
 *
 * For 'code' profile both layers must pass when the legacy layer runs;
 * for non-'code' profiles only the v2 validator gates pass/fail.
 *
 * Silently skips entirely when `DISABLE_FINAL_VALIDATION=true`.
 * On failure: records a metadata flag on the workflow but does NOT throw.
 * Callers can check `workflow.metadata.validation` in post-processing.
 */
/**
 * Resolve the directory the code-profile validators (build check + tests) should
 * inspect. Prefers the worktree where a completed cli_spawn task actually wrote
 * code (data/worktrees/...) over the path parsed from the objective text — the
 * objective path is usually the unedited source, since worktree changes are not
 * merged back before consolidation. Falls back to the objective path (legacy
 * behaviour) only when no cli_spawn worktree exists on disk. Returns null when
 * neither is available.
 */
function resolveCodeValidationRoot(
  db: Database.Database,
  wfId: string,
  objective: string,
): { rootDir: string; source: 'cli_spawn_worktree' | 'objective_path' } | null {
  const tasks = loadWorkflowTasks(db, wfId);
  for (const t of tasks) {
    if (t.kind !== 'cli_spawn') continue;
    const worktree = deriveTaskWorktreeRoot(t, wfId);
    if (worktree && existsSync(worktree)) {
      return { rootDir: worktree, source: 'cli_spawn_worktree' };
    }
  }
  const objRoot = inferProjectDir(objective);
  if (objRoot && existsSync(objRoot)) {
    return { rootDir: objRoot, source: 'objective_path' };
  }
  return null;
}

export async function runFinalValidationStep(
  db: Database.Database,
  workflow: Workflow,
  objective: string,
): Promise<void> {
  if (process.env['DISABLE_FINAL_VALIDATION'] === 'true') return;

  // Tier 0 Wave 4 (0.10) — re-read the workflow row from the DB. The
  // in-memory `workflow` param is built in executeWorkflow with
  // `metadata: null` (and so does not see metadata set by a previous
  // run-level setter or pre-insert). Falling back to the in-memory
  // object guarantees this still works in pure unit tests.
  const dbWorkflow = loadWorkflowById(db, workflow.id);
  const metadataSource: string | null = dbWorkflow?.metadata ?? workflow.metadata;

  // Resolve validator profile from workflow metadata (default: 'code').
  let validatorProfile: ValidatorProfile = 'code';
  if (metadataSource) {
    try {
      const meta = JSON.parse(metadataSource) as Record<string, unknown>;
      if (typeof meta['validator_profile'] === 'string') {
        validatorProfile = meta['validator_profile'] as ValidatorProfile;
      }
    } catch (err) {
      // Malformed metadata — keep default. Emit a low-noise event so this
      // failure is enumerable (F-D1-2). Never let observability break validation.
      try {
        insertEvent(db, {
          workflow_id: workflow.id,
          type: 'consolidation_metadata_parse_failed',
          payload: {
            error: (err as Error).message ?? String(err),
            site: 'validator_profile_lookup',
          },
        });
      } catch {
        /* observability failure must not break validation step */
      }
    }
  }

  const validatorFn = getValidator(validatorProfile);
  // 'none' profile opts out of validation entirely.
  if (validatorFn === null) {
    insertEvent(db, {
      workflow_id: workflow.id,
      type: 'workflow_validation_skipped',
      payload: { reason: 'profile_none', profile: validatorProfile },
    });
    return;
  }

  insertEvent(db, {
    workflow_id: workflow.id,
    type: 'validator_invoked',
    payload: { profile: validatorProfile },
  });

  // ---------------------------------------------------------------------
  // Layer 1 — v2 profile validator (always runs for code/content/data/analysis)
  // ---------------------------------------------------------------------
  let v2Result: ValidatorResult;
  try {
    const completedTasks = loadWorkflowTasks(db, workflow.id);
    const assembled = assembleCompletedTaskOutputs(completedTasks);
    v2Result = validatorFn(assembled);
  } catch (err) {
    // The v2 validators are pure heuristics — they should not throw. If one
    // does (e.g. an unexpected runtime), treat it as a non-fatal validator
    // error and record the issue without halting the workflow.
    const msg = err instanceof Error ? err.message : String(err);
    insertEvent(db, {
      workflow_id: workflow.id,
      type: 'validator_failed',
      payload: {
        profile: validatorProfile,
        layer: 'v2',
        reason: 'validator_threw',
        error: msg,
      },
    });
    v2Result = { passed: false, message: `validator threw: ${msg}` };
  }

  insertEvent(db, {
    workflow_id: workflow.id,
    type: v2Result.passed ? 'validator_passed' : 'validator_failed',
    payload: {
      profile: validatorProfile,
      layer: 'v2',
      message: v2Result.message,
    },
  });

  // ---------------------------------------------------------------------
  // Layer 2 — legacy build check (code profile only, when a project is
  // detectable in the objective).
  // ---------------------------------------------------------------------
  let legacyResult: {
    passed: boolean;
    summary: string;
    attempts: number;
    project_type?: string;
    root_dir?: string;
  } | null = null;

  // Layer 3 — Aurora-parity Wave 1: run the project's OWN tests under a
  // constrained profile + self-fix. Only gates when it actually ran (a test
  // command was detected and DISABLE_TEST_VALIDATION is not set). Runs AFTER the
  // build check so deps installed by Layer 2 are present for the test command.
  let testResult: {
    passed: boolean;
    summary: string;
    attempts: number;
    ran: boolean;
    command: string | null;
    error?: boolean;
  } | null = null;

  if (validatorProfile === 'code') {
    // Aurora-parity Wave 1 (review HIGH): validate WHERE THE CODE LANDED.
    // cli_spawn tasks write to an isolated per-workflow worktree
    // (data/worktrees/...), NOT the objective-text path — so prefer a completed
    // cli_spawn task's worktree and fall back to a path named in the objective
    // only when no worktree exists. Detect the project type from that real root
    // so the build + test layers don't validate a stale/empty tree.
    const codeRoot = resolveCodeValidationRoot(db, workflow.id, objective);
    const projectType = codeRoot ? detectProjectType(codeRoot.rootDir) : null;
    if (codeRoot && projectType) {
      const project: DetectedProject = { type: projectType, rootDir: codeRoot.rootDir };
      insertEvent(db, {
        workflow_id: workflow.id,
        type: 'validator_code_root_resolved',
        payload: { root_dir: codeRoot.rootDir, source: codeRoot.source, project_type: projectType },
      });
      try {
        const result = await runFinalValidation(db, workflow, project);
        legacyResult = {
          passed: result.passed,
          summary: result.summary,
          attempts: result.attempts,
          project_type: project.type,
          root_dir: project.rootDir,
        };
      } catch (err) {
        // Never let legacy validation errors crash the workflow.
        const msg = err instanceof Error ? err.message : String(err);
        insertEvent(db, {
          workflow_id: workflow.id,
          type: 'workflow_validation_error',
          payload: { error: msg },
        });
        legacyResult = {
          passed: false,
          summary: `legacy validation threw: ${msg}`,
          attempts: 0,
        };
      }

      try {
        const t = await runTestValidation(db, workflow, project);
        testResult = {
          passed: t.passed,
          summary: t.summary,
          attempts: t.attempts,
          ran: t.ran,
          command: t.command,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        insertEvent(db, {
          workflow_id: workflow.id,
          type: 'workflow_test_validation_error',
          payload: { error: msg },
        });
        // error:true distinguishes a crashed run from "no tests found" (both ran=false).
        testResult = { passed: false, summary: `test validation threw: ${msg}`, attempts: 0, ran: false, command: null, error: true };
      }
    }
    // No code root / detectable type → legacy + test layers are N/A.
  }

  // ---------------------------------------------------------------------
  // Merge all layers and persist a single `validation` summary on metadata.
  // For 'code' profile, each layer gates ONLY when it actually ran.
  // ---------------------------------------------------------------------
  let overallPassed = v2Result.passed;
  if (validatorProfile === 'code') {
    if (legacyResult !== null) overallPassed = overallPassed && legacyResult.passed;
    if (testResult !== null && testResult.ran) overallPassed = overallPassed && testResult.passed;
  }

  mergeWorkflowMetadata(db, workflow, {
    validation: {
      passed: overallPassed,
      profile: validatorProfile,
      v2: {
        passed: v2Result.passed,
        message: v2Result.message,
      },
      legacy: legacyResult,
      tests: testResult,
    },
  });
}
