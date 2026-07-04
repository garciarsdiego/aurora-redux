import { describe, it, expect } from 'vitest';
import { parseInput, ParseError } from '../../../src/repl/input/parser.js';

describe('parseInput — noop cases', () => {
  it('empty string → noop', () => {
    expect(parseInput('')).toEqual({ kind: 'noop' });
  });

  it('whitespace only → noop', () => {
    expect(parseInput('   ')).toEqual({ kind: 'noop' });
  });

  it('tab whitespace → noop', () => {
    expect(parseInput('\t  \t')).toEqual({ kind: 'noop' });
  });

  it('bare `/` → noop with warning', () => {
    const result = parseInput('/');
    expect(result.kind).toBe('noop');
    if (result.kind === 'noop') {
      expect(result.warning).toBeDefined();
      expect(result.warning).toMatch(/help/i);
    }
  });
});

describe('parseInput — slash commands', () => {
  it('/help → slash with no args', () => {
    expect(parseInput('/help')).toEqual({ kind: 'slash', command: 'help', args: [] });
  });

  it('/help arg1 arg2 arg3 → slash with three args', () => {
    expect(parseInput('/help arg1 arg2 arg3')).toEqual({
      kind: 'slash', command: 'help', args: ['arg1', 'arg2', 'arg3'],
    });
  });

  it('/run "build a TODO app" → slash with single quoted arg', () => {
    expect(parseInput('/run "build a TODO app"')).toEqual({
      kind: 'slash', command: 'run', args: ['build a TODO app'],
    });
  });

  it('/list --limit=5 → flag preserved as-is in args (binder normalises later)', () => {
    expect(parseInput('/list --limit=5')).toEqual({
      kind: 'slash', command: 'list', args: ['--limit=5'],
    });
  });

  it('/cmd --flag value mix → three positional tokens', () => {
    expect(parseInput('/cmd --flag value rest')).toEqual({
      kind: 'slash', command: 'cmd', args: ['--flag', 'value', 'rest'],
    });
  });

  it('command name is lowercased', () => {
    expect(parseInput('/HELP')).toEqual({ kind: 'slash', command: 'help', args: [] });
  });

  it('extra whitespace between args is collapsed', () => {
    expect(parseInput('/run   arg1   arg2')).toEqual({
      kind: 'slash', command: 'run', args: ['arg1', 'arg2'],
    });
  });

  it('escape `\\"` inside double-quoted string', () => {
    expect(parseInput('/run "obj com aspas \\""')).toEqual({
      kind: 'slash', command: 'run', args: ['obj com aspas "'],
    });
  });

  it('multiple quoted args', () => {
    expect(parseInput('/run "first arg" "second arg"')).toEqual({
      kind: 'slash', command: 'run', args: ['first arg', 'second arg'],
    });
  });

  it('single-quoted strings are literal (no escapes)', () => {
    expect(parseInput("/run 'no escape \\\" here'")).toEqual({
      kind: 'slash', command: 'run', args: ['no escape \\" here'],
    });
  });

  it('mix of single and double quotes', () => {
    expect(parseInput(`/run 'first' "second"`)).toEqual({
      kind: 'slash', command: 'run', args: ['first', 'second'],
    });
  });
});

describe('parseInput — bash mode', () => {
  it('!ls -la → bash kind', () => {
    expect(parseInput('!ls -la')).toEqual({ kind: 'bash', command: 'ls -la' });
  });

  it('!echo hello world → bash preserves rest of line', () => {
    expect(parseInput('!echo hello world')).toEqual({
      kind: 'bash', command: 'echo hello world',
    });
  });
});

describe('parseInput — objective', () => {
  it('plain text → objective', () => {
    expect(parseInput('create a tetris game')).toEqual({
      kind: 'objective', text: 'create a tetris game',
    });
  });

  it('text with leading/trailing whitespace is trimmed', () => {
    expect(parseInput('  build a TODO app  ')).toEqual({
      kind: 'objective', text: 'build a TODO app',
    });
  });

  it('multi-line objective preserves internal newlines', () => {
    const input = 'line one\nline two\nline three';
    expect(parseInput(input)).toEqual({
      kind: 'objective', text: 'line one\nline two\nline three',
    });
  });

  it('multi-line objective trims outer whitespace but keeps internal newlines', () => {
    const input = '\n  hello\nworld  \n';
    expect(parseInput(input)).toEqual({
      kind: 'objective', text: 'hello\nworld',
    });
  });
});

describe('parseInput — unterminated quote', () => {
  it('throws ParseError for unterminated double-quoted string with column', () => {
    expect(() => parseInput('/run "incompleto')).toThrow(ParseError);
    try {
      parseInput('/run "incompleto');
    } catch (err) {
      expect(err).toBeInstanceOf(ParseError);
      expect((err as ParseError).message).toMatch(/Unterminated double-quoted string/);
      expect((err as ParseError).message).toMatch(/column/);
      expect((err as ParseError).column).toBeGreaterThanOrEqual(0);
    }
  });

  it('throws ParseError for unterminated single-quoted string', () => {
    expect(() => parseInput("/run 'inacabado")).toThrow(ParseError);
    try {
      parseInput("/run 'inacabado");
    } catch (err) {
      expect((err as ParseError).message).toMatch(/Unterminated single-quoted string/);
    }
  });
});
