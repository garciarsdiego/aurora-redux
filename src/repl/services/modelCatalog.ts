// Model catalog loader — merges Omniroute live `/v1/models` with the local
// docs/08-AI-PROVIDER-MATRIX.csv catalog. Live API has precedence for the
// model_id list (Omniroute may have added/removed models since the CSV was
// last updated). CSV provides metadata (tier, use_primary, use_secondary,
// scores) that the live API doesn't return.
//
// Caching: 5min in-memory. Pickers re-fetch on every `/model` invocation only
// if cache stale.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getOmnirouteUrl, getOmnirouteApiKey } from '../../utils/config.js';
import { listOpencodeModels } from '../../v2/models/opencode-sync.js';
import {
  PROVIDER_MATRIX_CSV_REL,
  parseProviderMatrixCsv,
  type ProviderMatrixRow,
} from './providerMatrixCsv.js';

export type ModelKind = 'cli' | 'llm' | 'pal' | 'unknown';

export interface ModelEntry {
  readonly model_id: string;
  readonly provider: string;          // e.g. "cc", "claude", "cx", "gemini-cli", "pal", "cli"
  readonly kind: ModelKind;            // how the model is invoked (cli_spawn vs llm_call via Omniroute vs PAL)
  readonly tier?: string;              // S+/S/S-/A/B/C from CSV (omitted for virtual entries)
  readonly use_primary?: string;
  readonly use_secondary?: string;
  readonly score_primary?: string;
  readonly score_secondary?: string;
  readonly eq_ref?: string;
  /**
   * Where this entry came from:
   * - `'live'`     — returned by Omniroute /v1/models but not in the CSV
   * - `'csv'`      — in the CSV but Omniroute didn't return it (or live was offline)
   * - `'merged'`   — in both (CSV metadata + live confirmation)
   * - `'virtual'`  — locally-synthesized pseudo-entry representing a `cli:*`
   *                 executor_hint. Not a real Omniroute route; selecting it
   *                 via the picker sets <TARGET>_EXECUTOR in process.env so the
   *                 brain/executor promotes llm_call tasks to cli_spawn using
   *                 the chosen binary. See src/brain/executor/internal-utils.ts
   *                 applyExecutorOverride.
   * - `'opencode'` — discovered via `opencode models` (Wave C / Agent Q).
   *                 Routable through the OpenCode ACP adapter when its CLI is
   *                 installed. Treated as best-effort: the entry is dropped
   *                 silently if the binary is unavailable.
   */
  readonly source: 'live' | 'csv' | 'merged' | 'virtual' | 'opencode';
}

// Classify provider prefix as CLI / LLM call / PAL. Based on src/executors/cli.ts
// resolveCliSpec (Claude Code, Codex, Gemini CLI, Kimi CLI, plus Cursor/Kilo/
// OpenCode added in Commit 2) + Omniroute catalog.
//
// NOTE — the catalog prefix tags how the model is INVOKED in our system, not
// where its name comes from. For example `gemini-cli/*` in the CSV is an
// OMNIROUTE route (llm_call) even though its prefix hints at a Google CLI
// binary; the actual CLI binary is reached via `executor_hint: cli:gemini`
// which is NOT a catalog entry. Same pattern for `cc/*` (Omniroute route to
// Anthropic, not `cli:claude-code`) and `opencode-go/*` (Omniroute route
// through OpenCode-Go backend, not `cli:opencode` binary).
//
// Every prefix currently in the CSV routes through Omniroute — there is no
// "CLI catalog entry" yet. The `cli` and `claude_cli` buckets below exist for
// FUTURE virtual/pseudo-entries injected in Commit 3 (picker discoverability).
const KIND_BY_PROVIDER: Readonly<Record<string, ModelKind>> = {
  // Omniroute-routed LLM call — every prefix actually present in the CSV.
  cc: 'llm',
  cerebras: 'llm',
  cu: 'llm',
  cx: 'llm',
  'gemini-cli': 'llm',       // Omniroute route, NOT the local gemini CLI binary
  gh: 'llm',
  glm: 'llm',
  groq: 'llm',
  kmc: 'llm',
  minimax: 'llm',
  nvidia: 'llm',
  ollamacloud: 'llm',
  'opencode-go': 'llm',      // Omniroute route through OpenCode-Go, NOT the CLI binary
  // Legacy / alternative Omniroute aliases (older configs)
  claude: 'llm',
  openai: 'llm',
  gemini: 'llm',
  kimi: 'llm',
  // PAL MCP tools (different invocation path entirely)
  pal: 'pal',
  // CLI bucket — for pseudo-entries `cli:<slug>` injected in Commit 3.
  // These are executor_hints, not Omniroute routes; they spawn a local binary.
  cli: 'cli',
  claude_cli: 'cli',
  // OpenCode CLI: provider prefix on entries discovered via `opencode models`.
  // Treated as `cli` because invocation goes through the OpenCode ACP adapter,
  // not through Omniroute. Wave C / Agent Q (2026-05-09 → 2026-05-10).
  opencode: 'cli',
};

