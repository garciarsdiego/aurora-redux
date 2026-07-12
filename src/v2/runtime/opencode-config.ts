/**
 * Opencode global config inspector + model resolver.
 *
 * Aurora does NOT manage opencode authentication (opencode handles its own
 * OAuth/keys). What Aurora needs is a deterministic answer to:
 *
 *     "When I spawn an opencode session for this workflow, which model do I
 *      pass to `opencode session/new --model <X>` ?"
 *
 * This module is read-only — it inspects the user's opencode config files in
 * the standard XDG / dotfile locations, then layers Aurora-specific overrides
 * (env, workflow hint) on top of whatever opencode itself would default to.
 *
 * Wave C / Agent P (2026-05-09 → 2026-05-10) — original task was vault env
 * injection; revised once we confirmed OAuth-based CLIs don't need env from
 * Aurora. The real gap was "which model do we pass on spawn."
 *
 * This file deliberately:
 *   - Does NOT write to opencode config (read-only).
 *   - Does NOT spawn the opencode binary (config-only inspection).
 *   - Does NOT validate the model against `opencode models` (that's Agent Q's
 *     concern — see runtime probes / model-guidance modules).
 *   - Does NOT merge multiple configs. Opencode itself merges its layered
 *     configs; Aurora just inspects ONE (the first found).
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface OpencodeConfigSnapshot {
  /** Resolved absolute path to the config file, or null if none found. */
  configPath: string | null;
  /** Parsed JSON object, or {} if not found / unparseable. */
  raw: Record<string, unknown>;
  /** From `raw.defaultModel` (or `raw.default_model`) — null if absent. */
  defaultModel: string | null;
  /** Keys of `raw.provider` (e.g. ['omniroute', 'anthropic']). */
  declaredProviders: string[];
  /**
   * Flat list of every model declared across every provider, in declaration
   * order. Each entry is the literal model id as opencode would see it.
   */
  declaredModels: string[];
  /** Parse / access errors (file unreadable, JSON malformed, etc.). */
  errors: string[];
}

export type OpencodeModelSource =
  | 'env'
  | 'workflow_hint'
  | 'config_default'
  | 'config_first_declared'
  | 'none';

export interface OpencodeModelResolution {
  model: string | null;
  source: OpencodeModelSource;
  warnings: string[];
}

