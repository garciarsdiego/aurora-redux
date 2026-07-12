import { config as dotenvConfig } from 'dotenv';
import {
  getRuntimeAutoTagOverrides,
  type AutoTagOverrides,
} from '../v2/models/auto-tags.js';

dotenvConfig({ quiet: true });

export function optional(name: string, fallback: string): string {
  const val = process.env[name];
  return val && val.trim() !== '' ? val : fallback;
}

export function parsedNumber(name: string, fallback: number): number {
  const val = Number(optional(name, String(fallback)));
  return isNaN(val) ? fallback : val;
}

// All configs are LAZY (read process.env at call time, not module init). This lets
// loadWorkspaceEnv() influence values that are read later — the module-level
// dotenvConfig() above is only the initial load; workspace .env layers on top.
// Note: use non-`_cli/` providers. The `claude_cli/` wrapper duplicates output
// (JSON\nJSON), breaking strict parsers. Discovered at D2, 2026-04-16.

export function getOmnirouteUrl(): string {
  // Default aligned with .env.example, README, HANDOFF.md, 02-ARCHITECTURE.md.
  // Previous default (20128) was the V1 history value — caused silent failure
  // for fresh setups without .env.
  return optional('OMNIROUTE_URL', 'http://localhost:20228');
}

export function getOmnirouteApiKey(): string {
  return optional('OMNIROUTE_API_KEY', '');
}

export function getOmnirouteDefaultModel(): string {
  return optional('OMNIROUTE_DEFAULT_MODEL', 'cc/claude-sonnet-4-6');
}

export function getOmnirouteMaxTokens(): number {
  return parsedNumber('OMNIROUTE_MAX_TOKENS', 8192);
}

// Aurora-Redux direct-provider path: reasoning models (Kimi/MiniMax/GLM) spend
// part of their output budget on <think>/reasoning_content, so an explicit,
// generous max_tokens avoids the visible answer being truncated. Only applied
// to the direct-provider branch; the Omniroute path is unchanged.
export function getDirectProviderMaxTokens(): number {
  return parsedNumber('DIRECT_PROVIDER_MAX_TOKENS', 32_000);
}

export function getOmnirouteMaxContinuations(): number {
  return parsedNumber('OMNIROUTE_MAX_CONTINUATIONS', 3);
}

export function getOmnirouteUseResponsesApi(): boolean {
  const val = optional('OMNIROUTE_USE_RESPONSES_API', 'false').trim().toLowerCase();
  return val === 'true' || val === '1';
}

