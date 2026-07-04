/**
 * CLI argument parser tests for scripts/aggregate-matrix-cost.mjs
 * No DB or filesystem access — pure unit tests of the arg-parsing logic.
 */

import { describe, it, expect } from 'vitest';

// Mirror of parseArgs() from the script (kept in sync manually)
function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const result = {
    runId: null as string | null,
    all20260523: false,
    since: null as string | null,
    json: false,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--run-id' && args[i + 1]) {
      result.runId = args[++i];
    } else if (args[i] === '--all-2026-05-23') {
      result.all20260523 = true;
    } else if (args[i] === '--since' && args[i + 1]) {
      result.since = args[++i];
    } else if (args[i] === '--json') {
      result.json = true;
    }
  }
  return result;
}

// Simulate process.argv prefix
const base = ['node', 'aggregate-matrix-cost.mjs'];

describe('aggregate-matrix-cost arg parser', () => {
  it('parses --run-id', () => {
    const r = parseArgs([...base, '--run-id', 'harness-eval-1779559639035']);
    expect(r.runId).toBe('harness-eval-1779559639035');
    expect(r.all20260523).toBe(false);
    expect(r.since).toBeNull();
    expect(r.json).toBe(false);
  });

  it('parses --all-2026-05-23', () => {
    const r = parseArgs([...base, '--all-2026-05-23']);
    expect(r.all20260523).toBe(true);
    expect(r.runId).toBeNull();
  });

  it('parses --since with a date', () => {
    const r = parseArgs([...base, '--since', '2026-05-22']);
    expect(r.since).toBe('2026-05-22');
    expect(r.all20260523).toBe(false);
  });

  it('parses --json flag', () => {
    const r = parseArgs([...base, '--run-id', 'harness-eval-123', '--json']);
    expect(r.json).toBe(true);
    expect(r.runId).toBe('harness-eval-123');
  });

  it('returns all-null result for empty args', () => {
    const r = parseArgs([...base]);
    expect(r.runId).toBeNull();
    expect(r.all20260523).toBe(false);
    expect(r.since).toBeNull();
    expect(r.json).toBe(false);
  });

  it('--run-id without value is ignored', () => {
    const r = parseArgs([...base, '--run-id']);
    expect(r.runId).toBeNull();
  });

  it('--since without value is ignored', () => {
    const r = parseArgs([...base, '--since']);
    expect(r.since).toBeNull();
  });

  it('--json can appear before other flags', () => {
    const r = parseArgs([...base, '--json', '--all-2026-05-23']);
    expect(r.json).toBe(true);
    expect(r.all20260523).toBe(true);
  });
});
