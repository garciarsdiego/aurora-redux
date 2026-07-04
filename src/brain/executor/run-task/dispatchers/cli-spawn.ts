import type Database from 'better-sqlite3';
import type { Task } from '../../../../types/index.js';
import { insertEvent } from '../../../../db/persist.js';
import { consumeVersionedDefinition } from '../versioned-definition.js';

// Kind-specific preprocessing for `task.kind === 'cli_spawn'`.
// Consumes the worker.cli.<name> versioned-definition pin (when present).
export function dispatchCliSpawnPrep(params: {
  db: Database.Database;
  task: Task;
  workspace: string;
  workflowId: string;
}): void {
  const { db, task, workspace, workflowId } = params;
  if (typeof task.executor_hint !== 'string') return;
  const cliHint = task.executor_hint;
  const cliName = cliHint.startsWith('cli:')
    ? cliHint.slice('cli:'.length).trim()
    : null;
  if (cliName && /^[A-Za-z0-9._-]+$/.test(cliName)) {
    consumeVersionedDefinition(db, {
      workspace,
      kind: 'agent',
      name: `worker.cli.${cliName}`,
      workflowId,
      taskId: task.id,
      role: 'worker_cli_spawn',
    });
  }
}

// Wave 2.2 (F2-4): runtime-session pool acquisition for cli:claude-code on
// existing_code_feature workflows. Emits observability events only; spawn
// integration deferred to a later wave.
export async function tryAcquireClaudeCodeRuntimeSession(params: {
  db: Database.Database;
  task: Task;
  workflowId: string;
  attempt: number;
}): Promise<import('../../../../runtime/process-pool.js').RuntimePoolHandle | null> {
  const { db, task, workflowId, attempt } = params;
  if (task.kind !== 'cli_spawn' || task.executor_hint !== 'cli:claude-code') {
    return null;
  }
  const { getRuntimePoolMode } = await import('../../../../utils/config.js');
  const poolMode = getRuntimePoolMode();
  if (poolMode === 'off') return null;

  try {
    const { tryAcquireRuntimeSession, RuntimePoolEscalationError } = await import(
      '../../../../runtime/process-pool.js'
    );
    // workspace param is the workspace name, not a filesystem path. We forward
    // null here so the runtime store does not record a misleading
    // workspace_path. The live spawn down-call already resolves the
    // worktree-aware execution_context cwd via `prepareWorktreeRoot()` before
    // opening the process — see `runWorkflowLifecycle`.
    const workspacePath: string | null = null;
    let runtimeHandle: import('../../../../runtime/process-pool.js').RuntimePoolHandle | null = null;
    try {
      runtimeHandle = await tryAcquireRuntimeSession(db, {
        workflowId,
        taskId: task.id,
        executorId: 'cli:claude-code',
        protocolTier: 'jsonl-headless',
        streamFormat: 'claude-stream-json',
        workspacePath,
        profile: 'code',
        runMode: 'dry-run',
        approvalStatus: 'not_required',
        auditStatus: 'recorded',
      });
    } catch (escalationErr) {
      if (escalationErr instanceof RuntimePoolEscalationError) {
        insertEvent(db, {
          workflow_id: workflowId,
          task_id: task.id,
          type: 'runtime.session.fallback',
          payload: {
            reason: `escalation_refused: ${escalationErr.message}`,
            executor_hint: task.executor_hint,
            attempt,
          },
        });
        return null;
      }
      throw escalationErr;
    }
    if (runtimeHandle) {
      insertEvent(db, {
        workflow_id: workflowId,
        task_id: task.id,
        type: 'runtime.session.created',
        payload: {
          sessionId: runtimeHandle.sessionId,
          executor: 'cli:claude-code',
          profile: runtimeHandle.profile,
          runMode: runtimeHandle.runMode,
          reused: runtimeHandle.reused,
          attempt,
        },
      });
      return runtimeHandle;
    }
    insertEvent(db, {
      workflow_id: workflowId,
      task_id: task.id,
      type: 'runtime.session.fallback',
      payload: {
        reason: 'pool_unavailable',
        executor_hint: task.executor_hint,
        attempt,
      },
    });
    return null;
  } catch (err) {
    insertEvent(db, {
      workflow_id: workflowId,
      task_id: task.id,
      type: 'runtime.session.fallback',
      payload: {
        reason: err instanceof Error ? err.message : String(err),
        executor_hint: task.executor_hint,
        attempt,
      },
    });
    return null;
  }
}

// Wave D — observability breadcrumb when opencode ACP is the target.
// The actual pool acquire happens inside runCliTask -> runOpencodeViaAcp.
export function emitOpencodeAcpIntentIfApplicable(params: {
  db: Database.Database;
  task: Task;
  workflowId: string;
  attempt: number;
}): void {
  const { db, task, workflowId, attempt } = params;
  if (
    task.kind === 'cli_spawn' &&
    task.executor_hint === 'cli:opencode' &&
    process.env.OMNIFORGE_OPENCODE_TRANSPORT !== 'spawn'
  ) {
    insertEvent(db, {
      workflow_id: workflowId,
      task_id: task.id,
      type: 'runtime.session.intent',
      payload: {
        executor: 'cli:opencode',
        transport: 'acp-stdio',
        via: 'runOpencodeViaAcp',
        attempt,
      },
    });
  }
}