export interface ResolveOpencodeModelOptions {
  /** Hint from the workflow (e.g. 'opencode/claude-haiku-4-5'). */
  workflowModelHint?: string | null;
  /**
   * Pre-fetched snapshot. If omitted, the resolver re-reads from disk so
   * unit tests can exercise either path.
   */
  configSnapshot?: OpencodeConfigSnapshot;
  /** Explicit env override (typically `OMNIFORGE_OPENCODE_MODEL`). */
  envOverride?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Config locations (in resolution order — first found wins)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the candidate-path list. Exposed for testability so unit tests can
 * stub the home directory.
 */
export function buildOpencodeConfigCandidates(home: string): readonly string[] {
  return Object.freeze([
    join(home, '.config', 'opencode', 'opencode.json'),
    join(home, '.config', 'opencode', 'config.json'),
    join(home, '.config', 'opencode', 'opencode.jsonc'),
    join(home, '.opencode', 'opencode.json'),
    join(home, '.opencode', 'opencode.jsonc'),
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// JSONC support — minimal stripper (single-line // and block /* */)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strip `//` and `/* ... *\/` comments from a JSONC source. Conservative:
 * tracks string state so we never strip inside a JSON string. Trailing commas
 * are NOT removed — opencode tooling already accepts plain JSON, and JSONC
 * official spec keeps trailing commas as a separate concern.
 */
export function stripJsonComments(src: string): string {
  const out: string[] = [];
  let i = 0;
  let inString = false;
  let stringQuote = '';
  let inLineComment = false;
  let inBlockComment = false;

  while (i < src.length) {
    const ch = src[i];
    const next = i + 1 < src.length ? src[i + 1] : '';

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        out.push(ch);
      }
      i += 1;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    if (inString) {
      out.push(ch);
      if (ch === '\\' && next !== '') {
        out.push(next);
        i += 2;
        continue;
      }
      if (ch === stringQuote) {
        inString = false;
        stringQuote = '';
      }
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringQuote = ch;
      out.push(ch);
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 2;
      continue;
    }
    out.push(ch);
    i += 1;
  }
  return out.join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot extraction
// ─────────────────────────────────────────────────────────────────────────────

// Factory (not a frozen singleton) so declaredProviders/declaredModels/errors
// stay genuinely `string[]`-typed without an `as unknown as string[]` lie —
// each call gets its own fresh, empty arrays instead of a shared frozen one.
function emptySnapshot(): OpencodeConfigSnapshot {
  return {
    configPath: null,
    raw: {},
    defaultModel: null,
    declaredProviders: [],
    declaredModels: [],
    errors: [],
  };
}

function extractDefaultModel(raw: Record<string, unknown>): string | null {
  const direct = raw['defaultModel'];
  if (typeof direct === 'string' && direct.trim().length > 0) return direct.trim();
  const snake = raw['default_model'];
  if (typeof snake === 'string' && snake.trim().length > 0) return snake.trim();
  return null;
}

function extractDeclaredProvidersAndModels(raw: Record<string, unknown>): {
  providers: string[];
  models: string[];
} {
  const providers: string[] = [];
  const models: string[] = [];
  const providerSection = raw['provider'];
  if (!providerSection || typeof providerSection !== 'object' || Array.isArray(providerSection)) {
    return { providers, models };
  }
  for (const [providerName, providerValue] of Object.entries(
    providerSection as Record<string, unknown>,
  )) {
    providers.push(providerName);
    if (!providerValue || typeof providerValue !== 'object' || Array.isArray(providerValue)) {
      continue;
    }
    const modelsSection = (providerValue as Record<string, unknown>)['models'];
    if (!modelsSection || typeof modelsSection !== 'object' || Array.isArray(modelsSection)) {
      continue;
    }
    for (const modelName of Object.keys(modelsSection as Record<string, unknown>)) {
      // Opencode model identifiers are typically `<provider>/<model>` —
      // preserve provider context for downstream resolvers.
      models.push(`${providerName}/${modelName}`);
    }
  }
  return { providers, models };
}

/**
 * Read and parse opencode global config from standard locations.
 * Returns an immutable snapshot. Never throws.
 */
export function readOpencodeConfig(
  opts: { home?: string } = {},
): OpencodeConfigSnapshot {
  const home = opts.home ?? homedir();
  const candidates = buildOpencodeConfigCandidates(home);
  const errors: string[] = [];
  const found: string[] = [];

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) found.push(candidate);
    } catch (err) {
      errors.push(`existsSync failed for ${candidate}: ${(err as Error).message}`);
    }
  }

  if (found.length === 0) return emptySnapshot();

  const primary = found[0];
  const additional = found.slice(1);
  for (const extra of additional) {
    errors.push(
      `Multiple opencode configs detected; using first: ${primary} (also found: ${extra})`,
    );
  }

  let body: string;
  try {
    body = readFileSync(primary, 'utf8');
  } catch (err) {
    errors.push(`readFileSync failed for ${primary}: ${(err as Error).message}`);
    return Object.freeze({
      configPath: primary,
      raw: {},
      defaultModel: null,
      declaredProviders: [],
      declaredModels: [],
      errors,
    });
  }

  const isJsonc = primary.toLowerCase().endsWith('.jsonc');
  const source = isJsonc ? stripJsonComments(body) : body;

  let parsed: Record<string, unknown> = {};
  try {
    const candidateValue = JSON.parse(source) as unknown;
    if (candidateValue && typeof candidateValue === 'object' && !Array.isArray(candidateValue)) {
      parsed = candidateValue as Record<string, unknown>;
    } else {
      errors.push(`Config root is not an object: ${primary}`);
    }
  } catch (err) {
    errors.push(`JSON parse failed for ${primary}: ${(err as Error).message}`);
  }

  const defaultModel = extractDefaultModel(parsed);
  const { providers, models } = extractDeclaredProvidersAndModels(parsed);

  return Object.freeze({
    configPath: primary,
    raw: parsed,
    defaultModel,
    declaredProviders: providers,
    declaredModels: models,
    errors,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolution
// ─────────────────────────────────────────────────────────────────────────────

// Factory for the same reason as emptySnapshot() above — a fresh `warnings`
// array per call avoids the readonly-array cast a frozen singleton would need.
function noneResult(): OpencodeModelResolution {
  return {
    model: null,
    source: 'none',
    warnings: ['No model resolvable'],
  };
}

function trimOrNull(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Determine which model Aurora should pass to `opencode session/new` for a
 * workflow.
 *
 * Resolution priority (first match wins):
 *   1. envOverride           — explicit operator override
 *   2. workflowModelHint     — workflow author specified a model
 *   3. config defaultModel   — opencode's own default
 *   4. first declared model  — deterministic fallback
 *   5. none                  — caller must surface clear error
 *
 * Workflow hints are passed through verbatim — even if the provider prefix
 * doesn't match anything declared in the snapshot. Compatibility validation
 * is the caller's job (Agent Q / model-guidance).
 */
export function resolveOpencodeModelForWorkflow(
  opts: ResolveOpencodeModelOptions = {},
): OpencodeModelResolution {
  const warnings: string[] = [];
  const snapshot = opts.configSnapshot ?? readOpencodeConfig();

  // Always surface snapshot errors — they affect operator confidence even
  // when a higher-priority source resolves the model.
  for (const err of snapshot.errors) warnings.push(`opencode-config: ${err}`);

  const envValue = trimOrNull(opts.envOverride);
  if (envValue) {
    return Object.freeze({ model: envValue, source: 'env', warnings });
  }

  const hintValue = trimOrNull(opts.workflowModelHint);
  if (hintValue) {
    if (snapshot.declaredProviders.length > 0) {
      const slashIdx = hintValue.indexOf('/');
      if (slashIdx > 0) {
        const providerPrefix = hintValue.slice(0, slashIdx);
        if (!snapshot.declaredProviders.includes(providerPrefix)) {
          warnings.push(
            `workflow_hint provider '${providerPrefix}' not in declared providers ` +
              `[${snapshot.declaredProviders.join(', ')}] — passing through anyway`,
          );
        }
      }
    }
    return Object.freeze({ model: hintValue, source: 'workflow_hint', warnings });
  }

  const defaultValue = trimOrNull(snapshot.defaultModel);
  if (defaultValue) {
    return Object.freeze({ model: defaultValue, source: 'config_default', warnings });
  }

  if (snapshot.declaredModels.length > 0) {
    return Object.freeze({
      model: snapshot.declaredModels[0],
      source: 'config_first_declared',
      warnings,
    });
  }

  // Nothing resolvable. Preserve any snapshot warnings, append the canonical
  // "no model" message expected by tests + downstream UX.
  if (warnings.length === 0) {
    return noneResult();
  }
  return Object.freeze({
    model: null,
    source: 'none',
    warnings: [...warnings, 'No model resolvable'],
  });
}
