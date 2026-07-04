import type { Dag } from '../types/index.js';
import { getMaxSequentialTasks } from '../utils/setup-config.js';
// Adapted from Runfusion/Fusion (MIT) — packages/engine/src/scheduler.ts @ 5f6d998
import { pathsOverlap } from '../v2/scheduling/file-scope.js';

export interface ValidationIssue {
  rule: string;
  message: string;
  severity: 'error' | 'warn';
  taskIds?: string[];
  /** Convenience: first id of `taskIds`, present when the issue is scoped to one task. */
  task_id?: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  /** Convenience: `issues.filter(i => i.severity === 'error')`. Same objects, not copies. */
  errors: ValidationIssue[];
  /** Convenience: `issues.filter(i => i.severity === 'warn')`. Same objects, not copies. */
  warnings: ValidationIssue[];
}

const ALLOWED_TASK_KINDS = new Set<string>([
  'llm_call',
  'cli_spawn',
  'tool_call',
  'pal_call',
  'if_else',
  'switch',
  'extract_json',
  'print',
  'loop',
  'merge',
  'transform',
  'evaluator',
]);

function checkTaskKindWhitelist(dag: Dag, issues: ValidationIssue[]): void {
  for (const task of dag.tasks) {
    if (!ALLOWED_TASK_KINDS.has(task.kind as string)) {
      issues.push({
        rule: 'task-kind',
        message: `Task '${task.id}' has invalid kind '${task.kind}'. Allowed: ${[...ALLOWED_TASK_KINDS].sort().join(', ')}.`,
        severity: 'error',
        taskIds: [task.id],
      });
    }
  }
}

// Batch 0.7 (item 3) — warn when an objective contains a literal arithmetic
// expression but the DAG never routes it through the deterministic `calculator`
// tool. An LLM/CLI may compute it wrong, and a baked answer in acceptance_criteria
// would then rubber-stamp the error (the 36795-vs-36845 live finding). Advisory
// (warn) only, and active only when the caller supplies the objective (the
// decomposer does; other callers keep the original behavior).
function checkArithmeticUsesCalculator(
  dag: Dag,
  objective: string | undefined,
  issues: ValidationIssue[],
): void {
  if (!objective) return;
  // digit OP digit, OP in * / % + — '-' is excluded so ranges like "5-10" don't match.
  if (!/\d+\s*[*/%+]\s*\d+/.test(objective)) return;
  if (dag.tasks.some((t) => t.tool_name === 'calculator')) return;
  issues.push({
    rule: 'arithmetic-no-calculator',
    message:
      `Objective contains a literal arithmetic expression but no task uses the ` +
      `deterministic 'calculator' tool. An LLM/CLI may compute it wrong (and a ` +
      `baked answer in criteria would rubber-stamp the error). Prefer a tool_call ` +
      `'calculator' + print pair.`,
    severity: 'warn',
  });
}

export function validateDag(dag: Dag, opts?: { objective?: string }): ValidationResult {
  const issues: ValidationIssue[] = [];
  checkTaskKindWhitelist(dag, issues);
  checkGraphIntegrity(dag, issues);
  checkMaxChainLength(dag, issues);
  checkVagueCriteria(dag, issues);
  checkTaskCount(dag, issues);
  checkAcceptanceCriteriaRatio(dag, issues);
  checkCliSpawnTimeouts(dag, issues);
  checkToolCallArgs(dag, issues);
  checkDeterministicKindArgs(dag, issues);
  checkFileScopeOverlap(dag, issues);
  checkArithmeticUsesCalculator(dag, opts?.objective, issues);
  for (const i of issues) {
    if (i.taskIds && i.taskIds.length > 0 && i.task_id === undefined) {
      i.task_id = i.taskIds[0];
    }
  }
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warn');
  return {
    valid: errors.length === 0,
    issues,
    errors,
    warnings,
  };
}

