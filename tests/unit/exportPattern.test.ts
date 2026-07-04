import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import type Database from 'better-sqlite3';
import { initDb } from '../../src/db/client.js';
import { insertPattern } from '../../src/db/persist.js';
import { getPatternByName } from '../../src/patterns/store.js';
import { DagSchema } from '../../src/types/schemas.js';
import { resolveFormat, serialize } from '../../src/cli/commands/exportPattern.js';

function makeDb(): Database.Database {
  return initDb(':memory:');
}

const sampleDag = {
  tasks: [
    { id: 't1', name: 'Draft outline', kind: 'llm_call' as const, depends_on: [], acceptance_criteria: 'Has 5 sections' },
    { id: 't2', name: 'Write body', kind: 'llm_call' as const, depends_on: ['t1'], model: 'kimi-coding/kimi-k2.5-thinking' },
  ],
};

function seedPattern(db: Database.Database, name: string, dag: unknown = sampleDag): void {
  insertPattern(db, {
    id: `pt_${name}`,
    workspace: 'internal',
    name,
    source: 'imported',
    objective_sample: 'sample objective',
    dag_json: JSON.stringify(dag),
    usage_count: 0,
    success_count: 0,
    avg_duration_ms: null,
    last_used_at: null,
    created_at: Date.now(),
  });
}

describe('resolveFormat — precedence', () => {
  it('explicit --format json wins over output extension', () => {
    expect(resolveFormat('json', 'out.yaml')).toBe('json');
  });

  it('explicit --format yaml wins over output extension', () => {
    expect(resolveFormat('yaml', 'out.json')).toBe('yaml');
  });

  it('falls back to .yaml extension when format omitted', () => {
    expect(resolveFormat(undefined, 'pattern.yaml')).toBe('yaml');
  });

  it('treats .yml the same as .yaml', () => {
    expect(resolveFormat(undefined, 'pattern.yml')).toBe('yaml');
  });

  it('falls back to .json extension when format omitted', () => {
    expect(resolveFormat(undefined, 'pattern.json')).toBe('json');
  });

  it('defaults to json when nothing provided', () => {
    expect(resolveFormat(undefined, undefined)).toBe('json');
  });

  it('defaults to json when output has unknown extension', () => {
    expect(resolveFormat(undefined, 'pattern.txt')).toBe('json');
  });

  it('throws on invalid explicit format', () => {
    expect(() => resolveFormat('xml', undefined)).toThrow(/unsupported format/);
  });
});

describe('serialize', () => {
  it('produces parseable JSON with trailing newline', () => {
    const out = serialize(sampleDag, 'json');
    expect(out.endsWith('\n')).toBe(true);
    expect(JSON.parse(out)).toEqual(sampleDag);
  });

  it('produces parseable YAML', () => {
    const out = serialize(sampleDag, 'yaml');
    expect(typeof out).toBe('string');
    expect(yamlLoad(out)).toEqual(sampleDag);
  });
});

describe('export → import round-trip via DB', () => {
  it('JSON: export → re-parse → DagSchema validates → matches original', () => {
    const db = makeDb();
    seedPattern(db, 'rt-json');

    const pattern = getPatternByName(db, 'internal', 'rt-json');
    expect(pattern).not.toBeNull();

    const dag = JSON.parse(pattern!.dag_json);
    const exported = serialize(dag, 'json');
    const reparsed = JSON.parse(exported);
    const validated = DagSchema.safeParse(reparsed);

    expect(validated.success).toBe(true);
    if (validated.success) {
      expect(validated.data.tasks[1].model).toBe('kimi-coding/kimi-k2.5-thinking');
      expect(validated.data).toEqual(sampleDag);
    }
  });

  it('YAML: export → re-parse → DagSchema validates → matches original', () => {
    const db = makeDb();
    seedPattern(db, 'rt-yaml');

    const pattern = getPatternByName(db, 'internal', 'rt-yaml');
    const dag = JSON.parse(pattern!.dag_json);
    const exported = serialize(dag, 'yaml');
    const reparsed = yamlLoad(exported);
    const validated = DagSchema.safeParse(reparsed);

    expect(validated.success).toBe(true);
    if (validated.success) {
      expect(validated.data).toEqual(sampleDag);
    }
  });

  it('round-trip preserves model: null', () => {
    const dagWithNullModel = {
      tasks: [{ id: 't1', name: 'Task', kind: 'llm_call' as const, depends_on: [], model: null }],
    };
    const db = makeDb();
    seedPattern(db, 'null-model', dagWithNullModel);

    const pattern = getPatternByName(db, 'internal', 'null-model');
    const dag = JSON.parse(pattern!.dag_json);
    const yamlOut = serialize(dag, 'yaml');
    const restored = DagSchema.parse(yamlLoad(yamlOut));

    expect(restored.tasks[0].model).toBeNull();
  });
});

describe('getPatternByName', () => {
  it('returns the pattern when name matches workspace+name', () => {
    const db = makeDb();
    seedPattern(db, 'exists');
    expect(getPatternByName(db, 'internal', 'exists')?.name).toBe('exists');
  });

  it('returns null when pattern does not exist', () => {
    const db = makeDb();
    expect(getPatternByName(db, 'internal', 'ghost')).toBeNull();
  });

  it('returns null when name exists in different workspace', () => {
    const db = makeDb();
    seedPattern(db, 'scoped');
    expect(getPatternByName(db, 'initech', 'scoped')).toBeNull();
  });
});

describe('-o file: writes content to disk', () => {
  it('writes JSON to file (extension implies json)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omniforge-export-'));
    try {
      const file = join(dir, 'out.json');
      const content = serialize(sampleDag, resolveFormat(undefined, file));
      await writeFile(file, content, 'utf-8');

      const onDisk = readFileSync(file, 'utf-8');
      expect(JSON.parse(onDisk)).toEqual(sampleDag);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes YAML to file (extension implies yaml)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omniforge-export-'));
    try {
      const file = join(dir, 'out.yaml');
      const content = serialize(sampleDag, resolveFormat(undefined, file));
      await writeFile(file, content, 'utf-8');

      const onDisk = readFileSync(file, 'utf-8');
      expect(yamlLoad(onDisk)).toEqual(sampleDag);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
