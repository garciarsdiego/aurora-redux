/**
 * Aurora-parity Wave 0 — diagnostic-drift fixes.
 *   - doctor's migration check now derives the expected count from the
 *     migrations dir (was hardcoded ">=22 as of Sprint 2").
 *   - trace exports stamp the real version (was hardcoded "0.3.0").
 */

import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { countMigrationFiles } from '../../src/db/client.js';
import { omniforgeVersion } from '../../src/v2/observability/tracing.js';

describe('countMigrationFiles — doctor migration source of truth', () => {
  it('matches the real number of shipped migration .sql files', () => {
    const direct = readdirSync(resolve(process.cwd(), 'src/db/migrations')).filter((f) => f.endsWith('.sql')).length;
    expect(countMigrationFiles()).toBe(direct);
  });

  it('is well past the old hardcoded floor of 22', () => {
    const count = countMigrationFiles();
    expect(count).not.toBeNull();
    expect(count as number).toBeGreaterThan(22);
  });
});

describe('omniforgeVersion — trace export version (no longer hardcoded)', () => {
  it('returns a semver-shaped string', () => {
    expect(omniforgeVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('is memoized (stable across calls)', () => {
    expect(omniforgeVersion()).toBe(omniforgeVersion());
  });
});