function inferKind(provider: string): ModelKind {
  return KIND_BY_PROVIDER[provider] ?? 'unknown';
}

// Virtual pseudo-entries for every local CLI binary supported via `executor_hint:
// cli:<slug>`. These are NOT in the Omniroute catalog — they're locally synthesized
// so the picker can surface them alongside real models. Each `model_id` begins
// with `cli:` so applyModel can distinguish executor-target overrides from
// Omniroute model overrides (model_id.startsWith('cli:') → *_EXECUTOR env;
// otherwise → *_MODEL env). Keep in sync with resolveCliSpec in src/executors/cli.ts.
const VIRTUAL_CLI_ENTRIES: readonly ModelEntry[] = [
  {
    model_id: 'cli:claude-code',
    provider: 'cli',
    kind: 'cli',
    source: 'virtual',
    use_primary: 'Sonnet/Haiku via Claude Code (stream-json + Agent tool)',
  },
  {
    model_id: 'cli:codex',
    provider: 'cli',
    kind: 'cli',
    source: 'virtual',
    use_primary: 'OpenAI Codex (sandboxed file edits)',
  },
  {
    model_id: 'cli:gemini',
    provider: 'cli',
    kind: 'cli',
    source: 'virtual',
    use_primary: 'Gemini CLI (grounded search + long context)',
  },
  {
    model_id: 'cli:kimi',
    provider: 'cli',
    kind: 'cli',
    source: 'virtual',
    use_primary: 'Kimi CLI (long context)',
  },
  {
    model_id: 'cli:cursor',
    provider: 'cli',
    kind: 'cli',
    source: 'virtual',
    use_primary: 'Cursor agent (headless IDE refactors)',
  },
  {
    model_id: 'cli:kilo',
    provider: 'cli',
    kind: 'cli',
    source: 'virtual',
    use_primary: 'Kilo Code (autonomous run --auto)',
  },
  {
    model_id: 'cli:opencode',
    provider: 'cli',
    kind: 'cli',
    source: 'virtual',
    use_primary: 'OpenCode (configurable backend via -m)',
  },
];

export interface ProviderInfo {
  readonly id: string;                 // canonical prefix
  readonly displayName: string;        // human-friendly
  readonly modelCount: number;
}

