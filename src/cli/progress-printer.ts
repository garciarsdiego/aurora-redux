// Live progress printer for the run command + run-wf-from-file script.
// Subscribes to WorkflowProgressEvent emissions from the executor and writes
// human-readable lines to the terminal. Stateless (each event prints one
// line) so safe to use without buffering.

import type { WorkflowProgressEvent } from '../brain/executor/types.js';

const SYM = {
  start: '▶',
  done: '✓',
  fail: '✗',
  trophy: '🎉',
};

function formatMs(ms: number | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec - min * 60;
  if (min < 60) return remSec === 0 ? `${min}m` : `${min}m ${remSec}s`;
  const h = Math.floor(min / 60);
  const remMin = min - h * 60;
  return remMin === 0 ? `${h}h` : `${h}h ${remMin}m`;
}

function shortModel(model: string | null | undefined): string {
  if (!model) return '(default)';
  // 'cc/claude-sonnet-4-6' → 'claude-sonnet-4-6'
  const parts = model.split('/');
  return parts[parts.length - 1] ?? model;
}

function fmtCounter(completed: number, total: number): string {
  const w = String(total).length;
  return `[${String(completed).padStart(w)}/${total}]`;
}

/**
 * Produce a single terminal line for one progress event. Returns null when
 * the event has no human-meaningful representation (e.g. duplicate batch
 * boundaries that the per-task lines already cover).
 */
export function formatProgressLine(ev: WorkflowProgressEvent): string | null {
  const p = ev.payload;
  switch (ev.type) {
    case 'workflow_started': {
      const total = p['total'] as number;
      return `${SYM.start} Workflow iniciado — ${total} task${total === 1 ? '' : 's'}`;
    }
    case 'batch_started': {
      // Per-task lines convey the same info more granularly. Skip the batch
      // banner unless the batch has many parallel tasks (>1 → useful summary).
      const tasks = p['tasks'] as string[] | undefined;
      if (!tasks || tasks.length <= 1) return null;
      const completed = p['completed'] as number;
      const total = p['total'] as number;
      return `\n──── batch paralelo: ${tasks.length} tasks (${completed}/${total} já concluídas) ────`;
    }
    case 'task_started': {
      const name = p['task_name'] as string;
      const kind = p['kind'] as string;
      const model = shortModel(p['model'] as string | null | undefined);
      const completed = p['completed'] as number;
      const total = p['total'] as number;
      return `${fmtCounter(completed, total)} ${SYM.start} ${name}  (${kind}, ${model})`;
    }
    case 'task_completed': {
      const name = p['task_name'] as string;
      const dur = formatMs(p['duration_ms'] as number);
      const completed = p['completed'] as number;
      const total = p['total'] as number;
      return `${fmtCounter(completed, total)} ${SYM.done} ${name}  (${dur})`;
    }
    case 'task_failed': {
      const name = p['task_name'] as string;
      const err = p['error'] as string;
      const dur = formatMs(p['duration_ms'] as number);
      const completed = p['completed'] as number;
      const total = p['total'] as number;
      return `${fmtCounter(completed, total)} ${SYM.fail} ${name}  (${dur}) — ${err.slice(0, 100)}${err.length > 100 ? '…' : ''}`;
    }
    case 'batch_completed': {
      const remaining = p['remaining'] as number;
      // Skip the batch summary unless it brings new info — the per-task
      // completed lines already showed each finish.
      if (remaining === 0) return null;
      return `   ${remaining} task${remaining === 1 ? '' : 's'} restante${remaining === 1 ? '' : 's'}`;
    }
    case 'workflow_completed': {
      const total = p['total'] as number;
      return `\n${SYM.trophy} Workflow concluído — ${total} tasks executadas`;
    }
    case 'workflow_pause_requested':
      return '⏸ Pause solicitado — o workflow vai parar antes da próxima task';
    case 'workflow_paused':
      return '⏸ Workflow pausado antes da próxima task';
    case 'workflow_resume_requested':
      return '▶ Resume solicitado — aguardando daemon continuar';
    case 'workflow_resumed':
      return '▶ Workflow retomado';
    case 'workflow_cancel_requested':
      return '✗ Cancel solicitado — abortando tasks pendentes/em execução';
    case 'workflow_canceled':
      return '✗ Workflow cancelado pelo operador';
    // MC streaming events: legacy CLI progress printer ignores them — chunks
    // are too noisy for a line-based terminal printer (the REPL StreamingMessage
    // component handles them). _start/_end are also implicit in task_started/
    // task_completed for the legacy view, so we suppress them here.
    case 'task_streaming_start':
    case 'task_streaming_chunk':
    case 'task_streaming_end':
    case 'cli_tool_call':
      return null;
    case 'cli_killed_on_cancel': {
      const taskName = (p['task_name'] as string | undefined) ?? 'task';
      const bin = (p['bin'] as string | undefined) ?? 'cli';
      const pid = p['pid'] as number | null | undefined;
      return `${SYM.fail} CLI ${bin} (pid=${pid ?? '?'}) killed on cancel — ${taskName}`;
    }
    default:
      // F7-1: WorkflowProgressEvent['type'] is now `OmniforgeEventType | string`
      // (open union) so the legacy printer treats unknown types the same way
      // it treats streaming chunks — silent no-op. The REPL has its own
      // dedicated rendering for the broader event surface.
      return null;
  }
}

/**
 * Build a printer fn ready to be wired as opts.onEvent. Writes to the given
 * stream (default stdout) and never throws — any formatting issue becomes
 * a stderr warning so the workflow itself is never affected by output bugs.
 */
export function makeProgressPrinter(
  stream: NodeJS.WritableStream = process.stdout,
): (ev: WorkflowProgressEvent) => void {
  return (ev) => {
    try {
      const line = formatProgressLine(ev);
      if (line !== null) stream.write(line + '\n');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[progress-printer] ${msg}\n`);
    }
  };
}
