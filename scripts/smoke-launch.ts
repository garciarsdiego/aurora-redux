// F7-7 — Daemon launch smoke test (Aurora).
//
// Boots an isolated Omniforge HTTP MCP daemon on a free port, executes the
// smallest possible workflow (one tool_call → calculator), asserts the
// expected result, and shuts down cleanly. Designed for CI: no external
// services required, no shared state with the operator's main daemon.
//
// Usage:
//   pnpm smoke:launch                 # uses tsx
//   tsx scripts/smoke-launch.ts        # direct
//
// Exit codes:
//   0 = full success (daemon booted, workflow ran, result matches, shutdown clean)
//   1 = any step failed (diagnostics printed to stdout)
//
// Implementation notes:
//   - Uses `scripts/start-isolated-http-daemon.ts` as the daemon entrypoint
//     because it (a) takes --port + --data-dir flags directly, (b) bypasses
//     bin/omniforge's PID-file dance, and (c) keeps state under tmp/ so we
//     never touch the operator's data/omniforge.db.
//   - Picks a kernel-assigned free port via createServer().listen(0).
//   - Polls /health (no auth) for readiness, then issues the workflow via
//     /api/dashboard/dags/run with Bearer auth.
//   - The smoke wraps the daemon process in try/finally so SIGTERM ALWAYS
//     fires, even on assertion failure or unexpected exception.

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ───────────────────────────────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────────────────────────────

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isolatedDaemonScript = path.join(repoRoot, 'scripts', 'start-isolated-http-daemon.ts');

const HEALTH_TIMEOUT_MS = 30_000;     // wait up to 30s for daemon to come up
const WORKFLOW_TIMEOUT_MS = 30_000;   // wait up to 30s for the calculator workflow
const SHUTDOWN_TIMEOUT_MS = 10_000;   // give the daemon up to 10s to exit on SIGTERM
const POLL_INTERVAL_MS = 250;

// ───────────────────────────────────────────────────────────────────────
// Logging helpers — every step prints `[smoke] step N: <desc> -> OK/FAIL`
// ───────────────────────────────────────────────────────────────────────

let stepCounter = 0;
function step(description: string): { ok: () => void; fail: (reason: string) => void } {
  const n = ++stepCounter;
  process.stdout.write(`[smoke] step ${n}: ${description} ... `);
  return {
    ok: () => process.stdout.write('OK\n'),
    fail: (reason: string) => process.stdout.write(`FAIL — ${reason}\n`),
  };
}

function logInfo(message: string): void {
  process.stdout.write(`[smoke] ${message}\n`);
}

function logDiagnostic(label: string, detail: unknown): void {
  const serialized = typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2);
  process.stdout.write(`[smoke] ${label}:\n${serialized}\n`);
}

// ───────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      if (!addr || typeof addr === 'string') {
        probe.close();
        reject(new Error('createServer().address() returned no port'));
        return;
      }
      const port = addr.port;
      probe.close(() => resolve(port));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref();
  });
}

async function waitForHealth(baseUrl: string, deadlineMs: number): Promise<void> {
  while (Date.now() < deadlineMs) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) {
        const body = (await res.json()) as { status?: string };
        if (body.status === 'ok') return;
      }
    } catch {
      // ECONNREFUSED while daemon is still booting — keep polling.
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`daemon /health did not become ready within ${HEALTH_TIMEOUT_MS}ms`);
}

interface WorkflowTask {
  id: string;
  name: string;
  status: string;
  kind: string;
  output_json: string | null;
}

interface WorkflowDagSnapshot {
  workflow_id: string;
  status: string;
  tasks: WorkflowTask[];
}