export interface Catalog {
  readonly models: readonly ModelEntry[];
  readonly providers: readonly ProviderInfo[];
  readonly source: 'live' | 'csv' | 'merged';
  readonly fetchedAt: number;
  readonly liveError?: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_LIVE_TIMEOUT_MS = 15_000;

let _cache: Catalog | null = null;
let _cacheStaleAfter = 0;

// Maps Omniroute provider prefix → human-friendly "Name (prefix)" label.
// Display format: "<Name> (<prefix>)" so search matches both the short code
// (cu) and the brand name (Cursor). See docs/08-AI-PROVIDER-MATRIX.csv for
// the full list of prefixes actually used.
const PROVIDER_DISPLAY: Readonly<Record<string, string>> = {
  // Omniroute-native prefixes (from 08-AI-PROVIDER-MATRIX.csv)
  cc: 'Claude direct (cc)',
  cerebras: 'Cerebras (cerebras)',
  cu: 'Cursor (cu)',
  cx: 'Codex / OpenAI (cx)',
  'gemini-cli': 'Gemini CLI (gemini-cli)',
  gh: 'GitHub Models (gh)',
  glm: 'Zhipu GLM (glm)',
  groq: 'Groq (groq)',
  kmc: 'Moonshot Kimi (kmc)',
  minimax: 'MiniMax (minimax)',
  nvidia: 'NVIDIA NIM (nvidia)',
  ollamacloud: 'Ollama Cloud (ollamacloud)',
  'opencode-go': 'OpenCode (opencode-go)',
  // Legacy / alternative prefixes (older configs still use these)
  claude: 'Claude legacy (claude)',
  claude_cli: 'Claude CLI wrapper (claude_cli)',
  openai: 'OpenAI legacy (openai)',
  gemini: 'Gemini direct (gemini)',
  kimi: 'Kimi legacy (kimi)',
  // Non-Omniroute targets that may appear via executor hints
  pal: 'PAL MCP tools (pal)',
  cli: 'Local CLI executors (cli)',
  // OpenCode CLI (discovered via `opencode models`)
  opencode: 'OpenCode CLI (opencode)',
};

/** Extract provider prefix from a model id like "cc/claude-sonnet-4-6" or "pal:consensus". */
export function extractProvider(modelId: string): string {
  const slashIdx = modelId.indexOf('/');
  if (slashIdx > 0) return modelId.slice(0, slashIdx);
  const colonIdx = modelId.indexOf(':');
  if (colonIdx > 0) return modelId.slice(0, colonIdx);
  return 'unknown';
}

function displayProvider(id: string): string {
  return PROVIDER_DISPLAY[id] ?? id;
}

/**
 * Try to fetch live model list from Omniroute. Returns null on any error
 * (timeout, network, non-200, malformed response) so the caller can fall back
 * to CSV without crashing.
 */
async function fetchLiveModels(): Promise<readonly string[] | null> {
  const url = `${getOmnirouteUrl()}/v1/models`;
  const apiKey = getOmnirouteApiKey();
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const ctrl = new AbortController();
  const timeoutMs = resolveLiveCatalogTimeoutMs();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: Array<{ id?: string }> };
    if (!Array.isArray(json.data)) return null;
    return json.data
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function resolveLiveCatalogTimeoutMs(): number {
  const raw = process.env.OMNIROUTE_MODEL_CATALOG_TIMEOUT_MS;
  if (!raw) return DEFAULT_LIVE_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1_000) return DEFAULT_LIVE_TIMEOUT_MS;
  return Math.min(parsed, 60_000);
}

// Parsing + path constant live in providerMatrixCsv.ts (shared with
// input/completer.ts). This loader only adds the existsSync guard.
function loadCsvCatalog(): readonly ProviderMatrixRow[] {
  const csvPath = join(process.cwd(), ...PROVIDER_MATRIX_CSV_REL);
  if (!existsSync(csvPath)) return [];
  return parseProviderMatrixCsv(readFileSync(csvPath, 'utf-8'));
}

