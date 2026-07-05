// Sprint 9 (D-H2.066): omniforge doctor — local diagnosis command.
//
// Single entrypoint for "is my Omniforge install / runtime healthy?"
// Targets the operator who needs to debug why daemon won't start, why
// workflows fail, or why a fresh checkout is misbehaving.
//
// Checks (each independent, never throws — accumulates report):
//   1. Node version
//   2. .env file presence + gateway-free role envs (T3, 2026-07-04;
//      generalized P1c, 2026-07-04):
//        - the 4 *_MODEL roles are warn-if-missing (never fail)
//        - direct-provider prefixes FAIL if their API key env is unset —
//          the prefix→key mapping is now derived from
//          listDirectProviderRoutes() (provider-routes.ts): the 3 presets
//          (kimi/minimax/glm) PLUS any provider registered by convention via
//          <NOME>_BASE_URL/<NOME>_API_KEY get the same fail, naming the exact
//          env the operator needs to set
//        - warn if OMNIFORGE_SKIP_MODEL_VALIDATION != 'true' while a role
//          uses a direct/CLI prefix (legacy catalog validation may abort boot)
//        - OMNIROUTE_URL/KEY are informational (only relevant for no-prefix ids)
//   3. Daemon HTTP /health reachable
//   4. SQLite DB reachable + integrity_check
//   5. Migrations applied count
//   6. Daemon token file exists with restrictive mode
//   7. CLI binaries on PATH (claude, codex, gemini, kimi)
//   8. Playwright/Chromium availability (informational — prepares the visual
//      harness; ok/warn only, never fail)
//
// Output: line per check + final summary "OK / N warnings / N errors".

import type { Command } from 'commander';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { initDb, countMigrationFiles } from '../../db/client.js';
import { getDbPath } from '../../utils/config.js';
import { listDirectProviderRoutes } from '../../utils/provider-routes.js';

type CheckSeverity = 'ok' | 'warn' | 'fail';
interface CheckResult {
  name: string;
  severity: CheckSeverity;
  detail: string;
}

const SYM: Record<CheckSeverity, string> = {
  ok: '✓',
  warn: '⚠',
  fail: '✗',
};

function checkNodeVersion(): CheckResult {
  const v = process.versions.node;
  const major = Number.parseInt(v.split('.')[0] ?? '0', 10);
  if (major >= 22) return { name: 'Node version', severity: 'ok', detail: `v${v}` };
  return { name: 'Node version', severity: 'fail', detail: `v${v} — Omniforge requires Node 22+` };
}

// The four orchestration roles. Gateway-free: a missing role is a warning
// (the engine falls back to defaults), never a hard failure.
const ROLE_MODEL_ENVS = [
  'DECOMPOSER_MODEL',
  'REVIEWER_MODEL',
  'TASK_MODEL',
  'CONSOLIDATOR_MODEL',
] as const;

// Direct-HTTP provider prefixes → the API-key env each one requires.
// P1c (2026-07-04): derived from listDirectProviderRoutes() (presets +
// convention-registered providers) instead of a hardcoded kimi/minimax/glm
// map, so any `<NOME>_BASE_URL`/`<NOME>_API_KEY` provider gets the same
// fail-if-missing check naming its exact env var.
function directPrefixKeyEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const route of listDirectProviderRoutes()) out[route.providerName] = route.envVar;
  return out;
}

// CLI-transport prefixes (spawn a local binary; no API key env needed).
const CLI_PREFIXES = new Set(['claude-cli', 'codex-cli']);

/** Lowercased routing prefix of a model id, or null when it carries none. */
function modelPrefix(model: string): string | null {
  const slash = model.indexOf('/');
  if (slash <= 0) return null;
  return model.slice(0, slash).toLowerCase();
}

/**
 * Parse a dotenv-style buffer into a key→value map. Merges over process.env so
 * inline-env invocations (`KEY=v node bin/omniforge doctor`) are seen even when
 * the value is not written to a .env file.
 */
function readEnvMap(content: string): Record<string, string> {
  const map: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    map[key] = value;
  }
  return map;
}

