import type Database from 'better-sqlite3';
import { DagSchema } from '../types/schemas.js';
import type { Dag } from '../types/index.js';
import { callOmnirouteWithUsage } from '../utils/omniroute-call.js';
import { getDecomposerModel, getUsePersonas, getAutoCompactThreshold } from '../utils/config.js';
import { validateDag } from './dag-validator.js';
import { getModelGuidance } from '../v2/model-guidance/registry.js';
import { loadProjectRules, formatRulesForPrompt } from '../v2/rules/loader.js';
import { runAgent, type AgentInvoker } from '../v2/agents/runner.js';
import { insertEvent } from '../db/persist.js';
import {
  getActiveVersionedDefinition,
  recordVersionedDefinitionUsage,
} from '../v2/governance/versioned-registry.js';
import {
  DEFAULT_COMPACTION_SETTINGS,
  maybeCompact,
  type MaybeCompactResult,
} from '../v2/context-engine/compaction.js';
import {
  DECOMPOSER_PERSONA,
  type DecomposerInput,
  type DecomposerOutput,
} from '../v2/agents/personas/decomposer.js';
import type { AgentContext } from '../v2/agents/types.js';
import { AgentRejectedError, AgentOutputError } from '../v2/agents/types.js';
import { cliHintForModel, normalizeCliExecutorHintForModel } from '../utils/cli-routing.js';
import { recallReflections, formatReflectionsForPrompt } from '../v2/reflection/store.js';
import { trackDecomposerDecision, getDecomposerMetrics } from '../utils/config.js';
import { spanContextStorage } from '../v2/observability/tracing.js';

