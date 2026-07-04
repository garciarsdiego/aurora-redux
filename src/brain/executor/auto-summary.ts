import type Database from 'better-sqlite3';
import type { Task, TaskStatus, ReviewResult } from '../../types/index.js';
import { newTaskId, insertTask } from '../../db/persist.js';
import { bestComboForTask } from '../../v2/omniroute-bridge/index.js';
import { executeTaskWithRetry } from './run-task.js';

// Returns upstream task IDs that qualify for auto-summary:
// output > 10K chars AND ≥2 tasks in readyBatch depend on them.
export function detectFanoutUpstreams(readyBatch: Task[], completedTasks: Task[]): string[] {
  const dependentCount = new Map<string, number>();
  for (const t of readyBatch) {
    for (const dep of t.depends_on) {
      dependentCount.set(dep, (dependentCount.get(dep) ?? 0) + 1);
    }
  }
  const qualifying: string[] = [];
  for (const [upstreamId, count] of dependentCount) {
    if (count < 2) continue;
    const upstream = completedTasks.find(t => t.id === upstreamId);
    if (upstream?.output_json && upstream.output_json.length > 10_000) {
      qualifying.push(upstreamId);
    }
  }
  return qualifying;
}

// Creates and runs an auto-summary task inline (not added to main DAG).
export async function runAutoSummaryTask(
  db: Database.Database,
  upstream: Task,
  dependents: Task[],
  wfId: string,
  workspace: string,
  doExecute: (task: Task, signal?: AbortSignal) => Promise<string>,
  doSleep: (ms: number) => Promise<void>,
): Promise<string> {
  const downstreamNames = dependents.map(t => t.name).join(', ');
  const summaryTask: Task = {
    id: newTaskId(),
    workflow_id: wfId,
    name: `summarize-${upstream.name}-for-fanout`,
    kind: 'llm_call',
    input_json: JSON.stringify({
      objective: `Summarize the following output for downstream consumption by: ${downstreamNames}. Keep key facts, decisions, and data. Be concise.`,
      task_name: `summarize-${upstream.name}-for-fanout`,
      upstream_content: upstream.output_json,
    }),
    output_json: null,
    status: 'pending' as TaskStatus,
    depends_on: [],
    executor_hint: 'cc/claude-haiku-4-5-20251001',
    timeout_seconds: 120,
    max_retries: 1,
    retry_count: 0,
    retry_policy: 'exponential',
    started_at: null,
    completed_at: null,
    created_at: Date.now(),
    acceptance_criteria: null,
    refine_count: 0,
    max_refine: 0,
    refine_feedback: null,
    model: 'cc/claude-haiku-4-5-20251001',
    hitl: false,
  };
  insertTask(db, summaryTask);

  const stubReview = async (): Promise<ReviewResult> => ({ score: 1, feedback: '', passed: true });
  // stubHitl ignores its arg — auto-summary tasks have hitl:false so the gate
  // never fires; the stub exists only to satisfy the typed parameter.
  const stubHitl = async (): Promise<'approve'> => 'approve';

  await executeTaskWithRetry(
    db, summaryTask, wfId, workspace,
    `Summarize for fan-out from ${upstream.name}`,
    doExecute, doSleep, stubReview, 0, 100, stubHitl, true, bestComboForTask,
  );

  return summaryTask.output_json ?? '';
}
