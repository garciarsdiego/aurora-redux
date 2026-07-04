import Database from 'better-sqlite3';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function initDb(path: string): Database.Database {
  // Ensure parent directory exists. better-sqlite3 throws "Cannot open
  // database because the directory does not exist" otherwise — happens on
  // fresh clones that never had the data/ directory created. The ':memory:'
  // sentinel and any URI form (file:...) skip dirname resolution since
  // there is no parent dir to create.
  if (path !== ':memory:' && !path.startsWith('file:')) {
    const parent = dirname(path);
    if (parent && parent !== '.' && parent !== '/') {
      mkdirSync(parent, { recursive: true });
    }
  }

  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Tier 0 — Wave 2 DB-A: avoid immediate SQLITE_BUSY on contention. The
  // better-sqlite3 default is 0 ms which causes any concurrent writer
  // (HTTP server, schedule tick, REPL, supervisor) to fail loudly the
  // moment a write lock is held by another statement. 5 s is the
  // operating window the retry helper (`sqlite-retry.ts`) wraps around;
  // anything still locked past that is a real deadlock worth surfacing.
  db.pragma('busy_timeout = 5000');
  runMigrations(db);
  return db;
}

function ensureMigrationsTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`);
}

function appliedMigrations(db: Database.Database): Set<string> {
  const rows = db.prepare(`SELECT id FROM schema_migrations`).all() as { id: string }[];
  return new Set(rows.map(r => r.id));
}

/**
 * Locate the migrations directory. Tries multiple candidates because the same
 * client.ts file may be invoked from different __dirname contexts:
 *   - tsc-compiled `dist/db/client.js` → __dirname = dist/db/, expects ./migrations
 *   - tsup bundle inlining client.ts → __dirname = dist/repl/, needs ../db/migrations
 *   - tests with vitest from repo root → __dirname is the source TS path
 * Returns the first existing candidate or throws with the full search trail.
 */
function locateMigrationsDir(): string {
  const candidates = [
    resolve(__dirname, 'migrations'),
    resolve(__dirname, '..', 'db', 'migrations'),
    resolve(process.cwd(), 'dist', 'db', 'migrations'),
    resolve(process.cwd(), 'src', 'db', 'migrations'),
  ];
  for (const c of candidates) {
    try {
      readdirSync(c);
      return c;
    } catch {
      // try next candidate
    }
  }
  throw new Error(
    `Cannot locate migrations directory. Tried:\n  ${candidates.join('\n  ')}`,
  );
}

/**
 * Number of migration `.sql` files shipped — the count a fully-migrated DB's
 * `schema_migrations` table should reach (runMigrations records every file,
 * including reserved noops). Used by `omniforge doctor` to flag an
 * under-migrated DB without a hardcoded magic number. Returns null when the
 * migrations dir can't be located.
 */
export function countMigrationFiles(): number | null {
  try {
    const dir = locateMigrationsDir();
    return readdirSync(dir).filter((f) => f.endsWith('.sql')).length;
  } catch {
    return null;
  }
}

// Directive that opts a migration out of the default transaction wrap. Some
// migrations (notably FK-rebuild operations using the CREATE _v2 / INSERT /
// DROP / RENAME pattern) need `PRAGMA foreign_keys = OFF` around them, and
// SQLite ignores that PRAGMA when issued inside an open transaction.
const NO_TRANSACTION_DIRECTIVE = '-- @no-transaction';

// First-run detection: swallow only "duplicate column" (column already exists
// from a prior additive migration) and "table already exists" (idempotent
// CREATE TABLE IF NOT EXISTS still errors on some paths). Any other error is a
// real failure and must propagate.
function isSwallowableFirstRun(err: unknown): boolean {
  const msg = (err as Error).message ?? '';
  return /duplicate column|table .+ already exists/i.test(msg);
}

/**
 * Apply a single `-- @no-transaction` migration, recording its
 * `schema_migrations` row in its own tiny txn the instant the body is applied —
 * BEFORE the FK-reassert finally (Wave-1.5 triage #4). If the reassert threw
 * after the record ran after the finally, a non-idempotent @no-transaction
 * migration would be left applied-but-unrecorded, re-running (and corrupting)
 * on the next startup. Recording first keeps the row even if the FK-reassert
 * throws.
 *
 * @param reassertFk seam over the belt-and-braces "re-enable FK enforcement
 *   afterwards" step — injectable so the record-before-reassert ordering is
 *   testable. The default restores FK to ON when the body left it OFF, matching
 *   the prior inline behavior exactly.
 *
 * @internal Exported ONLY so the record-before-reassert ordering is unit-testable
 *   (the throwing-reassert case). Not part of the public DB API — call only from
 *   runMigrations or tests; do not invoke with arbitrary SQL/statements.
 */
export function applyNoTxnMigration(
  db: Database.Database,
  id: string,
  sql: string,
  recordApplied: Database.Statement,
  opts: { reassertFk?: (fkBefore: number) => void } = {},
): void {
  // Outside a transaction so the migration can toggle PRAGMA foreign_keys.
  // The migration body is responsible for restoring FK enforcement before
  // returning. We re-assert ON afterwards as a belt-and-braces guard.
  const fkBefore = db.pragma('foreign_keys', { simple: true }) as number;
  const reassertFk =
    opts.reassertFk ??
    ((before: number): void => {
      if (before && (db.pragma('foreign_keys', { simple: true }) as number) === 0) {
        db.pragma('foreign_keys = ON');
      }
    });
  try {
    try {
      db.exec(sql);
    } catch (err) {
      if (!isSwallowableFirstRun(err)) {
        // Leave FK in whatever state the migration set it to so the
        // operator can inspect, then re-throw (record NOT reached).
        throw err;
      }
      // Swallowable (duplicate column / table exists) — the body is
      // effectively already applied; fall through and record it.
    }
    // Record the migration row in its own tiny txn the instant the body is
    // applied, BEFORE the FK-reassert below.
    db.transaction(() => recordApplied.run(id, Date.now()))();
  } finally {
    reassertFk(fkBefore);
  }
}

function runMigrations(db: Database.Database): void {
  ensureMigrationsTable(db);
  const applied = appliedMigrations(db);
  const dir = locateMigrationsDir();
  const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();

  const recordApplied = db.prepare(
    `INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)`,
  );

  for (const file of files) {
    const id = file.replace(/\.sql$/, '');
    if (applied.has(id)) continue;

    const sql = readFileSync(resolve(dir, file), 'utf-8');
    const optOut = sql.split(/\r?\n/, 5).some((line) => line.trim() === NO_TRANSACTION_DIRECTIVE);

    if (optOut) {
      applyNoTxnMigration(db, id, sql, recordApplied);
    } else {
      db.transaction(() => {
        try {
          db.exec(sql);
        } catch (err) {
          if (!isSwallowableFirstRun(err)) throw err;
        }
        recordApplied.run(id, Date.now());
      })();
    }
    process.stderr.write(`[db] applied migration ${id}\n`);
  }
}
