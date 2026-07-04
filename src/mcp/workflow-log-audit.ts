import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

import { insertEvent } from '../db/persist.js';
import { buildWorkflowDebugLog, type WorkflowDebugLog } from '../db/workflow-debug-log.js';
import { safeRecordAdvisorContextReview } from '../context/advisors.js';
import { runAdvisorTool } from './tools/advisor_tools.js';
import { adjustDashboardTaskWithAi } from './dashboard-task-ops.js';

export type WorkflowLogAuditRunMode = 'dry-run' | 'approved-run';
export type WorkflowLogAuditApprovalStatus = 'not_required' | 'approved' | 'missing';
export type WorkflowLogAuditStatus = 'completed' | 'failed';
export type WorkflowLogAuditApplicationStatus = 'not_requested' | 'applied' | 'not_applicable' | 'failed';

export interface WorkflowLogAuditInput {
  run_mode?: WorkflowLogAuditRunMode;
  requested_by?: string;
  approved_by?: string;
  instruction?: string;
}

export interface WorkflowLogAuditResult {
  workflow_id: string;
  audit_id: string;
  run_mode: WorkflowLogAuditRunMode;
  dry_run: boolean;
  approved_run: boolean;
  approval_status: WorkflowLogAuditApprovalStatus;
  audit_status: WorkflowLogAuditStatus;
  application_status: WorkflowLogAuditApplicationStatus;
  audit_event: string;
  debug_log_hash: string;
  output: string;
  target_task_id: string | null;
  adjustment: unknown | null;
  structured_error_count: number;
}

export interface WorkflowLogAuditDeps {
  advisorRunner?: (args: unknown, log: WorkflowDebugLog) => Promise<string>;
  adjuster?: (
    db: Database.Database,
    workflowId: string,
    taskId: string,
    raw: unknown,
  ) => Promise<unknown>;
  advisorTimeoutMs?: number;
}

const DEFAULT_ADVISOR_TIMEOUT_MS = 60_000;
const MIN_ADVISOR_TIMEOUT_MS = 1_000;
const MAX_ADVISOR_TIMEOUT_MS = 10 * 60_000;

function parseInput(raw: unknown): Required<Pick<WorkflowLogAuditInput, 'requested_by'>> & WorkflowLogAuditInput {
  const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const runMode = input['run_mode'] === 'approved-run' ? 'approved-run' : 'dry-run';
  return {
    run_mode: runMode,
    requested_by: typeof input['requested_by'] === 'string' && input['requested_by'].trim()
      ? input['requested_by'].trim()
      : 'dashboard',
    approved_by: typeof input['approved_by'] === 'string' && input['approved_by'].trim()
      ? input['approved_by'].trim()
      : undefined,
    instruction: typeof input['instruction'] === 'string' && input['instruction'].trim()
      ? input['instruction'].trim()
      : undefined,
  };
}

function digestLog(log: WorkflowDebugLog): string {
  return createHash('sha256').update(JSON.stringify(log)).digest('hex');
}

function buildAdvisorArgs(log: WorkflowDebugLog, instruction?: string): unknown {
  const eventTail = log.events.slice(-120);
  const terminalTail = log.terminal_lines.slice(-180);
  const taskSummary = log.tasks.map((task) => ({
    id: task['id'],
    name: task['name'],
    status: task['status'],
    kind: task['kind'],
    model: task['model'] ?? null,
    executor_hint: task['executor_hint'] ?? null,
  }));

  return {
    mode: 'oneshot',
    step_number: 1,
    total_steps: 1,
    next_step_required: false,
    confidence: 'medium',
    step: [
      'Audit this Omniforge workflow execution log.',
      'Find the likely root cause, explain the failure chain, and propose concrete workflow/task adjustments.',
      'Do not ask for secrets. Do not include credentials. Treat the supplied log as already redacted.',
      instruction ? `Operator instruction: ${instruction}` : '',
    ].filter(Boolean).join('\n'),
    findings: JSON.stringify({
      workflow: log.workflow,
      control_state: log.control_state,
      tasks: taskSummary,
      structured_errors: log.structured_errors,
      terminal_tail: terminalTail,
      events_tail: eventTail,
      model_calls: log.model_calls,
    }, null, 2).slice(0, 60_000),
    files_checked: [],
    relevant_files: [],
    relevant_context: ['workflow-debug-log', 'dashboard-workflow-controls'],
    hypothesis: log.structured_errors[0]?.message ?? 'Workflow failure requires log audit.',
  };
}

