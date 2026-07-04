import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSkillContent } from '../../src/v2/skills/parser.js';
import { matchSkills } from '../../src/v2/skills/matcher.js';
import {
  registerSkill,
  resolveSkill,
  listSkills,
  recordWin,
  getWinCount,
  isCaptured,
  listCapturedSkills,
  loadSkillsFromDir,
  CAPTURE_THRESHOLD,
  _resetRegistry,
} from '../../src/v2/skills/registry.js';
import {
  applySkillExecutionMode,
  applyBestSkillExecutionMode,
} from '../../src/v2/skills/apply-to-dag.js';
import type { SkillDefinition } from '../../src/v2/skills/types.js';
import type { Dag, DagTask } from '../../src/types/index.js';

// ---------------------------------------------------------------------------
// Parser — parseSkillContent
// ---------------------------------------------------------------------------

const FULL_SKILL_MD = `---
name: code-review
description: Reviews code for quality and security issues
trigger_when:
  - review code
  - check security
  - code quality
examples:
  - Review my pull request
  - Check this code for vulnerabilities
---
Body content here.
`;

describe('parseSkillContent — valid frontmatter', () => {
  it('parses name, description, trigger_when and examples', () => {
    const skill = parseSkillContent(FULL_SKILL_MD);
    expect(skill.name).toBe('code-review');
    expect(skill.description).toBe('Reviews code for quality and security issues');
    expect(skill.trigger_when).toEqual(['review code', 'check security', 'code quality']);
    expect(skill.examples).toEqual(['Review my pull request', 'Check this code for vulnerabilities']);
  });

  it('parses minimal frontmatter (name + description only)', () => {
    const content = `---\nname: minimal\ndescription: minimal desc\n---\n`;
    const skill = parseSkillContent(content);
    expect(skill.name).toBe('minimal');
    expect(skill.trigger_when).toEqual([]);
    expect(skill.examples).toEqual([]);
  });

  it('attaches filePath when provided', () => {
    const content = `---\nname: pathtest\ndescription: test\n---\n`;
    const skill = parseSkillContent(content, '/skills/pathtest.skill.md');
    expect(skill.filePath).toBe('/skills/pathtest.skill.md');
  });

  it('omits filePath when not provided', () => {
    const content = `---\nname: nopath\ndescription: test\n---\n`;
    const skill = parseSkillContent(content);
    expect('filePath' in skill).toBe(false);
  });

  it('throws when frontmatter delimiters are absent', () => {
    expect(() => parseSkillContent('No frontmatter here.')).toThrow(/frontmatter/i);
  });

  it('throws when name field is missing', () => {
    const content = `---\ndescription: missing name\n---\n`;
    expect(() => parseSkillContent(content)).toThrow(/name/i);
  });

  it('accepts single string for trigger_when (scalar → array)', () => {
    const content = `---\nname: single-trigger\ndescription: test\ntrigger_when: run tests\n---\n`;
    const skill = parseSkillContent(content);
    expect(skill.trigger_when).toEqual(['run tests']);
  });
});

// ---------------------------------------------------------------------------
// Matcher — matchSkills
// ---------------------------------------------------------------------------

const SKILLS: SkillDefinition[] = [
  {
    name: 'code-review',
    description: 'Review code for quality',
    trigger_when: ['review code', 'code quality'],
    examples: ['Review my PR', 'Check my code'],
    execution_mode: 'ephemeral',
  },
  {
    name: 'deploy',
    description: 'Deploy application to production',
    trigger_when: ['deploy app', 'push to production'],
    examples: ['Deploy to staging', 'Release to prod'],
    execution_mode: 'ephemeral',
  },
  {
    name: 'test-runner',
    description: 'Run tests and report failures',
    trigger_when: ['run tests', 'test suite'],
    examples: ['Execute unit tests', 'Run the test suite'],
    execution_mode: 'ephemeral',
  },
];

