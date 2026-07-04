import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import cursorParser from '../../src/v2/cli-tail/parsers/cursor.js';
import geminiParser from '../../src/v2/cli-tail/parsers/gemini.js';

describe('captured CLI transcript parsers', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'omniforge-cli-tail-captured-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('cursor happy path: extracts stdout/stderr sections from captured sample', () => {
    const file = path.join(dir, 'cursor.txt');
    writeFileSync(
      file,
      [
        'cli: cursor',
        'captured_at: 2026-05-05T23:49:37.230Z',
        'timeout_ms: 30000',
        '',
        'attempt: 1',
        'command: cursor --version',
        'started_at: 2026-05-05T23:49:36.909Z',
        'timed_out: false',
        'exit_code: 0',
        '--- stdout ---',
        '3.2.16',
        '3e548838cf824b70851dd3ef27d0c6aae371b3f0',
        'x64',
        '--- stderr ---',
        '<empty>',
      ].join('\n'),
      'utf8',
    );

    const events = cursorParser.parse(file);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      kind: 'message',
      role: 'assistant',
      text: '3.2.16\n3e548838cf824b70851dd3ef27d0c6aae371b3f0\nx64',
    });
    expect(events[1]).toMatchObject({ kind: 'meta', text: 'stderr: <empty>' });
  });

  it('cursor malformed line: skips broken metadata and still extracts stdout', () => {
    const file = path.join(dir, 'cursor-malformed.txt');
    writeFileSync(
      file,
      [
        'cli cursor',
        'captured_at: 2026-05-05T23:49:37.230Z',
        '--- stdout ---',
        '3.2.16',
        '--- stderr ---',
        '<empty>',
      ].join('\n'),
      'utf8',
    );

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const events = cursorParser.parse(file);

      expect(events[0]).toMatchObject({ kind: 'message', role: 'assistant', text: '3.2.16' });
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('malformed capture metadata line'));
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('gemini happy path: extracts stdout/stderr sections from captured sample', () => {
    const file = path.join(dir, 'gemini-cli.txt');
    writeFileSync(
      file,
      [
        'cli: gemini-cli',
        'captured_at: 2026-05-05T23:49:36.908Z',
        'timeout_ms: 30000',
        '',
        'attempt: 1',
        'command: gemini -p echo hi',
        'started_at: 2026-05-05T23:49:25.379Z',
        'timed_out: false',
        'exit_code: 0',
        '--- stdout ---',
        'hi',
        'The environment is set up and ready. How can I help you today?',
        '--- stderr ---',
        'Warning: 256-color support not detected. Using a terminal with at least 256-color support is recommended for a better visual experience.',
        'Ripgrep is not available. Falling back to GrepTool.',
      ].join('\n'),
      'utf8',
    );

    const events = geminiParser.parse(file);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      kind: 'message',
      role: 'assistant',
      text: 'hi\nThe environment is set up and ready. How can I help you today?',
    });
    expect(events[1]).toMatchObject({
      kind: 'meta',
      text: 'stderr: Warning: 256-color support not detected. Using a terminal with at least 256-color support is recommended for a better visual experience.\nRipgrep is not available. Falling back to GrepTool.',
    });
  });

  it('gemini malformed line: skips broken metadata and still extracts stderr', () => {
    const file = path.join(dir, 'gemini-malformed.txt');
    writeFileSync(
      file,
      [
        'cli gemini-cli',
        'captured_at: 2026-05-05T23:49:36.908Z',
        '--- stdout ---',
        'hi',
        '--- stderr ---',
        'Warning: terminal color degraded.',
      ].join('\n'),
      'utf8',
    );

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const events = geminiParser.parse(file);

      expect(events[1]).toMatchObject({ kind: 'meta', text: 'stderr: Warning: terminal color degraded.' });
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('malformed capture metadata line'));
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
