// Sprint F (setup persistence): JSON-backed setup configuration.
//
// Example asked for an ops-friendly, human-editable persistence layer for the
// new Setup screens (provider toggles, role-model overrides, fallback chain,
// max_sequential_tasks). SQLite would have worked, but a single JSON file at
// `data/setup-config.json` is easier to inspect (`cat`/`type`) and edit by
// hand when the daemon is down.
//
// Atomic writes via tmp-file rename so a crash mid-write never leaves a
// half-truncated JSON; readers always see a complete snapshot.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { getDbPath } from './config.js';

// ── Schema ────────────────────────────────────────────────────────────────

export interface RoleModels {
  /** Decomposer override — empty/undefined means "use env var default". */
  decomposer?: string;
  /** Default LLM for llm_call tasks without a model field. */
  task?: string;
  /** Reviewer override. */
  reviewer?: string;
  /** Consolidator override. */
  consolidator?: string;
  /** Summarizer override (auto-summary subsystem). */
  summarizer?: string;
}

export interface FallbackEntry {
  provider: string;
  model: string;
}

export interface FallbackConfig {
  /** Master toggle — when false, a single provider failure stops the run. */
  enabled: boolean;
  /** Ordered list. The runner tries entries top-to-bottom on failure. */
  chain: FallbackEntry[];
}

export interface LimitsConfig {
  /** Max sequential chain length (longest path in DAG). Mirrors MAX_CHAIN
   *  in dag-validator.ts. Default 10 — see comments there for rationale. */
  max_sequential_tasks?: number;
}

export interface SetupConfig {
  /** Provider ids that should be hidden from the model picker and the
   *  routing matrix. The picker filter compares against catalog
   *  `provider` field (e.g. "cc", "cx", "gemini-cli", "minimax"). */
  disabled_providers: string[];
  role_models: RoleModels;
  fallback: FallbackConfig;
  limits: LimitsConfig;
}

const DEFAULT_CONFIG: SetupConfig = {
  disabled_providers: [],
  role_models: {},
  fallback: { enabled: true, chain: [] },
  limits: {},
};

// ── Path resolution ───────────────────────────────────────────────────────

/**
 * Setup config sits next to the SQLite db (`data/`) so it travels with the
 * rest of daemon-local state. Override via `OMNIFORGE_SETUP_CONFIG_PATH` for
 * tests that need an isolated file.
 */
export function getSetupConfigPath(): string {
  const override = process.env['OMNIFORGE_SETUP_CONFIG_PATH'];
  if (override && override.trim().length > 0) return override;
  // getDbPath() returns "data/omniforge.db" (or absolute equivalent).
  // Walk up to the dir and append the setup file name.
  const dbPath = getDbPath();
  return join(dirname(dbPath), 'setup-config.json');
}

// ── Read ──────────────────────────────────────────────────────────────────

function isFallbackEntry(value: unknown): value is FallbackEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as FallbackEntry).provider === 'string' &&
    typeof (value as FallbackEntry).model === 'string'
  );
}

function normalize(raw: unknown): SetupConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_CONFIG };
  const r = raw as Partial<SetupConfig>;

  const disabled_providers = Array.isArray(r.disabled_providers)
    ? r.disabled_providers.filter((v): v is string => typeof v === 'string')
    : [];

  const rmRaw = (r.role_models ?? {}) as Record<string, unknown>;
  const role_models: RoleModels = {};
  for (const key of ['decomposer', 'task', 'reviewer', 'consolidator', 'summarizer'] as const) {
    const v = rmRaw[key];
    if (typeof v === 'string' && v.trim().length > 0) role_models[key] = v;
  }

  const fbRaw = (r.fallback ?? {}) as Partial<FallbackConfig>;
  const fallback: FallbackConfig = {
    enabled: typeof fbRaw.enabled === 'boolean' ? fbRaw.enabled : true,
    chain: Array.isArray(fbRaw.chain) ? fbRaw.chain.filter(isFallbackEntry) : [],
  };

  const limitsRaw = (r.limits ?? {}) as Partial<LimitsConfig>;
  const limits: LimitsConfig = {};
  if (typeof limitsRaw.max_sequential_tasks === 'number' && Number.isFinite(limitsRaw.max_sequential_tasks)) {
    limits.max_sequential_tasks = Math.max(1, Math.floor(limitsRaw.max_sequential_tasks));
  }

  return { disabled_providers, role_models, fallback, limits };
}

