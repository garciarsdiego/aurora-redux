#!/usr/bin/env node
/**
 * dev:daemon — watch-and-restart loop for the Omniforge daemon.
 *
 * Runs `tsc --watch -p tsconfig.json` to incrementally rebuild dist/ on
 * every src/**.ts change, and restarts the daemon (./bin/omniforge daemon
 * restart) when dist/ stabilizes after a build pass.
 *
 * Without this, the operator's loop is:
 *   1. edit src/X.ts
 *   2. pnpm tsc -p tsconfig.json
 *   3. ./bin/omniforge daemon restart
 *   4. wait for the daemon to come up
 * — and forgetting step 2 or 3 means the daemon silently runs old code.
 *
 * With this:
 *   pnpm dev:daemon          (one terminal, leave running)
 *   edit src/X.ts            (auto-rebuild + auto-restart)
 *
 * Behavior:
 *   - Streams tsc output to stdout (prefixed `[tsc]`)
 *   - On a successful build (line containing "Found 0 errors"), debounces 500ms
 *     then triggers `./bin/omniforge daemon restart`
 *   - Daemon restart runs in foreground; its stdout/stderr is visible
 *   - Ctrl-C kills both tsc and any in-flight daemon restart
 *   - Type errors don't trigger a restart (the daemon stays on the last good build)
 *
 * Origin: AUDIT-2026-05-05.md §13 P2 #13.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const DEBOUNCE_MS = 500;

let restartTimer = null;
let restartInFlight = null;
let tscProc = null;

function log(prefix, line) {
  // Strip terminal control codes for cleaner output and prefix every line
  const cleaned = line.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
  if (cleaned.length === 0) return;
  process.stdout.write(`${prefix} ${cleaned}\n`);
}

function scheduleRestart() {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(triggerRestart, DEBOUNCE_MS);
}

async function triggerRestart() {
  restartTimer = null;
  if (restartInFlight) {
    // A restart is already running — coalesce: when it finishes, do another
    return;
  }
  process.stdout.write('[dev] tsc OK → restarting daemon...\n');
  restartInFlight = new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? './bin/omniforge.cmd' : './bin/omniforge';
    const child = spawn(cmd, ['daemon', 'restart'], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      shell: false,
    });
    child.on('close', (code) => {
      restartInFlight = null;
      process.stdout.write(`[dev] daemon restart exited ${code}\n`);
      resolve();
    });
    child.on('error', (err) => {
      restartInFlight = null;
      process.stderr.write(`[dev] daemon restart error: ${err.message}\n`);
      resolve();
    });
  });
}

function startTsc() {
  process.stdout.write('[dev] starting tsc --watch...\n');
  const cmd = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  tscProc = spawn(cmd, ['exec', 'tsc', '--watch', '-p', 'tsconfig.json', '--preserveWatchOutput'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });

  let buffer = '';
  tscProc.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let lineBreakIdx;
    while ((lineBreakIdx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, lineBreakIdx);
      buffer = buffer.slice(lineBreakIdx + 1);
      log('[tsc]', line);
      // Trigger restart on a clean build (no errors found)
      if (/Found 0 errors/i.test(line)) {
        scheduleRestart();
      }
    }
  });
  tscProc.stderr.on('data', (chunk) => {
    log('[tsc:err]', chunk.toString('utf8'));
  });
  tscProc.on('close', (code) => {
    process.stdout.write(`[dev] tsc --watch exited ${code}\n`);
    process.exit(code ?? 1);
  });
  tscProc.on('error', (err) => {
    process.stderr.write(`[dev] tsc --watch error: ${err.message}\n`);
    process.exit(1);
  });
}

function shutdown() {
  process.stdout.write('\n[dev] shutting down...\n');
  if (restartTimer) clearTimeout(restartTimer);
  if (tscProc && !tscProc.killed) tscProc.kill('SIGTERM');
  // Best-effort: stop the daemon on shutdown so the next dev session starts clean
  const cmd = process.platform === 'win32' ? './bin/omniforge.cmd' : './bin/omniforge';
  spawn(cmd, ['daemon', 'stop'], { cwd: REPO_ROOT, stdio: 'inherit', shell: false })
    .on('close', () => process.exit(0));
  // If daemon stop hangs, force-exit after 5s
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

startTsc();
