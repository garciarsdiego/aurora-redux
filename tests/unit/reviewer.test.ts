import { describe, it, expect } from 'vitest';
import { getReviewerClaudeArgs, getReviewerSpawnOptions, parseReviewOutput } from '../../src/reviewer/reviewer.js';

describe('parseReviewOutput', () => {
  it('parses strict JSON (no fences)', () => {
    const raw = '{"outcome_type": "soft_success", "confidence": 0.85, "feedback": "solid, minor phrasing issue"}';
    expect(parseReviewOutput(raw)).toEqual({
      outcome_type: "soft_success",
      confidence: 0.85,
      feedback: 'solid, minor phrasing issue',
    });
  });

  it('strips markdown json fences', () => {
    const raw = '```json\n{"outcome_type": "hard_success", "confidence": 0.9, "feedback": "great"}\n```';
    expect(parseReviewOutput(raw)).toEqual({ outcome_type: "hard_success", confidence: 0.9, feedback: 'great' });
  });

  it('strips plain ``` fences', () => {
    const raw = '```\n{"outcome_type": "soft_failure", "confidence": 0.5, "feedback": "half right"}\n```';
    expect(parseReviewOutput(raw)).toEqual({ outcome_type: "soft_failure", confidence: 0.5, feedback: 'half right' });
  });

  it('rejects malformed JSON', () => {
    expect(() => parseReviewOutput('not json at all')).toThrow(/parse LLM output/);
  });

  it('rejects confidence out of range (>1)', () => {
    const raw = '{"outcome_type": "soft_success", "confidence": 1.5, "feedback": "nope"}';
    expect(() => parseReviewOutput(raw)).toThrow(/match schema/);
  });

  it('rejects missing outcome_type field', () => {
    const raw = '{"confidence": 0.8}';
    expect(() => parseReviewOutput(raw)).toThrow(/match schema/);
  });

  // Regression: 2026-04-23 Tetris workflow — reviewer CLI returned narrative
  // prefix "Let me analyze the task output carefully..." before the JSON
  // object. Original `JSON.parse` saw "Let me ana..." and threw.
  // Fix: extract first {...} block as fallback.
  it('extracts JSON when LLM prefixes narrative reasoning', () => {
    const raw = [
      'Let me analyze the task output carefully.',
      '',
      'The output claims to have created files but contents are not shown.',
      '',
      '{"outcome_type": "hard_failure", "confidence": 0.9, "feedback": "no file contents"}',
    ].join('\n');
    expect(parseReviewOutput(raw)).toEqual({
      outcome_type: 'hard_failure',
      confidence: 0.9,
      feedback: 'no file contents',
    });
  });

  it('extracts JSON when LLM appends commentary after the object', () => {
    const raw = '{"outcome_type": "soft_success", "confidence": 0.7, "feedback": "ok"}\n\nThat is my assessment.';
    expect(parseReviewOutput(raw)).toEqual({
      outcome_type: 'soft_success',
      confidence: 0.7,
      feedback: 'ok',
    });
  });

  it('extracts JSON wrapped in narrative on both sides', () => {
    const raw = 'Reviewing now.\n{"outcome_type":"hard_success","confidence":1.0,"feedback":"perfect"}\nDone.';
    expect(parseReviewOutput(raw)).toEqual({
      outcome_type: 'hard_success',
      confidence: 1.0,
      feedback: 'perfect',
    });
  });

  it('still rejects when extracted block has invalid JSON shape', () => {
    const raw = 'Here you go: { not valid json } final';
    expect(() => parseReviewOutput(raw)).toThrow(/parse LLM output/);
  });

  it('still rejects pure narrative without any JSON braces', () => {
    expect(() => parseReviewOutput('I think it looks good but I cannot output JSON')).toThrow(/parse LLM output/);
  });
});

describe('reviewer CLI subprocess options', () => {
  it('does not use shell:true for reviewer subprocesses', () => {
    const options = getReviewerSpawnOptions();
    expect(options.shell).toBe(false);
    expect(options.env?.NO_COLOR).toBe('1');
  });

  it('daemon child defaults reviewer CLI to safe mode', () => {
    const previous = process.env.OMNIFORGE_DAEMON_CHILD;
    const previousSafe = process.env.CLI_SAFE_MODE;
    try {
      process.env.OMNIFORGE_DAEMON_CHILD = '1';
      delete process.env.CLI_SAFE_MODE;
      expect(getReviewerClaudeArgs()).toEqual(['--print']);
    } finally {
      if (previous === undefined) delete process.env.OMNIFORGE_DAEMON_CHILD;
      else process.env.OMNIFORGE_DAEMON_CHILD = previous;
      if (previousSafe === undefined) delete process.env.CLI_SAFE_MODE;
      else process.env.CLI_SAFE_MODE = previousSafe;
    }
  });
});
