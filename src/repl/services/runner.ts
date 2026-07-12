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
import { errorMessage } from '../utils/errors.js';

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

/**
 * Progress-event sink shared by every run. Plain-text lines go to the
 * outputBuffer, streaming chunks feed the live tokenBuffer (consumed by
 * StreamingMessage), and workflow lifecycle events sync the Zustand store so
 * Header + StatusBar update as soon as we get a workflow id back.
 *
 * Note: workflow failure surfaces as a thrown Error from executeWorkflow, not
 * as a progress event — caught in runWorkflow's try/catch.
 */
function onEvent(ev: WorkflowProgressEvent): void {
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
  switch (ev.type) {
    case 'task_streaming_start': {
      const taskId = (ev.payload as { task_id?: string }).task_id ?? null;
      tokenBuffer.reset(taskId);
      break;
    }
    case 'task_streaming_chunk': {
      const chunk = (ev.payload as { chunk?: string }).chunk;
      if (typeof chunk === 'string') tokenBuffer.push(chunk);
      break;
    }
    case 'task_streaming_end': {
      tokenBuffer.finalize();
      break;
    }
    case 'cli_tool_call': {
      const p = ev.payload as { tool_name?: string; input_summary?: string };
      const tool = p.tool_name ?? 'tool';
      const sum = p.input_summary ?? '';
      appendOutput(`  [cli] ${tool}${sum ? ` ${sum}` : ''}`, 'info');
      break;
    }
    case 'workflow_started': {
      useReplStore.getState().workflow.addWorkflow({ id: ev.workflow_id, status: 'running' });
      useReplStore.getState().workflow.setCurrent(ev.workflow_id);
      break;
    }
    case 'workflow_completed': {
      useReplStore.getState().workflow.upsertTask(ev.workflow_id, {
        id: '__wf__',
        name: 'workflow',
        kind: 'meta',
        status: 'completed',
      });
      break;
    }
    default:
      break;
  }
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

  // Resolve the DAG: try a pattern match first (unless explicitly disabled),
  // then fall back to a single fresh-decompose point.
  let dag: Dag;
  let patternId: string | undefined;
  try {
    let patternDag: Dag | null = null;
    if (opts.noPattern) {
      appendOutput('Skipping pattern matcher (--no-pattern)…', 'info');
    } else {
      const patterns = listPatterns(db, opts.workspace);
      const match = await matchPattern(opts.objective, patterns);
      if (match.action === 'use') {
        appendOutput(`Using pattern: ${match.pattern.name}`, 'info');
        patternDag = JSON.parse(match.pattern.dag_json) as Dag;
        patternId = match.pattern.id;
      } else {
        appendOutput('No pattern match — generating fresh DAG…', 'info');
      }
    }
    if (patternDag) {
      dag = patternDag;
    } else {
      dag = await decompose(opts.objective);
      appendOutput(`DAG ready: ${dag.tasks.length} tasks`, 'info');
    }
  } catch (err) {
    appendOutput(`Decomposer/matcher failed: ${errorMessage(err)}`, 'error');
    throw err;
  }

  let wf;
  try {
    wf = await executeWorkflow(db, dag, opts.workspace, opts.objective, {
      ...(patternId ? { pattern_id: patternId } : {}),
      autoApprove: true,
      onEvent,
    });
  } catch (err) {
    appendOutput(`✗ Workflow failed: ${errorMessage(err)}`, 'error');
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
