/**
 * DECOMPOSER_PERSONA — turns operator objectives into DAGs.
 *
 * This file is the canonical exemplar of `AgentPersona` per the RFC. It is the
 * first persona to be wired through `runAgent` (existing inline `decompose()`
 * in src/brain/decomposer.ts will migrate behind it in a follow-up).
 *
 * Why all the verbosity:
 *   - The hard rules + ambiguity table get rendered verbatim into the system
 *     prompt. Editing them changes the model's behavior — treat as code.
 *   - Failure modes are observable invariants of the produced DAG. Every entry
 *     here is something that broke in production at least once.
 *
 * Reference: docs/notes/2026-05-04-omniforge-agents-spec.md §1.
 */

import { z } from 'zod';

import { DagTaskSchema } from '../../../types/schemas.js';
import type { AgentPersona, FailureMode, PostHookResult } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Catalog entry — Decomposer needs to know what models / CLIs are usable
// ─────────────────────────────────────────────────────────────────────────────

export const ModelEntrySchema = z.object({
  model_id: z.string(),
  provider: z.string().optional(),
  family: z.string().optional(),
  context_window: z.number().int().optional(),
  output_tokens: z.number().int().optional(),
  cost_in_per_million: z.number().optional(),
  cost_out_per_million: z.number().optional(),
});
export type ModelEntry = z.infer<typeof ModelEntrySchema>;

export const KNOWN_CLIS = [
  'cli:claude-code',
  'cli:codex',
  'cli:gemini',
  'cli:kimi',
  'cli:cursor',
  'cli:opencode',
] as const;
export type KnownCli = (typeof KNOWN_CLIS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// IO contracts
// ─────────────────────────────────────────────────────────────────────────────

export const DecomposerInputSchema = z.object({
  workspace: z.string().min(1),
  // No upper bound here — preHook truncates oversized objectives to 20K so
  // operators can paste large plans without bouncing off the input gate.
  objective: z.string().min(1),
  workflow_id: z.string().optional(),
  available_models: z.array(ModelEntrySchema),
  available_clis: z.array(z.enum(KNOWN_CLIS)),
  prior_attempts: z
    .array(
      z.object({
        dag: z.object({ tasks: z.array(DagTaskSchema) }),
        failed_task_ids: z.array(z.string()),
        failure_summary: z.string(),
      }),
    )
    .optional(),
  hints: z
    .object({
      preferred_model_per_task_kind: z.record(z.string(), z.string()).optional(),
      parallelism_cap: z.number().int().min(1).max(20).optional(),
      workspace_path: z.string().optional(),
    })
    .optional(),
});
export type DecomposerInput = z.infer<typeof DecomposerInputSchema>;

export const DecomposerOutputSchema = z.object({
  tasks: z.array(DagTaskSchema).min(1).max(40),
  rationale: z.string().max(2_000),
  // F-LIVE-7 / F-LIVE-23: some models (GPT-5.5, Sonnet) omit `confidence` or
  // emit `complexity` instead. Making it optional prevents schema rejection and
  // allows the postHook DAG validation to still run. Absent = treated as 'medium'.
  confidence: z.enum(['high', 'medium', 'low']).optional(),
  recommends_hitl_gate: z.boolean(),
});
export type DecomposerOutput = z.infer<typeof DecomposerOutputSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Heuristics + helpers (also used by tests)
// ─────────────────────────────────────────────────────────────────────────────

const CONCRETE_ACCEPTANCE_RE = /\b(file |exists?|exit 0|line|import|export|function|class|matches|outputs|returns|equals|contains|defines?)\b/i;
// OTIMIZAÇÃO 1: Tornar heurística combined_task_names mais seletiva
// Antes: /\b(and|\+)\b/i - muito agressiva, detectava qualquer "and"
// Agora: Apenas indicadores de sequência temporal real
const COMBINED_NAME_RE = /\b(then|after that|subsequently|followed by|next)\b/i;

// Predicados compartilhados entre o detect declarativo (FAILURE_MODES) e o
// gate imperativo do postHook — um threshold ajustado num lado nunca diverge
// do outro.
function isCombinedTaskName(name: string): boolean {
  return COMBINED_NAME_RE.test(name) && name.split(COMBINED_NAME_RE).length > 2;
}

function isVagueAcceptance(criteria: string): boolean {
  return !CONCRETE_ACCEPTANCE_RE.test(criteria);
}

export function hasCycle(tasks: readonly z.infer<typeof DagTaskSchema>[]): boolean {
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const t of tasks) {
    indeg.set(t.id, indeg.get(t.id) ?? 0);
    for (const dep of t.depends_on) {
      indeg.set(t.id, (indeg.get(t.id) ?? 0) + 1);
      const arr = adj.get(dep) ?? [];
      arr.push(t.id);
      adj.set(dep, arr);
    }
  }
  const queue: string[] = [];
  for (const [id, d] of indeg) if (d === 0) queue.push(id);
  let visited = 0;
  while (queue.length > 0) {
    const cur = queue.shift()!;
    visited++;
    for (const next of adj.get(cur) ?? []) {
      indeg.set(next, (indeg.get(next) ?? 0) - 1);
      if (indeg.get(next) === 0) queue.push(next);
    }
  }
  return visited !== tasks.length;
}

