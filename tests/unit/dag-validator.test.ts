import { describe, it, expect } from 'vitest';
import { validateDag, type ValidationResult } from '../../src/brain/dag-validator.js';
import type { Dag } from '../../src/types/index.js';

// Helper: build a linear chain of n tasks (t1 → t2 → ... → tn)
function linearChain(n: number): Dag {
  return {
    tasks: Array.from({ length: n }, (_, i) => ({
      id: `t${i + 1}`,
      name: `task ${i + 1}`,
      kind: 'llm_call' as const,
      depends_on: i === 0 ? [] : [`t${i}`],
      executor_hint: null,
      model: null,
    })),
  };
}

// Helper: build n independent tasks (no dependencies)
function parallelTasks(n: number): Dag {
  return {
    tasks: Array.from({ length: n }, (_, i) => ({
      id: `t${i + 1}`,
      name: `task ${i + 1}`,
      kind: 'llm_call' as const,
      depends_on: [],
      executor_hint: null,
      model: null,
    })),
  };
}

function hasError(result: ValidationResult, rule: string): boolean {
  return result.issues.some(i => i.rule === rule && i.severity === 'error');
}

function hasWarn(result: ValidationResult, rule: string): boolean {
  return result.issues.some(i => i.rule === rule && i.severity === 'warn');
}

// ---------------------------------------------------------------------------
// max-chain-length
// ---------------------------------------------------------------------------