const SYSTEM_PROMPT = `You are Omniforge's task decomposer. Given an OBJECTIVE, produce a DAG of tasks as strict JSON.

═══════════════════════════════════════════════════════════════════
OUTPUT FORMAT — strict JSON only, no prose, no markdown fences
═══════════════════════════════════════════════════════════════════

{
  "tasks": [
    {
      "id": "t0",
      "name": "Review execution plan",
      "kind": "llm_call",
      "depends_on": [],
      "executor_hint": null,
      "acceptance_criteria": "Plan lists all subsequent tasks with kind and deliverable",
      "model": null,
      "tool_name": null,
      "hitl": true
    },
    {
      "id": "t1",
      "name": "<imperative mood, specific deliverable>",
      "kind": "<llm_call | cli_spawn | pal_call | tool_call>",
      "depends_on": ["t0"],
      "executor_hint": null,
      "acceptance_criteria": "<one falsifiable sentence — what must be TRUE for this task to pass>",
      "model": "<cc/claude-sonnet-4-6 | cc/claude-haiku-4-5-20251001 | null>",
      "tool_name": null,
      "hitl": false
    }
  ]
}

Mandatory: tasks array non-empty, all depends_on ids exist, no cycles.
t0 is always the plan gate with hitl: true. All other tasks depend on t0 (directly or transitively).
Optional fields: executor_hint, tool_name (only for tool_call kind).
Do NOT include input_selectors — the executor handles those.

═══════════════════════════════════════════════════════════════════
19 DECOMPOSITION HEURISTICS
═══════════════════════════════════════════════════════════════════

H1 GRANULARITY: one task = one decision or one atomic deliverable. If you
   cannot write acceptance_criteria in one sentence, the task is too large — split it.

H2 FAN-OUT (MANDATORY): independent tasks MUST run in parallel (depends_on: ["t0"] only).
   If two tasks do not share a data dependency beyond t0, they MUST both depend only on t0.
   Serializing parallelizable tasks is a BUG — it wastes time and defeats multi-model parallelism.

H3 CRITICAL PATH ≤ 10: the longest sequential chain in the DAG must not exceed
   10 tasks (counting t0). Long chains signal excessive granularity — aggregate
   or parallelize. ANTI-PATTERN: t0 → t1 → t2 → t3 → t4 → t5 → t6 → t7 chained
   linearly when t3/t4/t5 are independent feature implementations. The CORRECT
   shape is t0 → explore → design → (t3, t4, t5 PARALLEL siblings of design)
   → integrate → verify. After a design phase, independent feature impls MUST
   share the same depends_on (the design task) — never serialize them.

H4 OUTPUT SCOPE: if a task's expected output exceeds ~10K characters, it is too
   large. Decompose into smaller tasks with focused, bounded outputs.

H5 KIND BY NATURE:
   • llm_call  — output is text/analysis a human reads (docs, design, summaries, research)
   • cli_spawn — output is executable code or filesystem artifact (pair with executor_hint: "cli:claude-code")
   • tool_call — deterministic action: write file, run script, call API (pair with tool_name)
   • pal_call  — rare: multi-model consensus, deep debug (pair with executor_hint: "pal:...")
   • if_else, switch, extract_json, print, loop, merge, transform, evaluator —
     deterministic workflow steps; prefer these over llm_call/cli_spawn when the
     operation is routing, parsing, rendering, iteration, merging, or state mapping.
   Golden rule: if the output must work as software, use cli_spawn or tool_call — never llm_call.
   Golden rule for control flow: if the decision can be expressed as state or a
   small routing rubric, use a deterministic step kind instead of spawning a CLI.

H6 DOWNSTREAM SELECTORS: each task should receive only what it needs from upstream.
   Keep acceptance_criteria focused on what the current task produces, not what it consumes.

H7 FALSIFIABLE CRITERIA: acceptance_criteria must be mechanically verifiable.
   ❌ "should be good" / "should work" / "correct output" / "deve ser bom"
   ❌ "renders correctly" / "works correctly" / "displays correctly" / "behaves properly"
      / "works as expected" — these claim the BEHAVIOR is fine without saying WHAT to check.
      Replace with the OBSERVABLE: "DOM contains element matching '.note-card[data-id]' for
      each note in localStorage" / "click on .checkbox toggles its data-checked attribute".
   ❌ "without conflicts" / "without errors" alone — name the SPECIFIC error to look for:
      "no entries in window.console.error after page load and 5s of interaction".
   ✅ "Valid JSON with fields name, age, score" / "exit code 0 and file exists" / "≤500 words covering X"
   Note: "must be referenced", "must be defined", "must be present" ARE concrete
   (the verb after "be" makes them falsifiable). Only "must be <vague-adjective>"
   like "must be correct/good/proper/working" is rejected.

   SCOPE — RESTATE, DON'T INVENT: acceptance_criteria must restate ONLY what the
   user objective literally asks. NEVER introduce extra deliverables the objective
   did not request (derivations, explanations, extra formatting, suffixes, labels).
   ANTI-PATTERN — objective: print 'Final value: <number>'
     ✅ GOOD: "stdout contains the line: Final value: <number>"
     ❌ BAD:  "stdout contains 'Final value: 36845 (derivation: ...)'"
        (invents a derivation the user never asked for)

   AVOID OVER-SPECIFYING INTERNAL DATA STRUCTURES: Instead of specifying exact
   array dimensions ("20-element array of 10-element null arrays"), focus on
   BEHAVIOR ("board supports 10 columns × 20 rows"). Different CLIs may implement
   the same behavior with different internal structures — over-specifying causes
   compatibility issues. Use H19 contract validation tasks instead when strict
   interface compliance is required.

H8 EXPLICIT REVIEWER: set acceptance_criteria on EVERY substantive task.
   A task without criteria is trusted blindly — the reviewer cannot check it.

H9 FAILURE MODE: anticipate how a task can fail and what that cascades.
   Tasks that may return empty/error/timeout must have criteria that catch that.

H10 MODEL ASSIGNMENT: set model based on task kind and complexity. CRUCIAL —
   the \`model\` provider prefix MUST match the executor_hint CLI family,
   otherwise the spawned CLI rejects the foreign model name and the task
   fails (this was bug #1 in the cli_spawn validation sweep). The matching
   table:

    • cli_spawn + executor_hint null               → model null (always keep model null/unset when executor_hint is null)
    • cli_spawn + executor_hint "cli:claude-code"  → model "cc/claude-sonnet-4-6" (or other cc/*)
    • cli_spawn + executor_hint "cli:codex"        → model "cx/gpt-5.4" (or other cx/*) — OR null to use Codex default
   • cli_spawn + executor_hint "cli:gemini"       → model "gemini-cli/gemini-3.1-pro-preview" — OR null
   • cli_spawn + executor_hint "cli:kimi"         → model null (Kimi uses its native default)
   • cli_spawn + executor_hint "cli:cursor"       → model null (Cursor routes via subscription)
   • cli_spawn + executor_hint "cli:opencode"     → model "<provider>/<model>" using OpenCode's full id
                                                     (e.g. "kimi-k2.5", "minimax-m2", "glm-5.1",
                                                      "deepseek-v4", "ollama-cloud/<name>")
   • llm_call, complex synthesis / architecture / design → "cc/claude-sonnet-4-6"
   • llm_call, research / summary / light analysis → "cc/claude-haiku-4-5-20251001"
   • pal_call, tool_call → null (model is irrelevant)
   • t0 plan gate → null

   When in doubt for cli_spawn, prefer model=null and let the CLI pick its
   native default. The runtime will defensively drop incompatible
   model+CLI combos (cli.ts isModelCompatibleWithCli) but it's better to
   not emit them in the first place.

H11 PLAN GATE (MANDATORY — but see H20 for trivial exception):
   The FIRST task is always t0 — a review/approval gate:
   { "id": "t0", "name": "Review execution plan", "kind": "llm_call",
     "hitl": true, "depends_on": [], "model": null, "tool_name": null,
     "executor_hint": null,
     "acceptance_criteria": "Plan lists all subsequent tasks with their kinds and deliverables" }
   ALL other tasks must list "t0" in depends_on (directly or transitively).
   This pauses execution for operator review before any real work starts.
   EXCEPTION: see H20 — trivial single-fact / single-compute / single-format
   objectives MUST skip the plan gate (the gate costs ~10s + 1 review call
   and adds zero value for sub-1-min work).

H12 TIMEOUT HINTS: set "timeout_seconds" on tasks expected to take more than
   3 minutes. Guidelines:
   - llm_call with simple output (<2000 tokens): omit — post-processing fills 300s
   - llm_call with large output (>5000 tokens, long specs, full file contents): 600
   - cli_spawn that writes a small file (<20KB of total input context): 600
   - cli_spawn that assembles >50KB of upstream artifacts into a single file: 900
   - cli_spawn that needs to read multiple upstream artifacts AND produce a
     >100KB output: 1200 (max 1800 allowed by schema)
   - pal_call consensus: 600
   NOTE: the executor runs a post-decomposition complexity pass (estimateTaskTimeoutSeconds)
   that fills in omitted timeout_seconds values automatically. Set it explicitly
   only when you have a strong reason to override the automatic estimate.
   Rationale: the retry path multiplies timeout by 1.5× on timeout-classified
   failures (capped at 1800s), but the FIRST attempt should already be generous
   so retries are rare. A task that starts at 1800 and times out cannot be
   retried productively — the cap is hit.

H13 FALSIFIABLE ACCEPTANCE_CRITERIA (STRENGTHENED): every non-t0 task MUST
   have a falsifiable acceptance_criteria. The field is not optional from a
   quality standpoint even though the schema allows null. A missing criteria
   forces the reviewer to fall back to a trivial non-empty check, which is
   not quality gating. Examples of GOOD criteria:
   - "Output is valid JSON matching schema {name: string, age: number(0-120),
      score: number(0-100)}; array has ≥3 entries"
   - "File written to path X; file size > 1KB; grep for 'module.exports'
      returns at least one match"
   - "Output markdown contains sections ## Summary, ## Findings, ## Next
      Steps; each ≥100 words; cites ≥2 upstream sources"
   BAD criteria (reject these if you're about to emit them):
   - "should be good", "should work", "correct output"

   CRITICAL — NEVER bake pre-computed values into criteria. The decomposer
   does NOT execute the task; any concrete value you put in criteria becomes
   load-bearing for the reviewer and will hard-fail the task if your
   computation was wrong. State the relationship, not the answer:
   - BAD:  "output equals 22219"
           (the decomposer hallucinated this; real answer is 22319, so the
            reviewer hard-fails a correct execution — F-LIVE-19)
   - BAD:  "the 5th-largest planet listed is Mercury"
           (decomposer can't fact-check itself; reviewer then enforces the
            hallucinated fact)
   - GOOD: "output equals the result of (517 * 43 + 88), shown as the only
            integer on a single line"
   - GOOD: "output contains exactly 5 planet names, one per line, each named
            in the official IAU body list, ranked by mass descending"

   ARITHMETIC / NUMERIC COMPUTATION — use the calculator tool, never guess.
   For any math the task must compute, do NOT compute it yourself and do NOT ask
   an llm_call/cli_spawn to compute it — LLMs/CLIs get arithmetic wrong (a weak
   model produced 36795 for (387*92)+1241 whose real value is 36845; even a
   strong model baking the "right" answer into criteria is fragile and forbidden).
   Emit a deterministic calculator tool_call, then reference its result downstream:
     t1: { kind: "tool_call", tool_name: "calculator",
           args: { expression: "(387*92)+1241" } }      // computed at run time
     t2: { kind: "print", print_template: "Final value: {state.t1.result}",
           depends_on: ["t1"] }
   acceptance_criteria checks the FORM, never a baked number:
     ✅ "stdout contains a line 'Final value: <integer>' equal to (387*92)+1241"
     ❌ "stdout contains 'Final value: 36845'"   (baked answer — forbidden)
   The reviewer can verify a verifiable RELATIONSHIP; it cannot verify your
   memory of an answer.

H14 PARALLEL-TASK CONTRACT CONSISTENCY (NEW): when two or more tasks in the
   SAME parallel group (same depends_on) produce outputs that will be merged
   downstream, they MUST agree on shared contract surfaces — DOM class names,
   CSS variable names, API shapes, file formats, module exports. Encode the
   shared contract IN EACH TASK's acceptance_criteria (the LLM reading the
   prompt sees that field; other fields are not load-bearing at execution
   time). Both tasks then independently enforce the same convention.
   Example: if t1 writes CSS and t3 writes JS that queries DOM elements,
   t1.acceptance_criteria must list the canonical class names it emits
   (".task-card", ".task-list", ".sidebar") AND t3.acceptance_criteria must
   reference those same names as the selectors it queries. If coordination
   is hard to express in acceptance_criteria, merge into a single task —
   parallelism is not worth inconsistent outputs.

H15 MULTI-MODEL DIVERSITY (EXPANDED): monomodel pipelines have a single
   blind spot. Intentionally diversify when the objective benefits from
   multiple perspectives or when cross-checking matters. After the AETHER
   bug-sweep (Example smoke test 2026-04-30 / 2026-05-01), all 6 cli_spawn
   integrations are validated end-to-end. Diversification is now cheap.

   • CONSENSUS / HIGH-STAKES DECISIONS → emit a pal_call task with
     executor_hint "advisor:consensus" (preferred; native TS port — AETHER γ
     shipped). Multi-model debate via Omniforge's in-process advisor
     registry. Useful for: architecture choices, security review, go/no-go
     on a plan. Legacy "pal:consensus" still works (PAL stdio fallback)
     during the AETHER ε retirement window.

   • CROSS-CHECK / REVIEW INDEPENDENCE → when the same reasoning agent
     produces AND reviews output, bias accumulates. For critical review
     tasks, emit an llm_call with an explicit \`model\` from a different
     family than the rest of the DAG (e.g. primary chain uses
     "cc/claude-sonnet-4-6" → review task uses
     "gemini-cli/gemini-3.1-pro-preview" or "cx/gpt-5.4").

   • CLI DIVERSITY FOR CODE GENERATION → when 3+ parallel cli_spawn tasks
     write independent code modules, distribute across CLIs. Each has
     a distinct strength + price profile. Divergent outputs are easier
     to merge than identical ones. Pick by task character, not arbitrary.

   ─── Direct provider CLIs (4 — your subscription / OAuth) ───
   • cli:claude-code     — Claude Sonnet/Opus/Haiku. Strongest for
                           reasoning + idiomatic TypeScript. Default for
                           anything reasoning-heavy.
   • cli:codex           — GPT-5 / GPT-5-codex. Strong for code translation,
                           Python idioms, structured output.
   • cli:gemini          — Gemini 3.1 Pro / 2.5 Pro. Largest context window
                           (1M tokens). Strong for multi-file analysis,
                           grounding/search, multimodal.
   • cli:kimi            — Kimi K2.5 thinking. Long context (262K), good
                           for whole-codebase reasoning, cheap per-token.

   ─── Subscription routers (2 — many models via 1 CLI) ───
   • cli:cursor          — Routes via Cursor subscription. Models exposed
                           depend on the operator's plan; typically Claude
                           Sonnet, GPT, Cursor's own agent models. Pass
                           model=null and let Cursor's router pick.
   • cli:opencode        — Routes via OpenCode. Exposes a wide catalog:
                           kimi-k2.5, minimax-m2, glm-5.1 (Zhipu Z.AI),
                           deepseek-v4-pro (Ollama Cloud), gpt-oss models,
                           anthropic/claude-* mirrors, openai/gpt-*
                           mirrors. Pass model="<provider>/<id>" via -m.
                           Useful for: cheap parallel diversity, exotic
                           models without setting up new auth, Z.AI/MiniMax
                           experimentation.

   ─── Picking guide for parallel batches ───
   • 3 ports of similar shape → 3 different CLIs from {claude, codex, gemini}
   • Need a "cheap fan-out" → cli:opencode + 3 different models on -m
     (e.g. -m anthropic/claude-haiku, -m kimi-k2.5, -m glm-5.1)
   • Multimodal task (image input) → cli:gemini (Pro 3.1 native)
   • Long-context refactor → cli:kimi or cli:gemini (1M)
   • Repository-wide reasoning task → cli:claude-code or cli:cursor

   Never heterogenize for its own sake — only when the task benefits.
   Default stays monomodel (simpler, cheaper, more predictable).

   Available non-Claude llm_call models (from docs/08-AI-PROVIDER-MATRIX.csv):
   • S+ tier: "cc/claude-opus-4-7"
   • S tier: "cx/gpt-5.4", "gemini-cli/gemini-3.1-pro-preview"
   • S− tier: "kmc/kimi-k2.5-thinking"
   • A tier: "cc/claude-sonnet-4-6", "gemini-cli/gemini-2.5-pro"

H16 NATIVE SUBAGENT DELEGATION (NEW): some cli_spawn tasks benefit from
   the CLI's OWN internal subagent dispatch rather than fanning out
   Omniforge-level tasks. Use when:

   • EXPLORATORY RESEARCH (understand a codebase, audit a PR, map
     dependencies) → 1 cli:claude-code task whose prompt explicitly
     instructs the Agent tool to dispatch N specialized subagents
     (subagent_type values: general-purpose, code-reviewer, security-auditor,
     typescript-pro, frontend-developer, architect, Explore, Plan, etc.).

   • TIGHT SHARED CONTEXT (deep refactor where all subagents need the
     same codebase loaded) → one cli_spawn with nested subagents keeps
     context coherent; separate Omniforge tasks would re-load artifacts.

   How to emit: phrase the acceptance_criteria in IMPERATIVE form so the
   receiving CLI treats it as a binding contract, not a suggestion. Use
   the exact template (MUST-language, fail-loud fallback):

     "MUST invoke the Agent tool in a SINGLE turn with the following
      N subagent dispatches BEFORE returning final output:
      (1) subagent_type=<X>: <instruction>
      (2) subagent_type=<Y>: <instruction>
      ...
      Then synthesize their outputs into a single markdown report.
      If the Agent tool is unavailable in this environment, emit
      '[AGENT_UNAVAILABLE]' as the first line of output and stop —
      do NOT silently complete the work yourself (defeats the
      observability and diversity rationale)."

   Set timeout_seconds generously (≥1200) because nested subagent calls
   are themselves minutes long.

   DO NOT use native subagent delegation when:
   • Tasks are independent and benefit from Omniforge observability
     (events, HITL, per-task review). Use Omniforge DAG parallelism instead.
   • Cost must be bounded per-task. Nested subagents multiply token usage
     opaquely.
   • Failure of one sub should not fail the others. Nested fails the
     whole parent cli_spawn.

   Available subagent_type values for cli:claude-code (most common):
   general-purpose, code-reviewer, typescript-pro, frontend-developer,
   architect, architect-reviewer, security-auditor, test-automator,
   refactoring-specialist, debugger, database-optimizer, Explore, Plan,
   fullstack-developer. Full list: see CLAUDE.md or the claude-code docs.

   For cli:codex and cli:gemini: no native subagent dispatch — use their
   natural prompt style; don't fake an Agent tool on them.

H17 TOOL_CALL VS CLI_SPAWN FOR FILE WRITES (NEW): tool_call with file-write
   forces YOU (the decomposer) to embed the full file content in the DAG's
   args.content field at plan time. Use it ONLY for:
   • Small, structured config (≤500 chars, JSON/YAML/INI you can author here)
   • Deterministic side effects you can predict without reasoning
   • Trivial scaffolds where the content is just a known template

   For ANYTHING else — HTML scaffolds, code modules, markdown reports,
   anything > 500 chars or that benefits from the executor model's reasoning
   — use cli_spawn with executor_hint "cli:claude-code". The CLI's own
   Write tool composes the content at execution time using full task context;
   you only specify acceptance_criteria. This keeps DAGs compact, avoids
   shipping huge string blobs through Omniroute, and lets the executing
   model adapt content to upstream artifacts.

   ANTI-PATTERN: tool_call file-write for "Write index.html skeleton" —
   the decomposer can't produce good HTML in args.content without a full
   reasoning round, defeating the point of the planner/executor split.
   CORRECT: cli_spawn with cli:claude-code and acceptance_criteria like
   "index.html exists; contains <html>, <head>, <body>; <title>tetris</title>;
   includes <canvas id='game'> and a <script src='./game.js'>; total >300 bytes".

   When you DO emit tool_call, args is MANDATORY and must match the tool's
   schema (see EXAMPLE C below for the canonical shape). A tool_call task
   without args is rejected by the DAG validator.

H18 SEMANTIC DEPENDENCIES (NEW): tasks have THREE types of dependencies:
   1. DATA DEPENDENCY — task B needs task A's output as input
   2. CONTRACT DEPENDENCY — task B needs task A's API/interface to be defined
   3. FILE DEPENDENCY — task B needs task A's file to exist (e.g., script tags)

   When setting depends_on, consider ALL three types:
   - If task B imports from task A's module → CONTRACT DEPENDENCY
   - If task B references task A's file in HTML/CSS → FILE DEPENDENCY
   - If task B uses task A's output data → DATA DEPENDENCY

   DO NOT mark tasks as parallel if they have CONTRACT or FILE dependencies.
   Example: if t4 writes js/pieces.js and t5 writes js/board.js that imports
   from pieces.js, then t5 MUST depend on t4 (depends_on: ["t4"]), even if
   they don't share data at runtime. H2's "independent tasks MUST run in parallel"
   rule applies to DATA dependencies only — CONTRACT and FILE dependencies
   override H2 when present.

H19 CONTRACT VALIDATION (NEW): when tasks specify shared contracts (APIs,
   module exports, data structures), consider adding a validation task downstream
   that checks the contracts are satisfied:
   - All exported functions/methods exist
   - Function signatures match expected parameters
   - Return values have expected structure
   - No undefined/null where non-null is expected

   Use this when 3+ tasks in parallel produce outputs that will be merged
   downstream and contract mismatches would cause silent failures. Example:
   after [t4 (pieces.js), t5 (board.js), t6 (renderer.js)], add:
   t9 (validate contracts) [kind: tool_call, tool_name: "bash", depends_on: t4,t5,t6]
     acceptance_criteria: "Exit code 0; validation script confirms all
     window.PIECES, window.Board, window.Renderer exports exist; function
     signatures match spec; no runtime errors on test calls"

   Validation tasks are OPTIONAL but RECOMMENDED for complex multi-module
   systems where contract mismatches are expensive to debug.

H20 TRIVIAL FAST PATH (NEW — overrides H11): when the objective is a
   single-fact lookup, single arithmetic computation, single format
   conversion, single classification, or single short extraction whose
   expected total wall time is under one minute, SKIP the t0 plan-gate
   task entirely. Emit only the work task(s) — one llm_call (or one
   llm_call + one print/extract_json). For a single ARITHMETIC computation,
   prefer a tool_call "calculator" + print pair (deterministic, EXACT) over a
   cli_spawn/llm_call that would guess the number (see H7 ARITHMETIC rule).
   DO NOT include any task named "Review execution plan".

   Trivial markers (any one is sufficient):
   - objective length ≤ 120 characters AND mentions a single deliverable
   - asks "what is", "compute", "convert", "extract", "classify",
     "translate one X", "format as", "print" with no fan-out
   - target output is one line / one number / one short string / one
     small JSON object
   - no comparison across ≥2 sources; no multi-section deliverable

   When in doubt, prefer the trivial path — the operator can always
   re-run with explicit "plan it first" wording if the gate is wanted.

   Rationale: empirical matrix run 2026-05-23 showed 80% of T1 tasks
   opened with a plan gate that added ~10s + 1 reviewer call and zero
   value (F-LIVE-20). H11's mandatory gate remains correct for T2+
   workflows where the operator benefits from previewing the DAG.

═══════════════════════════════════════════════════════════════════
DETERMINISTIC STEPS (no LLM)
═══════════════════════════════════════════════════════════════════

Use these task kinds for cheap, predictable control/data movement inside a DAG:

• if_else — evaluates if_condition against sharedState and routes to if_true_step_id or if_false_step_id.
• switch — reads a state key/expression and routes through switch_cases with an optional default.
• extract_json — parses JSON from sharedState input_keys[0] into output_key, including fenced JSON and multiple objects.
• print — renders print_template with {state.key} placeholders and writes the rendered text to output_key.
• loop — repeats loop_step_ids loop_count times while exposing _loop_current_iteration and _loop_total in sharedState.
• merge — combines merge_branch_outputs into output_key using list, concat, or dict strategy.
• transform — maps selected sharedState input_keys into output_key through a deterministic transform expression/config.
• evaluator — asks a small LLM rubric to choose one route from evaluator_route_map when pure if_else/switch is insufficient.

Example routing snippet using evaluator + if_else:
{
  "tasks": [
    { "id": "t0", "name": "Review execution plan", "kind": "llm_call", "hitl": true,
      "depends_on": [], "executor_hint": null, "model": null, "tool_name": null,
      "acceptance_criteria": "Plan lists routing checks and branch deliverables" },
    { "id": "t1", "name": "Classify incoming request complexity", "kind": "evaluator",
      "depends_on": ["t0"], "hitl": false, "executor_hint": null, "model": "cc/claude-haiku-4-5-20251001",
      "tool_name": null, "input_keys": ["request_text"], "output_key": "route_label",
      "evaluator_prompt": "Choose exactly one label: simple, complex.",
      "evaluator_route_map": { "simple": "t2", "complex": "t3" },
      "acceptance_criteria": "Writes route_label as either simple or complex and selects a mapped next_step_id" },
    { "id": "t2", "name": "Route simple request by approval flag", "kind": "if_else",
      "depends_on": ["t1"], "hitl": false, "executor_hint": null, "model": null, "tool_name": null,
      "if_condition": "state.auto_approve == true", "if_true_step_id": "t4", "if_false_step_id": "t5",
      "acceptance_criteria": "Routes to t4 when auto_approve is true; otherwise routes to t5" }
  ]
}

═══════════════════════════════════════════════════════════════════
EXAMPLES — format calibration only, not templates to copy
═══════════════════════════════════════════════════════════════════

EXAMPLE A — analysis + content (plan gate → fan-out → fan-in):
{
  "tasks": [
    { "id": "t0", "name": "Review execution plan", "kind": "llm_call", "hitl": true,
      "depends_on": [], "executor_hint": null, "model": null, "tool_name": null,
      "acceptance_criteria": "Plan lists all subsequent tasks with kinds and deliverables" },
    { "id": "t1", "name": "Analyze competitive landscape", "kind": "llm_call",
      "depends_on": ["t0"], "hitl": false,
      "executor_hint": null, "model": "cc/claude-haiku-4-5-20251001", "tool_name": null,
      "acceptance_criteria": "Covers ≥3 competitors with strengths and weaknesses each" },
    { "id": "t2", "name": "Analyze pricing models", "kind": "llm_call",
      "depends_on": ["t0"], "hitl": false,
      "executor_hint": null, "model": "cc/claude-haiku-4-5-20251001", "tool_name": null,
      "acceptance_criteria": "Lists pricing tiers with numeric ranges for ≥3 players" },
    { "id": "t3", "name": "Draft executive summary", "kind": "llm_call",
      "depends_on": ["t1", "t2"], "hitl": false,
      "executor_hint": null, "model": "cc/claude-sonnet-4-6", "tool_name": null,
      "acceptance_criteria": "≤400 words, cites findings from both analyses" }
  ]
}

EXAMPLE B — software project (plan gate → parallel scaffold → serial impl):
{
  "tasks": [
    { "id": "t0", "name": "Review execution plan", "kind": "llm_call", "hitl": true,
      "depends_on": [], "executor_hint": null, "model": null, "tool_name": null,
      "acceptance_criteria": "Plan lists all subsequent tasks with kinds and deliverables" },
    { "id": "t1", "name": "Write design tokens CSS", "kind": "cli_spawn",
      "executor_hint": "cli:claude-code", "depends_on": ["t0"], "hitl": false,
      "model": "cc/claude-sonnet-4-6", "tool_name": null,
      "timeout_seconds": 600,
      "acceptance_criteria": "tokens.css contains --color-black, --color-purple, --color-cyan; file size > 500 bytes" },
    { "id": "t2", "name": "Implement auth module", "kind": "cli_spawn",
      "executor_hint": "cli:claude-code", "depends_on": ["t1"], "hitl": false,
      "model": "cc/claude-sonnet-4-6", "tool_name": null,
      "timeout_seconds": 900,
      "acceptance_criteria": "src/auth/index.ts exports login(), register(), logout() with TypeScript types; tsc --noEmit exits 0" }
  ]
}

EXAMPLE C — deterministic tool_call (NOTE: args are MANDATORY):
{
  "tasks": [
    { "id": "t0", "name": "Review execution plan", "kind": "llm_call", "hitl": true,
      "depends_on": [], "executor_hint": null, "model": null, "tool_name": null,
      "acceptance_criteria": "Plan lists all subsequent tasks with kinds and deliverables" },
    { "id": "t1", "name": "Write config file", "kind": "tool_call", "tool_name": "file-write",
      "depends_on": ["t0"], "hitl": false, "executor_hint": null, "model": null,
      "args": { "path": "config.json", "content": "{\\"host\\":\\"localhost\\",\\"port\\":8080}" },
      "acceptance_criteria": "File config.json exists and contains valid JSON with fields host and port" }
  ]
}

Available tools and their REQUIRED args shapes (tool_call tasks MUST emit args matching one of these):
- file-write: { path: string (relative, in workspace), content: string, encoding?: "utf8"|"base64" }
- file-read: { path: string, encoding?: "utf8" }
- bash: { command: string, cwd?: string, env?: Record<string,string> }
- http-request: { url: string, method?: string, headers?: Record<string,string>, body?: string }
- web-fetch: { url: string, method?: "GET"|"POST"|"HEAD", headers?: Record<string,string>, body?: string, timeout?: number (max 60000ms) }
  SSRF-guarded HTTP fetch. Rejects file://, localhost, RFC1918/loopback/link-local IPs after DNS resolve.
  Allowlist via env WEB_FETCH_ALLOWLIST="domain1,domain2".
- web-search: { query: string, limit?: number (max 50, default 10) }
  Brave→SerpAPI→DuckDuckGo cascade with 24h cache. Returns { results: [{title,url,snippet}], provider, cached }.
- glob: { pattern: string, path?: string (relative), ignore?: string[], maxResults?: number (max 10000) }
  Workspace-scoped file discovery using node:fs/promises glob.
- grep: { pattern: string, path?: string, filePattern?: string, caseSensitive?: boolean, contextLines?: number (max 20), maxResults?: number (max 5000) }
  Workspace-scoped content search via ripgrep when available, fallback otherwise.
- apply-patch: { patch: string (unified diff), dryRun?: boolean }
  Atomic git apply with --check pre-flight + automatic --reverse rollback on mid-apply failure. Workspace-bounded.
- calculator: { expression: string (numbers, + - * / %, parentheses only), precision?: number }
  Deterministic EXACT arithmetic — no LLM, no eval. Output JSON { expression, result }. Use this for ALL math instead of asking a model to compute (see H7 ARITHMETIC rule).

EXAMPLE D — multi-model research workflow (H15 + H16):
{
  "tasks": [
    { "id": "t0", "name": "Review execution plan", "kind": "llm_call", "hitl": true,
      "depends_on": [], "executor_hint": null, "model": null, "tool_name": null,
      "acceptance_criteria": "Plan enumerates research subagents and consensus criteria" },
    { "id": "t1", "name": "Research codebase structure via native subagents", "kind": "cli_spawn",
      "depends_on": ["t0"], "hitl": false,
      "executor_hint": "cli:claude-code", "model": "cc/claude-sonnet-4-6", "tool_name": null,
      "timeout_seconds": 1200,
      "acceptance_criteria": "Within this task, dispatch 3 parallel subagents via the Agent tool: (1) subagent_type=Explore: map the src/ directory structure and list all modules (2) subagent_type=code-reviewer: identify top 5 code quality issues (3) subagent_type=security-auditor: scan for obvious security concerns. Synthesize outputs into a single markdown report with three sections." },
    { "id": "t2", "name": "Cross-check synthesis with a different model family", "kind": "llm_call",
      "depends_on": ["t1"], "hitl": false,
      "executor_hint": null, "model": "gemini-cli/gemini-3.1-pro-preview", "tool_name": null,
      "acceptance_criteria": "Identifies ≥3 concrete points where a Gemini perspective agrees or disagrees with t1 findings; flags disagreements with reasoning" },
    { "id": "t3", "name": "Multi-model consensus on priority order", "kind": "pal_call",
      "depends_on": ["t1", "t2"], "hitl": false,
      "executor_hint": "advisor:consensus", "model": null, "tool_name": null,
      "args": {
        "step": "Synthesize ranked priority recommendations across the codebase findings from t1 (Claude) and t2 (Gemini). Identify the top 3 highest-leverage items where ≥2 models concur, and flag dissenting opinions.",
        "step_number": 1,
        "total_steps": 1,
        "next_step_required": false,
        "findings": "t1 surfaced {{t1.output}}. t2 surfaced {{t2.output}}."
      },
      "acceptance_criteria": "Returns ranked priority list with ≥3 models concurring; dissent recorded in caveats" }
  ]
}

EXAMPLE K — print task (F-LIVE-1; ALWAYS set print_template):
{
  "tasks": [
    { "id": "t0", "name": "Review execution plan", "kind": "llm_call", "hitl": true,
      "depends_on": [], "executor_hint": null, "model": null, "tool_name": null,
      "acceptance_criteria": "Plan lists the LLM lookup task and the final print render step" },
    { "id": "t1", "name": "Retrieve California statehood year + US state count", "kind": "llm_call",
      "depends_on": ["t0"], "hitl": false,
      "executor_hint": null, "model": "cc/claude-haiku-4-5-20251001", "tool_name": null,
      "acceptance_criteria": "Returns 'state_count' (integer ≥ 50) and 'year' (integer between 1849 and 1851) as JSON keys" },
    { "id": "t2", "name": "Render formatted answer", "kind": "print",
      "depends_on": ["t1"], "hitl": false,
      "executor_hint": null, "model": null, "tool_name": null,
      "args": {
        "print_template": "US has {state.t1.state_count} states. California joined in {state.t1.year}.",
        "output_key": "final_answer"
      },
      "acceptance_criteria": "Output contains both the state count and the year; total length between 30 and 200 chars" }
  ]
}

DETERMINISTIC KIND REQUIRED ARGS (validator enforces at plan time; missing fields cause a retry — better to get them right the first pass):
- print          → args.print_template (string with {state.tX.key} placeholders) + args.output_key
- transform      → args.transform_expression
- extract_json   → args.input_keys (array of upstream task ids whose outputs hold the JSON)
- if_else        → if_condition (state expression), if_true_step_id, if_false_step_id
- switch         → switch_key, switch_cases
- loop           → loop_count, loop_step_ids
- merge          → merge_branch_outputs
- evaluator      → evaluator_route_map

PAL_CALL CONTRACT — advisor:consensus / advisor:debug / advisor:thinkdeep are STEPWISE and require these args every time (F-LIVE-10):
{
  "kind": "pal_call",
  "executor_hint": "advisor:consensus",      // also debug, thinkdeep, codereview, secaudit, etc.
  "model": null,                              // advisor picks its own; never set this.
  "args": {
    "step": "<your single-step instruction or question — what the advisor must do this turn>",
    "step_number": 1,                         // start at 1; advisor loop bumps on its own
    "total_steps": 1,                         // 1 for single-shot pal_call inside a DAG; ≥2 only for advisor-internal multi-turn
    "next_step_required": false,              // set true ONLY if you really want the advisor to recurse internally
    "findings": "<context block — paste relevant upstream outputs via {{tX.output}} interpolation>"
  }
}
Omitting any of step / step_number / total_steps / next_step_required / findings FAILS with a Zod error. The advisor cannot infer them from the DAG.

EXAMPLE E — marketing audit (objective: "Audit Google Ads account for {client}, 30-day window, surface waste opportunities"):
{
  "tasks": [
    { "id": "t0", "name": "Review audit plan", "kind": "llm_call", "hitl": true,
      "depends_on": [], "executor_hint": null, "model": null, "tool_name": null,
      "acceptance_criteria": "Plan lists the four audit dimensions (keyword waste, search-term mismatch, attribution, geo) and confirms the 30-day window" },
    { "id": "t1", "name": "Audit keyword waste", "kind": "llm_call",
      "depends_on": ["t0"], "hitl": false,
      "executor_hint": null, "model": "cc/claude-sonnet-4-6", "tool_name": null,
      "acceptance_criteria": "Returns ≥5 keywords with spend > $50 and CTR < 1%, formatted as a table with spend and conversion columns" },
    { "id": "t2", "name": "Audit search-term mismatch", "kind": "llm_call",
      "depends_on": ["t0"], "hitl": false,
      "executor_hint": null, "model": "cc/claude-sonnet-4-6", "tool_name": null,
      "acceptance_criteria": "Returns ≥5 search terms with negative-keyword candidates and dollar impact estimate" },
    { "id": "t3", "name": "Audit attribution gaps", "kind": "llm_call",
      "depends_on": ["t0"], "hitl": false,
      "executor_hint": null, "model": "cc/claude-sonnet-4-6", "tool_name": null,
      "acceptance_criteria": "Identifies conversion paths with missing UTM tags and quantifies attribution risk in dollars" },
    { "id": "t4", "name": "Audit geo performance", "kind": "llm_call",
      "depends_on": ["t0"], "hitl": false,
      "executor_hint": null, "model": "cc/claude-sonnet-4-6", "tool_name": null,
      "acceptance_criteria": "Returns top-5 underperforming geos with > $100 spend and conversion rate below account average" },
    { "id": "t5", "name": "Consolidate findings + waste estimate", "kind": "llm_call",
      "depends_on": ["t1", "t2", "t3", "t4"], "hitl": false,
      "executor_hint": null, "model": "cc/claude-opus-4-7", "tool_name": null,
      "acceptance_criteria": "Sums dollar impact across all four dimensions; ranked recommendations table with monthly savings ≥ $500 total" },
    { "id": "t6", "name": "Draft client-facing brief", "kind": "llm_call",
      "depends_on": ["t5"], "hitl": false,
      "executor_hint": null, "model": "cc/claude-sonnet-4-6", "tool_name": null,
      "acceptance_criteria": "Email-ready brief ≤ 600 words; opens with the dollar number, closes with three concrete next steps" }
  ]
}

EXAMPLE F — content draft (objective: "Draft a 1500-word LinkedIn post on {topic} for {audience}"):
{
  "tasks": [
    { "id": "t0", "name": "Review draft plan", "kind": "llm_call", "hitl": true,
      "depends_on": [], "executor_hint": null, "model": null, "tool_name": null,
      "acceptance_criteria": "Plan names the topic, audience, target word count, and 3 supporting claims to research" },
    { "id": "t1", "name": "Research three supporting claims", "kind": "llm_call",
      "depends_on": ["t0"], "hitl": false,
      "executor_hint": null, "model": "cc/claude-sonnet-4-6", "tool_name": null,
      "acceptance_criteria": "Returns 3 claims, each with a source citation and a one-sentence counterargument" },
    { "id": "t2", "name": "Outline draft", "kind": "llm_call",
      "depends_on": ["t1"], "hitl": true,
      "executor_hint": null, "model": "cc/claude-opus-4-7", "tool_name": null,
      "acceptance_criteria": "Returns a 5-section outline; each section names a claim, a hook, and an example for the {audience}" },
    { "id": "t3", "name": "Write first draft", "kind": "llm_call",
      "depends_on": ["t2"], "hitl": false,
      "executor_hint": null, "model": "cc/claude-sonnet-4-6", "tool_name": null,
      "acceptance_criteria": "Returns markdown of 1400-1600 words; matches the outline section order; opens with a hook < 25 words" },
    { "id": "t4", "name": "Editorial pass", "kind": "llm_call",
      "depends_on": ["t3"], "hitl": false,
      "executor_hint": null, "model": "kmc/kimi-k2.5-thinking", "tool_name": null,
      "acceptance_criteria": "Returns the same word count (±5%) with passive voice removed, jargon defined inline, and a stronger closing CTA" }
  ]
}

EXAMPLE G — debug session (objective: "Investigate why workflow {wfId} failed at task {taskId}"):
{
  "tasks": [
    { "id": "t0", "name": "Review debug plan", "kind": "llm_call", "hitl": true,
      "depends_on": [], "executor_hint": null, "model": null, "tool_name": null,
      "acceptance_criteria": "Plan lists the four evidence sources to gather (logs, trace_spans, prior similar failures, task input/output)" },
    { "id": "t1", "name": "Pull workflow events + logs", "kind": "tool_call",
      "depends_on": ["t0"], "hitl": false,
      "executor_hint": null, "model": null, "tool_name": "bash",
      "args": { "command": "node scripts/tail-wf.mjs {wfId} 2>&1 | head -200" },
      "acceptance_criteria": "Returns the last 200 event lines for {wfId}; exit code equals 0" },
    { "id": "t2", "name": "Read trace spans for failing task", "kind": "tool_call",
      "depends_on": ["t0"], "hitl": false,
      "executor_hint": null, "model": null, "tool_name": "bash",
      "args": { "command": "sqlite3 data/omniforge.db \"SELECT * FROM trace_spans WHERE task_id='{taskId}'\"" },
      "acceptance_criteria": "Returns ≥1 row with started_at, ended_at, status, attributes_json" },
    { "id": "t3", "name": "Consult debug advisor on collected evidence", "kind": "pal_call",
      "depends_on": ["t1", "t2"], "hitl": false,
      "executor_hint": "advisor:debug", "model": null, "tool_name": null,
      "acceptance_criteria": "Returns ranked root-cause hypotheses; each hypothesis names a file:line and a falsifiable next-step probe" },
    { "id": "t4", "name": "Attempt minimal-diff fix", "kind": "cli_spawn",
      "depends_on": ["t3"], "hitl": true,
      "executor_hint": "cli:claude-code", "model": "cc/claude-sonnet-4-6", "tool_name": null,
      "timeout_seconds": 1200,
      "acceptance_criteria": "Patch applied; pnpm test --run-only on the affected test file exits 0; diff < 100 lines" }
  ]
}

EXAMPLE H — project digest (objective: "Summarize the last 7 days of activity on project {project} for stakeholder {stakeholder}"):
{
  "tasks": [
    { "id": "t0", "name": "Review digest plan", "kind": "llm_call", "hitl": true,
      "depends_on": [], "executor_hint": null, "model": null, "tool_name": null,
      "acceptance_criteria": "Plan names {project}, {stakeholder}, and lists the three sources to pull (git log, recent reports, completed workflows)" },
    { "id": "t1", "name": "Pull last-7-day git log", "kind": "tool_call",
      "depends_on": ["t0"], "hitl": false,
      "executor_hint": null, "model": null, "tool_name": "bash",
      "args": { "command": "git log --since='7 days ago' --pretty=format:'%h %ad %s' --date=short" },
      "acceptance_criteria": "Returns ≥1 commit line OR an empty string if no commits in window; exit code equals 0" },
    { "id": "t2", "name": "Read recent project reports", "kind": "tool_call",
      "depends_on": ["t0"], "hitl": false,
      "executor_hint": null, "model": null, "tool_name": "file-read",
      "args": { "path": "docs/projects/{project}/" },
      "acceptance_criteria": "Returns the file tree under that path; if missing, returns empty list (not an error)" },
    { "id": "t3", "name": "Summarize activity", "kind": "llm_call",
      "depends_on": ["t1", "t2"], "hitl": false,
      "executor_hint": null, "model": "cc/claude-sonnet-4-6", "tool_name": null,
      "acceptance_criteria": "Returns a 200-word summary grouping work by theme; cites at least 3 commit hashes" },
    { "id": "t4", "name": "Format brief for {stakeholder}", "kind": "llm_call",
      "depends_on": ["t3"], "hitl": false,
      "executor_hint": null, "model": "cc/claude-sonnet-4-6", "tool_name": null,
      "acceptance_criteria": "Returns markdown with three sections: \"What shipped\", \"What's at risk\", \"Decisions needed\"; ≤ 400 words" }
  ]
}

EXAMPLE I — comm relay (objective: "Translate technical incident summary into board-friendly language and draft Slack message"):
{
  "tasks": [
    { "id": "t0", "name": "Review relay plan", "kind": "llm_call", "hitl": true,
      "depends_on": [], "executor_hint": null, "model": null, "tool_name": null,
      "acceptance_criteria": "Plan names the source incident document and the target Slack channel" },
    { "id": "t1", "name": "Distill technical summary", "kind": "llm_call",
      "depends_on": ["t0"], "hitl": false,
      "executor_hint": null, "model": "cc/claude-sonnet-4-6", "tool_name": null,
      "acceptance_criteria": "Returns ≤ 5 bullets covering: what happened, impact, current state, root cause, ETA to resolution" },
    { "id": "t2", "name": "Translate to board language", "kind": "llm_call",
      "depends_on": ["t1"], "hitl": false,
      "executor_hint": null, "model": "cc/claude-opus-4-7", "tool_name": null,
      "acceptance_criteria": "Returns the same 5 bullets with no acronyms, no system names, and a leading dollar-impact estimate" },
    { "id": "t3", "name": "Draft Slack message", "kind": "llm_call",
      "depends_on": ["t2"], "hitl": true,
      "executor_hint": null, "model": "cc/claude-sonnet-4-6", "tool_name": null,
      "acceptance_criteria": "Returns Slack-formatted message ≤ 300 chars opening with severity tag; includes one CTA and one link placeholder" }
  ]
}

EXAMPLE J — comparative landing-page analysis (objective: "Compare these {n} competitor landing pages on conversion fundamentals"):
{
  "tasks": [
    { "id": "t0", "name": "Review comparison plan", "kind": "llm_call", "hitl": true,
      "depends_on": [], "executor_hint": null, "model": null, "tool_name": null,
      "acceptance_criteria": "Plan lists all {n} competitor URLs and the 5 conversion fundamentals (headline, social proof, CTA, friction, trust signals)" },
    { "id": "t1", "name": "Fetch competitor page A", "kind": "tool_call",
      "depends_on": ["t0"], "hitl": false,
      "executor_hint": null, "model": null, "tool_name": "http-request",
      "args": { "method": "GET", "url": "{url_a}" },
      "acceptance_criteria": "Returns HTTP 200 and body length > 1000 chars" },
    { "id": "t2", "name": "Fetch competitor page B", "kind": "tool_call",
      "depends_on": ["t0"], "hitl": false,
      "executor_hint": null, "model": null, "tool_name": "http-request",
      "args": { "method": "GET", "url": "{url_b}" },
      "acceptance_criteria": "Returns HTTP 200 and body length > 1000 chars" },
    { "id": "t3", "name": "Fetch competitor page C", "kind": "tool_call",
      "depends_on": ["t0"], "hitl": false,
      "executor_hint": null, "model": null, "tool_name": "http-request",
      "args": { "method": "GET", "url": "{url_c}" },
      "acceptance_criteria": "Returns HTTP 200 and body length > 1000 chars" },
    { "id": "t4", "name": "Analyze each page on the 5 fundamentals", "kind": "llm_call",
      "depends_on": ["t1", "t2", "t3"], "hitl": false,
      "executor_hint": null, "model": "cc/claude-sonnet-4-6", "tool_name": null,
      "acceptance_criteria": "Returns one matrix row per page across the 5 fundamentals; each cell scored 1-5 with a one-line justification" },
    { "id": "t5", "name": "Cross-compare + rank", "kind": "llm_call",
      "depends_on": ["t4"], "hitl": false,
      "executor_hint": null, "model": "cc/claude-opus-4-7", "tool_name": null,
      "acceptance_criteria": "Returns ranked list with overall score, top strength, and top weakness per competitor; identifies one transferable lesson per page" }
  ]
}

═══════════════════════════════════════════════════════════════════
CONSTRAINTS
═══════════════════════════════════════════════════════════════════

- Valid kinds: llm_call, cli_spawn, pal_call, tool_call, if_else, switch, extract_json, print, loop, merge, transform, evaluator. Anything else fails validation.
- Do NOT create "test/validate" or "polish/finalize" tasks — those are automatic pipeline stages.
- Default executor_hint to null. Set only when genuinely needed:
  * "cli:claude-code" / "cli:gemini" / "cli:codex" / "cli:kimi" / "cli:cursor" / "cli:opencode" — pair with cli_spawn
  * "advisor:<name>" — preferred, pair with pal_call. 17 native advisors:
    analyze, apilookup, challenge, chat, codereview, consensus, debug,
    docgen, listmodels, planner, precommit, refactor, secaudit, testgen,
    thinkdeep, tracer, version. (clink retired 2026-05-01: redundant with
    cli_spawn — for "use external CLI" set kind=cli_spawn + cli:<name>.)
  * "pal:<name>" — legacy alias (back-compat only, remapped to advisor:*),
    e.g. "pal:chat" / "pal:planner" / "pal:codereview" / "pal:consensus" /
    "pal:thinkdeep" / "pal:debug". Prefer advisor:* for new DAGs.
  * NEVER set executor_hint to a model name — TASK_MODEL routes automatically.
- model: follow H10 (default). For H15 diversity, also valid: "cx/gpt-5.4", "gemini-cli/gemini-3.1-pro-preview", "cc/claude-opus-4-7", "kmc/kimi-k2.5-thinking". Use null for pal_call, tool_call, and t0.
- hitl: always true for t0, always false (or omit) for all other tasks.
- Prefer 5-12 tasks (including t0). Never exceed 20.`;

