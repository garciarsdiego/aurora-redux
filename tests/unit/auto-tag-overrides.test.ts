/**
 * Wave 2.B: dashboard-managed auto-tag overrides — runtime cache + persistence.
 *
 * Covers:
 *   - normalizeAutoTagOverrides drops unknown tags, non-strings, and empty values.
 *   - setRuntimeAutoTagOverrides round-trip through getRuntimeAutoTagOverrides.
 *   - getDashboardAutoTagOverrides + setDashboardAutoTagOverrides persist in
 *     daemon_state and update the runtime cache so subsequent
 *     resolveAutoTag(...) calls observe the change without a restart.
 *   - Empty overrides clear the runtime cache (fall through to env / defaults).
 *   - hydrateAutoTagOverridesFromDb seeds the cache for boot replay.
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AUTO_TAG_DEFAULTS,
  getRuntimeAutoTagOverrides,
  normalizeAutoTagOverrides,
  resolveAutoTag,
  setRuntimeAutoTagOverrides,
} from '../../src/v2/models/auto-tags.js';
import {
  getDashboardAutoTagOverrides,
  hydrateAutoTagOverridesFromDb,
  setDashboardAutoTagOverrides,
} from '../../src/mcp/routes/dashboard-data.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE daemon_state (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  return db;
}

describe('normalizeAutoTagOverrides', () => {
  it('keeps known auto-tag keys with non-empty string values', () => {
    expect(
      normalizeAutoTagOverrides({
        auto: 'cc/claude-sonnet-4-6',
        'auto:strong': 'gemini/gemini-3.1-pro-preview',
      }),
    ).toEqual({
      auto: 'cc/claude-sonnet-4-6',
      'auto:strong': 'gemini/gemini-3.1-pro-preview',
    });
  });

  it('drops unknown keys, non-strings, and empty / whitespace values', () => {
    expect(
      normalizeAutoTagOverrides({
        auto: 'valid',
        unknown: 'ignored',
        'auto:fast': '',
        'auto:strong': '   ',
        'auto:cheap': 42,
        'auto:vision': null,
      }),
    ).toEqual({ auto: 'valid' });
  });

  it('returns {} for non-objects, arrays, and null', () => {
    expect(normalizeAutoTagOverrides(null)).toEqual({});
    expect(normalizeAutoTagOverrides('auto')).toEqual({});
    expect(normalizeAutoTagOverrides(['auto'])).toEqual({});
  });

  it('trims surrounding whitespace from accepted values', () => {
    expect(normalizeAutoTagOverrides({ auto: '  cc/claude-sonnet-4-6  ' })).toEqual({
      auto: 'cc/claude-sonnet-4-6',
    });
  });
});

describe('runtime cache + resolveAutoTag wire', () => {
  beforeEach(() => {
    setRuntimeAutoTagOverrides(null);
  });

  afterEach(() => {
    setRuntimeAutoTagOverrides(null);
  });

  it('round-trips overrides through the runtime cache', () => {
    expect(getRuntimeAutoTagOverrides()).toBeNull();
    setRuntimeAutoTagOverrides({ auto: 'gemini/gemini-3.1-pro-preview' });
    expect(getRuntimeAutoTagOverrides()).toEqual({ auto: 'gemini/gemini-3.1-pro-preview' });
  });

  it('still resolves auto via the explicit overrides argument (cache is opt-in)', () => {
    // The cache is consumed by config.getAutoTagOverrides; resolveAutoTag itself
    // only sees what the caller passes. Confirm both paths behave correctly.
    expect(resolveAutoTag('auto')).toBe(AUTO_TAG_DEFAULTS.auto);
    expect(
      resolveAutoTag('auto', { auto: 'gemini/gemini-3.1-pro-preview' }),
    ).toBe('gemini/gemini-3.1-pro-preview');
  });
});

describe('daemon_state persistence + boot hydration', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
    setRuntimeAutoTagOverrides(null);
  });

  afterEach(() => {
    setRuntimeAutoTagOverrides(null);
    db.close();
  });

  it('persists overrides via setDashboardAutoTagOverrides and updates the cache', () => {
    const saved = setDashboardAutoTagOverrides(db, {
      auto: 'cc/claude-sonnet-4-6',
      bogus: 'ignored',
      'auto:strong': '   ',
    });

    expect(saved).toEqual({ auto: 'cc/claude-sonnet-4-6' });
    // Daemon_state row.
    expect(getDashboardAutoTagOverrides(db)).toEqual({ auto: 'cc/claude-sonnet-4-6' });
    // Runtime cache mirrors the saved value so omniroute-call sees it.
    expect(getRuntimeAutoTagOverrides()).toEqual({ auto: 'cc/claude-sonnet-4-6' });
  });

  it('clears the runtime cache when the operator saves an empty override map', () => {
    setDashboardAutoTagOverrides(db, { auto: 'cc/claude-sonnet-4-6' });
    expect(getRuntimeAutoTagOverrides()).not.toBeNull();

    setDashboardAutoTagOverrides(db, {});
    expect(getRuntimeAutoTagOverrides()).toBeNull();
    expect(getDashboardAutoTagOverrides(db)).toEqual({});
  });

  it('hydrateAutoTagOverridesFromDb seeds the cache from a persisted row', () => {
    setDashboardAutoTagOverrides(db, { 'auto:strong': 'opus-4-6' });
    setRuntimeAutoTagOverrides(null); // simulate a daemon restart

    const hydrated = hydrateAutoTagOverridesFromDb(db);
    expect(hydrated).toEqual({ 'auto:strong': 'opus-4-6' });
    expect(getRuntimeAutoTagOverrides()).toEqual({ 'auto:strong': 'opus-4-6' });
  });

  it('hydrate is a no-op when daemon_state has no row', () => {
    const hydrated = hydrateAutoTagOverridesFromDb(db);
    expect(hydrated).toEqual({});
    expect(getRuntimeAutoTagOverrides()).toBeNull();
  });
});
