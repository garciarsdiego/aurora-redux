// Sprint 9 (D-H2.066): omniforge doctor — local diagnosis command.
//
// Single entrypoint for "is my Omniforge install / runtime healthy?"
// Targets the operator who needs to debug why daemon won't start, why
// workflows fail, or why a fresh checkout is misbehaving.
//
// Checks (each independent, never throws — accumulates report):
//   1. Node version
//   2. .env file presence + critical envs
//   3. Daemon HTTP /health reachable
//   4. SQLite DB reachable + integrity_check
//   5. Migrations applied count
//   6. Daemon token file exists with restrictive mode
//   7. CLI binaries on PATH (claude, codex, gemini, kimi)
//
// Output: line per check + final summary "OK / N warnings / N errors".

import type { Command } from 'commander';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { initDb, countMigrationFiles } from '../../db/client.js';
import { getDbPath } from '../../utils/config.js';

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

function checkEnvFile(): CheckResult[] {
  const envPath = resolve(process.cwd(), '.env');
  if (!existsSync(envPath)) {
    return [{
      name: '.env file',
      severity: 'warn',
      detail: 'not found in cwd — daemon will use only process.env (Telegram + Omniroute likely fail)',
    }];
  }
  const content = readFileSync(envPath, 'utf-8');
  const checks: CheckResult[] = [{
    name: '.env file',
    severity: 'ok',
    detail: envPath,
  }];

  const critical = ['OMNIROUTE_URL', 'OMNIROUTE_API_KEY'];
  for (const key of critical) {
    const re = new RegExp(`^${key}=(.+)$`, 'm');
    const m = content.match(re);
    if (!m || !m[1]?.trim()) {
      checks.push({ name: `env ${key}`, severity: 'warn', detail: 'unset or empty' });
    } else {
      checks.push({ name: `env ${key}`, severity: 'ok', detail: 'set' });
    }
  }

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

export function registerDoctor(program: Command): void {
  program
    .command('doctor')
    .description('Run local diagnostics (env, daemon, DB, CLI binaries) and report')
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