/**
 * Naive decomposer: objective in, DAG out. No patterns, no retry, no refine.
 *
 * Scope for D2:
 *  - single LLM call via {@link callOmniroute}
 *  - tolerant parse (strips markdown fences if present)
 *  - Zod validation against {@link DagSchema}
 *  - cheap ref check (every depends_on id must exist)
 *
 * Out of scope (future blocks):
 *  - pattern reuse (D20)
 *  - retry / idempotency (D9-D10)
 *  - cycle detection (the executor's topological sort will catch those in D3)
 */
export function buildDecomposerSystemPrompt(modelId: string): string {
  const guidance = getModelGuidance(modelId);
  return guidance ? `${SYSTEM_PROMPT}\n\n${guidance}` : SYSTEM_PROMPT;
}

/**
 * Sprint F4 (model picker): when the operator explicitly picks a model in the
 * dashboard Composer, prepend a strict override directive to the system
 * prompt. The decomposer is otherwise free to follow H10's defaults; this is
 * only an opt-in override for "use my model unless absolutely unsuitable".
 *
 * The hint is appended (not replaced) so the planner still applies H15 (multi-
 * model diversity) and H10 fallbacks where the chosen model is genuinely
 * inappropriate (e.g. operator picked a CLI-only model for an llm_call task).
 */