/**
 * Runs `fn` with `process.env` temporarily overlaid by `env` (own keys only,
 * restored verbatim in `finally` — never left mutated). `listDirectProviderRoutes()`
 * scans `process.env` directly (P1a, provider-routes.ts), but `env` here may
 * come from a parsed `.env` FILE that was never exported into the real
 * process env (readEnvMap parses without a dotenv side-effect). Without this
 * overlay, a provider registered only in the .env file (not the shell) would
 * be invisible to the dynamic-discovery scan and the doctor would silently
 * skip its fail-if-missing-key check. (P1c, 2026-07-04.)
 */
function withEnvOverlay<T>(env: Record<string, string>, fn: () => T): T {
  const prior = new Map<string, string | undefined>();
  for (const key of Object.keys(env)) {
    prior.set(key, process.env[key]);
    process.env[key] = env[key];
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/**
 * Gateway-free env diagnostics. Given the resolved env map, report on the four
 * *_MODEL roles, the direct-provider API keys they imply, legacy validation,
 * and the now-informational Omniroute settings.
 */
export function checkGatewayFreeEnv(env: Record<string, string>): CheckResult[] {
  const checks: CheckResult[] = [];

  // (a) The four roles: warn-if-missing, never fail.
  const activeModels: { role: string; model: string }[] = [];
  for (const role of ROLE_MODEL_ENVS) {
    const value = env[role]?.trim();
    if (!value) {
      checks.push({ name: `env ${role}`, severity: 'warn', detail: 'unset — role will use engine default' });
    } else {
      checks.push({ name: `env ${role}`, severity: 'ok', detail: value });
      activeModels.push({ role, model: value });
    }
  }

  // (b) Each direct-provider role needs its API key present → fail naming it.
  // Computed once per call: presets + any convention-registered provider seen
  // in the CURRENT env (mirrors listDirectProviderRoutes()'s per-call scan).
  // Overlaid so providers registered only in the checked `env` map (e.g. a
  // parsed .env file, not the real process env) are still discovered.
  const directPrefixKeyEnvMap = withEnvOverlay(env, () => directPrefixKeyEnv());
  const missingKeys = new Map<string, string[]>(); // keyEnv → roles needing it
  let usesDirectOrCli = false;
  let usesNoPrefix = false;
  for (const { role, model } of activeModels) {
    const prefix = modelPrefix(model);
    if (prefix === null) {
      usesNoPrefix = true;
      continue;
    }
    if (CLI_PREFIXES.has(prefix)) {
      usesDirectOrCli = true;
      continue;
    }
    const keyEnv = directPrefixKeyEnvMap[prefix];
    if (keyEnv) {
      usesDirectOrCli = true;
      if (!env[keyEnv]?.trim()) {
        const roles = missingKeys.get(keyEnv) ?? [];
        roles.push(role);
        missingKeys.set(keyEnv, roles);
      }
    } else {
      // Unknown prefix (e.g. 'cc/', 'cx/') → falls through to legacy Omniroute.
      usesNoPrefix = true;
    }
  }
  for (const [keyEnv, roles] of missingKeys) {
    checks.push({
      name: `env ${keyEnv}`,
      severity: 'fail',
      detail: `required by ${roles.join(', ')} (direct-provider prefix) but unset`,
    });
  }
  // Positive confirmation for direct-provider keys that ARE present.
  for (const keyEnv of new Set(
    activeModels
      .map((m) => directPrefixKeyEnvMap[modelPrefix(m.model) ?? ''])
      .filter((k): k is string => Boolean(k)),
  )) {
    if (env[keyEnv]?.trim() && !missingKeys.has(keyEnv)) {
      checks.push({ name: `env ${keyEnv}`, severity: 'ok', detail: 'set' });
    }
  }

  // (c) Legacy model validation may abort boot when a direct/CLI prefix is used.
  if (usesDirectOrCli && env['OMNIFORGE_SKIP_MODEL_VALIDATION']?.trim() !== 'true') {
    checks.push({
      name: 'env OMNIFORGE_SKIP_MODEL_VALIDATION',
      severity: 'warn',
      detail: "not 'true' — legacy catalog validation may abort boot for direct/CLI model ids; set OMNIFORGE_SKIP_MODEL_VALIDATION=true",
    });
  }

  // Omniroute is now informational — only relevant for no-prefix model ids.
  const omniUrl = env['OMNIROUTE_URL']?.trim();
  if (usesNoPrefix) {
    checks.push({
      name: 'env OMNIROUTE_URL',
      severity: omniUrl ? 'ok' : 'warn',
      detail: omniUrl ? 'set (used by no-prefix model ids)' : 'unset — a *_MODEL uses no known prefix and will fall back to Omniroute',
    });
  } else {
    checks.push({
      name: 'env OMNIROUTE_URL',
      severity: 'ok',
      detail: omniUrl ? 'set (informational — all roles route gateway-free)' : 'unset (ok — all roles route gateway-free)',
    });
  }

  return checks;
}

function checkEnvFile(): CheckResult[] {
  const envPath = resolve(process.cwd(), '.env');
  if (!existsSync(envPath)) {
    const checks: CheckResult[] = [{
      name: '.env file',
      severity: 'warn',
      detail: 'not found in cwd — daemon will use only process.env',
    }];
    // Still run the role/key checks against process.env (inline-env invocations).
    checks.push(...checkGatewayFreeEnv(readEnvMap('')));
    return checks;
  }
  const content = readFileSync(envPath, 'utf-8');
  const checks: CheckResult[] = [{
    name: '.env file',
    severity: 'ok',
    detail: envPath,
  }];
  checks.push(...checkGatewayFreeEnv(readEnvMap(content)));
  return checks;
}

async function checkDaemonHealth(): Promise<CheckResult> {
  const port = process.env.OMNIFORGE_DAEMON_PORT
    ? Number.parseInt(process.env.OMNIFORGE_DAEMON_PORT, 10)
    : 20129;
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctrl.signal });
    clearTimeout(timeout);
    if (!res.ok) return { name: `Daemon /health (:${port})`, severity: 'fail', detail: `HTTP ${res.status}` };
    const body = await res.json() as {
      status?: string;
      version?: string;
      last_schedule_tick?: { status?: string; age_ms?: number | null };
    };
    const tick = body.last_schedule_tick;
    const tickInfo = tick
      ? `, tick ${tick.status ?? '?'}${
          tick.age_ms !== null && tick.age_ms !== undefined
            ? ` (${Math.round(tick.age_ms / 1000)}s ago)`
            : ''
        }`
      : '';
    return {
      name: `Daemon /health (:${port})`,
      severity: 'ok',
      detail: `${body.status ?? 'ok'} v${body.version ?? '?'}${tickInfo}`,
    };
  } catch (err) {
    return {
      name: `Daemon /health (:${port})`,
      severity: 'warn',
      detail: `unreachable (${err instanceof Error ? err.message : String(err)}) — start with 'omniforge daemon start'`,
    };
  }
}

