/**
 * Tests for src/v2/observability/state-schema.ts (audit §13 P3 #19, B9.2).
 * Pure data-validation logic; no I/O.
 */

import { describe, it, expect } from 'vitest';

import {
  validateOutputAgainstStateSchema,
  type StateSchema,
} from '../../src/v2/observability/state-schema.js';

describe('validateOutputAgainstStateSchema', () => {
  it('returns valid when schema is empty', () => {
    expect(validateOutputAgainstStateSchema({ anything: 'goes' }, {})).toEqual({
      valid: true,
      violations: [],
    });
  });

  it('returns valid when schema is missing entirely', () => {
    expect(validateOutputAgainstStateSchema(
      { foo: 'bar' },
      undefined as unknown as StateSchema,
    )).toEqual({ valid: true, violations: [] });
  });

  it('passes happy path: every declared field present with correct type', () => {
    const schema: StateSchema = {
      title: { type: 'string' },
      score: { type: 'number' },
      active: { type: 'boolean' },
      meta: { type: 'object' },
      tags: { type: 'array' },
    };
    const output = { title: 'x', score: 42, active: true, meta: {}, tags: [] };
    const r = validateOutputAgainstStateSchema(output, schema);
    expect(r.valid).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it('reports missing fields when they have no default', () => {
    const schema: StateSchema = { title: { type: 'string' }, score: { type: 'number' } };
    const r = validateOutputAgainstStateSchema({ title: 'x' }, schema);
    expect(r.valid).toBe(false);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toEqual({
      field: 'score', expected: 'number', actual: 'undefined', reason: 'missing',
    });
  });

  it('treats fields with a default as optional (no violation when missing)', () => {
    const schema: StateSchema = {
      title: { type: 'string' },
      tags: { type: 'array', default: [] },
    };
    expect(validateOutputAgainstStateSchema({ title: 'x' }, schema)).toEqual({
      valid: true,
      violations: [],
    });
  });

  it('reports wrong types', () => {
    const schema: StateSchema = {
      score: { type: 'number' },
      active: { type: 'boolean' },
    };
    const r = validateOutputAgainstStateSchema(
      { score: 'forty-two', active: 1 },
      schema,
    );
    expect(r.valid).toBe(false);
    expect(r.violations).toEqual(
      expect.arrayContaining([
        { field: 'score', expected: 'number', actual: 'string', reason: 'wrong_type' },
        { field: 'active', expected: 'boolean', actual: 'number', reason: 'wrong_type' },
      ]),
    );
  });

  it('distinguishes array from object', () => {
    const schema: StateSchema = { tags: { type: 'array' } };
    const r = validateOutputAgainstStateSchema({ tags: { x: 1 } }, schema);
    expect(r.valid).toBe(false);
    expect(r.violations[0]).toMatchObject({ expected: 'array', actual: 'object' });
  });

  it('distinguishes null from object', () => {
    const schema: StateSchema = { meta: { type: 'object' } };
    const r = validateOutputAgainstStateSchema({ meta: null }, schema);
    expect(r.valid).toBe(false);
    expect(r.violations[0]).toMatchObject({ expected: 'object', actual: 'null' });
  });

  it("'null' type accepts null, rejects undefined and other types", () => {
    const schema: StateSchema = { x: { type: 'null' } };
    expect(validateOutputAgainstStateSchema({ x: null }, schema).valid).toBe(true);
    expect(validateOutputAgainstStateSchema({ x: 0 }, schema).valid).toBe(false);
  });

  it("'unknown' type passes any value (escape hatch)", () => {
    const schema: StateSchema = { x: { type: 'unknown' } };
    for (const value of [null, 0, 'str', false, [], {}, undefined]) {
      // undefined still triggers missing → handled separately
      if (value === undefined) continue;
      expect(validateOutputAgainstStateSchema({ x: value }, schema).valid).toBe(true);
    }
  });

  it('parses a JSON-string output before validating', () => {
    const schema: StateSchema = { title: { type: 'string' } };
    const r = validateOutputAgainstStateSchema('{"title":"hello"}', schema);
    expect(r.valid).toBe(true);
  });

  it('reports a parse_error when a string output is not JSON', () => {
    const schema: StateSchema = { title: { type: 'string' } };
    const r = validateOutputAgainstStateSchema('not-json', schema);
    expect(r.valid).toBe(false);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toMatchObject({ reason: 'parse_error', field: '<root>' });
  });

  it('reports parse_error when the parsed JSON is not an object (array)', () => {
    const schema: StateSchema = { title: { type: 'string' } };
    const r = validateOutputAgainstStateSchema('[1,2,3]', schema);
    expect(r.valid).toBe(false);
    // `actual` reports the type of rawOutput (the input the function received),
    // which is the JSON string itself. The IMPLEMENTATION could report the
    // parsed value's type instead — that's a UX call. Document the current
    // behavior here.
    expect(r.violations[0]).toMatchObject({ reason: 'parse_error', actual: 'string' });
  });

  it('reports parse_error when non-string non-object passed', () => {
    const schema: StateSchema = { title: { type: 'string' } };
    const r = validateOutputAgainstStateSchema(42 as unknown, schema);
    expect(r.valid).toBe(false);
    expect(r.violations[0]).toMatchObject({ reason: 'parse_error', actual: 'number' });
  });

  it('aggregates multiple violations in order of declaration', () => {
    const schema: StateSchema = {
      a: { type: 'string' },
      b: { type: 'number' },
      c: { type: 'boolean' },
    };
    const r = validateOutputAgainstStateSchema({ a: 1, b: 'x' }, schema);
    expect(r.violations).toHaveLength(3);
    expect(r.violations.map((v) => v.field)).toEqual(['a', 'b', 'c']);
  });
});
