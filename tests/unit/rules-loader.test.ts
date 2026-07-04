import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProjectRules, formatRulesForPrompt } from '../../src/v2/rules/loader.js';

describe('loadProjectRules', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rules-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns null when RULES.md does not exist', async () => {
    const result = await loadProjectRules(dir);
    expect(result).toBeNull();
  });

  it('returns ProjectRules with correct fields when RULES.md exists', async () => {
    await writeFile(join(dir, 'RULES.md'), '# Rules\n- no secrets');
    const result = await loadProjectRules(dir);
    expect(result).not.toBeNull();
    expect(result!.raw).toBe('# Rules\n- no secrets');
    expect(result!.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(result!.path).toContain('RULES.md');
    expect(typeof result!.loaded_at).toBe('number');
  });

  it('returns cached entry on cache hit (same mtime)', async () => {
    await writeFile(join(dir, 'RULES.md'), '# Rules\ncached');
    const first = await loadProjectRules(dir);
    const second = await loadProjectRules(dir);
    expect(second).toBe(first); // same object reference
  });

  it('returns new entry on cache miss when mtime changes', async () => {
    const rulesPath = join(dir, 'RULES.md');
    await writeFile(rulesPath, '# Rules\nv1');
    const first = await loadProjectRules(dir);

    // Advance mtime by 2 seconds
    const future = new Date(Date.now() + 2000);
    await writeFile(rulesPath, '# Rules\nv2');
    await utimes(rulesPath, future, future);

    const second = await loadProjectRules(dir);
    expect(second).not.toBe(first);
    expect(second!.raw).toBe('# Rules\nv2');
  });
});

describe('formatRulesForPrompt', () => {
  it('returns empty string when rules is null', () => {
    expect(formatRulesForPrompt(null, 'decomposer')).toBe('');
    expect(formatRulesForPrompt(null, 'reviewer')).toBe('');
  });

  it('uses decomposer prefix', async () => {
    const rules = {
      raw: 'no secrets',
      hash: 'abc',
      path: '/x/RULES.md',
      loaded_at: Date.now(),
    };
    const out = formatRulesForPrompt(rules, 'decomposer');
    expect(out).toContain('PROJECT RULES (binding for DAG decisions):');
    expect(out).toContain('no secrets');
  });

  it('uses reviewer prefix', async () => {
    const rules = {
      raw: 'no secrets',
      hash: 'abc',
      path: '/x/RULES.md',
      loaded_at: Date.now(),
    };
    const out = formatRulesForPrompt(rules, 'reviewer');
    expect(out).toContain('PROJECT RULES (apply as additional acceptance criteria):');
    expect(out).toContain('no secrets');
  });
});