function checkDbIntegrity(): CheckResult[] {
  const dbPath = getDbPath();
  if (!existsSync(dbPath) && dbPath !== ':memory:') {
    return [{ name: 'SQLite DB', severity: 'warn', detail: `not found at ${dbPath} (will be created on first run)` }];
  }
  try {
    const db = initDb(dbPath);
    try {
      const integrity = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
      const migrations = db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get() as { count: number };
      const intResult: CheckResult = integrity.integrity_check === 'ok'
        ? { name: 'SQLite integrity', severity: 'ok', detail: dbPath }
        : { name: 'SQLite integrity', severity: 'fail', detail: integrity.integrity_check };
      const expectedMigrations = countMigrationFiles();
      const migResult: CheckResult = expectedMigrations === null
        ? {
            name: 'Migrations applied',
            severity: 'ok',
            detail: `${migrations.count} applied (expected count unknown — migrations dir not found)`,
          }
        : {
            name: 'Migrations applied',
            severity: migrations.count >= expectedMigrations ? 'ok' : 'warn',
            detail: `${migrations.count}/${expectedMigrations} applied`,
          };
      return [intResult, migResult];
    } finally {
      db.close();
    }
  } catch (err) {
    return [{
      name: 'SQLite integrity',
      severity: 'fail',
      detail: err instanceof Error ? err.message : String(err),
    }];
  }
}