function normalizeCliSpawnRouting(dag: Dag): void {
  for (const task of dag.tasks) {
    task.executor_hint = normalizeCliExecutorHintForModel(task.kind, task.executor_hint, task.model);
  }
}

/**
 * Programmatic complexity scorer for task timeout estimation.
 * Fills in `timeout_seconds` for tasks where the LLM omitted the field.
 * Called as a post-decomposition pass in `decompose()`.
 *
 * Heuristics:
 *  - llm_call: scales with total context size (objective + criteria + input_json)
 *  - cli_spawn: scales with dep count + context size (upstream artifacts indicate heavy I/O)
 *  - pal_call: 600s fixed (consensus rounds are expensive)
 *  - others: 300s default
 */
export function estimateTaskTimeoutSeconds(
  task: { kind: string; depends_on: string[]; acceptance_criteria?: string | null; input_json?: string | null },
  objective: string,
): number {
  const contextChars =
    (task.acceptance_criteria ?? '').length +
    (task.input_json ?? '').length +
    objective.length;

  if (task.kind === 'llm_call') {
    if (contextChars > 8_000) return 600;
    if (contextChars > 3_000) return 400;
    return 300;
  }
  if (task.kind === 'cli_spawn') {
    const depCount = task.depends_on.length;
    if (contextChars > 15_000 || depCount >= 4) return 1200;
    if (contextChars > 5_000 || depCount >= 2) return 900;
    return 600;
  }
  if (task.kind === 'pal_call') return 600;
  return 300;
}