function checkGraphIntegrity(dag: Dag, issues: ValidationIssue[]): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const task of dag.tasks) {
    if (seen.has(task.id)) duplicates.add(task.id);
    seen.add(task.id);
  }
  if (duplicates.size > 0) {
    issues.push({
      rule: 'graph-integrity',
      message: `Duplicate DAG task id(s): ${[...duplicates].sort().join(', ')}`,
      severity: 'error',
      taskIds: [...duplicates].sort(),
    });
  }

  const ids = new Set(dag.tasks.map((task) => task.id));
  for (const task of dag.tasks) {
    if (task.depends_on.includes(task.id)) {
      issues.push({
        rule: 'graph-integrity',
        message: `Task '${task.id}' depends on itself.`,
        severity: 'error',
        taskIds: [task.id],
      });
    }

    const missing = task.depends_on.filter((dep) => !ids.has(dep));
    if (missing.length > 0) {
      issues.push({
        rule: 'graph-integrity',
        message: `Task '${task.id}' depends on missing task id(s): ${[...new Set(missing)].sort().join(', ')}`,
        severity: 'error',
        taskIds: [task.id, ...missing],
      });
    }
  }

  if (duplicates.size > 0) return;

  const byId = new Map(dag.tasks.map((task) => [task.id, task]));
  const state = new Map<string, 'visiting' | 'visited'>();
  const cycleIds = new Set<string>();

  function visit(id: string, path: string[]): void {
    const current = state.get(id);
    if (current === 'visited') return;
    if (current === 'visiting') {
      const idx = path.indexOf(id);
      for (const cycleId of path.slice(idx >= 0 ? idx : 0)) cycleIds.add(cycleId);
      cycleIds.add(id);
      return;
    }

    const task = byId.get(id);
    if (!task) return;
    state.set(id, 'visiting');
    for (const dep of task.depends_on) visit(dep, [...path, id]);
    state.set(id, 'visited');
  }

  for (const task of dag.tasks) visit(task.id, []);
  if (cycleIds.size > 0) {
    issues.push({
      rule: 'graph-integrity',
      message: `DAG contains a dependency cycle involving: ${[...cycleIds].sort().join(', ')}`,
      severity: 'error',
      taskIds: [...cycleIds].sort(),
    });
  }
}

function checkMaxChainLength(dag: Dag, issues: ValidationIssue[]): void {
  // Compute longest path (in edges + 1) to each node via memoized DFS.
  // dp[id] = length of longest chain ending at that task (single task = 1).
  const dp = new Map<string, number>();

  function longestTo(id: string): number {
    if (dp.has(id)) return dp.get(id)!;
    // Avoid infinite loops on cycles (checkGraphIntegrity reports real cycles separately)
    dp.set(id, 0);
    const task = dag.tasks.find(t => t.id === id);
    if (!task) return 0;
    const parentLengths = task.depends_on.map(longestTo);
    const length = parentLengths.length === 0 ? 1 : 1 + Math.max(...parentLengths);
    dp.set(id, length);
    return length;
  }

  for (const t of dag.tasks) longestTo(t.id);

  const maxChain = dp.size === 0 ? 0 : Math.max(...dp.values());

  // Cap default 10 (Example smoke test 2026-04-30 raised from 7). The original
  // chain of 7 covered:
  //   t0 plan → t1 explore → t2 design → t3 impl (parallel siblings t4/t5)
  //   → t6 integrate → t7 verify
  // But realistic refines like "split tetris into smaller tasks" legitimately
  // need a deeper chain when the operator explicitly asks for granularity:
  //   t0 plan → design → core_logic → renderer → input → scoring →
  //   integrate → polish → verify (9 tasks). Tightening below this rejected
  //   sound decompositions and offered no fallback.
  //
  // Sprint F (Setup gaps): the cap is now operator-tunable via
  // `getMaxSequentialTasks()`, which honors (in order): the
  // OMNIFORGE_MAX_SEQUENTIAL_TASKS env var → `data/setup-config.json` →
  // the historical default of 10. Tightening below 10 lets Example enforce
  // shallower decompositions without editing source.
  const MAX_CHAIN = getMaxSequentialTasks();
  if (maxChain > MAX_CHAIN) {
    issues.push({
      rule: 'max-chain-length',
      message: `Longest sequential chain is ${maxChain} tasks (max allowed: ${MAX_CHAIN}). Decompose differently or parallelize independent steps.`,
      severity: 'error',
    });
  }
}

// Vague continuation words after "should be" / "must be" / "deve ser".
// "must be referenced verbatim" is concrete; "must be correct" is vague —
// the difference is the WORD following "be". Require an explicitly vague
// continuation so we don't reject sentences whose only sin is using a
// modal+copula in front of a falsifiable verb.
const VAGUE_CONTINUATION_EN =
  '(correct|right|good|fine|nice|ok|valid|working|able|proper|reasonable|sensible|clean|robust|complete|accurate|appropriate)';
const VAGUE_CONTINUATION_PT =
  '(bom|boa|correto|correta|certo|certa|ok|bons|boas|bonito|bonita|bonitos|bonitas|adequado|adequada|adequados|adequadas|funcional|funcionais|completo|completa)';