export function loadSetupConfig(): SetupConfig {
  const path = getSetupConfigPath();
  if (!existsSync(path)) return { ...DEFAULT_CONFIG };
  try {
    const raw = readFileSync(path, 'utf8');
    if (!raw.trim()) return { ...DEFAULT_CONFIG };
    return normalize(JSON.parse(raw));
  } catch (err) {
    // Don't crash the daemon if the file is malformed — log and degrade to
    // defaults so the operator can re-author from the dashboard.
    process.stderr.write(
      `[setup-config] failed to read ${path}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return { ...DEFAULT_CONFIG };
  }
}

// ── Write ─────────────────────────────────────────────────────────────────

/**
 * Atomic write — serialize to a tmp file then `rename` over the target.
 * On Windows `renameSync` will replace an existing file; on POSIX it's an
 * atomic operation per the rename(2) contract.
 */
export function saveSetupConfig(next: SetupConfig): SetupConfig {
  const normalized = normalize(next);
  const path = getSetupConfigPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmpPath = `${path}.tmp.${process.pid}`;
  writeFileSync(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  renameSync(tmpPath, path);
  return normalized;
}

// ── Mutators (read-modify-write) ──────────────────────────────────────────

export function setProviderDisabled(providerId: string, disabled: boolean): SetupConfig {
  const current = loadSetupConfig();
  const set = new Set(current.disabled_providers);
  if (disabled) set.add(providerId);
  else set.delete(providerId);
  return saveSetupConfig({ ...current, disabled_providers: [...set].sort() });
}

export function setRoleModels(input: RoleModels): SetupConfig {
  const current = loadSetupConfig();
  // Merge — empty/undefined values clear the override.
  const next: RoleModels = { ...current.role_models };
  for (const key of ['decomposer', 'task', 'reviewer', 'consolidator', 'summarizer'] as const) {
    const v = input[key];
    if (v === undefined) continue;
    if (v === '' || v === null) {
      delete next[key];
    } else {
      next[key] = v;
    }
  }
  return saveSetupConfig({ ...current, role_models: next });
}

export function setFallbackConfig(input: FallbackConfig): SetupConfig {
  const current = loadSetupConfig();
  return saveSetupConfig({ ...current, fallback: input });
}

export function setLimitsConfig(input: LimitsConfig): SetupConfig {
  const current = loadSetupConfig();
  return saveSetupConfig({ ...current, limits: { ...current.limits, ...input } });
}

// ── Convenience accessors used by daemon code paths ──────────────────────

/** Disabled provider set — fast lookup for catalog filtering. */
export function getDisabledProviders(): Set<string> {
  return new Set(loadSetupConfig().disabled_providers);
}

/**
 * Max chain length precedence: env var (OMNIFORGE_MAX_SEQUENTIAL_TASKS) wins
 * over setup-config.json which wins over the hard-coded fallback (10). The
 * env var path lets developers override during tests without touching
 * `data/setup-config.json`.
 */
export function getMaxSequentialTasks(): number {
  const envRaw = process.env['OMNIFORGE_MAX_SEQUENTIAL_TASKS'];
  if (envRaw && envRaw.trim().length > 0) {
    const parsed = Number(envRaw);
    if (Number.isFinite(parsed) && parsed >= 1) return Math.floor(parsed);
  }
  const fromFile = loadSetupConfig().limits.max_sequential_tasks;
  if (fromFile && fromFile >= 1) return fromFile;
  return 10;
}