function defaultAdvisorRunner(workflowId: string, workspace: string) {
  return async (args: unknown): Promise<string> =>
    runAdvisorTool('omniforge_debug', args, {
      workspace,
      workflow_id: workflowId,
      mode: 'oneshot',
    });
}

function resolveAdvisorTimeoutMs(override?: number): number {
  if (typeof override === 'number' && Number.isFinite(override)) {
    return Math.max(MIN_ADVISOR_TIMEOUT_MS, Math.min(MAX_ADVISOR_TIMEOUT_MS, Math.floor(override)));
  }
  const raw = process.env.OMNIFORGE_LOG_AUDIT_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_ADVISOR_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_ADVISOR_TIMEOUT_MS;
  return Math.max(MIN_ADVISOR_TIMEOUT_MS, Math.min(MAX_ADVISOR_TIMEOUT_MS, parsed));
}

class WorkflowLogAuditTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`LLM log audit timed out after ${timeoutMs}ms`);
    this.name = 'WorkflowLogAuditTimeoutError';
  }
}

async function runAdvisorWithTimeout(
  advisorRunner: (args: unknown, log: WorkflowDebugLog) => Promise<string>,
  args: unknown,
  log: WorkflowDebugLog,
  timeoutMs: number,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      advisorRunner(args, log),
      new Promise<string>((_, reject) => {
        timer = setTimeout(() => reject(new WorkflowLogAuditTimeoutError(timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function selectAdjustmentTarget(db: Database.Database, workflowId: string): string | null {
  const row = db.prepare(
    `SELECT id
       FROM tasks
      WHERE workflow_id = ?
        AND status IN ('failed', 'failover', 'pending', 'waiting', 'skipped')
      ORDER BY
        CASE status
          WHEN 'failed' THEN 0
          WHEN 'failover' THEN 1
          WHEN 'pending' THEN 2
          WHEN 'waiting' THEN 3
          ELSE 4
        END,
        created_at ASC
      LIMIT 1`,
  ).get(workflowId) as { id: string } | undefined;
  return row?.id ?? null;
}

function safePreview(text: string): string {
  return text.length > 2000 ? `${text.slice(0, 2000)}...` : text;
}

export async function auditWorkflowDebugLog(
  db: Database.Database,
  workflowId: string,
  raw: unknown,
  deps: WorkflowLogAuditDeps = {},
): Promise<WorkflowLogAuditResult> {
  const input = parseInput(raw);
  const runMode = input.run_mode ?? 'dry-run';
  const approvedRun = runMode === 'approved-run';
  const approvalStatus: WorkflowLogAuditApprovalStatus = approvedRun
    ? input.approved_by
      ? 'approved'
      : 'missing'
    : 'not_required';

  if (approvalStatus === 'missing') {
    throw new Error('approved-run requires approved_by');
  }

  const auditId = `audit_${randomUUID()}`;
  const log = buildWorkflowDebugLog(db, workflowId);
  const workspace = String(log.workflow['workspace'] ?? 'internal');
  const logHash = digestLog(log);

  insertEvent(db, {
    workflow_id: workflowId,
    type: 'workflow_log_audit_requested',
    payload: {
      audit_id: auditId,
      run_mode: runMode,
      approval_status: approvalStatus,
      requested_by: input.requested_by,
      approved_by: input.approved_by ?? null,
      debug_log_hash: logHash,
      structured_error_count: log.structured_errors.length,
    },
  });

  const advisorRunner = deps.advisorRunner ?? defaultAdvisorRunner(workflowId, workspace);
  const advisorTimeoutMs = resolveAdvisorTimeoutMs(deps.advisorTimeoutMs);
  let output = '';
  let auditStatus: WorkflowLogAuditStatus = 'completed';
  try {
    output = await runAdvisorWithTimeout(
      advisorRunner,
      buildAdvisorArgs(log, input.instruction),
      log,
      advisorTimeoutMs,
    );
  } catch (err) {
    auditStatus = 'failed';
    if (err instanceof WorkflowLogAuditTimeoutError) {
      output = [
        err.message,
        'Suggested action: export the debugger log, inspect the first structured error, then retry the audit with a narrower instruction or increase OMNIFORGE_LOG_AUDIT_TIMEOUT_MS.',
      ].join('\n');
    } else {
      output = err instanceof Error ? err.message : String(err);
    }
  }

  let targetTaskId: string | null = null;
  let adjustment: unknown | null = null;
  let applicationStatus: WorkflowLogAuditApplicationStatus = approvedRun ? 'not_applicable' : 'not_requested';

  if (approvedRun && auditStatus === 'completed') {
    targetTaskId = selectAdjustmentTarget(db, workflowId);
    if (targetTaskId) {
      try {
        const adjuster = deps.adjuster ?? adjustDashboardTaskWithAi;
        adjustment = await adjuster(db, workflowId, targetTaskId, {
          instruction: [
            'Apply the following approved workflow log audit to make the selected task more likely to succeed on retry.',
            output,
          ].join('\n\n').slice(0, 8_000),
          apply: true,
        });
        applicationStatus =
          adjustment &&
          typeof adjustment === 'object' &&
          (adjustment as { applied?: unknown }).applied === true
            ? 'applied'
            : 'not_applicable';
      } catch (err) {
        applicationStatus = 'failed';
        adjustment = {
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }

  insertEvent(db, {
    workflow_id: workflowId,
    task_id: targetTaskId,
    type: 'workflow_log_audit_completed',
    payload: {
      audit_id: auditId,
      run_mode: runMode,
      approval_status: approvalStatus,
      audit_status: auditStatus,
      application_status: applicationStatus,
      target_task_id: targetTaskId,
      output_preview: safePreview(output),
      debug_log_hash: logHash,
    },
  });

  safeRecordAdvisorContextReview(db, {
    workspace,
    runId: workflowId,
    taskId: targetTaskId,
    advisorName: 'workflow-log-audit',
    outcome: auditStatus === 'completed'
      ? approvedRun && applicationStatus === 'applied'
        ? 'retry'
        : 'audit'
      : 'note',
    summary: [
      `audit_id: ${auditId}`,
      `run_mode: ${runMode}`,
      `approval_status: ${approvalStatus}`,
      `audit_status: ${auditStatus}`,
      `application_status: ${applicationStatus}`,
      `debug_log_hash: ${logHash}`,
      '',
      safePreview(output),
    ].join('\n'),
    recommendation: approvedRun
      ? 'Approved-run audit was recorded with approval metadata; inspect the adjustment before retrying the task.'
      : 'Dry-run audit only. Review the recommendation before approving any task adjustment.',
    metadata: {
      audit_id: auditId,
      run_mode: runMode,
      approval_status: approvalStatus,
      audit_status: auditStatus,
      application_status: applicationStatus,
      debug_log_hash: logHash,
      requested_by: input.requested_by,
      approved_by: input.approved_by ?? null,
    },
  });

  return {
    workflow_id: workflowId,
    audit_id: auditId,
    run_mode: runMode,
    dry_run: runMode === 'dry-run',
    approved_run: approvedRun,
    approval_status: approvalStatus,
    audit_status: auditStatus,
    application_status: applicationStatus,
    audit_event: 'workflow_log_audit_completed',
    debug_log_hash: logHash,
    output,
    target_task_id: targetTaskId,
    adjustment,
    structured_error_count: log.structured_errors.length,
  };
}
