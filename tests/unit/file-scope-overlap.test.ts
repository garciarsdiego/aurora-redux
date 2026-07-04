import { describe, it, expect } from 'vitest';
import { pathsOverlap, filterPathsByIgnoreList } from '../../src/v2/scheduling/file-scope.js';
import { validateDag } from '../../src/brain/dag-validator.js';
import type { Dag } from '../../src/types/index.js';

// ---------------------------------------------------------------------------
// pathsOverlap
// ---------------------------------------------------------------------------

describe('pathsOverlap', () => {
  it('exact match returns true', () => {
    expect(pathsOverlap(['src/foo.ts'], ['src/foo.ts'])).toBe(true);
  });

  it('directory glob prefix vs concrete file returns true', () => {
    expect(pathsOverlap(['src/*'], ['src/bar.ts'])).toBe(true);
  });

  it('no overlap between distinct files returns false', () => {
    expect(pathsOverlap(['src/a.ts'], ['tests/b.ts'])).toBe(false);
  });

  it('two non-overlapping directory globs return false', () => {
    expect(pathsOverlap(['packages/a/*'], ['packages/b/*'])).toBe(false);
  });

  it('parent glob vs nested file returns true', () => {
    expect(pathsOverlap(['packages/*'], ['packages/a/x.ts'])).toBe(true);
  });

  it('empty array a vs non-empty array b returns false', () => {
    expect(pathsOverlap([], ['src/foo.ts'])).toBe(false);
  });

  it('non-empty array a vs empty array b returns false', () => {
    expect(pathsOverlap(['src/foo.ts'], [])).toBe(false);
  });

  it('both arrays empty returns false', () => {
    expect(pathsOverlap([], [])).toBe(false);
  });

  it('overlapping child glob returns true', () => {
    expect(pathsOverlap(['src/utils/*'], ['src/utils/helpers.ts'])).toBe(true);
  });

  it('sibling directories do not overlap', () => {
    expect(pathsOverlap(['src/api/*'], ['src/ui/*'])).toBe(false);
  });

  it('parent directory glob matches deep nested file', () => {
    expect(pathsOverlap(['src/*'], ['src/deep/nested/file.ts'])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// filterPathsByIgnoreList
// ---------------------------------------------------------------------------

describe('filterPathsByIgnoreList', () => {
  it('returns all paths when no ignore list provided', () => {
    const paths = ['src/foo.ts', 'src/bar.ts'];
    expect(filterPathsByIgnoreList(paths)).toEqual(paths);
  });

  it('returns all paths when ignore list is empty', () => {
    const paths = ['src/foo.ts', 'src/bar.ts'];
    expect(filterPathsByIgnoreList(paths, [])).toEqual(paths);
  });

  it('removes exact match from ignore list', () => {
    expect(filterPathsByIgnoreList(['src/foo.ts', 'src/bar.ts'], ['src/foo.ts'])).toEqual(['src/bar.ts']);
  });

  it('removes paths under ignored directory glob', () => {
    const result = filterPathsByIgnoreList(
      ['docs/generated/api.md', 'src/index.ts', 'docs/generated/types.md'],
      ['docs/generated/*'],
    );
    expect(result).toEqual(['src/index.ts']);
  });

  it('handles backslash normalization in ignore paths', () => {
    const result = filterPathsByIgnoreList(
      ['src/foo.ts', 'src/bar.ts'],
      ['src\\foo.ts'],
    );
    expect(result).toEqual(['src/bar.ts']);
  });

  it('removes leading ./ from paths when matching', () => {
    const result = filterPathsByIgnoreList(
      ['./src/foo.ts', 'src/bar.ts'],
      ['src/foo.ts'],
    );
    expect(result).toEqual(['src/bar.ts']);
  });
});

// ---------------------------------------------------------------------------
// DAG validator — checkFileScopeOverlap
// ---------------------------------------------------------------------------

function makeBaseDag(tasks: Partial<Dag['tasks'][number]>[]): Dag {
  return {
    objective: 'test',
    tasks: tasks.map((t, i) => ({
      id: `t${i}`,
      name: `Task ${i}`,
      kind: 'llm_call' as const,
      depends_on: [],
      executor_hint: null,
      acceptance_criteria: 'Output matches expected schema with all required fields present.',
      model: null,
      ...t,
    })),
  };
}

describe('validateDag — file_scope_overlap check', () => {
  it('two parallel tasks with overlapping file_scope produce a warn issue', () => {
    const dag = makeBaseDag([
      { id: 't0', file_scope: ['src/utils.ts'] },
      { id: 't1', file_scope: ['src/utils.ts'] },
    ]);
    const result = validateDag(dag);
    const overlap = result.issues.filter((i) => i.rule === 'file_scope_overlap');
    expect(overlap).toHaveLength(1);
    expect(overlap[0].severity).toBe('warn');
    expect(overlap[0].taskIds).toContain('t0');
    expect(overlap[0].taskIds).toContain('t1');
  });

  it('two tasks with dependency and overlapping file_scope produce no issue', () => {
    const dag = makeBaseDag([
      { id: 't0', file_scope: ['src/utils.ts'], depends_on: [] },
      { id: 't1', file_scope: ['src/utils.ts'], depends_on: ['t0'] },
    ]);
    const result = validateDag(dag);
    const overlap = result.issues.filter((i) => i.rule === 'file_scope_overlap');
    expect(overlap).toHaveLength(0);
  });

  it('two tasks with non-overlapping file_scope produce no issue', () => {
    const dag = makeBaseDag([
      { id: 't0', file_scope: ['src/api.ts'] },
      { id: 't1', file_scope: ['src/ui.ts'] },
    ]);
    const result = validateDag(dag);
    const overlap = result.issues.filter((i) => i.rule === 'file_scope_overlap');
    expect(overlap).toHaveLength(0);
  });

  it('task without file_scope is ignored by the check', () => {
    const dag = makeBaseDag([
      { id: 't0' },
      { id: 't1', file_scope: ['src/utils.ts'] },
    ]);
    const result = validateDag(dag);
    const overlap = result.issues.filter((i) => i.rule === 'file_scope_overlap');
    expect(overlap).toHaveLength(0);
  });

  it('glob vs concrete path overlap is detected', () => {
    const dag = makeBaseDag([
      { id: 't0', file_scope: ['src/*'] },
      { id: 't1', file_scope: ['src/index.ts'] },
    ]);
    const result = validateDag(dag);
    const overlap = result.issues.filter((i) => i.rule === 'file_scope_overlap');
    expect(overlap).toHaveLength(1);
    expect(overlap[0].severity).toBe('warn');
  });

  it('three-task dag: only the non-dependent pair is flagged', () => {
    // t0 -> t1 -> t2, but t0 and t2 are in different scopes; t0 and t1 same scope but dep exists
    const dag = makeBaseDag([
      { id: 't0', file_scope: ['src/shared.ts'], depends_on: [] },
      { id: 't1', file_scope: ['src/shared.ts'], depends_on: ['t0'] },
      { id: 't2', file_scope: ['src/shared.ts'], depends_on: [] },
    ]);
    const result = validateDag(dag);
    const overlap = result.issues.filter((i) => i.rule === 'file_scope_overlap');
    // t0↔t2 and t1↔t2 both lack a dependency, so 2 warn issues expected
    expect(overlap).toHaveLength(2);
  });
});
