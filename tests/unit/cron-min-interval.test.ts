// M1 / Wave 1-E (A8): minimum-interval guard on schedule cron expressions.
//
// `* * * * *` would fire 1440 times per day even if the operator intended an
// hourly run (typo: dropped the `0` in the minute field). createDashboardSchedule
// must reject this when SCHEDULE_MIN_INTERVAL_SECONDS >= 60 (the default).
//
// Schemas:
//   - Reject `* * * * *` (every minute, current default 60s floor).
//   - Accept `*/5 * * * *` (every 5 min — explicit step beyond the floor).
//   - Accept `0 * * * *` (hourly — bare integer minute field).
//   - Accept `0 9 * * *` (daily at 09:00 — existing happy path).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDb } from '../../src/db/client.js';

const ENV_KEY = 'SCHEDULE_MIN_INTERVAL_SECONDS';

describe('cron min-interval guard', () => {
  const originalEnv = process.env[ENV_KEY];

  beforeEach(() => {
    // Each test mutates the env and re-imports the module so the module-level
    // `const SCHEDULE_MIN_INTERVAL_S = Number(...)` picks up the new value.
    vi.resetModules();
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = originalEnv;
    vi.resetModules();
  });

  it('rejects `* * * * *` (every-minute cron) under the default 60s floor', async () => {
    delete process.env[ENV_KEY];
    const { createDashboardSchedule } = await import('../../src/mcp/dashboard-triggers.js');
    const db = initDb(':memory:');
    try {
      expect(() => createDashboardSchedule(db, {
        name: 'flood',
        workspace: 'internal',
        target_ref: 'Run every minute',
        cron_expression: '* * * * *',
        timezone: 'UTC',
      })).toThrow(/SCHEDULE_MIN_INTERVAL_SECONDS|every minute/i);
    } finally {
      db.close();
    }
  });

  it('accepts `*/5 * * * *` (every five minutes) under the default 60s floor', async () => {
    delete process.env[ENV_KEY];
    const { createDashboardSchedule } = await import('../../src/mcp/dashboard-triggers.js');
    const db = initDb(':memory:');
    try {
      const schedule = createDashboardSchedule(db, {
        name: 'five-min',
        workspace: 'internal',
        target_ref: 'Run every five minutes',
        cron_expression: '*/5 * * * *',
        timezone: 'UTC',
      });
      expect(schedule.cron_expression).toBe('*/5 * * * *');
    } finally {
      db.close();
    }
  });

  it('accepts `0 * * * *` (hourly — minute field is a literal 0)', async () => {
    delete process.env[ENV_KEY];
    const { createDashboardSchedule } = await import('../../src/mcp/dashboard-triggers.js');
    const db = initDb(':memory:');
    try {
      const schedule = createDashboardSchedule(db, {
        name: 'hourly',
        workspace: 'internal',
        target_ref: 'Hourly run',
        cron_expression: '0 * * * *',
        timezone: 'UTC',
      });
      expect(schedule.cron_expression).toBe('0 * * * *');
    } finally {
      db.close();
    }
  });

  it('accepts `0 9 * * *` (daily — preserves existing happy path)', async () => {
    delete process.env[ENV_KEY];
    const { createDashboardSchedule } = await import('../../src/mcp/dashboard-triggers.js');
    const db = initDb(':memory:');
    try {
      const schedule = createDashboardSchedule(db, {
        name: 'daily-summary',
        workspace: 'internal',
        target_ref: 'Summarize yesterday',
        cron_expression: '0 9 * * *',
        timezone: 'UTC',
      });
      expect(schedule.cron_expression).toBe('0 9 * * *');
    } finally {
      db.close();
    }
  });

  it('allows `* * * * *` when the floor is explicitly relaxed to <60s', async () => {
    // Operator opts in by setting the floor below 60 — guard becomes inactive.
    process.env[ENV_KEY] = '30';
    const { createDashboardSchedule } = await import('../../src/mcp/dashboard-triggers.js');
    const db = initDb(':memory:');
    try {
      const schedule = createDashboardSchedule(db, {
        name: 'opted-in-flood',
        workspace: 'internal',
        target_ref: 'Run every minute opted-in',
        cron_expression: '* * * * *',
        timezone: 'UTC',
      });
      expect(schedule.cron_expression).toBe('* * * * *');
    } finally {
      db.close();
    }
  });
});