describe('matchSkills — keyword overlap', () => {
  it('returns best-matching skill first', () => {
    const results = matchSkills('please review my code quality', SKILLS);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.skill.name).toBe('code-review');
  });

  it('returns empty array when no token overlaps', () => {
    const results = matchSkills('foobar baz quux zzzz', SKILLS);
    expect(results).toHaveLength(0);
  });

  it('only returns skills with score > 0', () => {
    const results = matchSkills('deploy to production environment', SKILLS);
    expect(results.every((r) => r.score > 0)).toBe(true);
  });

  it('score equals matched token count', () => {
    const results = matchSkills('run tests and test suite now', SKILLS);
    const runner = results.find((r) => r.skill.name === 'test-runner');
    expect(runner).toBeDefined();
    expect(runner!.score).toBeGreaterThanOrEqual(2);
    expect(runner!.matchedTokens.length).toBe(runner!.score);
  });

  it('results are sorted descending by score', () => {
    const results = matchSkills('review code quality run tests', SKILLS);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score);
    }
  });
});

// ---------------------------------------------------------------------------
// Registry — registerSkill, resolveSkill, listSkills, capture threshold
// ---------------------------------------------------------------------------

function makeSkill(name: string): SkillDefinition {
  return { name, description: `${name} description`, trigger_when: [], examples: [], execution_mode: 'ephemeral' };
}

describe('SkillRegistry — basics', () => {
  beforeEach(() => _resetRegistry());

  it('registerSkill + resolveSkill round-trips', () => {
    registerSkill(makeSkill('my-skill'));
    expect(resolveSkill('my-skill')!.name).toBe('my-skill');
  });

  it('resolveSkill returns undefined for unknown name', () => {
    expect(resolveSkill('ghost-skill')).toBeUndefined();
  });

  it('listSkills returns all registered skills', () => {
    registerSkill(makeSkill('alpha'));
    registerSkill(makeSkill('beta'));
    const names = listSkills().map((s) => s.name);
    expect(names).toContain('alpha');
    expect(names).toContain('beta');
  });

  it('re-registering same name overwrites the entry', () => {
    registerSkill({ name: 'dup', description: 'first', trigger_when: [], examples: [], execution_mode: 'ephemeral' });
    registerSkill({ name: 'dup', description: 'second', trigger_when: [], examples: [], execution_mode: 'ephemeral' });
    expect(resolveSkill('dup')!.description).toBe('second');
    expect(listSkills().filter((s) => s.name === 'dup')).toHaveLength(1);
  });
});

