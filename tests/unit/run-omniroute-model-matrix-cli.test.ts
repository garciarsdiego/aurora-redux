/**
 * Unit tests for the CLI arg parser in run-omniroute-model-matrix.mjs.
 * No network calls — pure argument parsing logic.
 *
 * Run: pnpm vitest run tests/unit/run-omniroute-model-matrix-cli.test.ts
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// Dynamic import of the ESM script so we can extract parseArgs + PROMPTS.
// We use a top-level await via a helper since Vitest supports it in ESM mode.
// To keep this file as .ts (compiled by Vitest's esbuild transform), we import
// via a lazy async fixture.

type ParsedArgs = {
  limit: number;
  freeOnly: boolean;
  providers: string[];
  prompts: string[];
  concurrency: number;
  timeoutS: number;
  resume: boolean;
  help: boolean;
};

type ParseArgsFn = (argv: string[]) => ParsedArgs;
type PromptsMap = Record<string, { id: string; label: string; messages: { role: string; content: string }[] }>;

let parseArgs: ParseArgsFn;
let PROMPTS: PromptsMap;

// Vitest supports top-level await in ESM; load once before all tests.
// We inline a tiny shim so this .ts file stays importable without network.
async function loadModule() {
  // Because the script uses import.meta.url / __dirname we import it directly.
  const mod = await import('../../scripts/run-omniroute-model-matrix.mjs');
  parseArgs = mod.parseArgs as ParseArgsFn;
  PROMPTS = mod.PROMPTS as PromptsMap;
}

// Vitest runs beforeAll at module scope when using top-level await pattern.
// We use a workaround: call loadModule() synchronously via a global before hook.
import { beforeAll } from 'vitest';
beforeAll(async () => {
  await loadModule();
});

// ── Helper: build argv as if called from CLI ──────────────────────────────────
function argv(...flags: string[]): string[] {
  return ['node', 'run-omniroute-model-matrix.mjs', ...flags];
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('parseArgs — defaults', () => {
  it('returns sensible defaults when no flags given', () => {
    const result = parseArgs(argv());
    expect(result.limit).toBe(20);
    expect(result.freeOnly).toBe(false);
    expect(result.providers).toEqual([]);
    expect(result.prompts).toEqual(['fact', 'json', 'summary']);
    expect(result.concurrency).toBe(4);
    expect(result.timeoutS).toBe(60);
    expect(result.resume).toBe(false);
    expect(result.help).toBe(false);
  });
});

describe('parseArgs — --limit', () => {
  it('parses --limit 50', () => {
    expect(parseArgs(argv('--limit', '50')).limit).toBe(50);
  });

  it('clamps nonsense --limit to default 20', () => {
    expect(parseArgs(argv('--limit', 'banana')).limit).toBe(20);
  });

  it('clamps --limit 0 to default 20', () => {
    expect(parseArgs(argv('--limit', '0')).limit).toBe(20);
  });
});

describe('parseArgs — --free-only', () => {
  it('sets freeOnly to true', () => {
    expect(parseArgs(argv('--free-only')).freeOnly).toBe(true);
  });
});

describe('parseArgs — --providers', () => {
  it('splits comma-separated providers', () => {
    expect(parseArgs(argv('--providers', 'cc,cx,kmc')).providers).toEqual(['cc', 'cx', 'kmc']);
  });

  it('trims whitespace around provider names', () => {
    expect(parseArgs(argv('--providers', ' cc , cx ')).providers).toEqual(['cc', 'cx']);
  });

  it('filters empty segments', () => {
    expect(parseArgs(argv('--providers', 'cc,,cx')).providers).toEqual(['cc', 'cx']);
  });

  it('returns empty array for empty string', () => {
    expect(parseArgs(argv('--providers', '')).providers).toEqual([]);
  });
});

describe('parseArgs — --prompts', () => {
  it('accepts a subset of valid prompts', () => {
    expect(parseArgs(argv('--prompts', 'fact,json')).prompts).toEqual(['fact', 'json']);
  });

  it('filters unknown prompt ids', () => {
    expect(parseArgs(argv('--prompts', 'fact,bogus')).prompts).toEqual(['fact']);
  });

  it('falls back to all prompts when all ids are invalid', () => {
    const result = parseArgs(argv('--prompts', 'bogus1,bogus2'));
    expect(result.prompts).toEqual(['fact', 'json', 'summary']);
  });

  it('accepts a single valid prompt', () => {
    expect(parseArgs(argv('--prompts', 'summary')).prompts).toEqual(['summary']);
  });
});

describe('parseArgs — --concurrency', () => {
  it('parses --concurrency 8', () => {
    expect(parseArgs(argv('--concurrency', '8')).concurrency).toBe(8);
  });

  it('clamps invalid concurrency to 4', () => {
    expect(parseArgs(argv('--concurrency', 'abc')).concurrency).toBe(4);
  });
});

describe('parseArgs — --timeout-s', () => {
  it('parses --timeout-s 30', () => {
    expect(parseArgs(argv('--timeout-s', '30')).timeoutS).toBe(30);
  });

  it('clamps invalid timeout to 60', () => {
    expect(parseArgs(argv('--timeout-s', '-1')).timeoutS).toBe(60);
  });
});

describe('parseArgs — --resume', () => {
  it('sets resume to true', () => {
    expect(parseArgs(argv('--resume')).resume).toBe(true);
  });
});

describe('parseArgs — --help', () => {
  it('sets help to true for --help', () => {
    expect(parseArgs(argv('--help')).help).toBe(true);
  });

  it('sets help to true for -h', () => {
    expect(parseArgs(argv('-h')).help).toBe(true);
  });
});

describe('parseArgs — combined flags', () => {
  it('handles multiple flags together', () => {
    const result = parseArgs(
      argv('--limit', '100', '--free-only', '--providers', 'cc,cx', '--concurrency', '8', '--resume')
    );
    expect(result.limit).toBe(100);
    expect(result.freeOnly).toBe(true);
    expect(result.providers).toEqual(['cc', 'cx']);
    expect(result.concurrency).toBe(8);
    expect(result.resume).toBe(true);
  });
});

describe('PROMPTS — structure', () => {
  it('exposes fact, json, summary prompt definitions', () => {
    expect(Object.keys(PROMPTS)).toEqual(expect.arrayContaining(['fact', 'json', 'summary']));
  });

  it('each prompt has id, label, and messages array', () => {
    for (const key of ['fact', 'json', 'summary']) {
      const p = PROMPTS[key];
      expect(p).toBeDefined();
      expect(p.id).toBe(key);
      expect(typeof p.label).toBe('string');
      expect(Array.isArray(p.messages)).toBe(true);
      expect(p.messages.length).toBeGreaterThan(0);
      expect(p.messages[0].role).toBe('user');
      expect(typeof p.messages[0].content).toBe('string');
    }
  });

  it('fact prompt asks for four-digit year', () => {
    expect(PROMPTS.fact.messages[0].content).toMatch(/four digits/i);
  });

  it('json prompt asks for JSON object extraction', () => {
    expect(PROMPTS.json.messages[0].content).toMatch(/JSON object/i);
  });

  it('summary prompt requests under 30 words', () => {
    expect(PROMPTS.summary.messages[0].content).toMatch(/30 words/i);
  });
});