function buildProviders(models: readonly ModelEntry[]): readonly ProviderInfo[] {
  const counts = new Map<string, number>();
  for (const m of models) counts.set(m.provider, (counts.get(m.provider) ?? 0) + 1);
  // Alphabetical by displayName (Example's preference 2026-04-24) — volume-first
  // was hiding small but important providers (PAL, CLI) at the bottom.
  return [...counts.entries()]
    .map(([id, modelCount]) => ({ id, displayName: displayProvider(id), modelCount }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/**
 * Load the catalog with live + CSV merge.
 * - Live API success → models present in API are tagged 'live', CSV-only are 'csv'.
 *   Merged entries (in both) keep CSV metadata + 'merged' source tag.
 * - Live API failure → all entries from CSV with source 'csv'; liveError populated.
 * - Both empty → throws (catastrophic config issue).
 *
 * Cached 5min. Pass `{force:true}` to bypass cache.
 */
export async function loadCatalog(opts: { force?: boolean } = {}): Promise<Catalog> {
  if (!opts.force && _cache && Date.now() < _cacheStaleAfter) {
    return _cache;
  }

  const csvRows = loadCsvCatalog();
  const liveIds = await fetchLiveModels();
  const liveError = liveIds === null ? 'live API unavailable (timeout/auth/404)' : undefined;

  const csvByModelId = new Map<string, ProviderMatrixRow>();
  for (const r of csvRows) csvByModelId.set(r.model_id, r);

  const liveSet = new Set(liveIds ?? []);
  const allIds = new Set<string>([...liveSet, ...csvByModelId.keys()]);

  const models: ModelEntry[] = [];
  for (const id of allIds) {
    const csv = csvByModelId.get(id);
    const inLive = liveSet.has(id);
    const source: ModelEntry['source'] = inLive && csv ? 'merged' : inLive ? 'live' : 'csv';
    const provider = extractProvider(id);
    models.push({
      model_id: id,
      provider,
      kind: inferKind(provider),
      ...(csv?.tier ? { tier: csv.tier } : {}),
      ...(csv?.use_primary ? { use_primary: csv.use_primary } : {}),
      ...(csv?.use_secondary ? { use_secondary: csv.use_secondary } : {}),
      ...(csv?.score_primary ? { score_primary: csv.score_primary } : {}),
      ...(csv?.score_secondary ? { score_secondary: csv.score_secondary } : {}),
      ...(csv?.eq_ref ? { eq_ref: csv.eq_ref } : {}),
      source,
    });
  }

  if (models.length === 0) {
    throw new Error(
      `Model catalog empty. Live API unreachable AND CSV missing at ${join(...PROVIDER_MATRIX_CSV_REL)}.`,
    );
  }

  // Inject virtual pseudo-entries for every `cli:<slug>` executor_hint we
  // support. These let the picker surface CLI binaries as selectable "models"
  // even though they're not in the live catalog — Example's 4-target picker can
  // then pick between Omniroute LLM routes (llm_call) and local CLI spawns
  // (cli_spawn) using the same UX. Filter by Ctrl+K → kind:cli to narrow.
  // See docs/decisions.md D-H2.016 (picker as dogfood harness for combos).
  for (const v of VIRTUAL_CLI_ENTRIES) {
    models.push(v);
  }

  // Wave C / Agent Q (2026-05-09 → 2026-05-10): merge `opencode models` into
  // the catalog if the binary is installed. Best-effort and bounded by an
  // internal 15s timeout + 1h cache; missing binary => empty array, no throw.
  // Opencode model IDs already present (live/csv/merged) keep their richer
  // metadata; new ones get added with `source: 'opencode'` so the dashboard
  // can surface a "via OpenCode" badge later. Routing decisions for these
  // entries are deferred to Wave D dogfood — for now we only populate.
  const existingIds = new Set(models.map((m) => m.model_id));
  const opencodeEntries = await listOpencodeModels().catch(() => [] as const);
  for (const entry of opencodeEntries) {
    if (existingIds.has(entry.id)) continue;
    existingIds.add(entry.id);
    models.push({
      model_id: entry.id,
      provider: entry.provider,
      kind: inferKind(entry.provider),
      source: 'opencode',
    });
  }

  // Sort: tier S+ first, then alphabetical
  models.sort((a, b) => {
    const tierRank = (t: string | undefined): number => {
      if (!t) return 99;
      if (t === 'S+') return 0;
      if (t === 'S') return 1;
      if (t === 'S-') return 2;
      if (t === 'A') return 3;
      if (t === 'B') return 4;
      if (t === 'C') return 5;
      return 10;
    };
    const ta = tierRank(a.tier);
    const tb = tierRank(b.tier);
    if (ta !== tb) return ta - tb;
    return a.model_id.localeCompare(b.model_id);
  });

  const providers = buildProviders(models);
  const sourceLabel: Catalog['source'] = liveIds ? (csvRows.length > 0 ? 'merged' : 'live') : 'csv';

  _cache = {
    models,
    providers,
    source: sourceLabel,
    fetchedAt: Date.now(),
    ...(liveError ? { liveError } : {}),
  };
  _cacheStaleAfter = Date.now() + CACHE_TTL_MS;
  return _cache;
}

/** Test-only: clear the in-memory cache. */
export function _clearCatalogCache(): void {
  _cache = null;
  _cacheStaleAfter = 0;
}

/** Get models for a specific provider. Loads catalog if needed. */
export async function getModelsByProvider(providerId: string): Promise<readonly ModelEntry[]> {
  const cat = await loadCatalog();
  return cat.models.filter((m) => m.provider === providerId);
}