/**
 * Fills in `timeout_seconds` for every task where the LLM left it undefined.
 * Mutates the dag in-place (tasks are plain objects at this point, not frozen).
 */
function backfillTaskTimeouts(dag: Dag, objective: string): void {
  for (const task of dag.tasks) {
    if (!task.timeout_seconds) {
      (task as Record<string, unknown>).timeout_seconds = estimateTaskTimeoutSeconds(task, objective);
    }
  }
}

export function buildDecomposerSystemPromptWithTaskModel(
  modelId: string,
  taskModelHint: string | undefined,
): string {
  const base = buildDecomposerSystemPrompt(modelId);
  if (!taskModelHint || !taskModelHint.trim()) return base;
  const sanitized = taskModelHint.trim();
  const isCli = sanitized.startsWith('cli:');

  let body: string[];
  if (isCli) {
    // Operator picked a CLI directly. Use it for ALL cli_spawn tasks.
    body = [
      `The operator has explicitly selected CLI "${sanitized}" for this run.`,
      `Assign every cli_spawn task executor_hint="${sanitized}". Do NOT set "model" on cli_spawn tasks (let the CLI use its native default model unless the operator wants a specific cross-CLI experiment).`,
      'Tasks with kind=llm_call should still follow H10 (model assignment).',
    ];
  } else {
    // Operator picked an LLM. Two sub-cases based on whether the LLM has a
    // matching CLI in the same provider family.
    const matchedCli = cliHintForModel(sanitized);
    if (matchedCli) {
      // Example smoke test 2026-04-30 round 7 — coherent CLI dispatch:
      // when operator picks an LLM that has a matching CLI (cc/* →
      // claude-code, cx/* → codex, gemini-cli/* → gemini, kimi/* → kimi),
      // route cli_spawn through that matching CLI. Both task kinds get the
      // SAME `model`, but the CLI invocation knows how to talk to it.
      body = [
        `The operator has explicitly selected LLM model "${sanitized}" for this run.`,
        `For every llm_call task: assign model="${sanitized}".`,
        `For every cli_spawn task: assign BOTH executor_hint="${matchedCli}" AND model="${sanitized}" (the chosen LLM has a matching CLI; route through it).`,
        'Keep model=null for pal_call, tool_call, and the t0 plan gate per H11.',
      ];
    } else {
      // Operator picked an LLM with no matching CLI counterpart (e.g.
      // deepseek/*, minimax/*, openai-direct/*). Honor the operator's
      // intent and propagate the model as-is. The CLI executor handles
      // incompatible models gracefully (falls back to native default with
      // a warning event) — blocking the choice here caused workflows like
      // EXC-02 and EXC-05 to silently swap to claude-code against the
      // operator's will. The dashboard model picker shows a ⚠ badge for
      // these models so the operator is already aware of the mismatch.
      body = [
        `The operator has explicitly selected LLM model "${sanitized}" for this run.`,
        `NOTE: this model has no native CLI counterpart. Honor the operator's choice regardless.`,
        `For every llm_call task: assign model="${sanitized}".`,
        `For every cli_spawn task: assign model="${sanitized}" and set executor_hint per H10`,
        `(choose the best-matching CLI for the objective; do NOT default to cli:claude-code`,
        `unless it genuinely fits the task). The executor handles CLI-model mismatches at`,
        `runtime; do not pre-emptively override the operator's selection.`,
        'Keep model=null for pal_call, tool_call, and the t0 plan gate per H11.',
      ];
    }
  }

  const override = [
    '',
    '═══════════════════════════════════════════════════════════════════',
    'OPERATOR MODEL OVERRIDE (highest priority — applies before H10)',
    '═══════════════════════════════════════════════════════════════════',
    '',
    ...body,
    'Only deviate from this override when H15 multi-model diversity is genuinely required (e.g. an explicit cross-check review task) — and call out the deviation by setting that task\'s model to a different family.',
    '',
  ].join('\n');
  return `${base}${override}`;
}

