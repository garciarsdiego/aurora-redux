import { describe, it, expect } from 'vitest';
import {
  validateCode,
  validateContent,
  validateData,
  validateAnalysis,
  getValidator,
} from '../../src/v2/validators/index.js';

// ---------------------------------------------------------------------------
// validateCode — tsc/test output analysis
// ---------------------------------------------------------------------------

describe('validateCode', () => {
  it('empty output → passed (clean tsc --noEmit produces no output)', () => {
    const r = validateCode('');
    expect(r.passed).toBe(true);
  });

  it('output with TypeScript error → failed', () => {
    const r = validateCode("error TS2345: Argument of type 'number' is not assignable to type 'string'.");
    expect(r.passed).toBe(false);
    expect(r.message).toMatch(/typescript error/i);
  });

  it('output with test failures → failed', () => {
    const r = validateCode('Test Suites: 1 failed, 1 total\nTests: 3 failed, 5 total');
    expect(r.passed).toBe(false);
    expect(r.message).toMatch(/fail/i);
  });

  it('clean output with no error markers → passed', () => {
    const r = validateCode('Build succeeded. 3 modules processed.');
    expect(r.passed).toBe(true);
  });

  it('whitespace-only output → passed (treated as clean)', () => {
    expect(validateCode('   \n\t  ').passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateContent — minimum length check
// ---------------------------------------------------------------------------

describe('validateContent', () => {
  it('empty string → failed', () => {
    expect(validateContent('').passed).toBe(false);
  });

  it('string shorter than 100 chars → failed', () => {
    const r = validateContent('Too short.');
    expect(r.passed).toBe(false);
    expect(r.message).toMatch(/short/i);
  });

  it('string exactly at 100 chars → passed', () => {
    expect(validateContent('a'.repeat(100)).passed).toBe(true);
  });

  it('string longer than 100 chars → passed', () => {
    expect(validateContent('a'.repeat(150)).passed).toBe(true);
  });

  it('message includes char count when failing', () => {
    const r = validateContent('hello');
    expect(r.message).toContain('5');
  });
});

// ---------------------------------------------------------------------------
// validateData — JSON parse + row count
// ---------------------------------------------------------------------------

describe('validateData', () => {
  it('non-JSON string → failed', () => {
    const r = validateData('not json at all');
    expect(r.passed).toBe(false);
    expect(r.message).toMatch(/json/i);
  });

  it('empty string → failed', () => {
    expect(validateData('').passed).toBe(false);
  });

  it('empty array → failed (0 rows)', () => {
    const r = validateData('[]');
    expect(r.passed).toBe(false);
    expect(r.message).toMatch(/empty/i);
  });

  it('array with rows → passed', () => {
    const r = validateData(JSON.stringify([{ name: 'Alice', score: 95 }, { name: 'Bob', score: 87 }]));
    expect(r.passed).toBe(true);
    expect(r.message).toContain('2');
  });

  it('non-empty object → passed', () => {
    expect(validateData(JSON.stringify({ total: 42, items: [] })).passed).toBe(true);
  });

  it('empty object → failed', () => {
    expect(validateData('{}').passed).toBe(false);
  });

  it('primitive JSON (number) → failed', () => {
    expect(validateData('42').passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateAnalysis — conclusion + min length
// ---------------------------------------------------------------------------

describe('validateAnalysis', () => {
  it('empty string → failed', () => {
    expect(validateAnalysis('').passed).toBe(false);
  });

  it('text shorter than 200 chars without conclusion → failed', () => {
    const r = validateAnalysis('Some analysis without a conclusion marker here.');
    expect(r.passed).toBe(false);
  });

  it('long text without conclusion marker → failed', () => {
    const r = validateAnalysis('x'.repeat(300));
    expect(r.passed).toBe(false);
    expect(r.message).toMatch(/conclusion/i);
  });

  it('long text with "conclusion" → passed', () => {
    const r = validateAnalysis('This is a detailed analysis. ' + 'x'.repeat(200) + ' In conclusion, the results are clear.');
    expect(r.passed).toBe(true);
  });

  it('long text with "therefore" → passed', () => {
    const r = validateAnalysis('Extensive analysis here. ' + 'y'.repeat(200) + ' Therefore, we recommend approach A.');
    expect(r.passed).toBe(true);
  });

  it('long text with Portuguese "portanto" → passed', () => {
    const r = validateAnalysis('Análise detalhada aqui. ' + 'z'.repeat(200) + ' Portanto, a conclusão é positiva.');
    expect(r.passed).toBe(true);
  });

  it('"in summary" marker triggers pass', () => {
    const r = validateAnalysis('Detailed findings follow. ' + 'a'.repeat(200) + ' In summary, all metrics improved.');
    expect(r.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getValidator — dispatcher
// ---------------------------------------------------------------------------

describe('getValidator', () => {
  it('"code" profile returns a function', () => {
    const fn = getValidator('code');
    expect(typeof fn).toBe('function');
  });

  it('"content" profile returns a function', () => {
    expect(typeof getValidator('content')).toBe('function');
  });

  it('"data" profile returns a function', () => {
    expect(typeof getValidator('data')).toBe('function');
  });

  it('"analysis" profile returns a function', () => {
    expect(typeof getValidator('analysis')).toBe('function');
  });

  it('"none" profile returns null', () => {
    expect(getValidator('none')).toBeNull();
  });

  it('no argument → defaults to code validator (non-null)', () => {
    const defaultFn = getValidator();
    const codeFn = getValidator('code');
    expect(defaultFn).toBe(codeFn);
  });

  it('returned validator is callable and produces ValidatorResult shape', () => {
    const fn = getValidator('content')!;
    const result = fn('hello world');
    expect(result).toHaveProperty('passed');
    expect(result).toHaveProperty('message');
    expect(typeof result.passed).toBe('boolean');
    expect(typeof result.message).toBe('string');
  });
});
