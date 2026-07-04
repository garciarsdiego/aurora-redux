import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const LINE = '─'.repeat(64);

/**
 * Lean per-task summary for the plan-gate DAG view. Only the fields needed
 * to render a one-line entry per task in the operator's review.
 */
export interface PlanTaskSummary {
  id: string;
  name: string;
  kind: string;
  depends_on: string[];
  timeoutSeconds: number;
  model?: string | null;
  executorHint?: string | null;
  acceptanceCriteria?: string | null;
}

/**
 * Plan-gate context — populated only for the t0 plan-review gate (H11).
 * Lets the operator see the WHOLE DAG before approving execution, not just
 * the t0 task being gated.
 */
export interface PlanContext {
  workflowId: string;
  objective: string;
  tasks: PlanTaskSummary[];
}

/**
 * Rich context shown at the HITL prompt. The decomposer + executor populate
 * this so the operator sees what is being approved instead of only the task
 * name. Telegram + Slack notifications mirror the same fields.
 */
export interface HitlPromptInfo {
  /** Display name of the task being gated. */
  name: string;
  /** llm_call / cli_spawn / pal_call / tool_call. */
  kind: string;
  /** Resolved per-task model id, e.g. "cc/claude-sonnet-4-6", or null when default. */
  model?: string | null;
  /** executor_hint such as "cli:claude-code" / "pal:consensus" — null for plain llm_call. */
  executorHint?: string | null;
  /** Per-task wall-clock cap in seconds. Shown as "max" — not a real estimate. */
  timeoutSeconds?: number;
  /** Falsifiable success criteria the reviewer will check post-execution. */
  acceptanceCriteria?: string | null;
  /** Present only on the plan-review gate (t0) — full DAG for operator review. */
  planContext?: PlanContext;
}

/** Format an integer second count as "30s" / "5min" / "1h 12min" — for prompt display only. */
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
 * Longest path through the DAG by sum of timeout_seconds. Worst-case wall
 * clock if every task on the critical path hits its timeout. Pure DP with
 * memoisation; O(N + E). Returns 0 for empty input or unresolved deps.
 */
export function criticalPathSeconds(tasks: PlanTaskSummary[]): number {
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

/** Render the plan-gate DAG summary block. One row per task. */
function renderPlanContext(ctx: PlanContext, currentTaskName: string): string {
  const lines: string[] = [];
  const total = ctx.tasks.length;
  const cpSec = criticalPathSeconds(ctx.tasks);

  lines.push('');
  lines.push(`   DAG completo proposto (${total} task${total === 1 ? '' : 's'}, caminho crítico ~${formatDuration(cpSec)}):`);
  lines.push('');
  lines.push(`   Objetivo: ${ctx.objective.length > 100 ? ctx.objective.slice(0, 100) + '…' : ctx.objective}`);
  lines.push('');

  // Compute id → label mapping for stable depends_on display
  const idLabel = new Map(ctx.tasks.map((t, i) => [t.id, `t${i}`]));
  const NAME_MAX = 50;
  for (let i = 0; i < ctx.tasks.length; i++) {
    const t = ctx.tasks[i]!;
    const isCurrent = t.name === currentTaskName;
    const marker = isCurrent ? '►' : ' ';
    const label = `t${i}`;
    const dur = formatDuration(t.timeoutSeconds);
    const deps = t.depends_on.length === 0
      ? ''
      : ' deps:' + t.depends_on.map((d) => idLabel.get(d) ?? d).join(',');
    const nameTrunc = t.name.length > NAME_MAX ? t.name.slice(0, NAME_MAX - 1) + '…' : t.name;
    const modelTag = t.model ? ` [${t.model.split('/').pop()}]` : '';
    lines.push(`   ${marker} ${label.padEnd(3)} [${t.kind.padEnd(9)} ${dur.padStart(5)}] ${nameTrunc}${modelTag}${deps}`);
  }

  return lines.join('\n');
}

function renderHeader(info: HitlPromptInfo): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(LINE);
  lines.push('⏸  HITL GATE — aprovação necessária');
  lines.push('');
  lines.push(`   Task:        ${info.name}`);
  lines.push(`   Kind:        ${info.kind}`);
  lines.push(`   Model:       ${info.model ?? '(default — see env DECOMPOSER_MODEL/TASK_MODEL)'}`);
  lines.push(`   CLI / Hint:  ${info.executorHint ?? '(none)'}`);
  lines.push(`   Timeout máx: ${formatDuration(info.timeoutSeconds)} (${info.timeoutSeconds ?? '?'}s)`);
  if (info.acceptanceCriteria && info.acceptanceCriteria.trim() !== '') {
    lines.push('');
    lines.push('   Critério de aceitação:');
    const ac = info.acceptanceCriteria.trim().replace(/\s+/g, ' ');
    const chunks = ac.match(/.{1,70}(\s|$)/g) ?? [ac];
    for (const c of chunks) lines.push(`     ${c.trim()}`);
  }
  if (info.planContext !== undefined) {
    lines.push(renderPlanContext(info.planContext, info.name));
  }
  lines.push(LINE);
  return lines.join('\n');
}

export async function promptApproval(
  info: HitlPromptInfo | string,
): Promise<'approve' | 'reject'> {
  // Back-compat: if caller passed only a name string, render minimal info.
  const opts: HitlPromptInfo = typeof info === 'string'
    ? { name: info, kind: 'unknown' }
    : info;

  const rl = createInterface({ input, output });
  try {
    console.log(renderHeader(opts));
    const answer = await rl.question('   Aprovar? [y/N] ');
    const decision = answer.trim().toLowerCase() === 'y' ? 'approve' : 'reject';
    const label = decision === 'approve' ? '✓ Aprovado' : '✗ Rejeitado';
    console.log(`   Decisão: ${label}`);
    console.log(`${LINE}\n`);
    return decision;
  } finally {
    rl.close();
  }
}