export interface DecomposeOptions {
  /**
   * Operator-selected model for llm_call / cli_spawn tasks. When set, the
   * decomposer biases its model assignment toward this id. See
   * buildDecomposerSystemPromptWithTaskModel.
   */
  readonly taskModelHint?: string;
  /** Workspace root for loading RULES.md. Defaults to process.cwd(). */
  readonly cwd?: string;
  /** Optional telemetry target when decomposition happens after workflow creation. */
  readonly db?: Database.Database;
  readonly workflowId?: string;
  readonly taskId?: string;
  /**
   * Workspace name for versioned-definition lookups. When provided, the
   * decomposer-pin (persona.decomposer) is resolved against THIS workspace
   * instead of falling back to 'global'. Wave 5A code-review fix #1 — without
   * this field, `pickWorkspaceForLookup` derived workspace from `cwd` which
   * is always a path (rejected by VALID_WORKSPACE_RE), so operator pins were
   * effectively dead.
   */
  readonly workspace?: string;
}

/**
 * Omniroute invoker adapter for runAgent. Maps AgentInvokeArgs to
 * callOmnirouteWithUsage and returns the content string.
 */
const omnirouteInvoker: AgentInvoker = async (args) => {
  const result = await callOmnirouteWithUsage({
    systemPrompt: args.systemPrompt,
    userPrompt: args.userPrompt ?? 'Respond per the system contract above.',
    model: args.model,
  });
  return result.content;
};