async function fetchWorkflowSnapshot(
  baseUrl: string,
  token: string,
  workflowId: string,
): Promise<WorkflowDagSnapshot> {
  const res = await fetch(
    `${baseUrl}/api/dashboard/workflows/${encodeURIComponent(workflowId)}/dag`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET workflow dag → ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as WorkflowDagSnapshot;
}

interface PollResult {
  ok: boolean;
  finalStatus: string;
  tasks: WorkflowTask[];
}

async function pollWorkflowDone(
  baseUrl: string,
  token: string,
  workflowId: string,
  deadlineMs: number,
): Promise<PollResult> {
  while (Date.now() < deadlineMs) {
    const snap = await fetchWorkflowSnapshot(baseUrl, token, workflowId);
    if (snap.status === 'completed') return { ok: true, finalStatus: snap.status, tasks: snap.tasks };
    if (snap.status === 'failed' || snap.status === 'cancelled') {
      return { ok: false, finalStatus: snap.status, tasks: snap.tasks };
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return { ok: false, finalStatus: 'timeout', tasks: [] };
}

function shutdownDaemon(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once('exit', finish);
    child.once('close', finish);
    try {
      child.kill('SIGTERM');
    } catch {
      finish();
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
      finish();
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();
  });
}

// ───────────────────────────────────────────────────────────────────────
// Smoke test
// ───────────────────────────────────────────────────────────────────────

interface DaemonHandle {
  child: ChildProcess;
  dataDir: string;
  baseUrl: string;
  token: string;
}

async function bootDaemon(): Promise<DaemonHandle> {
  const portStep = step('pick free port');
  let port: number;
  try {
    port = await getFreePort();
    portStep.ok();
    logInfo(`port=${port}`);
  } catch (err) {
    portStep.fail((err as Error).message);
    throw err;
  }

  const dataDirStep = step('create isolated data dir');
  const dataDir = mkdtempSync(path.join(tmpdir(), 'omniforge-smoke-launch-'));
  mkdirSync(dataDir, { recursive: true });
  dataDirStep.ok();
  logInfo(`data_dir=${dataDir}`);

  const spawnStep = step('spawn isolated daemon (tsx scripts/start-isolated-http-daemon.ts)');
  // We use the local tsx binary so we don't depend on a built dist/. The
  // isolated daemon entry imports src/mcp/http-server.ts directly which
  // is the same code the production daemon runs.
  const tsxBin = process.platform === 'win32' ? 'tsx.cmd' : 'tsx';
  const child = spawn(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      isolatedDaemonScript,
      '--port', String(port),
      '--data-dir', dataDir,
    ],
    {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        OMNIFORGE_DAEMON_PORT: String(port),
        OMNIFORGE_ISOLATED_DATA_DIR: dataDir,
        // Disable Telegram notifications + injection enforcement for the smoke.
        // Calculator input is trusted by construction; we don't need the scan
        // adding latency or false positives.
        INJECTION_SCAN_ENFORCE: 'false',
        INJECTION_SCAN_OBJECTIVE: 'false',
      },
      // Detached so we can SIGTERM the whole tree on Unix; on Windows
      // tree-killing is best-effort via SIGKILL fallback.
      detached: process.platform !== 'win32',
    },
  );

  // Surface daemon stderr/stdout into the smoke log so failures are easy
  // to diagnose without hunting through tmp dirs.
  child.stdout?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[daemon stdout] ${chunk.toString()}`);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[daemon stderr] ${chunk.toString()}`);
  });

  // If the child exits before we get to the assertions, surface that as
  // a hard failure rather than blocking on /health forever.
  let earlyExitReason: string | null = null;
  child.once('exit', (code, signal) => {
    if (earlyExitReason === null) {
      earlyExitReason = `daemon exited early (code=${code}, signal=${signal})`;
    }
  });

  spawnStep.ok();
  logInfo(`pid=${child.pid ?? 'unknown'}, tsx=${tsxBin}`);

  const baseUrl = `http://127.0.0.1:${port}`;

  const healthStep = step(`wait for /health (deadline=${HEALTH_TIMEOUT_MS}ms)`);
  try {
    await waitForHealth(baseUrl, Date.now() + HEALTH_TIMEOUT_MS);
    healthStep.ok();
  } catch (err) {
    if (earlyExitReason !== null) {
      healthStep.fail(earlyExitReason);
    } else {
      healthStep.fail((err as Error).message);
    }
    throw err;
  }

  const tokenStep = step('read daemon token from data dir');
  let token: string;
  try {
    token = readFileSync(path.join(dataDir, 'daemon-token.txt'), 'utf8').trim();
    if (token.length === 0) throw new Error('token file is empty');
    tokenStep.ok();
    logInfo(`token=${token.slice(0, 8)}... (${token.length} chars)`);
  } catch (err) {
    tokenStep.fail((err as Error).message);
    throw err;
  }

  return { child, dataDir, baseUrl, token };
}

interface CalculatorOutput {
  expression: string;
  result: number;
}

