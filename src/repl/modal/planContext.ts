// planContext — render-only helpers for HitlModal plan-gate display.
// Mirrors src/hitl/cli.ts (criticalPathSeconds + plan rendering) but returns a
// readonly string[] suitable for Ink <Text> nodes instead of a single console
// dump. Keeping this in its own file lets tests exercise the formatting logic
// without spinning up Ink.

import type { PlanContext } from '../../hitl/cli.js';

const NAME_MAX = 50;
const OBJECTIVE_MAX = 100;

/** Format an integer second count as "30s" / "5min" / "1h 12min". */
export function formatDuration(seconds: number | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes - hours * 60;
  return rem === 0 ? `${hours}h` : `${hours}h ${rem}min`;
}

/**
 * Longest path through the DAG by sum of timeout_seconds. Pure DP with
 * memoisation. Returns 0 for empty input.
 */
export function criticalPathSeconds(
  tasks: readonly PlanContext['tasks'][number][],
): number {
  if (tasks.length === 0) return 0;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const memo = new Map<string, number>();

  function pathTo(id: string): number {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    const t = byId.get(id);
    if (t === undefined) return 0; // dangling dep — defensive, validator forbids
    const deps = t.depends_on.length === 0
      ? 0
      : Math.max(...t.depends_on.map((d) => pathTo(d)));
    const value = deps + (t.timeoutSeconds || 0);
    memo.set(id, value);
    return value;
  }

  return Math.max(...tasks.map((t) => pathTo(t.id)));
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '\u2026';
}

/**
 * Render the plan-gate DAG summary as an array of lines. Caller wraps each in
 * an Ink <Text>. Format mirrors the CLI prompt (src/hitl/cli.ts) so operators
 * who used the legacy CLI gate see the same shape inside the REPL modal.
 */
export function renderPlanContextLines(
  ctx: PlanContext,
  currentTaskName: string,
): readonly string[] {
  const lines: string[] = [];
  const total = ctx.tasks.length;
  const cpSec = criticalPathSeconds(ctx.tasks);

  lines.push('');
  lines.push(
    `DAG completo proposto (${total} task${total === 1 ? '' : 's'}, caminho crítico ~${formatDuration(cpSec)}):`,
  );
  lines.push('');
  lines.push(`Objetivo: ${truncate(ctx.objective, OBJECTIVE_MAX)}`);
  lines.push('');

  // Stable id → label map for depends_on display.
  const idLabel = new Map(ctx.tasks.map((t, i) => [t.id, `t${i}`]));

  for (let i = 0; i < ctx.tasks.length; i++) {
    const t = ctx.tasks[i]!;
    const isCurrent = t.name === currentTaskName;
    const marker = isCurrent ? '\u2605' : ' ';
    const label = `t${i}`;
    const dur = formatDuration(t.timeoutSeconds);
    const deps = t.depends_on.length === 0
      ? ''
      : ' deps:' + t.depends_on.map((d) => idLabel.get(d) ?? d).join(',');
    const nameTrunc = truncate(t.name, NAME_MAX);
    const modelTag = t.model ? ` [${t.model.split('/').pop()}]` : '';
    lines.push(
      `   ${marker} ${label.padEnd(3)} [${t.kind.padEnd(9)} ${dur.padStart(5)}] ${nameTrunc}${modelTag}${deps}`,
    );
  }

  return lines;
}
