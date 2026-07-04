import { describe, it, expect } from 'vitest';
import { load as yamlLoad } from 'js-yaml';
import { DagSchema } from '../../src/types/schemas.js';

const validYaml = `
tasks:
  - id: t1
    name: Draft outline
    kind: llm_call
    depends_on: []
    acceptance_criteria: Has 5 sections
  - id: t2
    name: Write body
    kind: llm_call
    depends_on: [t1]
    model: kimi-coding/kimi-k2.5-thinking
`;

const yamlWithNullModel = `
tasks:
  - id: t1
    name: Do thing
    kind: llm_call
    depends_on: []
    model: null
`;

const yamlWithNoModel = `
tasks:
  - id: t1
    name: Do thing
    kind: llm_call
    depends_on: []
`;

const invalidYaml = `
tasks: []
`;

const badSchemaYaml = `
tasks:
  - id: t1
    name: Task
    kind: llm_call
    depends_on: []
    model: 42
`;

describe('YAML → DagSchema round-trip', () => {
  it('parses valid YAML with model field', () => {
    const parsed = yamlLoad(validYaml);
    const result = DagSchema.safeParse(parsed);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tasks[1].model).toBe('kimi-coding/kimi-k2.5-thinking');
    }
  });

  it('parses YAML with model: null', () => {
    const parsed = yamlLoad(yamlWithNullModel);
    const result = DagSchema.safeParse(parsed);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tasks[0].model).toBeNull();
    }
  });

  it('parses YAML with model omitted', () => {
    const parsed = yamlLoad(yamlWithNoModel);
    const result = DagSchema.safeParse(parsed);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tasks[0].model).toBeUndefined();
    }
  });

  it('rejects YAML with tasks: [] (min 1 fails)', () => {
    const parsed = yamlLoad(invalidYaml);
    expect(DagSchema.safeParse(parsed).success).toBe(false);
  });

  it('rejects YAML with model: 42 (wrong type)', () => {
    const parsed = yamlLoad(badSchemaYaml);
    expect(DagSchema.safeParse(parsed).success).toBe(false);
  });

  it('.yml extension: same parse logic (js-yaml handles both)', () => {
    // js-yaml does not distinguish .yaml vs .yml — same parser
    const parsed = yamlLoad(validYaml);
    expect(DagSchema.safeParse(parsed).success).toBe(true);
  });
});