async function runCalculatorWorkflow(handle: DaemonHandle): Promise<void> {
  const { baseUrl, token } = handle;

  // Single-task DAG. The DB schema requires t0 to be the entry task.
  // Calculator is the simplest deterministic tool in src/v2/tools/core/index.ts:
  // it takes an expression string and returns { expression, result }.
  const dag = {
    tasks: [
      {
        id: 't0',
        name: 'Compute 2 + 2',
        kind: 'tool_call' as const,
        depends_on: [] as string[],
        tool_name: 'calculator',
        args: { expression: '2+2' },
        // Acceptance criteria isn't required for t0 (validator exempts it),
        // but we set it so the DAG looks sane in the UI if a human inspects it.
        acceptance_criteria: 'calculator returns numeric result equal to 4',
      },
    ],
  };

  const submitStep = step('POST /api/dashboard/dags/run (single calculator task)');
  let workflowId: string;
  try {
    const res = await fetch(`${baseUrl}/api/dashboard/dags/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        workspace: 'internal',
        objective: 'Smoke: verify daemon executes a single calculator tool_call',
        dag,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
    }
    const body = (await res.json()) as { workflow_id?: string; error?: string };
    if (body.error) throw new Error(`run returned error: ${body.error}`);
    if (typeof body.workflow_id !== 'string' || body.workflow_id.length === 0) {
      throw new Error('run response missing workflow_id');
    }
    workflowId = body.workflow_id;
    submitStep.ok();
    logInfo(`workflow_id=${workflowId}`);
  } catch (err) {
    submitStep.fail((err as Error).message);
    throw err;
  }

  const pollStep = step(`poll workflow status (deadline=${WORKFLOW_TIMEOUT_MS}ms)`);
  let result: PollResult;
  try {
    result = await pollWorkflowDone(baseUrl, token, workflowId, Date.now() + WORKFLOW_TIMEOUT_MS);
    if (!result.ok) {
      pollStep.fail(`workflow ended status=${result.finalStatus}`);
      logDiagnostic('workflow tasks', result.tasks);
      throw new Error(`workflow did not complete: ${result.finalStatus}`);
    }
    pollStep.ok();
    logInfo(`final_status=${result.finalStatus}, tasks=${result.tasks.length}`);
  } catch (err) {
    if (!(err instanceof Error && err.message.startsWith('workflow did not complete'))) {
      pollStep.fail((err as Error).message);
    }
    throw err;
  }

  const assertStep = step('assert task output contains result=4');
  try {
    const t0 = result.tasks.find((t) => t.id === 't0' || t.kind === 'tool_call');
    if (!t0) throw new Error('no tool_call task found in workflow snapshot');
    if (t0.status !== 'completed') {
      throw new Error(`tool_call task ended status=${t0.status} (expected completed)`);
    }
    if (typeof t0.output_json !== 'string' || t0.output_json.length === 0) {
      throw new Error('tool_call task has empty output_json');
    }
    // Outer envelope is the ToolResult JSON-stringified by the executor.
    const envelope = JSON.parse(t0.output_json) as { success?: boolean; output?: string };
    if (envelope.success !== true) {
      throw new Error(`tool reported failure: ${JSON.stringify(envelope).slice(0, 300)}`);
    }
    if (typeof envelope.output !== 'string') {
      throw new Error('tool envelope missing output string');
    }
    // Inner payload is the calculator's own JSON (expression + result).
    const inner = JSON.parse(envelope.output) as CalculatorOutput;
    if (inner.result !== 4) {
      throw new Error(`expected result=4, got ${inner.result}`);
    }
    assertStep.ok();
    logInfo(`calculator returned: ${JSON.stringify(inner)}`);
  } catch (err) {
    assertStep.fail((err as Error).message);
    logDiagnostic('failing task output_json', result.tasks.map((t) => ({
      id: t.id,
      status: t.status,
      output_json: t.output_json?.slice(0, 500) ?? null,
    })));
    throw err;
  }
}

// ───────────────────────────────────────────────────────────────────────
// Main
// ───────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  let handle: DaemonHandle | null = null;
  let exitCode = 0;
  try {
    handle = await bootDaemon();
    await runCalculatorWorkflow(handle);
    logInfo('all assertions passed');
  } catch (err) {
    exitCode = 1;
    logDiagnostic('smoke FAILED', err instanceof Error ? err.message : String(err));
  } finally {
    if (handle) {
      const shutdownStep = step('SIGTERM daemon and await exit');
      try {
        await shutdownDaemon(handle.child);
        shutdownStep.ok();
      } catch (err) {
        shutdownStep.fail((err as Error).message);
        exitCode = exitCode || 1;
      }
      const cleanupStep = step('remove temp data dir');
      try {
        rmSync(handle.dataDir, { recursive: true, force: true });
        cleanupStep.ok();
      } catch (err) {
        // Don't fail the whole smoke just because Windows held a file
        // handle on the SQLite WAL — log it and move on.
        cleanupStep.fail(`(non-fatal) ${(err as Error).message}`);
      }
    }
  }
  logInfo(exitCode === 0 ? 'SUCCESS' : 'FAILURE');
  return exitCode;
}

main().then((code) => {
  process.exit(code);
}).catch((err) => {
  // main() already swallows everything; this guard exists for unforeseen
  // top-level rejections so the process doesn't hang.
  process.stderr.write(`[smoke] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