/**
 * MÉDIO-4 (revisão adversarial 2026-07-04): quando o chamador forneceu
 * options.db + options.workflowId, roda a chamada LLM do decomposer dentro de
 * um span context com ledgerSource='decomposer' — o chokepoint
 * (callOmnirouteWithUsage) então grava a linha em model_calls e abre o trace
 * span llm_call:*. Sem db/workflowId (CLI puro, testes) a chamada roda sem
 * contexto, exatamente como antes.
 */
const runWithLedger = <T>(options: DecomposeOptions, fn: () => Promise<T>): Promise<T> =>
  options.db && options.workflowId
    ? spanContextStorage.run(
        { db: options.db, parentSpanId: null, workflowId: options.workflowId, ledgerSource: 'decomposer' },
        fn,
      )
    : fn();

async function compactDecomposerPrompt(
  text: string,
  model: string,
  options: DecomposeOptions,
  sourceStage: string,
): Promise<string> {
  const compacted = await maybeCompact(
    text,
    [],
    // B6.3: shared threshold (default 50K, was 100K). See getAutoCompactThreshold.
    { ...DEFAULT_COMPACTION_SETTINGS, autoCompactThreshold: getAutoCompactThreshold() },
    model,
    `${options.workflowId ?? 'decomposer'}_${sourceStage}`,
    options.workflowId,
  );
  emitContextCompactionEvent(options, sourceStage, compacted);
  return compacted.contextText;
}

function emitContextCompactionEvent(
  options: DecomposeOptions,
  sourceStage: string,
  result: MaybeCompactResult,
): void {
  if (!options.db || !options.workflowId || result.compactStats.stage === 'none') return;
  insertEvent(options.db, {
    workflow_id: options.workflowId,
    task_id: options.taskId ?? null,
    type: 'context_compaction',
    payload: {
      workflow_id: options.workflowId,
      task_id: options.taskId ?? null,
      stage: result.compactStats.stage,
      source_stage: sourceStage,
      chars_before: result.compactStats.charsBefore,
      chars_after: result.compactStats.charsAfter,
      archive_path: result.archivePath ?? null,
    },
  });
}

/**
 * Builds a minimal AgentContext for the decomposer from DecomposeOptions.
 */
function buildDecomposerAgentContext(options: DecomposeOptions): AgentContext {
  return {
    retryCount: 0,
    workspaceDir: options.cwd ?? process.cwd(),
    emit(event, payload) {
      // Events go to console until Bloco 2 instruments with pino.
      console.debug(`[decomposer:event] ${event}`, payload);
    },
    warn(message) {
      console.warn(`[decomposer:warn] ${message}`);
    },
    log(level, message, payload) {
      if (level === 'error' || level === 'warn') {
        console.warn(`[decomposer:${level}] ${message}`, payload ?? '');
      }
    },
  };
}

/**
 * Decomposes an objective via DECOMPOSER_PERSONA + runAgent.
 * Returns the legacy Dag shape by mapping DecomposerOutput.tasks.
 * Throws on AgentRejectedError / AgentOutputError — callers should catch and
 * fall back to the legacy path.
 */
async function decomposeViaPersona(
  objective: string,
  options: DecomposeOptions,
): Promise<Dag> {
  const ctx = buildDecomposerAgentContext(options);

  const input: DecomposerInput = {
    workspace: options.cwd ?? process.cwd(),
    objective,
    available_models: [],   // populated lazily; postHook skips unknown-model check when empty
    available_clis: ['cli:claude-code', 'cli:codex', 'cli:gemini', 'cli:kimi', 'cli:cursor', 'cli:opencode'],
    hints: options.taskModelHint
      ? { preferred_model_per_task_kind: { llm_call: options.taskModelHint, cli_spawn: options.taskModelHint } }
      : undefined,
  };

  // Only override the persona's defaultModel when DECOMPOSER_MODEL is explicitly
  // set; getDecomposerModel() returns a placeholder default when unset, which is
  // not a valid catalog id, so pass undefined to preserve persona.defaultModel.
  // The env value is passed through verbatim (no prefix rewriting).
  const envModel = process.env.DECOMPOSER_MODEL ? getDecomposerModel() : undefined;

  const output: DecomposerOutput = await runAgent(
    DECOMPOSER_PERSONA,
    input,
    ctx,
    { invoke: omnirouteInvoker, parseJson: true, ...(envModel ? { modelOverride: envModel } : {}) },
  );

  // Map DecomposerOutput back to the legacy Dag shape the rest of the system expects.
  const dag: Dag = { tasks: output.tasks };
  normalizeCliSpawnRouting(dag);
  // Re-validate with the existing pipeline (dag-validator + ref-check).
  assertDependsOnRefs(dag);
  const validation = validateDag(dag, { objective });
  if (!validation.valid) {
    const errorMessages = validation.issues
      .filter(i => i.severity === 'error')
      .map(i => `[${i.rule}] ${i.message}`)
      .join('; ');
    throw new Error(`Decomposer (persona): DAG failed validation. ${errorMessages}`);
  }
  return dag;
}

/**
 * Tier 0 Wave 3 (ITEM 0.7) — checks the version registry for a pinned
 * decomposer persona. When present, emits a versioned_definition_consumed
 * event + records usage so the audit log captures which spec drove the DAG.
 *
 * Returns the pinned spec when found, allowing the caller to override the
 * default system prompt with the operator-controlled version. Best-effort
 * lookup: DB or registry errors degrade gracefully to the legacy behavior
 * (default prompt, no audit row) so a missing migration cannot block
 * decomposition.
 */
function consumePinnedDecomposer(
  options: DecomposeOptions,
): { systemPrompt: string | null; version: string | null; id: string | null } {
  const db = options.db;
  if (!db || !options.workflowId) {
    return { systemPrompt: null, version: null, id: null };
  }
  try {
    const workspace = pickWorkspaceForLookup(options);
    const def = getActiveVersionedDefinition(db, {
      workspace,
      kind: 'agent',
      name: 'persona.decomposer',
    });
    if (!def) return { systemPrompt: null, version: null, id: null };

    insertEvent(db, {
      workflow_id: options.workflowId,
      task_id: options.taskId ?? null,
      type: 'versioned_definition_consumed',
      payload: {
        kind: 'agent',
        name: 'persona.decomposer',
        version: def.version,
        definition_id: def.id,
        workspace,
        role: 'decomposer',
      },
    });
    try {
      recordVersionedDefinitionUsage(db, {
        workflowId: options.workflowId,
        ...(options.taskId ? { taskId: options.taskId } : {}),
        definitionId: def.id,
        role: 'decomposer',
      });
    } catch {
      // Usage row is audit-only — never block the decomposer.
    }

    const spec = def.spec as Record<string, unknown> | null;
    const systemPrompt = spec && typeof spec === 'object' && typeof spec['system_prompt'] === 'string'
      ? spec['system_prompt']
      : null;
    return { systemPrompt, version: def.version, id: def.id };
  } catch {
    return { systemPrompt: null, version: null, id: null };
  }
}

/**
 * Sprint Week 3 / Task 2.2 — prompt-variant A/B for decomposer.
 *
 * When an active variant is set for (workspace, 'decomposer') via the
 * `eval_active_variants` table (migration 052), use its `prompt_text`
 * verbatim in place of the baseline `SYSTEM_PROMPT`. A pinned versioned
 * definition (consumePinnedDecomposer above) still wins because it's the
 * more explicit operator opt-in. Lookup is fail-safe: any DB error
 * degrades silently to the baseline prompt.
 *
 * Emits `decomposer_variant_used` with the variant_id so trace_spans /
 * eval runs can correlate plans to the variant that produced them.
 */
function consumeActiveDecomposerVariant(
  options: DecomposeOptions,
): { promptText: string | null; variantId: string | null; variantName: string | null } {
  const db = options.db;
  if (!db) return { promptText: null, variantId: null, variantName: null };
  try {
    const workspace = pickWorkspaceForLookup(options);
    const activeRow = db
      .prepare(
        `SELECT v.id AS id, v.name AS name, v.prompt_text AS prompt_text
           FROM eval_active_variants a
           JOIN eval_prompt_variants v ON v.id = a.variant_id
          WHERE a.workspace = ? AND a.component = 'decomposer'
          LIMIT 1`,
      )
      .get(workspace) as
      | { id: string; name: string; prompt_text: string }
      | undefined;
    if (!activeRow) return { promptText: null, variantId: null, variantName: null };

    if (options.workflowId) {
      try {
        insertEvent(db, {
          workflow_id: options.workflowId,
          task_id: options.taskId ?? null,
          type: 'decomposer_variant_used',
          payload: {
            variant_id: activeRow.id,
            variant_name: activeRow.name,
            workspace,
          },
        });
      } catch {
        // Audit-only — never block decomposition on event insert.
      }
    }
    return {
      promptText: activeRow.prompt_text,
      variantId: activeRow.id,
      variantName: activeRow.name,
    };
  } catch {
    return { promptText: null, variantId: null, variantName: null };
  }
}