function checkDaemonToken(): CheckResult {
  const tokenPath = join(process.cwd(), 'data', 'daemon-token.txt');
  if (!existsSync(tokenPath)) {
    return { name: 'Daemon token file', severity: 'warn', detail: `not found at ${tokenPath} (created on first daemon start)` };
  }
  try {
    const stat = statSync(tokenPath);
    const mode = stat.mode & 0o777;
    if (process.platform !== 'win32' && mode !== 0o600) {
      return { name: 'Daemon token file', severity: 'warn', detail: `${tokenPath} mode is 0o${mode.toString(8)} (expected 0o600)` };
    }
    return { name: 'Daemon token file', severity: 'ok', detail: `${tokenPath} mode 0o${mode.toString(8)}` };
  } catch (err) {
    return { name: 'Daemon token file', severity: 'fail', detail: err instanceof Error ? err.message : String(err) };
  }
}

function checkCliBinaries(): CheckResult[] {
  const bins = ['claude', 'codex', 'gemini', 'kimi'];
  const pathDirs = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':');
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.ps1', ''] : [''];
  const results: CheckResult[] = [];
  for (const bin of bins) {
    let found: string | null = null;
    for (const dir of pathDirs) {
      for (const ext of exts) {
        const candidate = join(dir, `${bin}${ext}`);
        if (existsSync(candidate)) { found = candidate; break; }
      }
      if (found) break;
    }
    results.push(found
      ? { name: `CLI: ${bin}`, severity: 'ok', detail: found }
      : { name: `CLI: ${bin}`, severity: 'warn', detail: 'not on PATH (cli_spawn for this binary will fail)' });
  }
  return results;
}

/**
 * P1c (2026-07-04): informational check preparing the visual test harness —
 * is Playwright installed, and is the Chromium binary it drives actually
 * downloaded? NEVER fails: a missing Playwright/Chromium doesn't affect the
 * engine's core operation, it only blocks the (separate) visual harness.
 * Tries both the bare `playwright` package and `@playwright/test` (this repo
 * ships the latter as a devDependency; `@playwright/test` re-exports the same
 * `chromium` launcher). `chromium.executablePath()` never throws even when
 * the browser binary itself was never downloaded — it just returns the path
 * it WOULD use, which we then check with `existsSync`.
 */
export async function checkPlaywrightAvailability(): Promise<CheckResult> {
  const name = 'Playwright/Chromium';
  let chromium: { executablePath(): string } | undefined;
  for (const pkg of ['playwright', '@playwright/test']) {
    try {
      const mod = (await import(pkg)) as { chromium?: { executablePath(): string } };
      if (mod.chromium) { chromium = mod.chromium; break; }
    } catch {
      // Not installed / not resolvable — try the next candidate package.
    }
  }
  if (!chromium) {
    return { name, severity: 'warn', detail: 'not installed — visual test harness unavailable (npm i -D @playwright/test)' };
  }
  try {
    const execPath = chromium.executablePath();
    if (existsSync(execPath)) {
      return { name, severity: 'ok', detail: `chromium at ${execPath}` };
    }
    return { name, severity: 'warn', detail: `chromium binary not downloaded (expected ${execPath}) — run 'npx playwright install chromium'` };
  } catch (err) {
    return { name, severity: 'warn', detail: `could not resolve chromium executable path: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function registerDoctor(program: Command): void {
  program
    .command('doctor')
    .description('Run local diagnostics (env, daemon, DB, CLI binaries, Playwright) and report')
    .action(async () => {
      console.log('');
      console.log('omniforge doctor — local diagnostics');
      console.log('');

      const checks: CheckResult[] = [];
      checks.push(checkNodeVersion());
      checks.push(...checkEnvFile());
      checks.push(await checkDaemonHealth());
      checks.push(...checkDbIntegrity());
      checks.push(checkDaemonToken());
      checks.push(...checkCliBinaries());
      checks.push(await checkPlaywrightAvailability());

      for (const c of checks) {
        const sym = SYM[c.severity];
        console.log(`  ${sym} ${c.name.padEnd(30)} ${c.detail}`);
      }

      const okCount = checks.filter((c) => c.severity === 'ok').length;
      const warnCount = checks.filter((c) => c.severity === 'warn').length;
      const failCount = checks.filter((c) => c.severity === 'fail').length;

      console.log('');
      console.log(`Summary: ${okCount} ok, ${warnCount} warn, ${failCount} fail`);

      if (failCount > 0) process.exitCode = 1;
    });
}
