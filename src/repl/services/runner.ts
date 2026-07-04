// runner.ts — REPL → executeWorkflow bridge.
//
// Translates a REPL `/run "objective"` into a real in-process workflow run:
//   1. loadWorkspaceEnv (env vars layered per workspace)
//   2. matchPattern (skip if --no-pattern)
//   3. decompose if no pattern
//   4. executeWorkflow with onEvent → outputBuffer + tokenBuffer
//
// HITL: this commit defers HITL modal wiring. autoApprove defaults to TRUE
// because Example's permission-mode default is "permissivo" (D-2026-04-23
// configuration). When false (explicit /run --no-auto), we throw with a
// pointer to the v0.4 follow-up since the modal-resolver bridge isn't built.
//
// Cancellation: AbortSignal is plumbed through to the executor, but the
// executor's withTimeout pattern only respects its OWN timeout — Ctrl+C from
// the REPL would need the executor to expose a top-level abort. v0.4 work.

import { decompose } from '../../brain/decomposer.js';
import { executeWorkflow } from '../../brain/executor.js';
import { matchPattern } from '../../brain/patternMatcher.js';
import { listPatterns, bumpPatternUsage } from '../../patterns/store.js';
import { loadWorkspaceEnv } from '../../utils/workspace.js';
import { formatProgressLine } from '../../cli/progress-printer.js';
import type { WorkflowProgressEvent } from '../../brain/executor/types.js';
import type { Dag } from '../../types/index.js';
import { appendOutput } from '../state/outputBuffer.js';
import { tokenBuffer } from '../state/tokenBuffer.js';
import { useReplStore } from '../state/store.js';
import { getBootResult } from '../bootstrap.js';

export interface RunOptions {
  readonly objective: string;
  readonly workspace: string;
  readonly autoApprove?: boolean;
  readonly noPattern?: boolean;
  readonly signal?: AbortSignal;
}

export interface RunResult {
  readonly workflowId: string;
  readonly status: string;
  readonly taskCount: number;
  readonly durationMs: number;
}

export async function runWorkflow(opts: RunOptions): Promise<RunResult> {
  const boot = getBootResult();
  if (!boot) {
    throw new Error('runner.runWorkflow called before REPL bootstrap completed');
  }
  const db = boot.db;

  // autoApprove defaults TRUE because the REPL's permission default is
  // "permissivo" (Example decision 2026-04-23). When the HITL modal+resolver
  // bridge lands, we'll flip this to follow session.permissionMode.
  const autoApprove = opts.autoApprove ?? true;
  if (!autoApprove) {
    throw new Error(
      'autoApprove=false not yet supported in REPL runner. ' +
        'HITL modal-resolver bridge ships in v0.4. ' +
        'Use the legacy CLI: `omniforge run "..." --workspace X` for now.',
    );
  }

  // Load workspace env (DECOMPOSER_MODEL etc. may be overridden per workspace).
  loadWorkspaceEnv(opts.workspace);

  const startedAt = Date.now();
  appendOutput(
    `▶ Decomposing: ${opts.objective.slice(0, 100)}${opts.objective.length > 100 ? '…' : ''}`,
    'info',
  );

  // Pattern matching unless explicitly disabled.
  let dag: Dag;
  let patternId: string | undefined;
  if (!opts.noPattern) {
    const patterns = listPatterns(db, opts.workspace);
    try {
      const match = await matchPattern(opts.objective, patterns);
      if (match.action === 'use') {
        appendOutput(`Using pattern: ${match.pattern.name}`, 'info');
        dag = JSON.parse(match.pattern.dag_json) as Dag;
        patternId = match.pattern.id;
      } else {
        appendOutput('No pattern match — generating fresh DAG…', 'info');
        dag = await decompose(opts.objective);
        appendOutput(`DAG ready: ${dag.tasks.length} tasks`, 'info');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendOutput(`Decomposer/matcher failed: ${msg}`, 'error');
      throw err;
    }
  } else {
    appendOutput('Skipping pattern matcher (--no-pattern)…', 'info');
    dag = await decompose(opts.objective);
    appendOutput(`DAG ready: ${dag.tasks.length} tasks`, 'info');
  }

  // Sync the workflow id into the store as soon as we get one back.
  const onEvent = (ev: WorkflowProgressEvent): void => {
    // Plain text progress — formatProgressLine returns null for events that
    // are noise in a line-based view (chunks, batch boundaries with zero
    // remaining).
    const line = formatProgressLine(ev);
    if (line !== null) {
      // Map kind → outputBuffer 'kind' for color hinting.
      const kind: 'output' | 'info' | 'error' =
        ev.type === 'task_failed' ? 'error' :
        ev.type === 'task_completed' || ev.type === 'workflow_completed' ? 'output' :
        'info';
      appendOutput(line, kind);
    }
    // Streaming events feed the live tokenBuffer (consumed by StreamingMessage).
    if (ev.type === 'task_streaming_start') {
      const taskId = (ev.payload as { task_id?: string }).task_id ?? null;
      tokenBuffer.reset(taskId);
    } else if (ev.type === 'task_streaming_chunk') {
      const chunk = (ev.payload as { chunk?: string }).chunk;
      if (typeof chunk === 'string') tokenBuffer.push(chunk);
    } else if (ev.type === 'task_streaming_end') {
      tokenBuffer.finalize();
    } else if (ev.type === 'cli_tool_call') {
      const p = ev.payload as { tool_name?: string; input_summary?: string };
      const tool = p.tool_name ?? 'tool';
      const sum = p.input_summary ?? '';
      appendOutput(`  [cli] ${tool}${sum ? ` ${sum}` : ''}`, 'info');
    } else if (ev.type === 'workflow_started') {
      const wfId = ev.workflow_id;
      // Push the new workflow into the store so Header + StatusBar update.
      useReplStore.getState().workflow.addWorkflow({ id: wfId, status: 'running' });
      useReplStore.getState().workflow.setCurrent(wfId);
    } else if (ev.type === 'workflow_completed') {
      const wfId = ev.workflow_id;
      useReplStore.getState().workflow.upsertTask(wfId, {
        id: '__wf__',
        name: 'workflow',
        kind: 'meta',
        status: 'completed',
      });
    }
    // Note: workflow failure surfaces as a thrown Error from executeWorkflow,
    // not as a progress event — caught in the outer try/catch below.
  };

  let wf;
  try {
    wf = await executeWorkflow(db, dag, opts.workspace, opts.objective, {
      ...(patternId ? { pattern_id: patternId } : {}),
      autoApprove: true,
      onEvent,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendOutput(`✗ Workflow failed: ${msg}`, 'error');
    throw err;
  }

  if (patternId) {
    try { bumpPatternUsage(db, patternId); } catch { /* best-effort */ }
  }

  const durationMs = Date.now() - startedAt;
  appendOutput(
    `✓ Workflow ${wf.id} ${wf.status} in ${Math.round(durationMs / 1000)}s`,
    wf.status === 'completed' ? 'output' : 'error',
  );

  return {
    workflowId: wf.id,
    status: wf.status,
    taskCount: dag.tasks.length,
    durationMs,
  };
}