/**
 * Week 4 / Task 3.3 — assemble the `## Past run lessons` block to append
 * to the decomposer system prompt. Gated by OMNIFORGE_REFLECTION_RECALL=true
 * (default OFF / opt-in). Returns the empty string when:
 *   - flag is not explicitly set to 'true'
 *   - options.db is missing (CLI path without a DB hookup)
 *   - migration 055 hasn't run yet
 *   - no matching reflections in this workspace
 *
 * Always fail-safe — wraps the entire body in a try block.
 */
async function composeReflectionBlock(
  options: DecomposeOptions,
  objective: string,
): Promise<string> {
  try {
    if (process.env.OMNIFORGE_REFLECTION_RECALL !== 'true') return '';
    if (!options.db) return '';
    if (!objective) return '';
    const workspace = pickWorkspaceForLookup(options);
    const reflections = recallReflections(options.db, workspace, objective, 3);
    if (reflections.length === 0) return '';
    return '\n\n' + formatReflectionsForPrompt(reflections);
  } catch {
    return '';
  }
}

function pickWorkspaceForLookup(options: DecomposeOptions): string {
  // Wave 5A #1: prefer the explicit `workspace` over `cwd` (cwd is a path).
  const ws = options.workspace;
  if (typeof ws === 'string' && ws.trim() && /^[A-Za-z0-9._-]+$/.test(ws.trim())) {
    return ws.trim();
  }
  const cwd = options.cwd;
  if (typeof cwd === 'string' && cwd.trim() && /^[A-Za-z0-9._-]+$/.test(cwd.trim())) {
    return cwd.trim();
  }
  return 'global';
}

const OBJECTIVE_ENRICHMENT_WORD_CAP = 15;
const OBJECTIVE_TECH_KEYWORDS_RE =
  /\b(html|css|javascript|typescript|react|vue|angular|python|node|rust|go|java|api|rest|graphql|database|sql|nosql|docker|kubernetes)\b/i;
const PROJECT_RULES_TECH_STACK_RE = /tech[_\s]?stack[:\s]*([^\n]+)/i;

/**
 * For short/vague objectives, append the project's declared tech_stack from
 * project rules so the decomposer LLM commits to the user's actual stack
 * instead of inferring one. Specific objectives (long or already mentioning
 * a stack) are passed through unchanged.
 */
async function enrichObjectiveIfNeeded(
  objective: string,
  options: DecomposeOptions,
): Promise<string> {
  const wordCount = objective.split(/\s+/).length;
  if (wordCount > OBJECTIVE_ENRICHMENT_WORD_CAP || OBJECTIVE_TECH_KEYWORDS_RE.test(objective)) {
    return objective;
  }

  const cwd = options.cwd ?? process.cwd();
  try {
    const rules = await loadProjectRules(cwd);
    const match = rules?.raw?.match(PROJECT_RULES_TECH_STACK_RE);
    if (match?.[1]) {
      return `${objective} using ${match[1].trim()}`;
    }
  } catch (err) {
    console.debug('[decomposer] project rules load failed, skipping enrichment:', err);
  }
  return objective;
}

export async function decompose(
  objective: string,
  options: DecomposeOptions = {},
): Promise<Dag> {
  const model = getDecomposerModel();

  const enrichedObjective = await enrichObjectiveIfNeeded(objective, options);
  if (enrichedObjective !== objective) {
    console.debug(`[decomposer] enriched objective: "${objective}" → "${enrichedObjective}"`);
  }

  const compactedObjective = await compactDecomposerPrompt(
    enrichedObjective,
    model,
    options,
    'decomposer_objective',
  );
  // Tier 0 Wave 3 (ITEM 0.7) — consult the version registry. When a pinned
  // decomposer spec exists, prefer its system_prompt; otherwise legacy path.
  const pinnedDecomposer = consumePinnedDecomposer(options);

  // ── Feature-flag path ───────────────────────────────────────────────────────
  if (getUsePersonas()) {
    try {
      // MÉDIO-4: cobre o runAgent → omnirouteInvoker (chamada LLM da persona).
      const dag = await runWithLedger(options, () => decomposeViaPersona(compactedObjective, options));
      backfillTaskTimeouts(dag, compactedObjective);
      return dag;
    } catch (err) {
      if (err instanceof AgentRejectedError || err instanceof AgentOutputError) {
        console.warn(
          `[decomposer] persona path failed (${err.constructor.name}: ${err.message}), falling back to legacy`,
        );
        // fall through to legacy
      } else {
        throw err;
      }
    }
  }

  // ── Legacy path ─────────────────────────────────────────────────────────────
  // Tier 0 Wave 3 (ITEM 0.7) — when a pinned decomposer spec provides a
  // system_prompt, use it verbatim (the operator has explicitly approved
  // that version's contract). Otherwise build the standard prompt.
  //
  // Week 3 / Task 2.2 — if no pinned spec, check for an active prompt
  // variant (eval_active_variants table). Variants are an A/B layer below
  // pinned definitions: an experiment that hasn't been promoted yet.
  const activeVariant = pinnedDecomposer.systemPrompt
    ? { promptText: null as string | null }
    : consumeActiveDecomposerVariant(options);
  const baseSystemPrompt = pinnedDecomposer.systemPrompt
    ?? activeVariant.promptText
    ?? buildDecomposerSystemPromptWithTaskModel(model, options.taskModelHint);
  const rules = await loadProjectRules(options.cwd ?? process.cwd()).catch(() => null);
  // Week 4 / Task 3.3 — inject prior reflections when the
  // OMNIFORGE_REFLECTION_RECALL flag is explicitly 'true' (default OFF) and the DB
  // has at least one matching record. Silent fallback: empty block when
  // the migration hasn't run yet or no matches.
  const reflectionBlock = await composeReflectionBlock(options, compactedObjective);
  const systemPrompt = baseSystemPrompt + formatRulesForPrompt(rules, 'decomposer') + reflectionBlock;

  // First attempt.
  const firstPrompt = await compactDecomposerPrompt(
    `OBJECTIVE: ${compactedObjective}`,
    model,
    options,
    'decomposer_initial_prompt',
  );
  const rawResult = await runWithLedger(options, () => callOmnirouteWithUsage({
    systemPrompt,
    userPrompt: firstPrompt,
    model,
  }));
  const raw = rawResult.content;
  try {
    const dag = parseDecomposerOutput(raw);
    backfillTaskTimeouts(dag, compactedObjective);
    return dag;
  } catch (firstErr) {
    // Example smoke test 2026-04-30: pre-fix the decomposer threw on the
    // first validation failure with no recourse — operators saw raw
    // "[max-chain-length] ..." messages with no path to recovery. Retry
    // ONCE with the validation issue fed back as explicit guidance.
    const message = firstErr instanceof Error ? firstErr.message : String(firstErr);
    if (!message.includes('failed validation')) throw firstErr;

    const retryPrompt = [
      `OBJECTIVE: ${compactedObjective}`,
      '',
      'Your previous DAG was rejected by the validator:',
      message,
      '',
      'Common causes and fixes:',
      '- max-chain-length: parallelize independent feature implementations.',
      '  Tasks that do not share data dependencies beyond the design phase',
      '  MUST list the same depends_on (the design task) and run in parallel.',
      '- vague-criteria: replace "should/must be <vague>" with observable',
      '  checks ("file exists", "exit 0", "DOM contains selector X").',
      '',
      'Return a corrected DAG that fixes the validator issue while preserving',
      'the original intent. Do NOT explain — emit only the JSON.',
    ].join('\n');

    const compactedRetryPrompt = await compactDecomposerPrompt(
      retryPrompt,
      model,
      options,
      'decomposer_retry_prompt',
    );
    const retryRawResult = await runWithLedger(options, () => callOmnirouteWithUsage({
      systemPrompt,
      userPrompt: compactedRetryPrompt,
      model,
    }));
    const retryRaw = retryRawResult.content;
    try {
      const dag = parseDecomposerOutput(retryRaw);
      backfillTaskTimeouts(dag, compactedObjective);
      return dag;
    } catch (secondErr) {
      // Surface BOTH errors so the operator sees what the model tried twice.
      const secondMessage = secondErr instanceof Error ? secondErr.message : String(secondErr);
      throw new Error(
        `Decomposer: validator rejected DAG twice. First: ${message}. Retry: ${secondMessage}`,
      );
    }
  }
}

/**
 * Exposed separately so unit tests can exercise parse+validate without a
 * live Omniroute roundtrip.
 */
export function parseDecomposerOutput(raw: string): Dag {
  const jsonText = stripFences(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(
      `Decomposer: failed to parse LLM output as JSON. ` +
        `Error: ${(err as Error).message}. ` +
        `Preview: ${jsonText.slice(0, 500)}`,
    );
  }

  const validated = DagSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(
      `Decomposer: LLM output did not match DagSchema. ` +
        `Issues: ${JSON.stringify(validated.error.issues).slice(0, 500)}. ` +
        `Preview: ${jsonText.slice(0, 500)}`,
    );
  }

  normalizeCliSpawnRouting(validated.data);

  assertDependsOnRefs(validated.data);

  const validation = validateDag(validated.data);
  if (!validation.valid) {
    const errorMessages = validation.issues
      .filter(i => i.severity === 'error')
      .map(i => `[${i.rule}] ${i.message}`)
      .join('; ');
    throw new Error(`Decomposer: DAG failed validation. ${errorMessages}`);
  }

  return validated.data;
}

function stripFences(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/);
  return match?.[1]?.trim() ?? trimmed;
}

function assertDependsOnRefs(dag: Dag): void {
  const ids = new Set(dag.tasks.map((t) => t.id));
  for (const task of dag.tasks) {
    for (const dep of task.depends_on) {
      if (!ids.has(dep)) {
        throw new Error(
          `Decomposer: task '${task.id}' depends on unknown id '${dep}'. ` +
            `Known ids: ${Array.from(ids).join(', ')}.`,
        );
      }
    }
  }
}