const VAGUE_PATTERNS: RegExp[] = [
  // "should/must be <vague>" — only flag when the continuation is itself vague.
  new RegExp(`\\bshould be ${VAGUE_CONTINUATION_EN}\\b`, 'i'),
  new RegExp(`\\bmust be ${VAGUE_CONTINUATION_EN}\\b`, 'i'),
  // "should/must <vague verb>" — these verbs without an object are vague on their own.
  /\bshould (work|run|pass|succeed|function|look|feel)\b/i,
  /\bmust (work|run|pass|succeed|function|look|feel)\b/i,
  // PT-BR equivalents
  new RegExp(`\\bdev[eo]m? ser ${VAGUE_CONTINUATION_PT}\\b`, 'i'),
  /\bfunciona(m)? (bem|corretamente|adequadamente)\b/i,
  // Verb+adverb pairs that describe behaviour without a measurable bar.
  // Note: standalone "correctly" is intentionally NOT flagged — "indexed
  // correctly", "typed correctly", and "correctly formatted" are all
  // legitimate technical phrases. We only catch the verbs that historically
  // hide a vague spec (renders/works/operates/etc.).
  /\b(works?|renders?|functions?|operates?|behaves?|displays?|performs?|executes?|runs?) correctly\b/i,
  /\b(works?|renders?|functions?|operates?|behaves?|displays?|performs?|executes?|runs?) properly\b/i,
  /\bworks as expected\b/i,
  /\bbehaves as expected\b/i,
  /\bnice\b/i,
  /\bgood (quality|output|result)\b/i,
  /\bis correct\b/i,
];

function checkVagueCriteria(dag: Dag, issues: ValidationIssue[]): void {
  for (const task of dag.tasks) {
    if (!task.acceptance_criteria) continue;
    const crit = task.acceptance_criteria.trim();

    if (crit.length < 20) {
      issues.push({
        rule: 'vague-criteria',
        message: `Task '${task.id}' acceptance_criteria is too short (${crit.length} chars). Write a specific, falsifiable sentence.`,
        severity: 'error',
        taskIds: [task.id],
      });
      continue;
    }

    for (const pattern of VAGUE_PATTERNS) {
      if (pattern.test(crit)) {
        issues.push({
          rule: 'vague-criteria',
          message: `Task '${task.id}' acceptance_criteria appears vague: "${crit}". Use a falsifiable statement (e.g. "exit code 0", "JSON with fields x, y", "≤500 words on topic Z").`,
          severity: 'error',
          taskIds: [task.id],
        });
        break;
      }
    }
  }
}

function checkTaskCount(dag: Dag, issues: ValidationIssue[]): void {
  const n = dag.tasks.length;
  if (n > 20) {
    issues.push({
      rule: 'task-count',
      message: `DAG has ${n} tasks (max: 20). Split into sub-objectives or aggregate fine-grained tasks.`,
      severity: 'error',
    });
  } else if (n > 12) {
    issues.push({
      rule: 'task-count',
      message: `DAG has ${n} tasks (recommended: ≤12). Consider whether all are necessary.`,
      severity: 'warn',
    });
  }
}

function checkAcceptanceCriteriaRatio(dag: Dag, issues: ValidationIssue[]): void {
  const nonT0Tasks = dag.tasks.filter(t => t.id !== 't0');
  if (nonT0Tasks.length === 0) return;

  const meaningful = nonT0Tasks.filter(t => {
    const c = (t.acceptance_criteria ?? '').trim();
    return c.length >= 20;
  });

  const ratio = meaningful.length / nonT0Tasks.length;
  if (ratio < 0.7) {
    issues.push({
      rule: 'acceptance-criteria-ratio',
      message:
        `Only ${meaningful.length}/${nonT0Tasks.length} non-t0 tasks have ` +
        `meaningful acceptance_criteria (<70% threshold). Reviewer will fall ` +
        `back to trivial non-empty checks on the rest.`,
      severity: 'warn',
    });
  }
}

function checkCliSpawnTimeouts(dag: Dag, issues: ValidationIssue[]): void {
  const cliNoTimeout = dag.tasks.filter(
    t => t.kind === 'cli_spawn' && t.timeout_seconds == null,
  );
  if (cliNoTimeout.length > 0) {
    issues.push({
      rule: 'cli-spawn-timeout',
      message:
        `${cliNoTimeout.length} cli_spawn task(s) lack timeout_seconds — they ` +
        `will use the 300s default which observed to be insufficient for ` +
        `assembly of large artifacts (see first-dogfood findings).`,
      severity: 'warn',
      taskIds: cliNoTimeout.map(t => t.id),
    });
  }
}

