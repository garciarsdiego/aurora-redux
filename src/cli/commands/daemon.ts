import type { Command } from 'commander';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import treeKill from 'tree-kill';
import { config as loadEnv } from 'dotenv';
import { resolveHttpPort, startHttpMcpServer } from '../../mcp/http-server.js';
import { recoverExpiredTaskLeases } from '../../db/task-leases.js';
import { sweepOrphans } from '../../v2/subagent/orphan-recovery.js';
import { scheduleWalCheckpointTick } from '../../db/maintenance.js';
import { insertEvent } from '../../db/persist.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/cli/commands/daemon.js → 3 levels up = project root
const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const PID_FILE = path.join(DATA_DIR, 'daemon.pid');
const LOG_FILE = path.join(DATA_DIR, 'daemon.log');
const CLI_ENTRY = path.join(PROJECT_ROOT, 'dist', 'cli', 'index.js');

function readPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const raw = readFileSync(PID_FILE, 'utf8').trim();
  const pid = parseInt(raw, 10);
  return isNaN(pid) ? null : pid;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killPid(pid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    treeKill(pid, 'SIGTERM', (err?: Error) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// F3-7: workflow statuses considered "in flight" for the purposes of
// shutdown drain. We hard-cancel sub-agents for these so SIGTERM does not
// leave orphan processes / stale `running` rows in the DB. `executing` is
// the canonical run-time status; `paused` and `approved` are pre-resume
// states whose tasks may also be running. `pending` covers freshly enqueued
// workflows that the executor has not yet picked up.
const IN_FLIGHT_WORKFLOW_STATUSES = ['executing', 'pending', 'approved', 'paused'] as const;

// Task statuses that block a clean shutdown — we wait until every in-flight
// task of every drained workflow flips to a terminal state before closing.
const NON_TERMINAL_TASK_STATUSES = new Set(['running', 'pending', 'ready', 'waiting']);

function resolveDrainTimeoutMs(): number {
  const raw = process.env.OMNIFORGE_SHUTDOWN_DRAIN_MS?.trim();
  if (!raw) return 30_000;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 30_000;
  return parsed;
}

async function drainInFlightWorkflows(): Promise<void> {
  const drainTimeoutMs = resolveDrainTimeoutMs();
  if (drainTimeoutMs === 0) {
    process.stderr.write('[daemon] drain disabled (OMNIFORGE_SHUTDOWN_DRAIN_MS=0)\n');
    return;
  }

  // Dynamic imports keep the daemon CLI's startup path light and avoid
  // potential circular imports between cli/commands and brain/v2.
  const { initDb } = await import('../../db/client.js');
  const { getDbPath } = await import('../../utils/config.js');
  const { broadcastCancelToWorkflow } = await import('../../v2/subagent/control.js');

  const db = initDb(getDbPath());
  try {
    type WfRow = { id: string; status: string };
    const placeholders = IN_FLIGHT_WORKFLOW_STATUSES.map(() => '?').join(',');
    const inFlight = db
      .prepare(
        `SELECT id, status FROM workflows WHERE status IN (${placeholders})`,
      )
      .all(...IN_FLIGHT_WORKFLOW_STATUSES) as WfRow[];

    if (inFlight.length === 0) {
      process.stderr.write('[daemon] drain: no in-flight workflows\n');
      return;
    }

    process.stderr.write(
      `[daemon] drain: cancelling ${inFlight.length} in-flight workflow(s)\n`,
    );

    let aggregateTasks = 0;
    let aggregateControllers = 0;
    for (const wf of inFlight) {
      try {
        const result = broadcastCancelToWorkflow(db, wf.id, 'daemon_shutdown');
        aggregateTasks += result.tasks_cancelled;
        aggregateControllers += result.controllers_aborted;
        process.stderr.write(
          `[daemon] drain: workflow ${wf.id} → tasks=${result.tasks_cancelled} aborted=${result.controllers_aborted} messages=${result.messages_cancelled}\n`,
        );
      } catch (err) {
        process.stderr.write(
          `[daemon] drain: broadcastCancelToWorkflow failed for ${wf.id}: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      }
    }

    process.stderr.write(
      `[daemon] drain: ${aggregateTasks} task(s) marked cancelled, ${aggregateControllers} controller(s) aborted\n`,
    );

    // Wait until all tasks of the drained workflows have flipped to a terminal
    // state (or until drainTimeoutMs elapses). Polling avoids the need for
    // event-broker subscriptions and keeps the shutdown path dependency-free.
    const wfIds = inFlight.map((row) => row.id);
    const placeholdersWf = wfIds.map(() => '?').join(',');
    const deadline = Date.now() + drainTimeoutMs;
    let lastRemaining = -1;
    while (Date.now() < deadline) {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS n FROM tasks
            WHERE workflow_id IN (${placeholdersWf})
              AND status IN ('running', 'pending', 'ready', 'waiting')`,
        )
        .get(...wfIds) as { n: number } | undefined;
      const remaining = row?.n ?? 0;
      if (remaining === 0) {
        process.stderr.write('[daemon] drain: all tasks reached terminal state\n');
        break;
      }
      if (remaining !== lastRemaining) {
        process.stderr.write(
          `[daemon] drain: waiting on ${remaining} non-terminal task(s)\n`,
        );
        lastRemaining = remaining;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    // Final report — even if we hit the deadline, log what is still hanging
    // so operators can investigate orphans on the next start sweep.
    const finalRow = db
      .prepare(
        `SELECT COUNT(*) AS n FROM tasks
          WHERE workflow_id IN (${placeholdersWf})
            AND status IN ('running', 'pending', 'ready', 'waiting')`,
      )
      .get(...wfIds) as { n: number } | undefined;
    const finalRemaining = finalRow?.n ?? 0;
    if (finalRemaining > 0) {
      process.stderr.write(
        `[daemon] drain: timeout — ${finalRemaining} task(s) still non-terminal after ${drainTimeoutMs}ms (orphan-recovery will clean up on next start)\n`,
      );
    }

    // Note: NON_TERMINAL_TASK_STATUSES is the canonical set used above.
    // Referenced here so future readers know it's the source of truth.
    void NON_TERMINAL_TASK_STATUSES;
  } finally {
    db.close();
  }
}

async function runOrphanRecoverySweep(): Promise<void> {
  // Wave C Agent O — sweep `runtime_sessions` for `acp-stdio` rows that the
  // previous daemon left behind (kill -9, crash, host reboot, etc.). Marks
  // their rows stale and tree-kills any still-alive child pids.
  const { initDb } = await import('../../db/client.js');
  const { getDbPath } = await import('../../utils/config.js');
  const { recoverOrphanAcpSessions } = await import('../../runtime/process-pool.js');

  const db = initDb(getDbPath());
  try {
    const result = await recoverOrphanAcpSessions(db);
    if (result.scanned > 0) {
      process.stderr.write(
        `[daemon] orphan-recovery: scanned=${result.scanned} marked_stale=${result.marked_stale} killed=${result.killed_pids} errors=${result.errors.length}\n`,
      );
      for (const e of result.errors) {
        process.stderr.write(`[daemon] orphan-recovery error: ${e.sessionId} → ${e.error}\n`);
      }
    }
  } catch (err) {
    process.stderr.write(
      `[daemon] orphan-recovery failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  } finally {
    db.close();
  }
}

async function runHitlOrphanRecoverySweep(): Promise<void> {
  // Tier 0 Wave 4 0.3 — surface pending HITL gates that the previous daemon
  // left behind. We emit `hitl_gate_orphan_recovered` events; we do NOT
  // auto-resolve. Failure here is logged but MUST NOT block daemon startup
  // (HITL is a soft path — operators can still see and act via /workflows
  // listings even if this sweep dies).
  const { initDb } = await import('../../db/client.js');
  const { getDbPath } = await import('../../utils/config.js');
  const { recoverOrphanHitlGates } = await import('../../db/hitl-orphan-recovery.js');

  const db = initDb(getDbPath());
  try {
    const result = recoverOrphanHitlGates(db);
    if (result.scanned > 0 || result.errors.length > 0) {
      process.stderr.write(
        `[daemon] hitl-orphan-recovery: scanned=${result.scanned} surfaced=${result.surfaced} skipped=${result.skipped} errors=${result.errors.length}\n`,
      );
      for (const e of result.errors) {
        process.stderr.write(`[daemon] hitl-orphan-recovery error: ${e.gate_id} → ${e.error}\n`);
      }
    }
  } catch (err) {
    process.stderr.write(
      `[daemon] hitl-orphan-recovery failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  } finally {
    db.close();
  }
}

async function runTriggerOrphanRetrySweepStartup(): Promise<void> {
  // Aurora Tier 0 / Wave 4 / 0.4 (F-REL-2): replay trigger fires whose
  // dispatch never completed. The schedule tick + webhook receive both
  // INSERT a `trigger_fires` row before dispatch; a daemon crash between
  // the row insert and the workflow row insert leaves the fire orphaned.
  // This sweep finds rows >5min old still missing dispatched_at and
  // re-attempts the workflow creation. Failure is logged but does not
  // block startup — the next daemon start will retry.
  try {
    const { runTriggerOrphanRetrySweep } = await import('../../mcp/routes/_trigger-orphan-retry.js');
    const result = await runTriggerOrphanRetrySweep();
    if (result.scanned > 0 || result.failed.length > 0) {
      process.stderr.write(
        `[daemon] trigger-orphan-retry: scanned=${result.scanned} dispatched=${result.dispatched.length} failed=${result.failed.length} skipped=${result.skipped}\n`,
      );
      for (const f of result.failed) {
        process.stderr.write(`[daemon] trigger-orphan-retry error: ${f.id} → ${f.error}\n`);
      }
    }
  } catch (err) {
    process.stderr.write(
      `[daemon] trigger-orphan-retry failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

// M1 Wave 1 (2026-05-12): wire 3 previously-dead reliability handlers into
// daemon startup. Each emits a `daemon_recovery_sweep_completed` event
// (workflow_id='_daemon' — migration 046 supplies the sentinel row) so the
// dashboard audit trail records what the sweep did.
//
// Exported for testability — tests/integration/daemon-recovery-sweeps.test.ts
// invokes this against an in-memory DB without spinning up the HTTP server.
//
// Returns the WAL-tick stop fn so the caller can wire it into the shutdown
// handler (the timer is `.unref()`ed and will not pin the process if the
// stop fn is forgotten, but cleaning it up explicitly keeps test runs tidy).
export interface StartupSweepResult {
  walTickStop: () => void;
  leasesRecovered: number;
  subagentOrphansFound: number;
  subagentOrphansRecovered: number;
}

// M1 Wave 2 (2026-05-12): result shape for the async portion of startup
// sweeps. Currently only the remediation-pickup loop lives here (kept
// separate from `StartupSweepResult` because the async path can't share a
// signature with the synchronous fan-out without breaking the existing test
// suite that calls `runStartupSweeps(db)` synchronously).
export interface StartupAsyncSweepResult {
  remediationPickedUp: number;
  remediationFailed: number;
}

// OPS-02 — tables the cost/benchmark subsystem reads & writes. Created by
// OPS-01 migrations 056 (model_costs), 057 (provider_benchmarks +
// benchmark_runs) and 058 (usage_costs). Kept as a flat list so the
// self-check stays trivial to extend when new analytics tables are added.
export const EXPECTED_TABLES = [
  'model_costs',
  'usage_costs',
  'provider_benchmarks',
  'benchmark_runs',
] as const;

// Returns the subset of EXPECTED_TABLES that are absent from the schema.
// Uses the same sqlite_master probe pattern as src/db/workflow-debug-log.ts
// and src/v2/reflection/store.ts. Pure read; no side effects.
function checkExpectedTables(db: Database.Database): string[] {
  const stmt = db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
  );
  const missing: string[] = [];
  for (const table of EXPECTED_TABLES) {
    const row = stmt.get(table) as { name: string } | undefined;
    if (row?.name !== table) missing.push(table);
  }
  return missing;
}

export function runStartupSweeps(db: Database.Database): StartupSweepResult {
  // (1) Expired task leases — runs that were holding a workflow_task_leases
  // row 'running' past its expires_at because the prior daemon crashed
  // mid-task. Flip them to 'expired' so the executor can re-acquire on
  // resume. The lease itself does not cancel the work — that's the
  // subagent-orphan sweep below.
  let leasesRecovered = 0;
  try {
    const expired = recoverExpiredTaskLeases(db, Date.now());
    leasesRecovered = expired.length;
    insertEvent(db, {
      workflow_id: '_daemon',
      type: 'daemon_recovery_sweep_completed',
      payload: { kind: 'task_leases', recovered: leasesRecovered },
    });
    if (leasesRecovered > 0) {
      process.stderr.write(
        `[daemon] task-lease-recovery: expired=${leasesRecovered}\n`,
      );
    }
  } catch (err) {
    process.stderr.write(
      `[daemon] task-lease-recovery failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  // (2) Orphaned subagent_runs — rows stuck in 'pending'/'running' past the
  // 10-minute orphan ceiling because the prior daemon crashed mid-spawn.
  // We pick 'fail' (not 'restart') on startup because the spawning task
  // is itself an orphan in the executor's task table; the auto-remediation
  // child-workflow path will handle re-driving the work if the operator
  // wants it.
  let subagentOrphansFound = 0;
  let subagentOrphansRecovered = 0;
  try {
    const result = sweepOrphans(db, 'fail');
    subagentOrphansFound = result.found;
    subagentOrphansRecovered = result.recovered;
    insertEvent(db, {
      workflow_id: '_daemon',
      type: 'daemon_recovery_sweep_completed',
      payload: {
        kind: 'subagent_orphans',
        found: result.found,
        recovered: result.recovered,
        skipped: result.skipped,
      },
    });
    if (result.found > 0) {
      process.stderr.write(
        `[daemon] subagent-orphan-recovery: found=${result.found} recovered=${result.recovered} skipped=${result.skipped}\n`,
      );
    }
  } catch (err) {
    process.stderr.write(
      `[daemon] subagent-orphan-recovery failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  // (3) WAL checkpoint maintenance tick — long-lived setInterval at
  // WAL_CHECKPOINT_INTERVAL_MS (1h). The timer is `.unref()`ed inside
  // scheduleWalCheckpointTick so it does not pin the event loop; the
  // caller is responsible for invoking the returned stop fn during
  // graceful shutdown so test runs don't leak the handle.
  let walTickStop: () => void = () => undefined;
  try {
    walTickStop = scheduleWalCheckpointTick(db);
    insertEvent(db, {
      workflow_id: '_daemon',
      type: 'daemon_recovery_sweep_completed',
      payload: { kind: 'wal_checkpoint_scheduled' },
    });
  } catch (err) {
    process.stderr.write(
      `[daemon] wal_checkpoint scheduling failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  // (4) OPS-02 — schema self-check. Verify the cost/benchmark tables that
  // OPS-01 migrations 056/057/058 create actually exist. This is pure
  // observability: it NEVER throws and NEVER blocks startup. A missing table
  // means the cost subsystem will silently degrade (see swallowed insert in
  // omniroute-call.ts), so we surface it loudly on stderr AND emit a sentinel
  // event the dashboard can show. Distinct event type
  // (`daemon_table_self_check_completed`, NOT `daemon_recovery_sweep_completed`)
  // so the 3-event count asserted by daemon-recovery-sweeps.test.ts is intact.
  try {
    const missing = checkExpectedTables(db);
    insertEvent(db, {
      workflow_id: '_daemon',
      type: 'daemon_table_self_check_completed',
      payload: {
        kind: 'expected_tables',
        expected: EXPECTED_TABLES,
        missing,
      },
    });
    if (missing.length > 0) {
      process.stderr.write(
        `[daemon] table-self-check: MISSING ${missing.length} expected table(s): ${missing.join(', ')} — cost/benchmark features will degrade. Run migrations (OPS-01 056/057/058).\n`,
      );
    }
  } catch (err) {
    // Self-check failure is itself non-fatal — log and continue. A daemon that
    // can't introspect sqlite_master is in deeper trouble, but startup must
    // not be blocked by an observability probe.
    process.stderr.write(
      `[daemon] table-self-check failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  return {
    walTickStop,
    leasesRecovered,
    subagentOrphansFound,
    subagentOrphansRecovered,
  };
}

/**
 * M1 Wave 2 (2026-05-12): pick up pending remediation child workflows
 * orphaned by a daemon crash between `spawnRemediationWorkflow` and the
 * in-process dispatch. Async sibling of `runStartupSweeps` — runs once
 * per daemon start, fire-and-forget per child so this fn returns quickly
 * even when many children are queued.
 *
 * Errors are caught and surfaced via the
 * `daemon_recovery_sweep_completed` event (workflow_id='_daemon') with
 * `picked_up=0 failed=N error=...` payload. Daemon startup is never blocked
 * by a pickup failure.
 *
 * Exported for the integration test that wires the same call site without
 * spinning up the full HTTP server.
 */
export async function runStartupAsyncSweeps(
  db: Database.Database,
): Promise<StartupAsyncSweepResult> {
  let remediationPickedUp = 0;
  let remediationFailed = 0;
  try {
    const { pickupPendingRemediationWorkflows } = await import('../../quality/remediation-pickup.js');
    const result = await pickupPendingRemediationWorkflows(db);
    remediationPickedUp = result.pickedUp;
    remediationFailed = result.failed;
    insertEvent(db, {
      workflow_id: '_daemon',
      type: 'daemon_recovery_sweep_completed',
      payload: {
        kind: 'remediation_pickup',
        picked_up: result.pickedUp,
        failed: result.failed,
        dispatched: result.dispatched,
        errors: result.errors,
      },
    });
    if (result.pickedUp > 0 || result.failed > 0) {
      process.stderr.write(
        `[daemon] remediation-pickup: picked_up=${result.pickedUp} failed=${result.failed}\n`,
      );
    }
  } catch (err) {
    // The sweep must NEVER block daemon startup — log and emit a
    // sentinel event so operators can see the failure on the dashboard.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[daemon] remediation-pickup failed: ${msg}\n`);
    try {
      insertEvent(db, {
        workflow_id: '_daemon',
        type: 'daemon_recovery_sweep_completed',
        payload: {
          kind: 'remediation_pickup',
          picked_up: 0,
          failed: 0,
          error: msg,
        },
      });
    } catch { /* observability — stderr is the audit */ }
  }

  return { remediationPickedUp, remediationFailed };
}

async function drainAcpProcesses(): Promise<void> {
  // Wave C Agent O — phase A: send `session/close` to every tracked ACP
  // session BEFORE the AbortController cascade. Children are NOT killed here;
  // the legacy `drainInFlightWorkflows` runs immediately after and lets the
  // executor's own cleanup chain shut things down. Force-kill of any leftover
  // children happens in `forceKillSurvivingAcpProcesses` at the end.
  const { initDb } = await import('../../db/client.js');
  const { getDbPath } = await import('../../utils/config.js');
  const { runtimeProcessPool } = await import('../../runtime/process-pool.js');

  const db = initDb(getDbPath());
  try {
    const result = await runtimeProcessPool.drainAcpProcesses(db);
    if (result.processesTouched > 0) {
      process.stderr.write(
        `[daemon] acp-drain: processes=${result.processesTouched} sessions_closed=${result.sessionsClosed} errors=${result.errors.length}\n`,
      );
      for (const e of result.errors) {
        process.stderr.write(`[daemon] acp-drain error: ${e.poolKey} → ${e.error}\n`);
      }
    }
  } catch (err) {
    process.stderr.write(
      `[daemon] acp-drain failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  } finally {
    db.close();
  }
}

async function forceKillAcpSurvivors(): Promise<void> {
  // Wave C Agent O — phase B: any opencode child that did not exit on its own
  // after the AbortController cascade gets tree-killed (SIGTERM, then SIGKILL
  // after 5s). Belt-and-braces — if the executor cleanup paths are working,
  // this is a no-op.
  try {
    const { runtimeProcessPool } = await import('../../runtime/process-pool.js');
    const result = await runtimeProcessPool.forceKillSurvivingAcpProcesses();
    if (result.killed > 0) {
      process.stderr.write(`[daemon] acp-force-kill: killed=${result.killed}\n`);
    }
  } catch (err) {
    process.stderr.write(
      `[daemon] acp-force-kill failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

async function runForeground(): Promise<void> {
  loadEnv({ path: path.join(PROJECT_ROOT, '.env') });
  const port = resolveHttpPort();
  mkdirSync(DATA_DIR, { recursive: true });

  // Aurora W4 — when started via `daemon start` the child runs with
  // OMNIFORGE_DAEMON_CHILD=1 and stdio: ['ignore', logFd, logFd], so
  // process.stdin is NOT a TTY. The HITL gate code (src/brain/executor/
  // hitl-gate.ts) correctly detects this and skips the terminal prompt to
  // avoid auto-rejecting gates, but the behaviour is silent. Log a clear
  // banner to daemon.log so operators know that approvals must flow through
  // the dashboard inbox / `omniforge_approve_gate` MCP tool.
  if (process.env.OMNIFORGE_DAEMON_CHILD === '1') {
    process.stderr.write(
      '[HITL] Detached mode — gate approvals via dashboard inbox only (terminal prompt disabled)\n',
    );
    // EXEC-02 — the daemon child defaults CLI spawns to SAFE mode (writes
    // blocked). In safe mode claude/kimi block on an interactive approval
    // that never arrives in a non-TTY subprocess (they hang to timeout) and
    // codex/cursor run read-only (no file writes). Make the gate visible so
    // operators do not chase a silent hang. Mode resolution lives in
    // src/executors/cli/permission-context.ts (isCliSafeMode).
    const explicitOverride =
      process.env.CLI_SAFE_MODE === 'false' || process.env.OMNIFORGE_MCP_SAFE_MODE === 'false';
    if (!explicitOverride) {
      process.stderr.write(
        '[cli-spawn] CLI permission mode = SAFE (writes blocked). cli_spawn tasks ' +
          'that need to write files will HANG (claude/kimi) or NO-OP (codex/cursor) ' +
          'until you enable writes. To enable: pass cli_permission_mode:"autonomous" ' +
          'to omniforge_run_workflow, OR set CLI_SAFE_MODE=false in .env and restart ' +
          'the daemon. (Security: autonomous runs grant the spawned CLI full ' +
          'workspace write + sandbox bypass — see permission-context.ts.)\n',
      );
    }
  }

  // Validate model env vars against Omniroute catalog before binding (D-H2.076).
  // Bypass with OMNIFORGE_SKIP_MODEL_VALIDATION=true (offline dev / catalog unreachable).
  if (process.env.OMNIFORGE_SKIP_MODEL_VALIDATION !== 'true') {
    try {
      const { validateModelEnvsAgainstCatalog } = await import('../../v2/governance/model-config-validator.js');
      const validation = await validateModelEnvsAgainstCatalog();
      if (!validation.valid) {
        process.stderr.write('[daemon] Model configuration errors detected:\n');
        for (const f of validation.failures) {
          const hint = f.suggestions.length > 0
            ? ` (did you mean: ${f.suggestions.join(', ')}?)`
            : '';
          process.stderr.write(`  ✗ ${f.env}="${f.value}" not found in Omniroute catalog${hint}\n`);
        }
        process.stderr.write('[daemon] Fix model env vars or set OMNIFORGE_SKIP_MODEL_VALIDATION=true to bypass.\n');
        process.exit(1);
      }
    } catch (err) {
      process.stderr.write(
        `[daemon] Model validation skipped (catalog unreachable): ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  // Wave C Agent O — orphan recovery runs BEFORE the HTTP server starts so
  // that any acp-stdio rows the previous daemon left behind are flipped to
  // 'stale' before clients can call /workflow/run and hit a row that points
  // at a dead pid. Failure is logged but does not block startup.
  await runOrphanRecoverySweep();

  // Tier 0 Wave 4 0.3 — sibling sweep for HITL gates that the previous daemon
  // left in `pending` state because it crashed between insertHitlGate and
  // resolveHitlGate. Surfaces them via `hitl_gate_orphan_recovered` events.
  // Same error-handling pattern: log and continue.
  await runHitlOrphanRecoverySweep();

  // Tier 0 Wave 4 0.4 — sibling sweep for trigger fires (schedules + webhooks)
  // whose workflow dispatch was interrupted by daemon crash. Re-attempts
  // dispatch for rows >5 minutes past `fired_at` with `dispatched_at IS NULL`.
  await runTriggerOrphanRetrySweepStartup();

  // M1 Wave 1 (2026-05-12) — three previously-dead reliability handlers:
  // task-lease recovery (workflow_task_leases) + subagent orphan sweep
  // (subagent_runs stuck >10 min) + WAL checkpoint maintenance tick.
  // Each emits a `daemon_recovery_sweep_completed` event on workflow_id
  // '_daemon' (migration 046 supplies the FK target). The WAL tick handle
  // is stored on this closure and cleared in the shutdown handler below.
  //
  // We deliberately do NOT close `sweepDb` here: scheduleWalCheckpointTick
  // captured a reference inside its setInterval closure, and closing the
  // handle would make subsequent pragma calls throw. The handle is owned
  // for the lifetime of the daemon process and reclaimed on process exit
  // (other consumers like the HTTP server open their own handles via
  // initDb(getDbPath()) — better-sqlite3 reference-counts the underlying
  // file descriptor across handles).
  let walTickStop: () => void = () => undefined;
  try {
    const { initDb } = await import('../../db/client.js');
    const { getDbPath } = await import('../../utils/config.js');
    const sweepDb = initDb(getDbPath());
    const result = runStartupSweeps(sweepDb);
    walTickStop = result.walTickStop;

    // M1 Wave 2 (2026-05-12) — pick up any remediation child workflows
    // orphaned by a daemon crash between `spawnRemediationWorkflow`
    // (W2 auto-remediation flag) and the in-process dispatch. Fire-and-
    // forget per child; the function returns once all dispatches are
    // launched. Failure is logged but does NOT block the HTTP server
    // from coming up (the HTTP server is started below regardless).
    //
    // We deliberately do not `await` the per-child execution promises —
    // each child runs on its own background DB handle, and the daemon
    // process keeps running for the duration of the workflows.
    try {
      await runStartupAsyncSweeps(sweepDb);
    } catch (err) {
      process.stderr.write(
        `[daemon] async-startup-sweeps failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  } catch (err) {
    process.stderr.write(
      `[daemon] startup-sweeps failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  const shutdown = await startHttpMcpServer(DATA_DIR, port);
  writeFileSync(PID_FILE, String(process.pid));

  let cleaningUp = false;
  const cleanup = async () => {
    if (cleaningUp) return;
    cleaningUp = true;
    process.stderr.write('[daemon] Shutting down...\n');

    // M1 Wave 1 — stop the WAL checkpoint tick before we close the DB
    // handle so a tick in flight doesn't race the process exit. The stop
    // fn is a no-op if scheduling failed during startup.
    try {
      walTickStop();
    } catch (err) {
      process.stderr.write(
        `[daemon] wal-tick stop failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }

    // Wave C Agent O — phase A: send `session/close` to every tracked ACP
    // session BEFORE we cancel workflows. The ACP server has the chance to
    // ack `session/update.cancelled` cleanly while AbortControllers + child
    // pids are still alive.
    try {
      await drainAcpProcesses();
    } catch (err) {
      process.stderr.write(
        `[daemon] acp-drain wrapper failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }

    // F3-7: drain in-flight workflows BEFORE closing transports/registry so
    // sub-agent abort signals propagate via the still-live AbortController
    // map. broadcastCancelToWorkflow walks tasks → aborts AbortControllers
    // (which kill spawned CLI children via tree-kill in run-task) → flips
    // task rows to 'cancelled' → cancels pending mailbox messages.
    try {
      await drainInFlightWorkflows();
    } catch (err) {
      process.stderr.write(
        `[daemon] drain failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }

    // Wave C Agent O — phase B: tree-kill any opencode/ACP child still alive
    // after the AbortController cascade. No-op when phase A + workflow drain
    // already cleaned things up.
    try {
      await forceKillAcpSurvivors();
    } catch (err) {
      process.stderr.write(
        `[daemon] acp-force-kill wrapper failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }

    await shutdown();
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
    process.exit(0);
  };

  process.on('SIGTERM', () => void cleanup());
  process.on('SIGINT', () => void cleanup());

  // Keep the process alive indefinitely
  await new Promise<never>(() => {});
}

async function doStart(): Promise<void> {
  loadEnv({ path: path.join(PROJECT_ROOT, '.env') });
  const port = resolveHttpPort();

  // Child process: run the HTTP server in-process
  if (process.env.OMNIFORGE_DAEMON_CHILD === '1') {
    await runForeground();
    return;
  }

  // Parent: check if already running
  const existingPid = readPid();
  if (existingPid !== null && isAlive(existingPid)) {
    console.error(`Daemon already running (PID ${existingPid})`);
    process.exit(1);
  }

  // Spawn background child
  mkdirSync(DATA_DIR, { recursive: true });
  const logFd = openSync(LOG_FILE, 'a');

  const child = spawn(process.execPath, [CLI_ENTRY, 'daemon', 'start'], {
    env: { ...process.env, OMNIFORGE_DAEMON_CHILD: '1' },
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();

  writeFileSync(PID_FILE, String(child.pid));
  console.log(`Daemon started (PID ${child.pid})`);
  console.log(`Log:  ${LOG_FILE}`);
  console.log(`Port: ${port}`);
}

async function doStop(): Promise<void> {
  const pid = readPid();
  if (pid === null) {
    console.log('Daemon not running (no PID file)');
    return;
  }
  if (!isAlive(pid)) {
    console.log(`Daemon not running (PID ${pid} dead) — cleaning up`);
    unlinkSync(PID_FILE);
    return;
  }
  await killPid(pid);
  if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  console.log(`Daemon stopped (PID ${pid})`);
}

async function doStatus(): Promise<void> {
  loadEnv({ path: path.join(PROJECT_ROOT, '.env') });
  const port = resolveHttpPort();
  const pid = readPid();
  if (pid === null) {
    console.log(JSON.stringify({ running: false }));
    return;
  }
  const running = isAlive(pid);
  if (!running) {
    // Stale PID file
    unlinkSync(PID_FILE);
  }
  console.log(JSON.stringify({ running, pid: running ? pid : undefined, port }));
}

export function registerDaemon(program: Command): void {
  const daemon = program
    .command('daemon')
    .description('Manage the Omniforge HTTP MCP daemon (default port 20129)');

  daemon
    .command('start')
    .description('Start daemon in background (spawns detached child process)')
    .action(async () => {
      await doStart();
    });

  daemon
    .command('stop')
    .description('Stop running daemon')
    .action(async () => {
      await doStop();
    });

  daemon
    .command('status')
    .description('Show daemon status as JSON')
    .action(async () => {
      await doStatus();
    });

  daemon
    .command('restart')
    .description('Stop then start daemon')
    .action(async () => {
      await doStop().catch(() => {});
      await doStart();
    });
}