export function getOmnirouteFallbackModels(): string[] {
  const raw = optional('OMNIROUTE_FALLBACK_MODELS', '').trim();
  return raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

// D-H2.078: default raised 120s → 300s. The old value worked when objectives
// were typically <2K chars; with the 200K cap and operators pasting full
// production-grade plans (30K-100K), 120s was timing out the decomposer's Opus
// call before it could finish thinking. 300s aligns with brain/validator
// (DEFAULT_PER_ATTEMPT_TIMEOUT_MS) and brain/executor/adaptive-supervisor
// (FALLBACK_TIMEOUT_MS) so the whole stack agrees on a single base ceiling.
//
// For oversized prompts the BASE timeout is still enforced — see
// `computeOmnirouteTimeoutMs` below for the prompt-size-aware variant the
// LLM caller actually uses.
export function getOmnirouteTimeoutMs(): number {
  return parsedNumber('OMNIROUTE_TIMEOUT_MS', 300_000);
}

/**
 * Per-call timeout that scales with prompt size.
 *
 * Why scale: a 30K-char plan takes a strong reasoning model (e.g. Opus 4.6)
 * meaningfully longer to digest than a 200-char one-liner — the time grows
 * with both input tokens and required thinking depth. We model this as
 *
 *   timeout = max(BASE, ceil(prompt_chars * MS_PER_CHAR))
 *
 * with `MS_PER_CHAR = 12` (≈12ms per character of system+user prompt). Quick
 * back-of-envelope:
 *
 *   prompt 1K   →  base 300s  (12s scaled, base wins)
 *   prompt 10K  →  base 300s  (120s scaled, base wins)
 *   prompt 30K  →  base 360s  (scaled wins; what your multi-chat plan needs)
 *   prompt 100K →  base 1200s (scaled wins; deep think on long context)
 *   prompt 200K →  capped 1800s (15-minute hard ceiling — see below)
 *
 * Hard ceiling of 1800s (30 min) defends against runaway requests; the
 * Omniroute upstream itself enforces its own per-provider caps below this.
 *
 * Override entirely via OMNIROUTE_TIMEOUT_MS — that becomes the new BASE so
 * operators can tighten or relax the floor without losing the dynamic scaling.
 */
export function computeOmnirouteTimeoutMs(promptChars: number): number {
  const base = getOmnirouteTimeoutMs();
  const HARD_CEILING_MS = 1_800_000; // 30 min absolute upper bound
  const MS_PER_CHAR = 12;
  if (!Number.isFinite(promptChars) || promptChars <= 0) return base;
  const scaled = Math.ceil(promptChars * MS_PER_CHAR);
  return Math.min(HARD_CEILING_MS, Math.max(base, scaled));
}

export function getOmnirouteMaxRetries(): number {
  return Math.max(0, Math.floor(parsedNumber('OMNIROUTE_MAX_RETRIES', 0)));
}

export function getMaxParallelTasks(): number {
  // OTIMIZAÇÃO 3: Aumentar paralelismo padrão de 0 (ilimitado) para 5
  // Isso permite melhor throughput sem sobrecarregar o sistema
  // Pode ser override via OMNIFORGE_MAX_PARALLEL_TASKS env var
  return Math.max(0, Math.floor(parsedNumber('OMNIFORGE_MAX_PARALLEL_TASKS', 5)));
}

export function getAdaptiveMaxIterations(): number {
  return Math.max(1, Math.floor(parsedNumber('OMNIFORGE_ADAPTIVE_MAX_ITERATIONS', 10)));
}

export function getMaxPlanModifications(): number {
  return Math.max(0, Math.floor(parsedNumber('OMNIFORGE_MAX_PLAN_MODIFICATIONS', 3)));
}

// OTIMIZAÇÃO 4: Review seletivo por complexidade
// Determina se uma task deve ser revisada baseado em sua complexidade e tipo
export function shouldReviewTask(task: {
  kind?: string;
  complexity?: string;
  requires_write?: boolean;
  acceptance_criteria?: string;
  timeout_seconds?: number;
  max_refine?: number;
}): boolean {
  // Se a tarefa possuir tentativas de refino configuradas, sempre revisar para permitir o refine loop
  if (task.max_refine && task.max_refine > 0) {
    return true;
  }

  // Skip review para tasks simples de llm_call
  if (task.kind === 'llm_call' && task.complexity === 'low') {
    return false;
  }
  
  // Sempre revisar tasks que criam arquivos
  if (task.requires_write) {
    return true;
  }
  
  // Sempre revisar tasks com timeout longo (indicam complexidade)
  if (task.timeout_seconds && task.timeout_seconds > 600) {
    return true;
  }
  
  // Skip review se acceptance_criteria for muito simples (< 50 chars)
  if (task.acceptance_criteria && task.acceptance_criteria.length < 50) {
    return false;
  }
  
  // Default: revisar
  return true;
}

// OTIMIZAÇÃO 5/6/7 (selectModelForTask / predictWorkflowDuration /
// callWithFallback e suas policies) removidas em 2026-07-11: nenhum chamador
// em src/ ou tests/ — eram exports mortos de uma geração anterior, com `any`
// e divisão-por-zero latente (maxParallelTasks=0 é válido).

// OTIMIZAÇÃO 10: Métricas do decomposer
const decomposerMetrics = {
  totalObjectives: 0,
  acceptedSingleTask: 0,
  rejectedForCombinedTasks: 0,
  rejectedForOtherReasons: 0,
  avgTasksPerDecomposition: 0,
  rejectionReasons: new Map<string, number>(),
};

export function trackDecomposerDecision(objective: string, decision: string, reason?: string) {
  decomposerMetrics.totalObjectives++;
  
  if (decision === 'accept_single_task') {
    decomposerMetrics.acceptedSingleTask++;
  } else if (decision === 'reject') {
    if (reason === 'combined_task_names') {
      decomposerMetrics.rejectedForCombinedTasks++;
    } else {
      decomposerMetrics.rejectedForOtherReasons++;
    }
    
    decomposerMetrics.rejectionReasons.set(
      reason || 'unknown',
      (decomposerMetrics.rejectionReasons.get(reason || 'unknown') || 0) + 1
    );
  }
}

export function getDecomposerMetrics() {
  return {
    ...decomposerMetrics,
    acceptanceRate: decomposerMetrics.totalObjectives > 0 
      ? decomposerMetrics.acceptedSingleTask / decomposerMetrics.totalObjectives 
      : 0,
    rejectionRate: decomposerMetrics.totalObjectives > 0
      ? decomposerMetrics.rejectedForCombinedTasks / decomposerMetrics.totalObjectives
      : 0,
    rejectionReasons: Object.fromEntries(decomposerMetrics.rejectionReasons),
  };
}

export function getMaxLlmStreamsPerActor(): number {
  return Math.max(1, Math.floor(parsedNumber('OMNIFORGE_MAX_LLM_STREAMS_PER_ACTOR', 4)));
}

export type QuotaGuardMode = 'off' | 'warn' | 'enforce';

export function getQuotaGuardMode(): QuotaGuardMode {
  const raw = optional('OMNIFORGE_QUOTA_GUARD', 'off').trim().toLowerCase();
  if (raw === 'warn' || raw === 'enforce') return raw;
  return 'off';
}

// Models are role-scoped: planning (decomposer) = Opus for deeper reasoning,
// task execution (coding) = Sonnet for speed/cost. Override per workspace.
export function getDecomposerModel(): string {
  return optional('DECOMPOSER_MODEL', 'claude/claude-opus-4-6');
}

export function getTaskModel(): string {
  return optional('TASK_MODEL', 'claude/claude-sonnet-4-6');
}

export function getAutoTagOverrides(): AutoTagOverrides {
  // Wave 2.B: dashboard-managed overrides win over the static env var. The
  // daemon boot path hydrates this cache from daemon_state once at startup;
  // the dashboard config route updates it on every save. Falls back to the
  // env var when the cache is empty (which is the case on fresh installs
  // and during the small window between boot and the first hydration).
  const runtime = getRuntimeAutoTagOverrides();
  if (runtime != null && Object.keys(runtime).length > 0) return runtime;

  const raw = optional('OMNIFORGE_AUTO_TAG_OVERRIDES', '').trim();
  if (!raw) return runtime ?? {};

  // Env malformada NÃO pode derrubar o chokepoint LLM (getAutoTagOverrides roda
  // em toda chamada) — degrada para o mesmo fallback das demais rotas inválidas.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    warnMalformedAutoTagOverridesOnce(err);
    return runtime ?? {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return runtime ?? {};

  const overrides: AutoTagOverrides = {};
  for (const [tag, model] of Object.entries(parsed)) {
    if (
      isAutoTagKey(tag) &&
      typeof model === 'string' &&
      model.trim() !== ''
    ) {
      overrides[tag] = model;
    }
  }
  return overrides;
}

// Warn-once: getAutoTagOverrides é hot path (toda chamada LLM); logar em cada
// leitura de uma env quebrada inundaria o daemon.log.
let warnedMalformedAutoTagOverrides = false;
function warnMalformedAutoTagOverridesOnce(err: unknown): void {
  if (warnedMalformedAutoTagOverrides) return;
  warnedMalformedAutoTagOverrides = true;
  console.warn(
    '[config] OMNIFORGE_AUTO_TAG_OVERRIDES is not valid JSON — ignoring the env var:',
    err instanceof Error ? err.message : String(err),
  );
}

function isAutoTagKey(tag: string): tag is keyof AutoTagOverrides {
  return (
    tag === 'auto' ||
    tag === 'auto:vision' ||
    tag === 'auto:docs' ||
    tag === 'auto:fast' ||
    tag === 'auto:strong' ||
    tag === 'auto:cheap'
  );
}

export function getDbPath(): string {
  return optional('DB_PATH', 'data/omniforge.db');
}

export function getToolPolicyName(): string {
  return optional('OMNIFORGE_TOOL_POLICY_NAME', '');
}

// PAL MCP server — Python stdio process. Override via workspace .env if path differs.
export function getPalPython(): string {
  return optional(
    'PAL_PYTHON',
    'C:/Users/Example User/Desktop/pal-mcp-server/.pal_venv/Scripts/python.exe',
  );
}

export function getPalServerScript(): string {
  return optional(
    'PAL_SERVER_SCRIPT',
    'C:/Users/Example User/Desktop/pal-mcp-server/server.py',
  );
}

// Model sent to PAL tools — must be a model alias recognized by PAL's provider config.
export function getPalModel(): string {
  return optional('PAL_MODEL', 'claude_cli/claude-sonnet-4-6');
}

// Reviewer — D13. Sonnet default; override to Opus (deeper critique) or Gemini (different perspective).
export function getReviewerModel(): string {
  return optional('REVIEWER_MODEL', 'claude/claude-sonnet-4-6');
}

export type QualityGateMode = 'off' | 'dry-run' | 'enforced';

function parsedQualityGateMode(name: string, fallback: QualityGateMode): QualityGateMode {
  const raw = optional(name, fallback).trim().toLowerCase();
  if (raw === 'off' || raw === 'false' || raw === '0') return 'off';
  if (raw === 'enforced' || raw === 'enforce' || raw === 'true' || raw === '1') return 'enforced';
  if (raw === 'dry-run' || raw === 'dry_run' || raw === 'dryrun') return 'dry-run';
  return fallback;
}

export function getTaskQualityReviewMode(): QualityGateMode {
  return parsedQualityGateMode('OMNIFORGE_TASK_QUALITY_REVIEW', 'off');
}

export function getTaskQualityReviewerModel(): string {
  return optional('OMNIFORGE_TASK_QUALITY_REVIEWER_MODEL', 'deepseek/deepseek-v4-flash');
}

export function getFinalQualityReviewMode(): QualityGateMode {
  return parsedQualityGateMode('OMNIFORGE_FINAL_QUALITY_REVIEW', 'off');
}

export function getFinalQualityReviewerModel(): string {
  return optional('OMNIFORGE_FINAL_QUALITY_REVIEWER_MODEL', 'claude/claude-opus-4-6');
}

export function getFinalVisualQualityReviewerModel(): string {
  return optional('OMNIFORGE_FINAL_VISUAL_QUALITY_REVIEWER_MODEL', 'kimi/kimi-for-coding');
}

// Consolidator — D16. Sonnet default for flat-rate subs; override to Opus for richer synthesis.
export function getConsolidatorModel(): string {
  return optional('CONSOLIDATOR_MODEL', 'claude/claude-sonnet-4-6');
}

export function getReviewPassThreshold(): number {
  return parsedNumber('REVIEW_PASS_THRESHOLD', 0.7);
}

// Eval-refine budget caps — D15.
// Cost per refine call is estimated (Omniroute does not expose token usage).
// See BUGS-AND-SKIPS.md. For flat-rate subs, prefer MAX_REFINE_TIME_MS.
export function getMaxRefineCostUsd(): number {
  return parsedNumber('MAX_REFINE_COST_USD', 0.10);
}

export function getRefineCostPerCallUsd(): number {
  return parsedNumber('REFINE_COST_PER_CALL_USD', 0.02);
}

// Wall-clock budget for the entire refine loop per task (0 = disabled).
export function getMaxRefineTimeMs(): number {
  return parsedNumber('MAX_REFINE_TIME_MS', 120_000);
}

// D34.5 Bug A — per-call wall-clock cap for reviewer LLM invocation.
// Without this, a hung Omniroute response blocks the entire workflow forever.
// On timeout the review is treated as a non-fatal error (task keeps its output).
//
// Example smoke test 2026-04-30 (after the spawn saga closed): a Klondike
// solitaire engine implementation cli_spawn task ran 199s and produced ~1KB
// of output, but the reviewer LLM call hit the 120s cap before it could
// finish analyzing the output against the acceptance_criteria. The review
// timeout cascaded into a hard_failure that aborted the workflow even
// though the engine code was actually written. Bumping the default floor
// to 240s catches the common code-review case; scaledReviewMs in
// reviewAndRefine() further lifts it proportionally to the task's own
// timeout_seconds for heavier work.
export function getMaxReviewTimeMs(): number {
  return parsedNumber('MAX_REVIEW_TIME_MS', 240_000);
}

// D34.5 Bug A — per-call wall-clock cap for consolidator LLM invocation.
// Consolidator runs once per workflow; timeout lets the workflow still close.
export function getMaxConsolidateTimeMs(): number {
  return parsedNumber('MAX_CONSOLIDATE_TIME_MS', 180_000);
}

/**
 * Feature flag: when true, wired persona paths (DECOMPOSER_PERSONA, REVIEWER_PERSONA,
 * FAILOVER_CLASSIFIER_PERSONA, CONSOLIDATOR_PERSONA, REFINER_PERSONA) are used instead
 * of the legacy inline LLM calls. Default true — operators opt out via .env or setConfig.
 */
export function getUsePersonas(): boolean {
  const val = optional('OMNIFORGE_USE_PERSONAS', 'true').trim().toLowerCase();
  return val === 'true' || val === '1';
}

/**
 * Bounded carry — when ON, each downstream task's prompt receives a compact
 * carry block built from each direct parent's parsed_handoff sections
 * (Summary/Artifacts/Risks/Next). See src/v2/handoff/wire.ts for the wire.
 *
 * Default: ON. Disable knob: OMNIFORGE_DISABLE_CARRY_INJECTION=true.
 */
export function getCarryFromUpstreamEnabled(): boolean {
  const val = optional('OMNIFORGE_DISABLE_CARRY_INJECTION', 'false').trim().toLowerCase();
  return !(val === 'true' || val === '1');
}

/**
 * Hard cap (chars) for the entire carry block, summed across all parents.
 * Per-parent budget is this divided by the number of parents that yielded
 * a parseable handoff (with a floor — see MIN_PER_PARENT_CARRY_CHARS).
 */
export function getCarryFromUpstreamMaxChars(): number {
  return parsedNumber('OMNIFORGE_CARRY_MAX_CHARS', 4000);
}

/**
 * B6.1 perf-win — when true, callOmnirouteWithUsage marks the system message
 * with Anthropic's `cache_control: ephemeral` for Anthropic-family models
 * whose system prompt is ≥4K chars. Default OFF until operators verify their
 * Omniroute provider adapter passes the marker through to the upstream API.
 *
 * See src/utils/omniroute-call.ts for the formatting + the size floor.
 */
export function getPromptPrefixCacheEnabled(): boolean {
  const val = optional('OMNIFORGE_PROMPT_PREFIX_CACHE', 'false').trim().toLowerCase();
  return val === 'true' || val === '1';
}

/**
 * B6.3 perf-win — char threshold above which `maybeCompact` triggers
 * automatic compaction (trim → LLM-summary fallback). Lowered from the
 * historical 100K to 50K per the audit's recommendation: catches context
 * inflation EARLIER, before the worker prompt explodes and triggers a
 * timeout / retry loop. Operators can override per workflow via env when
 * a specific run benefits from a higher ceiling.
 *
 * Used in: src/brain/executor/run-task.ts (upstream artifacts),
 * src/brain/decomposer.ts (objective + retry prompt),
 * src/mcp/dashboard-task-ops.ts (refiner feedback).
 */
export function getAutoCompactThreshold(): number {
  return Math.max(10_000, parsedNumber('OMNIFORGE_AUTO_COMPACT_THRESHOLD', 50_000));
}

/**
 * Aurora-parity Wave 2 — opt-in cost-aware routing on the live executor path.
 * Default OFF: an llm_call's model selection is UNCHANGED until the operator
 * flips this AND a budget cap (workflow/daily/total) is set, so engaging the
 * router is a deliberate double opt-in. See src/brain/executor/internal-utils.ts
 * (where the per-call headroom is threaded) + src/utils/omniroute-call.ts.
 */
export function getCostRouterEnabled(): boolean {
  const val = optional('OMNIFORGE_COST_ROUTER', 'false').trim().toLowerCase();
  return val === 'true' || val === '1';
}

/**
 * When true AND no model fits the remaining budget at minQuality, a cost-routed
 * call is HARD-GATED (throws BudgetExceededError) instead of proceeding with the
 * requested model. Default OFF (soft downshift only — pick a cheaper adequate
 * model when one exists, otherwise proceed + emit a warning). Pairs with
 * getCostRouterEnabled; ignored when routing is off.
 */
export function getCostRouterEnforce(): boolean {
  const val = optional('OMNIFORGE_COST_ROUTER_ENFORCE', 'false').trim().toLowerCase();
  return val === 'true' || val === '1';
}

/** Minimum quality (0..1) the cost router must preserve when downshifting. */
export function getCostRouterMinQuality(): number {
  const raw = parsedNumber('OMNIFORGE_COST_ROUTER_MIN_QUALITY', 0.7);
  return Math.min(1, Math.max(0, raw));
}

/**
 * Wave 2.2 (F2-4) — runtime persistent-session pool mode.
 *
 *   off  — never consult the runtime pool; every task spawns a fresh ephemeral
 *          process. Same behaviour as before Wave 2.
 *   on   — always consult the pool for eligible tasks. Useful for explicit opt-in
 *          when the operator wants to bias toward reuse.
 *   auto — current default. The gate inside run-task.ts decides per-task using
 *          workflow_mode + executor_hint signals (only existing_code_feature +
 *          cli:claude-code currently activate the gate).
 *
 * Lazy getter to honour late-binding workspace .env layering, same as the rest
 * of this module.
 */
export type RuntimePoolMode = 'off' | 'on' | 'auto';

export function getRuntimePoolMode(): RuntimePoolMode {
  const raw = optional('OMNIFORGE_RUNTIME_POOL', 'auto').trim().toLowerCase();
  if (raw === 'off' || raw === 'on') return raw;
  return 'auto';
}

// Telegram Bot API configuration for HITL gates
export function telegramBotToken(): string {
  return optional('TELEGRAM_BOT_TOKEN', '');
}

export function telegramChatId(): string {
  return optional('TELEGRAM_CHAT_ID', '');
}

// Telegram webhook secret for authenticating incoming webhook callbacks
export function telegramWebhookSecret(): string {
  return optional('TELEGRAM_WEBHOOK_SECRET', '');
}
