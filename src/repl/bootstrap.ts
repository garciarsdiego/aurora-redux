// Bootstrap: parse flags, validate workspace, open DB, init store, signal handlers.
// See docs/plans/REPL-LEVEL-D.md § 3.2 lifecycle.
//
// Boot sequence (each step in its own try/catch — failure aborts boot cleanly):
//   1. assertValidWorkspace(workspace) — regex check before any path resolve
//   2. loadWorkspaceEnv(workspace) — reads workspaces/<ws>/.env, overrides root .env
//   3. initDb(getDbPath()) — opens SQLite WAL (creates parent dir if missing)
//   4. preload last-N history entries into the store
//   5. register process.on('SIGINT'|'SIGTERM'|'uncaughtException') → gracefulShutdown
//   6. (D-H2.025) daemonClient.healthCheck() — observability only; falls back silently

import type Database from 'better-sqlite3';
import { initDb } from '../db/client.js';
import { getDbPath } from '../utils/config.js';
import { loadWorkspaceEnv, VALID_WORKSPACE_RE } from '../utils/workspace.js';
import { loadHistoryEntries } from './input/history.js';
import { healthCheck as daemonHealthCheck } from './services/daemonClient.js';
import { useReplStore } from './state/store.js';
import { redact } from './utils/redaction.js';
import { errorMessage } from './utils/errors.js';
import { gracefulShutdown } from './shutdown.js';

export interface BootConfig {
  readonly workspace: string;
  readonly autoApprove: boolean;
  readonly modelOverride?: string;
  readonly ephemeral: boolean;
  readonly noDaemon: boolean;
  readonly requireDaemon: boolean;
}

export interface BootResult {
  readonly db: Database.Database;
  readonly daemonAvailable: boolean;
  readonly historyLoaded: number;
}

let _bootResult: BootResult | null = null;

/** Get the result of the most recent bootstrap, if any. Used by shutdown.ts. */
export function getBootResult(): BootResult | null {
  return _bootResult;
}

export async function bootstrap(config: BootConfig): Promise<BootResult> {
  // 1. Validate workspace name BEFORE any filesystem operation.
  if (!VALID_WORKSPACE_RE.test(config.workspace)) {
    throw new Error(
      `Invalid workspace name '${config.workspace}'. ` +
        `Allowed: alphanumeric, underscore, hyphen.`,
    );
  }

  // 2. Load workspace .env (overrides root .env).
  loadWorkspaceEnv(config.workspace);

  // 3. Open DB (initDb creates parent dir if missing — landed earlier this session).
  const db = initDb(getDbPath());

  // 4. Preload history into store.
  let historyLoaded = 0;
  try {
    const entries = await loadHistoryEntries(config.workspace);
    historyLoaded = entries.length;
    // History is read-only at this point; PromptInput receives it via prop in App.
    // We don't push to a Zustand slice — App owns the live snapshot.
  } catch (err: unknown) {
    process.stderr.write(`[bootstrap] history preload failed: ${redact(errorMessage(err))}\n`);
  }

  // 5. Initialize Zustand session slice with workspace + model override.
  useReplStore.getState().session.setWorkspace(config.workspace);
  if (config.modelOverride) {
    useReplStore.getState().session.setModel(config.modelOverride);
  }

  // 6. Daemon health probe (observability only — REPL runs in-process today;
  //    real daemon-client routing wires in MD).
  let daemonAvailable = false;
  if (!config.ephemeral && !config.noDaemon) {
    try {
      const health = await daemonHealthCheck();
      daemonAvailable = health !== null;
    } catch {
      // Health check failure is non-fatal in MA — daemon-client mode comes in MD.
      daemonAvailable = false;
    }
    if (config.requireDaemon && !daemonAvailable) {
      db.close();
      throw new Error(
        'Daemon required (--require-daemon) but not reachable on :20129. ' +
          'Start it: `omniforge daemon start`.',
      );
    }
  }

  // 7. Register signal handlers — chain into gracefulShutdown.
  // Defensive: only register once per process lifetime.
  if (!_bootResult) {
    process.on('SIGINT', () => {
      // Single Ctrl+C cancels current task; second within 2s exits.
      // Real cancel registry wires in MB; for MA, treat any SIGINT as exit.
      void gracefulShutdown('sigint').then(() => process.exit(130));
    });
    process.on('SIGTERM', () => {
      void gracefulShutdown('sigterm').then(() => process.exit(143));
    });
    process.on('uncaughtException', (err: Error) => {
      const msg = redact(err.stack ?? err.message);
      process.stderr.write(`[repl] uncaught: ${msg}\n`);
      void gracefulShutdown('uncaught').then(() => process.exit(1));
    });
    process.on('unhandledRejection', (reason: unknown) => {
      const msg = redact(reason instanceof Error ? (reason.stack ?? reason.message) : String(reason));
      // Sprint 2.8 (D-H2.066, F-SEC-8): per-context handling.
      //
      // REPL (interactive): an unhandled rejection in a fire-and-forget UI
      //   path (e.g. background fetch) should NOT kill the operator's
      //   session. Log it red and let them keep working.
      //
      // Daemon child (long-lived background process): silent continuation
      //   risks corrupted state. Log + gracefulShutdown so systemd / pm2 /
      //   the parent can restart it cleanly.
      const isDaemonChild = process.env.OMNIFORGE_DAEMON_CHILD === '1';
      const tag = isDaemonChild ? '[daemon]' : '[repl]';
      process.stderr.write(`${tag} unhandled rejection: ${msg}\n`);
      if (isDaemonChild) {
        void gracefulShutdown('unhandled-rejection').then(() => process.exit(1));
      }
    });
  }

  _bootResult = { db, daemonAvailable, historyLoaded };
  return _bootResult;
}
