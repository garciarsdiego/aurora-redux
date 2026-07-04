// Unit tests for run-harness-eval-matrix.mjs — arg parser and secret scrubber.
// These tests import the named ESM exports; no child processes are spawned.

import { describe, it, expect } from 'vitest';
// Dynamic import is needed because the script is .mjs ESM with top-level side effects gated on main().
const mod = await import('../../scripts/run-harness-eval-matrix.mjs');
const { parseArgs, scrubSecrets } = mod;

describe('scrubSecrets', () => {
  it('redacts sk- API keys', () => {
    const input = 'Error: auth failed with key sk-EXAMPLEKEY00000-redacted-fixture in request';
    expect(scrubSecrets(input)).toBe('Error: auth failed with key [REDACTED-API-KEY] in request');
  });

  it('redacts Bearer tokens', () => {
    const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def';
    expect(scrubSecrets(input)).toBe('Authorization: Bearer [REDACTED]');
  });

  it('redacts multiple secrets in one string', () => {
    const input = 'key=sk-abc12345678901234567 token=Bearer mytoken123=';
    const out = scrubSecrets(input);
    expect(out).toContain('[REDACTED-API-KEY]');
    expect(out).toContain('Bearer [REDACTED]');
    expect(out).not.toContain('sk-abc');
    expect(out).not.toContain('mytoken123');
  });

  it('leaves clean strings unchanged', () => {
    const input = 'Everything looks fine, no secrets here.';
    expect(scrubSecrets(input)).toBe(input);
  });

  it('does not redact short sk- strings below the 20-char threshold', () => {
    // sk- followed by only 10 chars should NOT match
    const input = 'reference sk-short12345 end';
    expect(scrubSecrets(input)).toBe(input);
  });
});

describe('parseArgs', () => {
  it('defaults repeat to 1', () => {
    const opts = parseArgs(['--id', 'T1-FACT-001']);
    expect(opts.repeat).toBe(1);
    expect(opts.id).toBe('T1-FACT-001');
  });

  it('parses --repeat N correctly', () => {
    const opts = parseArgs(['--id', 'T1-FACT-001', '--repeat', '3']);
    expect(opts.repeat).toBe(3);
  });

  it('parses --all and --resume', () => {
    const opts = parseArgs(['--all', '--resume']);
    expect(opts.all).toBe(true);
    expect(opts.resume).toBe(true);
  });

  it('parses --tier and --domain', () => {
    const opts = parseArgs(['--tier', 'T2', '--domain', 'CONTENT']);
    expect(opts.tier).toBe('T2');
    expect(opts.domain).toBe('CONTENT');
  });

  it('parses --dry-run', () => {
    const opts = parseArgs(['--all', '--dry-run']);
    expect(opts.dryRun).toBe(true);
  });
});