describe('SkillRegistry — capture threshold', () => {
  beforeEach(() => _resetRegistry());

  it(`CAPTURE_THRESHOLD is ${CAPTURE_THRESHOLD}`, () => {
    expect(CAPTURE_THRESHOLD).toBe(3);
  });

  it('getWinCount starts at 0', () => {
    registerSkill(makeSkill('zero'));
    expect(getWinCount('zero')).toBe(0);
  });

  it('recordWin increments getWinCount', () => {
    registerSkill(makeSkill('incr'));
    recordWin('incr');
    recordWin('incr');
    expect(getWinCount('incr')).toBe(2);
  });

  it('skill is NOT captured with fewer than 3 wins', () => {
    registerSkill(makeSkill('under'));
    recordWin('under');
    recordWin('under');
    expect(isCaptured('under')).toBe(false);
  });

  it('skill IS captured after exactly 3 wins', () => {
    registerSkill(makeSkill('exact'));
    for (let i = 0; i < CAPTURE_THRESHOLD; i++) recordWin('exact');
    expect(isCaptured('exact')).toBe(true);
  });

  it('skill remains captured after more than 3 wins', () => {
    registerSkill(makeSkill('over'));
    for (let i = 0; i < 5; i++) recordWin('over');
    expect(isCaptured('over')).toBe(true);
  });

  it('listCapturedSkills includes only captured skills', () => {
    registerSkill(makeSkill('cap'));
    registerSkill(makeSkill('nocap'));
    for (let i = 0; i < CAPTURE_THRESHOLD; i++) recordWin('cap');
    const names = listCapturedSkills().map((s) => s.name);
    expect(names).toContain('cap');
    expect(names).not.toContain('nocap');
  });

  it('win counter works for unregistered skill name (recordWin is name-keyed)', () => {
    recordWin('phantom');
    recordWin('phantom');
    recordWin('phantom');
    expect(isCaptured('phantom')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FASE 1B Bloco A.3 — execution_mode in frontmatter
// ---------------------------------------------------------------------------

describe('parseSkillContent — execution_mode', () => {
  it('defaults to ephemeral when frontmatter omits execution_mode', () => {
    const content = `---\nname: no-mode\ndescription: test\n---\n`;
    const skill = parseSkillContent(content);
    expect(skill.execution_mode).toBe('ephemeral');
  });

  it("parses explicit 'adaptive' correctly", () => {
    const content = `---\nname: adaptive-skill\ndescription: test\nexecution_mode: adaptive\n---\n`;
    const skill = parseSkillContent(content);
    expect(skill.execution_mode).toBe('adaptive');
  });

  it("parses explicit 'ephemeral' correctly", () => {
    const content = `---\nname: ephemeral-skill\ndescription: test\nexecution_mode: ephemeral\n---\n`;
    const skill = parseSkillContent(content);
    expect(skill.execution_mode).toBe('ephemeral');
  });

  it('throws on invalid string execution_mode containing the value and field name', () => {
    const content = `---\nname: bad-mode\ndescription: test\nexecution_mode: weird\n---\n`;
    expect(() => parseSkillContent(content)).toThrow(/execution_mode/);
    expect(() => parseSkillContent(content)).toThrow(/weird/);
  });

  it('throws on non-string execution_mode (e.g. numeric 123)', () => {
    const content = `---\nname: bad-type\ndescription: test\nexecution_mode: 123\n---\n`;
    expect(() => parseSkillContent(content)).toThrow(/execution_mode/);
  });

  it('includes filePath in error message for invalid execution_mode', () => {
    const content = `---\nname: bad-mode-path\ndescription: test\nexecution_mode: nope\n---\n`;
    expect(() => parseSkillContent(content, '/skills/bad.md')).toThrow(/\/skills\/bad\.md/);
  });
});

// ---------------------------------------------------------------------------
// FASE 1B Bloco A.3 — applySkillExecutionMode
// ---------------------------------------------------------------------------

function makeDagTask(id: string, overrides: Partial<DagTask> = {}): DagTask {
  return {
    id,
    name: `Task ${id}`,
    kind: 'llm_call',
    depends_on: [],
    ...overrides,
  };
}

describe('applySkillExecutionMode', () => {
  it("sets execution_mode on all tasks when skill is 'adaptive'", () => {
    const dag: Dag = { tasks: [makeDagTask('t1'), makeDagTask('t2')] };
    const skill: SkillDefinition = {
      name: 'adaptive-skill',
      description: 'test',
      trigger_when: [],
      examples: [],
      execution_mode: 'adaptive',
    };
    const result = applySkillExecutionMode(dag, skill);
    expect(result.tasks[0]!.execution_mode).toBe('adaptive');
    expect(result.tasks[1]!.execution_mode).toBe('adaptive');
  });

  it('preserves an explicit task-level execution_mode over the skill default', () => {
    const dag: Dag = {
      tasks: [
        makeDagTask('t1', { execution_mode: 'ephemeral' }),
        makeDagTask('t2'),
      ],
    };
    const skill: SkillDefinition = {
      name: 'adaptive-skill',
      description: 'test',
      trigger_when: [],
      examples: [],
      execution_mode: 'adaptive',
    };
    const result = applySkillExecutionMode(dag, skill);
    // t1 has explicit ephemeral — must not be overwritten
    expect(result.tasks[0]!.execution_mode).toBe('ephemeral');
    // t2 has no explicit mode — inherits skill's adaptive
    expect(result.tasks[1]!.execution_mode).toBe('adaptive');
  });

  it('does not mutate the input dag (immutability)', () => {
    const originalTask = makeDagTask('t1');
    const dag: Dag = { tasks: [originalTask] };
    const skill: SkillDefinition = {
      name: 'adaptive-skill',
      description: 'test',
      trigger_when: [],
      examples: [],
      execution_mode: 'adaptive',
    };
    const result = applySkillExecutionMode(dag, skill);
    // returned task object is a new object
    expect(result.tasks[0]).not.toBe(originalTask);
    // original task is unchanged
    expect(originalTask.execution_mode).toBeUndefined();
    // returned dag is a new object
    expect(result).not.toBe(dag);
  });
});

// ---------------------------------------------------------------------------
// FASE 1B Bloco A.3 wire-up — loadSkillsFromDir + applyBestSkillExecutionMode
// (R-HIGH-2 fix from Opus review of A.2/A.3)
// ---------------------------------------------------------------------------

describe('loadSkillsFromDir', () => {
  let tempDir: string;

  beforeEach(() => {
    _resetRegistry();
    tempDir = mkdtempSync(join(tmpdir(), 'omniforge-skills-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns empty array when dir does not exist', () => {
    const loaded = loadSkillsFromDir(join(tempDir, 'no-such-dir'));
    expect(loaded).toEqual([]);
    expect(listSkills()).toHaveLength(0);
  });

  it('returns empty array when dir has no SKILL.md files', () => {
    mkdirSync(join(tempDir, 'just-a-dir'), { recursive: true });
    const loaded = loadSkillsFromDir(tempDir);
    expect(loaded).toEqual([]);
  });

  it('loads valid SKILL.md files into the registry', () => {
    mkdirSync(join(tempDir, 'skill-a'), { recursive: true });
    writeFileSync(
      join(tempDir, 'skill-a', 'SKILL.md'),
      `---\nname: alpha\ndescription: First skill\nexecution_mode: adaptive\n---\n`,
    );
    mkdirSync(join(tempDir, 'skill-b'), { recursive: true });
    writeFileSync(
      join(tempDir, 'skill-b', 'SKILL.md'),
      `---\nname: beta\ndescription: Second skill\n---\n`,
    );

    const loaded = loadSkillsFromDir(tempDir);
    expect(loaded).toHaveLength(2);
    expect(loaded.map((s) => s.name).sort()).toEqual(['alpha', 'beta']);
    expect(resolveSkill('alpha')?.execution_mode).toBe('adaptive');
    expect(resolveSkill('beta')?.execution_mode).toBe('ephemeral');
  });

  it('skips invalid SKILL.md files but still loads the rest', () => {
    mkdirSync(join(tempDir, 'broken'), { recursive: true });
    writeFileSync(join(tempDir, 'broken', 'SKILL.md'), 'no frontmatter here');
    mkdirSync(join(tempDir, 'good'), { recursive: true });
    writeFileSync(
      join(tempDir, 'good', 'SKILL.md'),
      `---\nname: good\ndescription: Good\n---\n`,
    );

    const loaded = loadSkillsFromDir(tempDir);
    expect(loaded.map((s) => s.name)).toEqual(['good']);
  });

  it('is idempotent — re-running overwrites existing entries', () => {
    mkdirSync(join(tempDir, 'skill-a'), { recursive: true });
    writeFileSync(
      join(tempDir, 'skill-a', 'SKILL.md'),
      `---\nname: alpha\ndescription: v1\n---\n`,
    );
    loadSkillsFromDir(tempDir);
    expect(resolveSkill('alpha')?.description).toBe('v1');

    writeFileSync(
      join(tempDir, 'skill-a', 'SKILL.md'),
      `---\nname: alpha\ndescription: v2\n---\n`,
    );
    loadSkillsFromDir(tempDir);
    expect(resolveSkill('alpha')?.description).toBe('v2');
    expect(listSkills()).toHaveLength(1);
  });
});

describe('applyBestSkillExecutionMode', () => {
  beforeEach(() => {
    _resetRegistry();
  });

  function dag(): Dag {
    return {
      tasks: [
        { id: 't1', name: 'task one', kind: 'llm_call', depends_on: [] } as DagTask,
        { id: 't2', name: 'task two', kind: 'llm_call', depends_on: ['t1'] } as DagTask,
      ],
    };
  }

  it('returns dag unchanged when no skills are registered', () => {
    const input = dag();
    const result = applyBestSkillExecutionMode(input, 'anything goes here');
    expect(result.dag).toBe(input); // identity — no copy
    expect(result.matchedSkill).toBeUndefined();
  });

  it('applies matched skill execution_mode when score >= threshold', () => {
    registerSkill({
      name: 'project-creation',
      description: 'Creates new projects with full scaffolding',
      trigger_when: ['create new project', 'scaffold project', 'bootstrap project'],
      examples: ['create new project for client X'],
      execution_mode: 'adaptive',
    });

    const result = applyBestSkillExecutionMode(
      dag(),
      'create new project for client Y with full scaffolding',
    );
    expect(result.matchedSkill?.name).toBe('project-creation');
    expect(result.matchScore).toBeGreaterThanOrEqual(3);
    for (const t of result.dag.tasks) {
      expect(t.execution_mode).toBe('adaptive');
    }
  });

  it('respects threshold — low-overlap objective returns dag unchanged', () => {
    registerSkill({
      name: 'highly-specific',
      description: 'Does one specific arcane thing',
      trigger_when: ['arcane'],
      examples: [],
      execution_mode: 'adaptive',
    });
    const input = dag();
    const result = applyBestSkillExecutionMode(input, 'unrelated boring objective');
    expect(result.matchedSkill).toBeUndefined();
    expect(result.dag).toBe(input);
  });

  it('explicit task-level execution_mode wins over skill default', () => {
    registerSkill({
      name: 'adaptive-default',
      description: 'Sets adaptive as default',
      trigger_when: ['triggers some words'],
      examples: ['trigger words'],
      execution_mode: 'adaptive',
    });

    const input: Dag = {
      tasks: [
        { id: 't1', name: 'override', kind: 'llm_call', depends_on: [], execution_mode: 'ephemeral' } as DagTask,
        { id: 't2', name: 'default', kind: 'llm_call', depends_on: ['t1'] } as DagTask,
      ],
    };

    const result = applyBestSkillExecutionMode(input, 'triggers some words and more');
    expect(result.matchedSkill?.name).toBe('adaptive-default');
    expect(result.dag.tasks[0].execution_mode).toBe('ephemeral'); // explicit kept
    expect(result.dag.tasks[1].execution_mode).toBe('adaptive'); // skill applied
  });
});

// ---------------------------------------------------------------------------
// research-multimodel SKILL.md — parse + applyBestSkillExecutionMode
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const _testDir: string = import.meta.dirname ?? join(fileURLToPath(import.meta.url), '..');

const RESEARCH_MULTIMODEL_PATH = join(_testDir, '../fixtures/skills/research-multimodel/SKILL.md');

describe('research-multimodel SKILL.md — parse', () => {
  let skillContent: string;

  beforeEach(() => {
    skillContent = readFileSync(RESEARCH_MULTIMODEL_PATH, 'utf8');
  });

  it('parses without throwing', () => {
    expect(() => parseSkillContent(skillContent, RESEARCH_MULTIMODEL_PATH)).not.toThrow();
  });

  it("has name='research-multimodel'", () => {
    const skill = parseSkillContent(skillContent, RESEARCH_MULTIMODEL_PATH);
    expect(skill.name).toBe('research-multimodel');
  });

  it("has execution_mode='ephemeral'", () => {
    const skill = parseSkillContent(skillContent, RESEARCH_MULTIMODEL_PATH);
    expect(skill.execution_mode).toBe('ephemeral');
  });

  it('trigger_when contains Portuguese triggers', () => {
    const skill = parseSkillContent(skillContent, RESEARCH_MULTIMODEL_PATH);
    expect(skill.trigger_when).toContain('auditar');
    expect(skill.trigger_when).toContain('pesquisar');
    expect(skill.trigger_when).toContain('investigar');
    expect(skill.trigger_when).toContain('avaliar');
    expect(skill.trigger_when).toContain('consenso');
  });

  it('trigger_when contains English triggers', () => {
    const skill = parseSkillContent(skillContent, RESEARCH_MULTIMODEL_PATH);
    expect(skill.trigger_when).toContain('audit');
    expect(skill.trigger_when).toContain('research');
    expect(skill.trigger_when).toContain('investigate');
    expect(skill.trigger_when).toContain('evaluate');
    expect(skill.trigger_when).toContain('consensus');
    expect(skill.trigger_when).toContain('cross-check');
    expect(skill.trigger_when).toContain('multiple perspectives');
  });

  it('has at least 4 examples', () => {
    const skill = parseSkillContent(skillContent, RESEARCH_MULTIMODEL_PATH);
    expect(skill.examples.length).toBeGreaterThanOrEqual(4);
  });
});

describe('research-multimodel — applyBestSkillExecutionMode integration', () => {
  beforeEach(() => {
    _resetRegistry();
    const content = readFileSync(RESEARCH_MULTIMODEL_PATH, 'utf8');
    const skill = parseSkillContent(content, RESEARCH_MULTIMODEL_PATH);
    registerSkill(skill);
  });

  function makeDag(): Dag {
    return {
      tasks: [
        { id: 't0', name: 'plan', kind: 'llm_call', depends_on: [] } as DagTask,
        { id: 't1', name: 'execute', kind: 'cli_spawn', depends_on: ['t0'] } as DagTask,
      ],
    };
  }

  it('"auditar o src/ diretório" matches research-multimodel with execution_mode=ephemeral (minScore=1)', () => {
    // "auditar" is in trigger_when → score=1; lower threshold to confirm match
    const result = applyBestSkillExecutionMode(makeDag(), 'auditar o src/ diretório', { minScore: 1 });
    expect(result.matchedSkill).toBeDefined();
    expect(result.matchedSkill!.name).toBe('research-multimodel');
    expect(result.matchedSkill!.execution_mode).toBe('ephemeral');
    for (const t of result.dag.tasks) {
      expect(t.execution_mode).toBe('ephemeral');
    }
  });

  it('"audit research investigate consensus" matches research-multimodel at default minScore=3', () => {
    // 4 tokens (audit, research, investigate, consensus) appear in trigger_when → score >= 3
    const result = applyBestSkillExecutionMode(makeDag(), 'audit research investigate consensus');
    expect(result.matchedSkill).toBeDefined();
    expect(result.matchedSkill!.name).toBe('research-multimodel');
    expect(result.matchedSkill!.execution_mode).toBe('ephemeral');
  });

  it('"audit security vulnerabilities" matches research-multimodel', () => {
    const result = applyBestSkillExecutionMode(makeDag(), 'audit security vulnerabilities in src/');
    expect(result.matchedSkill?.name).toBe('research-multimodel');
  });

  it('"research the best Postgres strategy" matches research-multimodel', () => {
    const result = applyBestSkillExecutionMode(makeDag(), 'research the best Postgres migration strategy');
    expect(result.matchedSkill?.name).toBe('research-multimodel');
  });

  it('unrelated objective does not match research-multimodel', () => {
    const result = applyBestSkillExecutionMode(makeDag(), 'build a landing page with React');
    expect(result.matchedSkill).toBeUndefined();
  });
});
