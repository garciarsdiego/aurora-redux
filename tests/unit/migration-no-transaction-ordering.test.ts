// Wave-1.5 triage #4 — `-- @no-transaction` migrations record their
// `schema_migrations` row BEFORE the FK-reassert finally, so a throw during the
// reassert can never leave the migration applied-but-unrecorded (which would
// re-run, and potentially corrupt, on the next startup). This exercises the
// injectable `applyNoTxnMigration` seam directly: the runMigrations path reads
// .sql off disk and offers no hook, so the ordering was previously untestable.
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { applyNoTxnMigration } from '../../src/db/client.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`);
  return db;
}

function recordAppliedStmt(db: Database.Database): Database.Statement {
  return db.prepare(
    `INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)`,
  );
}

function isRecorded(db: Database.Database, id: string): boolean {
  return db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(id) !== undefined;
}

describe('applyNoTxnMigration — record-before-reassert ordering', () => {
  it('records the migration row even when the FK-reassert hook throws', () => {
    const db = freshDb();
    const id = '900_ordering_probe';

    // The reassert hook throws AFTER the body applied. The error still
    // propagates out of the helper (it runs in a `finally`), so we catch it and
    // then assert the schema_migrations row was already persisted — the proof
    // that the record runs BEFORE the reassert.
    expect(() =>
      applyNoTxnMigration(
        db,
        id,
        `CREATE TABLE ordering_probe (id INTEGER PRIMARY KEY);`,
        recordAppliedStmt(db),
        {
          reassertFk: () => {
            throw new Error('FK reassert blew up');
          },
        },
      ),
    ).toThrow('FK reassert blew up');

    expect(isRecorded(db, id)).toBe(true);
    // The body genuinely applied too — the probe table exists.
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ordering_probe'").get(),
    ).toBeDefined();

    db.close();
  });

  it('happy path: applies the body, records the row, runs the FK reassert once', () => {
    const db = freshDb();
    const id = '901_happy_probe';
    let reassertCalls = 0;
    let observedFkBefore: number | undefined;

    applyNoTxnMigration(
      db,
      id,
      `CREATE TABLE happy_probe (id INTEGER PRIMARY KEY);`,
      recordAppliedStmt(db),
      {
        reassertFk: (fkBefore) => {
          reassertCalls++;
          observedFkBefore = fkBefore;
        },
      },
    );

    expect(isRecorded(db, id)).toBe(true);
    expect(reassertCalls).toBe(1);
    // FK enforcement was ON when the migration started (set in freshDb()).
    expect(observedFkBefore).toBe(1);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='happy_probe'").get(),
    ).toBeDefined();

    db.close();
  });

  it('does NOT record the row when the body throws a non-swallowable error', () => {
    const db = freshDb();
    const id = '902_bad_probe';

    expect(() =>
      applyNoTxnMigration(
        db,
        id,
        // Syntactically invalid SQL → real failure, must propagate and NOT record.
        `THIS IS NOT VALID SQL;`,
        recordAppliedStmt(db),
        { reassertFk: () => {} },
      ),
    ).toThrow();

    expect(isRecorded(db, id)).toBe(false);
    db.close();
  });

  it('records the row for a swallowable duplicate-column body (idempotent re-apply)', () => {
    const db = freshDb();
    const id = '903_dup_probe';

    // Pre-create the column the body tries to add so the body throws a
    // swallowable "duplicate column" error — the helper must treat the
    // migration as already-applied and still record it.
    db.exec(`CREATE TABLE dup_probe (id INTEGER PRIMARY KEY, extra TEXT);`);

    applyNoTxnMigration(
      db,
      id,
      `ALTER TABLE dup_probe ADD COLUMN extra TEXT;`,
      recordAppliedStmt(db),
      { reassertFk: () => {} },
    );

    expect(isRecorded(db, id)).toBe(true);
    db.close();
  });

  it('default reassertFk re-enables FK enforcement when the body left it OFF', () => {
    const db = freshDb();
    const id = '904_fk_toggle_probe';

    // FK enforcement is ON before the migration (freshDb). The body turns it
    // OFF (the reason @no-transaction exists — SQLite ignores the PRAGMA inside
    // a txn). With NO injected reassertFk, the default belt-and-braces guard
    // must restore it to ON — matching the prior inline behavior exactly.
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    applyNoTxnMigration(
      db,
      id,
      `PRAGMA foreign_keys = OFF;
       CREATE TABLE fk_toggle_probe (id INTEGER PRIMARY KEY);`,
      recordAppliedStmt(db),
      // no reassertFk → default path
    );

    expect(isRecorded(db, id)).toBe(true);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1); // restored to ON
    db.close();
  });
});