// Per-tool minimum required arg keys. Catching the missing-args case here
// (at plan time) gives a much clearer error than the runtime tool-schema
// validation, and prevents wasting an HITL gate on a doomed run.
const TOOL_REQUIRED_ARGS: Record<string, readonly string[]> = {
  'file-write': ['path', 'content'],
  'file-read': ['path'],
  bash: ['command'],
  'http-request': ['url'],
};

// F-LIVE-1 — per-kind required args for the deterministic step kinds.
// The runtime executor enforces these at run time and emits an opaque error
// (e.g. "print: print_template is required"); validating at plan time gives
// the decomposer a clearer issue + lets the retry-with-feedback loop fix it.
const DETERMINISTIC_KIND_REQUIRED_ARGS: Record<string, readonly string[]> = {
  print: ['print_template'],
  transform: ['transform_expression'],
  extract_json: ['input_keys'],
  if_else: ['if_condition'],
  switch: ['switch_key'],
  loop: ['loop_count', 'loop_step_ids'],
  merge: ['merge_branch_outputs'],
  evaluator: ['evaluator_route_map'],
};

function checkDeterministicKindArgs(dag: Dag, issues: ValidationIssue[]): void {
  for (const task of dag.tasks) {
    const required = DETERMINISTIC_KIND_REQUIRED_ARGS[task.kind as string];
    if (!required) continue;
    // Required args may live either on `task.args` (the canonical shape) or
    // directly on the task (legacy). Accept both so we don't false-positive
    // on workflows produced by older decomposer prompts.
    const args = (task as { args?: unknown }).args;
    const argsRecord =
      args && typeof args === 'object' && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : (task as unknown as Record<string, unknown>);
    const missing = required.filter((key) => {
      const value = argsRecord[key];
      return value === undefined || value === null || value === '';
    });
    if (missing.length > 0) {
      issues.push({
        rule: 'deterministic-kind-args',
        message:
          `Task '${task.id}' (kind=${task.kind}) is missing required args: ${missing.join(', ')}. ` +
          `${task.kind} tasks need ${required.join(', ')} set on the task object (or under \`args\`). ` +
          `If you don't have a stable template for ${task.kind}, use kind=llm_call instead.`,
        severity: 'error',
        taskIds: [task.id],
      });
    }
  }
}

function checkToolCallArgs(dag: Dag, issues: ValidationIssue[]): void {
  for (const task of dag.tasks) {
    if (task.kind !== 'tool_call') continue;

    const toolName = task.tool_name;
    if (!toolName) {
      issues.push({
        rule: 'tool-call-args',
        message: `Task '${task.id}' is kind=tool_call but has no tool_name. tool_call MUST include tool_name.`,
        severity: 'error',
        taskIds: [task.id],
      });
      continue;
    }

    const args = (task as { args?: unknown }).args;
    const argsRecord =
      args && typeof args === 'object' && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : null;

    if (!argsRecord) {
      issues.push({
        rule: 'tool-call-args',
        message:
          `Task '${task.id}' (tool_call '${toolName}') is missing args. ` +
          `tool_call tasks MUST include an args object matching the tool's schema. ` +
          `For content generation, prefer cli_spawn with cli:claude-code instead — see H17.`,
        severity: 'error',
        taskIds: [task.id],
      });
      continue;
    }

    const required = TOOL_REQUIRED_ARGS[toolName];
    if (!required) continue; // tool not in our minimum-required list — let runtime schema decide

    const missing = required.filter((key) => {
      const value = argsRecord[key];
      return value == null || value === '';
    });
    if (missing.length > 0) {
      issues.push({
        rule: 'tool-call-args',
        message:
          `Task '${task.id}' (tool_call '${toolName}') is missing required args: ` +
          `${missing.join(', ')}. Required for '${toolName}': ${required.join(', ')}. ` +
          `For content generation, prefer cli_spawn with cli:claude-code — see H17.`,
        severity: 'error',
        taskIds: [task.id],
      });
    }
  }
}

function checkFileScopeOverlap(dag: Dag, issues: ValidationIssue[]): void {
  const tasks = dag.tasks;
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i];
      const b = tasks[j];
      if (!a.file_scope?.length || !b.file_scope?.length) continue;
      // Skip if there's a dependency between them (either direction)
      const aDependsOnB = a.depends_on?.includes(b.id);
      const bDependsOnA = b.depends_on?.includes(a.id);
      if (aDependsOnB || bDependsOnA) continue;
      if (pathsOverlap(a.file_scope, b.file_scope)) {
        issues.push({
          rule: 'file_scope_overlap',
          message: `Tasks "${a.id}" and "${b.id}" have overlapping file_scope without a dependency — consider adding explicit depends_on to serialize them`,
          severity: 'warn',
          taskIds: [a.id, b.id],
        });
      }
    }
  }
}