describe('validateDag — max-chain-length', () => {
  it('chain of 1 task → valid', () => {
    const result = validateDag(linearChain(1));
    expect(result.valid).toBe(true);
    expect(hasError(result, 'max-chain-length')).toBe(false);
  });

  it('chain of 6 tasks → valid (well under limit)', () => {
    const result = validateDag(linearChain(6));
    expect(result.valid).toBe(true);
    expect(hasError(result, 'max-chain-length')).toBe(false);
  });

  it('chain of 7 tasks → valid (at the limit)', () => {
    const result = validateDag(linearChain(7));
    expect(result.valid).toBe(true);
    expect(hasError(result, 'max-chain-length')).toBe(false);
  });

  it('chain of 10 tasks → valid (at the limit)', () => {
    const result = validateDag(linearChain(10));
    expect(hasError(result, 'max-chain-length')).toBe(false);
  });

  it('chain of 11 tasks → error max-chain-length', () => {
    const result = validateDag(linearChain(11));
    expect(result.valid).toBe(false);
    expect(hasError(result, 'max-chain-length')).toBe(true);
  });

  it('chain of 12 tasks → error mentions chain length of 12', () => {
    const result = validateDag(linearChain(12));
    expect(result.valid).toBe(false);
    const issue = result.issues.find(i => i.rule === 'max-chain-length');
    expect(issue?.message).toContain('12');
  });

  it('fan-out: 1 upstream + 3 parallel children → valid (chain = 2)', () => {
    const dag: Dag = {
      tasks: [
        { id: 'up', name: 'upstream', kind: 'llm_call', depends_on: [], executor_hint: null, model: null },
        { id: 'c1', name: 'child1', kind: 'llm_call', depends_on: ['up'], executor_hint: null, model: null },
        { id: 'c2', name: 'child2', kind: 'llm_call', depends_on: ['up'], executor_hint: null, model: null },
        { id: 'c3', name: 'child3', kind: 'llm_call', depends_on: ['up'], executor_hint: null, model: null },
      ],
    };
    const result = validateDag(dag);
    expect(hasError(result, 'max-chain-length')).toBe(false);
  });

  it('diamond (A→B, A→C, B→D, C→D) → valid (chain = 3)', () => {
    const dag: Dag = {
      tasks: [
        { id: 'A', name: 'A', kind: 'llm_call', depends_on: [], executor_hint: null, model: null },
        { id: 'B', name: 'B', kind: 'llm_call', depends_on: ['A'], executor_hint: null, model: null },
        { id: 'C', name: 'C', kind: 'llm_call', depends_on: ['A'], executor_hint: null, model: null },
        { id: 'D', name: 'D', kind: 'llm_call', depends_on: ['B', 'C'], executor_hint: null, model: null },
      ],
    };
    const result = validateDag(dag);
    expect(hasError(result, 'max-chain-length')).toBe(false);
  });

  it('parallel tasks (no deps) → chain = 1, always valid', () => {
    const result = validateDag(parallelTasks(10));
    expect(hasError(result, 'max-chain-length')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// graph-integrity
// ---------------------------------------------------------------------------

describe('validateDag — graph-integrity', () => {
  function task(id: string, depends_on: string[] = []): Dag['tasks'][number] {
    return {
      id,
      name: `task ${id}`,
      kind: 'llm_call',
      depends_on,
      executor_hint: null,
      model: null,
      acceptance_criteria: 'Valid JSON object with field result string and explicit completion status',
    };
  }

  it('rejects a dependency that does not reference an existing task id', () => {
    const result = validateDag({ tasks: [task('t1', ['missing'])] });

    expect(result.valid).toBe(false);
    expect(hasError(result, 'graph-integrity')).toBe(true);
    expect(result.issues.find(i => i.rule === 'graph-integrity')?.message).toContain('missing');
  });

  it('rejects duplicate task ids before execution remaps DAG ids', () => {
    const result = validateDag({ tasks: [task('dup'), task('dup')] });

    expect(result.valid).toBe(false);
    expect(hasError(result, 'graph-integrity')).toBe(true);
    expect(result.issues.find(i => i.rule === 'graph-integrity')?.message).toContain('Duplicate');
  });

  it('rejects self-dependencies', () => {
    const result = validateDag({ tasks: [task('t1', ['t1'])] });

    expect(result.valid).toBe(false);
    expect(hasError(result, 'graph-integrity')).toBe(true);
    expect(result.issues.find(i => i.rule === 'graph-integrity')?.message).toContain('depends on itself');
  });

  it('rejects dependency cycles with all affected task ids', () => {
    const result = validateDag({
      tasks: [
        task('a', ['c']),
        task('b', ['a']),
        task('c', ['b']),
      ],
    });

    expect(result.valid).toBe(false);
    expect(hasError(result, 'graph-integrity')).toBe(true);
    const issue = result.issues.find(i => i.rule === 'graph-integrity');
    expect(issue?.message).toContain('cycle');
    expect(issue?.taskIds?.sort()).toEqual(['a', 'b', 'c']);
  });
});

// ---------------------------------------------------------------------------
// vague-criteria
// ---------------------------------------------------------------------------

describe('validateDag — vague-criteria', () => {
  function singleTask(acceptance_criteria: string | null | undefined): Dag {
    return {
      tasks: [{
        id: 't1', name: 'task', kind: 'llm_call', depends_on: [],
        executor_hint: null, model: null,
        ...(acceptance_criteria !== undefined ? { acceptance_criteria } : {}),
      }],
    };
  }

  it('null acceptance_criteria → valid (no criteria is allowed)', () => {
    const result = validateDag(singleTask(null));
    expect(hasError(result, 'vague-criteria')).toBe(false);
  });

  it('no acceptance_criteria field → valid', () => {
    const result = validateDag({ tasks: [{ id: 't1', name: 'x', kind: 'llm_call', depends_on: [], executor_hint: null, model: null }] });
    expect(hasError(result, 'vague-criteria')).toBe(false);
  });

  it('"should be good" → error vague-criteria', () => {
    const result = validateDag(singleTask('Output should be good and accurate'));
    expect(hasError(result, 'vague-criteria')).toBe(true);
  });

  it('"deve ser bom" → error vague-criteria', () => {
    const result = validateDag(singleTask('O resultado deve ser bom e correto'));
    expect(hasError(result, 'vague-criteria')).toBe(true);
  });

  it('"should work correctly" → error vague-criteria', () => {
    const result = validateDag(singleTask('The module should work correctly in all cases'));
    expect(hasError(result, 'vague-criteria')).toBe(true);
  });

  it('"must be correct" → error vague-criteria', () => {
    const result = validateDag(singleTask('The output must be correct and complete'));
    expect(hasError(result, 'vague-criteria')).toBe(true);
  });

  it('criteria with only 15 chars → error vague-criteria (too short)', () => {
    const result = validateDag(singleTask('must pass test'));
    expect(hasError(result, 'vague-criteria')).toBe(true);
    const issue = result.issues.find(i => i.rule === 'vague-criteria');
    expect(issue?.message).toContain('14'); // "must pass test" = 14 chars
  });

  it('"exit code 0 and file exists" → valid (specific)', () => {
    const result = validateDag(singleTask('exit code 0 and output file exists at dist/bundle.js'));
    expect(hasError(result, 'vague-criteria')).toBe(false);
  });

  it('"JSON with fields name, age, score" → valid (specific)', () => {
    const result = validateDag(singleTask('Valid JSON object with fields name (string), age (number), score (number)'));
    expect(hasError(result, 'vague-criteria')).toBe(false);
  });

  it('"≤400 words covering competitive landscape" → valid', () => {
    const result = validateDag(singleTask('≤400 words covering competitive landscape with ≥3 named players'));
    expect(hasError(result, 'vague-criteria')).toBe(false);
  });

  it('vague-criteria issue includes taskId', () => {
    const result = validateDag(singleTask('output should be good'));
    const issue = result.issues.find(i => i.rule === 'vague-criteria');
    expect(issue?.taskIds).toContain('t1');
  });

  // Regression: the broad regex /\bmust (be |...)\b/ used to match any
  // "must be <word>" — flagging concrete sentences like "must be referenced
  // verbatim". The tightened regex only fires when the continuation word is
  // itself vague (correct/good/proper/etc.).
  it('"must be referenced verbatim in t3" → valid (concrete; not flagged)', () => {
    const result = validateDag(singleTask(
      'All class names defined here MUST be referenced verbatim in t3, t4, t5, and t6 acceptance criteria',
    ));
    expect(hasError(result, 'vague-criteria')).toBe(false);
  });

  it('"must be defined in tokens.css" → valid (concrete)', () => {
    const result = validateDag(singleTask(
      'CSS variables --color-x and --color-y must be defined in tokens.css with hex values',
    ));
    expect(hasError(result, 'vague-criteria')).toBe(false);
  });

  it('"must be present in DOM" → valid (concrete)', () => {
    const result = validateDag(singleTask(
      'Every .note-card element must be present in document.body after page load and survive a refresh',
    ));
    expect(hasError(result, 'vague-criteria')).toBe(false);
  });

  it('"renders correctly with multiple notes" → still flagged (vague behavior)', () => {
    // The verb+correctly pair stays caught — this was a real vagueness in
    // dogfood wf, where "renders correctly" hid a missing observable.
    const result = validateDag(singleTask(
      'The workspace renders correctly with multiple notes in various states (standalone, stacked, with checklists)',
    ));
    expect(hasError(result, 'vague-criteria')).toBe(true);
  });

  it('"works as expected" → flagged (vague behavior)', () => {
    const result = validateDag(singleTask(
      'After click, the checklist toggle works as expected and updates the UI',
    ));
    expect(hasError(result, 'vague-criteria')).toBe(true);
  });

  it('"correctly indexed" → valid (adverb modifies a concrete verb form)', () => {
    // The standalone /\bcorrectly\b/ pattern was too aggressive — phrases
    // like "correctly indexed", "correctly typed", "correctly formatted"
    // describe specific properties and should NOT be rejected.
    const result = validateDag(singleTask(
      'Every entry is correctly indexed by note ID in the localStorage map under key "notes_v1"',
    ));
    expect(hasError(result, 'vague-criteria')).toBe(false);
  });

  it('"funciona corretamente" → flagged (PT-BR vague)', () => {
    const result = validateDag(singleTask(
      'O drag and drop funciona corretamente entre todas as notas do workspace',
    ));
    expect(hasError(result, 'vague-criteria')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// task-count
// ---------------------------------------------------------------------------

describe('validateDag — task-count', () => {
  it('12 tasks → valid, no warn', () => {
    const result = validateDag(parallelTasks(12));
    expect(result.valid).toBe(true);
    expect(hasError(result, 'task-count')).toBe(false);
    expect(hasWarn(result, 'task-count')).toBe(false);
  });

  it('13 tasks → warn task-count (not error)', () => {
    const result = validateDag(parallelTasks(13));
    expect(result.valid).toBe(true); // warn doesn't invalidate
    expect(hasWarn(result, 'task-count')).toBe(true);
    expect(hasError(result, 'task-count')).toBe(false);
  });

  it('20 tasks → warn (still valid)', () => {
    const result = validateDag(parallelTasks(20));
    expect(result.valid).toBe(true);
    expect(hasWarn(result, 'task-count')).toBe(true);
  });

  it('21 tasks → error task-count', () => {
    const result = validateDag(parallelTasks(21));
    expect(result.valid).toBe(false);
    expect(hasError(result, 'task-count')).toBe(true);
    const issue = result.issues.find(i => i.rule === 'task-count');
    expect(issue?.message).toContain('21');
  });
});

// ---------------------------------------------------------------------------
// acceptance-criteria-ratio
// ---------------------------------------------------------------------------

describe('validateDag — acceptance-criteria-ratio', () => {
  it('does not warn when all non-t0 tasks have meaningful criteria (happy path)', () => {
    const dag: Dag = {
      tasks: [
        { id: 't0', name: 'plan', kind: 'llm_call', depends_on: [],
          executor_hint: null, model: null,
          acceptance_criteria: 'Plan lists all subsequent tasks with kinds and deliverables' },
        { id: 't1', name: 'analyze', kind: 'llm_call', depends_on: ['t0'],
          executor_hint: null, model: null,
          acceptance_criteria: 'Covers ≥3 competitors with strengths and weaknesses each' },
        { id: 't2', name: 'summarize', kind: 'llm_call', depends_on: ['t0'],
          executor_hint: null, model: null,
          acceptance_criteria: 'Lists pricing tiers with numeric ranges for ≥3 players' },
      ],
    };
    const result = validateDag(dag);
    expect(hasWarn(result, 'acceptance-criteria-ratio')).toBe(false);
  });

  it('warns when >30% of non-t0 tasks lack meaningful acceptance_criteria', () => {
    // 3 non-t0 tasks, only 1 has meaningful criteria → ratio = 1/3 ≈ 33% < 70%
    const dag: Dag = {
      tasks: [
        { id: 't0', name: 'plan', kind: 'llm_call', depends_on: [],
          executor_hint: null, model: null },
        { id: 't1', name: 'task1', kind: 'llm_call', depends_on: ['t0'],
          executor_hint: null, model: null,
          acceptance_criteria: 'Output contains JSON with fields name and score from 0 to 100' },
        { id: 't2', name: 'task2', kind: 'llm_call', depends_on: ['t0'],
          executor_hint: null, model: null,
          acceptance_criteria: null },
        { id: 't3', name: 'task3', kind: 'llm_call', depends_on: ['t0'],
          executor_hint: null, model: null,
          acceptance_criteria: null },
      ],
    };
    const result = validateDag(dag);
    expect(hasWarn(result, 'acceptance-criteria-ratio')).toBe(true);
    const issue = result.issues.find(i => i.rule === 'acceptance-criteria-ratio');
    expect(issue?.message).toContain('1/3');
  });

  it('considers "ok" (length < 20) as non-meaningful acceptance_criteria', () => {
    // 2 non-t0 tasks: t1 has "ok" (2 chars), t2 has null → 0/2 meaningful = 0% < 70%
    const dag: Dag = {
      tasks: [
        { id: 't0', name: 'plan', kind: 'llm_call', depends_on: [],
          executor_hint: null, model: null },
        { id: 't1', name: 'task1', kind: 'llm_call', depends_on: ['t0'],
          executor_hint: null, model: null,
          acceptance_criteria: 'ok' },
        { id: 't2', name: 'task2', kind: 'llm_call', depends_on: ['t0'],
          executor_hint: null, model: null,
          acceptance_criteria: null },
      ],
    };
    const result = validateDag(dag);
    expect(hasWarn(result, 'acceptance-criteria-ratio')).toBe(true);
    const issue = result.issues.find(i => i.rule === 'acceptance-criteria-ratio');
    expect(issue?.message).toContain('0/2');
  });

  it('does not warn when exactly 70% of non-t0 tasks have meaningful criteria (at threshold)', () => {
    // 10 non-t0 tasks, 7 with meaningful criteria → 70% exactly, should NOT warn
    const tasks: Dag['tasks'] = [
      { id: 't0', name: 'plan', kind: 'llm_call', depends_on: [],
        executor_hint: null, model: null },
    ];
    for (let i = 1; i <= 7; i++) {
      tasks.push({
        id: `t${i}`, name: `task${i}`, kind: 'llm_call', depends_on: ['t0'],
        executor_hint: null, model: null,
        acceptance_criteria: `Output must contain at least ${i} validated entries with schema check`,
      });
    }
    for (let i = 8; i <= 10; i++) {
      tasks.push({
        id: `t${i}`, name: `task${i}`, kind: 'llm_call', depends_on: ['t0'],
        executor_hint: null, model: null,
        acceptance_criteria: null,
      });
    }
    const result = validateDag({ tasks });
    expect(hasWarn(result, 'acceptance-criteria-ratio')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// cli-spawn-timeout
// ---------------------------------------------------------------------------

describe('validateDag — cli-spawn-timeout', () => {
  it('accepts cli_spawn task with timeout_seconds set', () => {
    const dag: Dag = {
      tasks: [
        { id: 't1', name: 'build', kind: 'cli_spawn', depends_on: [],
          executor_hint: 'cli:claude-code', model: 'cc/claude-sonnet-4-6',
          timeout_seconds: 600,
          acceptance_criteria: 'dist/bundle.js exists and size > 1KB' },
      ],
    };
    const result = validateDag(dag);
    expect(hasWarn(result, 'cli-spawn-timeout')).toBe(false);
  });

  it('warns when cli_spawn task lacks timeout_seconds', () => {
    const dag: Dag = {
      tasks: [
        { id: 't1', name: 'build', kind: 'cli_spawn', depends_on: [],
          executor_hint: 'cli:claude-code', model: 'cc/claude-sonnet-4-6',
          acceptance_criteria: 'dist/bundle.js exists and size > 1KB' },
      ],
    };
    const result = validateDag(dag);
    expect(hasWarn(result, 'cli-spawn-timeout')).toBe(true);
    const issue = result.issues.find(i => i.rule === 'cli-spawn-timeout');
    expect(issue?.message).toContain('1 cli_spawn');
    expect(issue?.taskIds).toContain('t1');
  });

  it('counts multiple cli_spawn tasks without timeout in warning message', () => {
    const dag: Dag = {
      tasks: [
        { id: 't1', name: 'build1', kind: 'cli_spawn', depends_on: [],
          executor_hint: null, model: null,
          acceptance_criteria: 'file1.ts exists and exports default function with correct signature' },
        { id: 't2', name: 'build2', kind: 'cli_spawn', depends_on: [],
          executor_hint: null, model: null,
          acceptance_criteria: 'file2.ts exists and exports default function with correct signature' },
      ],
    };
    const result = validateDag(dag);
    expect(hasWarn(result, 'cli-spawn-timeout')).toBe(true);
    const issue = result.issues.find(i => i.rule === 'cli-spawn-timeout');
    expect(issue?.message).toContain('2 cli_spawn');
    expect(issue?.taskIds).toContain('t1');
    expect(issue?.taskIds).toContain('t2');
  });

  it('does not warn for llm_call tasks without timeout_seconds', () => {
    const dag: Dag = {
      tasks: [
        { id: 't1', name: 'analyze', kind: 'llm_call', depends_on: [],
          executor_hint: null, model: null,
          acceptance_criteria: 'Analysis covers ≥3 competitors with pros and cons' },
      ],
    };
    const result = validateDag(dag);
    expect(hasWarn(result, 'cli-spawn-timeout')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// combined
// ---------------------------------------------------------------------------

describe('validateDag — combined', () => {
  it('valid minimal DAG (2 tasks, specific criteria) → valid: true, no errors', () => {
    const dag: Dag = {
      tasks: [
        { id: 't1', name: 'analyze', kind: 'llm_call', depends_on: [],
          executor_hint: null, model: null,
          acceptance_criteria: 'Covers ≥3 competitors with strengths and weaknesses each' },
        { id: 't2', name: 'summarize', kind: 'llm_call', depends_on: ['t1'],
          executor_hint: null, model: null,
          acceptance_criteria: '≤400 words summarizing the competitive analysis' },
      ],
    };
    const result = validateDag(dag);
    expect(result.valid).toBe(true);
    expect(result.issues.filter(i => i.severity === 'error')).toHaveLength(0);
  });

  it('chain=11 + vague criteria → two errors, valid: false', () => {
    const dag = linearChain(11);
    // Add vague criteria to first task
    dag.tasks[0]!.acceptance_criteria = 'output should be good';
    const result = validateDag(dag);
    expect(result.valid).toBe(false);
    const errors = result.issues.filter(i => i.severity === 'error');
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(hasError(result, 'max-chain-length')).toBe(true);
    expect(hasError(result, 'vague-criteria')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// arithmetic-no-calculator (Batch 0.7, item 3) — advisory warn
// ---------------------------------------------------------------------------

describe('validateDag — arithmetic-no-calculator', () => {
  const arithObjective = "Compute (387*92+1241) and print 'Final value: <number>'";

  it('warns when an arithmetic objective has no calculator tool_call', () => {
    const result = validateDag(linearChain(1), { objective: arithObjective });
    expect(hasWarn(result, 'arithmetic-no-calculator')).toBe(true);
    expect(result.valid).toBe(true); // advisory only — never an error
  });

  it('does NOT warn when a calculator tool_call is present', () => {
    const dag = {
      tasks: [
        { id: 't1', name: 'calc', kind: 'tool_call', tool_name: 'calculator',
          depends_on: [], executor_hint: null, model: null,
          args: { expression: '(387*92)+1241' } },
        { id: 't2', name: 'report', kind: 'llm_call', depends_on: ['t1'],
          executor_hint: null, model: null },
      ],
    } as unknown as Dag;
    const result = validateDag(dag, { objective: arithObjective });
    expect(hasWarn(result, 'arithmetic-no-calculator')).toBe(false);
  });

  it('does NOT warn for a non-arithmetic objective', () => {
    const result = validateDag(linearChain(1), { objective: 'Summarize the meeting notes' });
    expect(hasWarn(result, 'arithmetic-no-calculator')).toBe(false);
  });

  it('does NOT warn when objective is omitted (backward compatible)', () => {
    expect(hasWarn(validateDag(linearChain(1)), 'arithmetic-no-calculator')).toBe(false);
  });

  it('does NOT match a numeric range like 5-10 (only * / % +)', () => {
    const result = validateDag(linearChain(1), { objective: 'List items 5-10 from the catalog' });
    expect(hasWarn(result, 'arithmetic-no-calculator')).toBe(false);
  });
});