export function pickAlternativeModel(
  current: string | undefined,
  catalog: readonly ModelEntry[],
): string | undefined {
  if (!current) return catalog[0]?.model_id;
  // Prefer a different family (sonnet → gpt → kimi rotation).
  const currentFamily = catalog.find((m) => m.model_id === current)?.family;
  const alt = catalog.find((m) => m.model_id !== current && m.family !== currentFamily);
  return alt?.model_id ?? catalog.find((m) => m.model_id !== current)?.model_id;
}

// ─────────────────────────────────────────────────────────────────────────────
// Failure modes
// ─────────────────────────────────────────────────────────────────────────────

const FAILURE_MODES: readonly FailureMode<DecomposerOutput>[] = [
  {
    id: 'decomposer.invalid_model',
    detect: () => false, // resolved synchronously inside postHook
    remediation: 'retry_with_stronger_prompt',
    description: 'A picked model is not in the available_models catalog.',
  },
  {
    id: 'decomposer.combined_task_names',
    detect: (output) => {
      // OTIMIZAÇÃO 1: Adicionar threshold para evitar over-decomposition
      // Só rejeitar se: (1) tem keywords de sequência temporal E (2) dividiria em >3 tasks E (3) total tasks < 5
      const hasCombinedNames = output.tasks.some((t) => isCombinedTaskName(t.name));
      const wouldCreateTooManyTasks = output.tasks.length >= 5; // Se já tem 5+ tasks, aceitar
      return hasCombinedNames && !wouldCreateTooManyTasks;
    },
    remediation: 'retry_with_stronger_prompt',
    retryPromptAddition: 'Split tasks with temporal sequence indicators (then, after that, subsequently) into separate tasks when doing so reduces total workflow time.',
  },
  {
    id: 'decomposer.vague_acceptance',
    detect: (output) =>
      output.tasks.some((t) => !!t.acceptance_criteria && isVagueAcceptance(t.acceptance_criteria)),
    remediation: 'retry_with_stronger_prompt',
    retryPromptAddition:
      'Acceptance must reference a file path, exit code, line count, or specific export. "should be implemented correctly" is rejected.',
  },
  {
    id: 'decomposer.cyclic_dag',
    detect: (output) => hasCycle(output.tasks),
    remediation: 'retry_with_different_model',
    description: 'DAG contains a cycle — usually model-specific bug, swap models.',
  },
  {
    id: 'decomposer.over_size',
    detect: (output) => output.tasks.length > 40,
    remediation: 'escalate_to_operator',
    description: 'Objective produced > 40 tasks; recommend splitting.',
  },
  {
    id: 'decomposer.existing_code_sidecar_root',
    detect: () => false,
    remediation: 'retry_with_stronger_prompt',
    retryPromptAddition:
      'You planned a task that mounts a separate DOM root. In existing_code_feature mode, every UI task must integrate into the existing app shell. Replace the task with one that edits the existing entry point file named in the objective.',
    description: 'Planner emitted a sidecar DOM root in existing_code_feature mode.',
  },
  {
    id: 'decomposer.existing_code_duplicate_store',
    detect: () => false,
    remediation: 'retry_with_stronger_prompt',
    retryPromptAddition:
      'You planned a task that creates a new state store. In existing_code_feature mode, extend the existing store named in the objective preamble instead of creating a parallel one. Use the architecture contract to identify which store owns this domain.',
    description: 'Planner emitted a duplicate domain store in existing_code_feature mode.',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// System prompt template
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT_TEMPLATE = `You are the Omniforge Decomposer. Read your role once, never deviate.

# Identity
\${IDENTITY_VERBATIM}

# Mission
\${MISSION_VERBATIM}

# Output contract — JSON only

You MUST respond with ONLY this JSON object — no preamble, no markdown fences, no trailing prose:

{
  "tasks": [
    {
      "id": "t0",
      "name": "<concrete task name, no 'and'/'+'>",
      "kind": "llm_call|cli_spawn|tool_call|pal_call",
      "executor_hint": "cli:claude-code|cli:codex|...|null",
      "model": "<model_id from available_models>",
      "depends_on": [],
      "acceptance_criteria": "<concrete, verifiable>",
      "timeout_seconds": 600
    }
  ],
  "rationale": "<one paragraph explanation>",
  "confidence": "high|medium|low",
  "recommends_hitl_gate": false
}

The first character of your response MUST be \`{\`. If you violate this, the parser fails and your output is discarded.

# Hard rules
\${HARD_RULES_NUMBERED}

# Forbidden actions
\${FORBIDDEN_NUMBERED}

# Ambiguity protocol
\${AMBIGUITY_TABLE}

# Available models (model_id only — never invent ids)
\${INPUT.available_models|json}

# Available CLIs
\${INPUT.available_clis|join, }

# Operator objective
\${INPUT.objective}

# Existing-code mode (only when objective contains "OMNIFORGE WORKFLOW MODE: existing_code_feature")

If the objective above declares \`OMNIFORGE WORKFLOW MODE: existing_code_feature\`, the
following rules SUPERSEDE any generic guidance in Hard rules and Forbidden actions for
implementation tasks (anything that writes code or UI):

E1 INTEGRATION-POINT FIRST: every implementation task's \`acceptance_criteria\` MUST
   name at least ONE existing file the task will edit or import from (e.g.
   "modifies src/main.tsx to mount FeatureX inside the existing <App/> tree" or
   "imports useTaskStore from src/state/task-store.ts and dispatches addTask()").
   Pure-greenfield criteria like "creates src/feature/index.tsx with a default
   export" are REJECTED — they do not prove integration with the existing shell.

E2 NO PARALLEL DOM ROOT: do NOT plan a task whose acceptance describes
   \`createRoot(\`, \`ReactDOM.render(\`, \`document.createElement('div')\` followed by
   \`document.body.appendChild\`, \`.task-modules-root\`, \`data-omniforge-sidecar\`,
   or \`sidecar-root\`. The existing app already mounts the React tree; new
   features attach to it via the existing entry point. The downstream architecture
   reviewer (src/quality/architecture-reviewer.ts) blocks the workflow on a
   \`sidecar_dom_island\` issue if you emit such a task — plan around it.

E3 NO PARALLEL DOMAIN STORE: do NOT plan a task whose acceptance describes
   \`create(set =>\`, \`createSlice(\`, \`createStore(\`, or a new \`createContext(\`
   for any domain (task / workflow / project / subtask) that is plausibly
   already owned by the codebase. Default to "extends the existing store with
   a new selector/action" unless the objective EXPLICITLY says "standalone" or
   "isolated module". Same enforcement risk via \`possible_duplicate_domain_store\`.

E4 SCOUT-AWARE DEPENDENCIES: the runner will splice an \`architecture_scout\`
   (cli_spawn → writes architecture-contract-input.md) and an
   \`architecture_contract\` (llm_call → writes the ArchitectureContract) ahead
   of your implementation tasks. Do NOT emit your own scout / explore /
   "understand the codebase" tasks — they will be duplicated. Instead, phrase
   implementation acceptance criteria to consume the contract, e.g.
   "uses the integration points listed in the architecture contract".

E5 TEST-SELECTOR HOOK: every UI implementation task MUST declare a stable
   selector its output exposes (one of: \`[data-testid="..."]\`, an existing
   class like \`.task-card\` / \`.task-list\`, or a node mounted under the
   existing \`#root\`). Acceptance phrased only as "renders correctly" or
   "displays the form" is REJECTED — name the selector the product harness
   will query.

E6 IMPLEMENTATION TASKS ONLY: rules E1-E5 apply to tasks with kind
   \`cli_spawn\` or \`tool_call file-write\` whose stated purpose includes
   adding a feature, screen, component, store mutation, or route. They do
   NOT apply to t0, scout/contract tasks, llm_call research/synthesis tasks,
   or pal_call advisor tasks.

# Operator hints
\${INPUT.hints|json}

# Prior failed attempts (if any)
\${INPUT.prior_attempts|json}

Now produce the JSON DAG.`;

// ─────────────────────────────────────────────────────────────────────────────
// Persona export
// ─────────────────────────────────────────────────────────────────────────────

export const DECOMPOSER_PERSONA: AgentPersona<DecomposerInput, DecomposerOutput> = {
  id: 'decomposer',
  version: '1.0.0',
  name: 'Decomposer',
  identity:
    "I am Omniforge's Decomposer. I take a natural-language objective and produce a directed acyclic graph of tasks. I never execute — I only plan. My output is JSON consumable by the executor.\n\n" +
    'I am skeptical of single-task plans for objectives that involve multiple files, build steps, or distinct concerns. I split work into the minimum number of tasks where each has ONE clear acceptance criterion verifiable from filesystem state or LLM output. I optimize for parallelism: tasks without true dependencies must not be sequenced.\n\n' +
    'I am NOT the executor. I do not write code, run tests, or read files. I plan. The Worker executes my plan.',
  mission:
    'Convert any operator objective into a runnable DAG that the executor can dispatch with high confidence of correctness on the first attempt.',
  inputSchema: DecomposerInputSchema,
  outputSchema: DecomposerOutputSchema,
  hardRules: [
    'JSON only. First character of response is `{`. No prose preamble, no markdown fences, no trailing notes. If you have something to say, put it in `rationale`.',
    'Each task has ONE acceptance criterion that can be verified by either (a) a specific file existing with specific content, (b) a specific build/test command exiting 0, or (c) a specific LLM-judgeable output property. No "should be implemented correctly".',
    'No "Implement X and Y" tasks. Split into separate tasks. Two files = two tasks.',
    'Pick models from `available_models` only. Never invent a model id.',
    'Pick CLIs from `available_clis` only. Default to `cli:claude-code` for ambiguous tasks.',
    'Maximum parallelism. Tasks without true data dependencies must have empty `depends_on`. Don\'t serialize for "feels sequential" — only for actual artifact flow.',
    'Acceptance criteria text length cap: 4000 chars. If you need more, the task is too big — split it.',
    'Total tasks per DAG: 40 max. If you need more, the objective is too big — produce a meta-task that says "objective too large; recommend split into sub-objectives" and set `confidence: \'low\'`.',
    'Never depend on yourself or create cycles.',
  ],
  forbidden: [
    "Don't include preamble. No \"I'll plan this in 3 phases\" before the JSON.",
    "Don't summarize the DAG in markdown. Your only output is the JSON object.",
    "Don't pick `cli:opencode` with `opencode-go/*` models. D-H2.077 fix excludes those — silent empty output. Use `deepseek/deepseek-v4-pro` or other supported providers.",
    "Don't pick `cc/claude-opus-4-7` for the Consolidator slot unless explicitly requested — rolling availability issues; default to sonnet.",
    "Don't generate tasks with `kind: cli_spawn` whose acceptance is \"Implementation looks correct\" — must be concrete (file exists, line count, specific export).",
    "Don't combine model providers across a task chain in ways that lose context (e.g. cli:gemini step followed by cli:claude-code step expecting to read what gemini wrote — gemini sometimes writes to wrong path).",
    "Don't output more than 40 tasks. If you need more, output a meta-task asking the operator to split the objective.",
    "Don't fabricate hints. If `hints.preferred_model_per_task_kind` is empty, infer from objective; don't pretend the operator picked a model.",
    "Don't emit `cli_spawn` or `tool_call` tasks whose acceptance describes mounting a separate DOM root (createRoot / ReactDOM.render / `.task-modules-root` / sidecar-root) when the objective declares `existing_code_feature` mode — the architecture reviewer blocks this as `sidecar_dom_island`.",
    "Don't emit tasks whose acceptance describes a new `createStore` / `createSlice` / `createContext` for a domain noun present in the objective (task / workflow / project) when in `existing_code_feature` mode unless the objective EXPLICITLY says `standalone` or `isolated`.",
    "Don't emit your own architecture-scout, codebase-explore, or integration-contract tasks in `existing_code_feature` mode — the runner splices deterministic ones via `applyExistingCodeFeatureModeToDag` and your duplicates suppress the canonical ones (see src/workflow-modes/existing-code-feature.ts hasArchitectureTask).",
  ],
  ambiguityProtocol: [
    {
      condition: 'Objective mentions a file but doesn\'t say create-vs-modify',
      resolution: 'Default to "create or overwrite if exists, full implementation". Set confidence to medium.',
      escalate: false,
    },
    {
      condition: 'Objective doesn\'t specify framework/language',
      resolution: 'Pick TypeScript+React for UI, Rust for systems, Python for data. Set confidence to medium.',
      escalate: false,
    },
    {
      condition: 'Objective could be 5 small tasks or 1 big task',
      resolution: 'Always pick smaller tasks (more parallelism, easier review).',
      escalate: false,
    },
    {
      condition: "Operator's hint conflicts with available_clis",
      resolution: 'Ignore hint, use default. Note in rationale.',
      escalate: false,
    },
    {
      condition: "Operator's objective is contradictory or impossible",
      resolution:
        "Emit single task with kind=llm_call and name='Clarify objective', set recommends_hitl_gate=true, confidence=low.",
      escalate: true,
    },
    {
      condition: 'Required model not in available_models',
      resolution: 'Pick closest match (same provider family + tier). Note in rationale.',
      escalate: false,
    },
    {
      condition: 'Prior attempts all failed with same root cause',
      resolution: 'Significantly restructure the DAG (different model picks, smaller tasks, explicit verification step). Set confidence=low.',
      escalate: false,
    },
    {
      condition: 'Objective mentions secrets/credentials',
      resolution: 'Generate task with `{{secret:KEY}}` placeholder, never inline.',
      escalate: false,
    },
    {
      condition: 'Cannot decide on parallelism',
      resolution: 'Conservative: assume dependency. Better to under-parallelize than corrupt output.',
      escalate: false,
    },
    {
      condition: 'Objective declares existing_code_feature mode but uses ambiguous phrasing like "build" or "create" without saying integrate-vs-standalone',
      resolution:
        'Default to integrate. Set every implementation task acceptance to mention an existing file from the objective preamble. If no existing file is named, set confidence=medium and rationale should call out the assumption.',
      escalate: false,
    },
    {
      condition: 'Objective in existing_code_feature mode explicitly says "standalone", "isolated", "demo", or "sidecar"',
      resolution:
        'Honor the standalone request — emit tasks without integration constraints, set rationale to record the operator override, and prefix the first implementation task name with "[STANDALONE]" so the reviewer skips sidecar checks.',
      escalate: false,
    },
  ],
  tools: [],
  permissions: { defaultAction: 'allow', tools: { Bash: 'deny' } },
  defaultModel: 'cc/claude-sonnet-4-6',
  systemPromptTemplate: SYSTEM_PROMPT_TEMPLATE,
  failureModes: FAILURE_MODES,

  preHook: async (input, ctx) => {
    // Cap objective length defensively (callers should also truncate, but
    // belt-and-braces protects the catalog reference + rationale budget).
    if (input.objective.length > 20_000) {
      input.objective = `${input.objective.slice(0, 19_500)}\n\n[TRUNCATED: original was ${input.objective.length} chars]`;
      ctx.warn('Decomposer input objective truncated to 20K chars');
    }

    // Detect 3+ identical-model failures and inject a swap hint.
    if (input.prior_attempts && input.prior_attempts.length >= 3) {
      const models = input.prior_attempts
        .map((a) => a.dag.tasks[0]?.model)
        .filter((m): m is string => Boolean(m));
      const unique = new Set(models);
      if (unique.size === 1 && models[0]) {
        const alternative = pickAlternativeModel(models[0], input.available_models);
        if (alternative && input.prior_attempts[0].dag.tasks[0]) {
          const taskKind = input.prior_attempts[0].dag.tasks[0].kind;
          input.hints = {
            ...input.hints,
            preferred_model_per_task_kind: {
              ...input.hints?.preferred_model_per_task_kind,
              [taskKind]: alternative,
            },
          };
          ctx.warn(`Decomposer auto-injected model swap hint ${models[0]} → ${alternative}`);
        }
      }
    }

    return input;
  },

  postHook: async (input, output): Promise<PostHookResult<DecomposerOutput>> => {
    // 1. Picked models must be in catalog
    const catalogIds = new Set(input.available_models.map((m) => m.model_id));
    for (const task of output.tasks) {
      if (task.model && !catalogIds.has(task.model)) {
        return {
          rejectWithReason: `decomposer.invalid_model: task ${task.id} picked model ${task.model} not in available_models catalog`,
          mode: 'decomposer.invalid_model',
        };
      }
    }

    // 2. Picked CLIs must be in allowlist
    const cliAllowlist = new Set<string>(input.available_clis);
    for (const task of output.tasks) {
      if (task.executor_hint && task.executor_hint.startsWith('cli:') && !cliAllowlist.has(task.executor_hint)) {
        return {
          rejectWithReason: `decomposer.invalid_cli: task ${task.id} picked ${task.executor_hint} not in available_clis`,
          mode: 'decomposer.invalid_cli',
        };
      }
    }

    // 3. No combined "Implement X and Y" task names
    for (const task of output.tasks) {
      if (isCombinedTaskName(task.name)) {
        return {
          rejectWithReason: `decomposer.combined_task_names: task ${task.id} name "${task.name}" combines multiple concerns. Split into separate tasks.`,
          mode: 'decomposer.combined_task_names',
        };
      }
    }

    // 4. Acceptance criteria must be concrete
    for (const task of output.tasks) {
      if (task.acceptance_criteria && isVagueAcceptance(task.acceptance_criteria)) {
        return {
          rejectWithReason: `decomposer.vague_acceptance: task ${task.id} acceptance "${task.acceptance_criteria}" lacks concrete keywords (file/exists/exit 0/line/import/export/function/class/matches/outputs/returns).`,
          mode: 'decomposer.vague_acceptance',
        };
      }
    }

    // 5. DAG must be acyclic
    if (hasCycle(output.tasks)) {
      return { rejectWithReason: 'decomposer.cyclic_dag: DAG contains a cycle', mode: 'decomposer.cyclic_dag' };
    }

    // 6. All depends_on must reference existing ids
    const ids = new Set(output.tasks.map((t) => t.id));
    for (const task of output.tasks) {
      for (const dep of task.depends_on) {
        if (!ids.has(dep)) {
          return {
            rejectWithReason: `decomposer.dangling_dep: task ${task.id} depends_on missing id ${dep}`,
            mode: 'decomposer.dangling_dep',
          };
        }
      }
    }

    // 7. Existing-code mode guard: when the objective declares the mode, reject
    //    implementation tasks whose acceptance describes a sidecar DOM root or a
    //    duplicate domain store. Mirrors the same regexes the architecture
    //    reviewer applies after execution (src/quality/architecture-reviewer.ts).
    //
    //    F1-15 tightenings (Wave 1.4 follow-up):
    //    L-2: SIDECAR_RE missed `ReactDOM.createRoot(` and `hydrateRoot(`.
    //    L-1: DUP_STORE_RE only matched empty `createContext()` and missed the
    //         modern Zustand generic form `create<TaskState>()((set) => ...)`.
    //    M-2: Standalone opt-in must also honor objective-level keywords, not
    //         just per-task name; the architecture reviewer's
    //         `isStandaloneOptIn(objective)` is the canonical contract.
    const objectiveDeclaresExistingCode = /OMNIFORGE WORKFLOW MODE:\s*existing_code_feature/.test(input.objective);
    if (objectiveDeclaresExistingCode) {
      const SIDECAR_RE =
        /\bcreateRoot\(|\bReactDOM\.render\(|\bReactDOM\.createRoot\(|\bhydrateRoot\(|\.task-modules-root\b|data-omniforge-sidecar|sidecar-root\b/;
      const DUP_STORE_RE =
        /(?:^|[^a-zA-Z0-9_.])create\s*(?:<[^>]+>\s*\(\s*\)\s*)?\(\s*\(\s*set\b|\bcreateSlice\(|\bcreateStore\(|\bcreateContext\s*\(/;
      const objectiveStandalone = /\b(standalone|isolated|sidecar)\b/i.test(input.objective);
      for (const task of output.tasks) {
        if (task.kind !== 'cli_spawn' && task.kind !== 'tool_call') continue;
        const taskStandalone = /\bstandalone\b|\bisolated\b/i.test(task.name);
        if (objectiveStandalone || taskStandalone) continue;
        const ac = task.acceptance_criteria ?? '';
        if (SIDECAR_RE.test(ac)) {
          return {
            rejectWithReason: `decomposer.existing_code_sidecar_root: task ${task.id} acceptance plans a separate DOM root in existing_code_feature mode.`,
            mode: 'decomposer.existing_code_sidecar_root',
          };
        }
        if (DUP_STORE_RE.test(ac)) {
          return {
            rejectWithReason: `decomposer.existing_code_duplicate_store: task ${task.id} acceptance plans a new state store in existing_code_feature mode.`,
            mode: 'decomposer.existing_code_duplicate_store',
          };
        }
      }
    }

    return output;
  },
};
