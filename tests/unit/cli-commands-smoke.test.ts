/**
 * Wave 3 — M1-W3-B / Agent test-automator.
 *
 * Smoke tests for CLI command handlers that lacked direct unit coverage.
 * Vol.2 audit found 9 of 13 CLI commands without a `register*` smoke test:
 *   run, daemon, init, list, status, patterns, mcp-server, resume,
 *   doctor, repl.
 *
 * Approach: register the command into a fresh `Command` instance and
 * assert the resulting subcommand shape (name, description, positional
 * arity, option declarations). For pure-helper exports (e.g.
 * `runStartupSweeps`), drive them with an in-memory DB. Skip commands
 * that need a running daemon or interactive TTY — those are integration
 * concerns covered elsewhere (daemon-smoke / e2e).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { registerRun } from '../../src/cli/commands/run.js';
import { registerDaemon, runStartupSweeps, runStartupAsyncSweeps } from '../../src/cli/commands/daemon.js';
import { registerInit } from '../../src/cli/commands/init.js';
import { registerList } from '../../src/cli/commands/list.js';
import { registerStatus } from '../../src/cli/commands/status.js';
import { registerPatterns } from '../../src/cli/commands/patterns.js';
import { registerMcpServer } from '../../src/cli/commands/mcp-server.js';
import { registerResume } from '../../src/cli/commands/resume.js';
import { registerDoctor } from '../../src/cli/commands/doctor.js';
import { registerRepl } from '../../src/cli/commands/repl.js';
import { initDb } from '../../src/db/client.js';

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function freshProgram(): Command {
  const p = new Command();
  p.exitOverride();
  p.configureOutput({
    writeOut: () => undefined,
    writeErr: () => undefined,
  });
  return p;
}

function findCommand(program: Command, name: string): Command | undefined {
  return program.commands.find((c) => c.name() === name);
}

function programFor(register: (p: Command) => void): Command {
  const p = freshProgram();
  register(p);
  return p;
}

// ────────────────────────────────────────────────────────────────────────────
// `omniforge run`
// ────────────────────────────────────────────────────────────────────────────

describe('omniforge run command', () => {
  it('registers with required <objective> positional and required --workspace option', () => {
    const cmd = findCommand(programFor(registerRun), 'run')!;
    expect(cmd).toBeDefined();
    expect(cmd.description()).toMatch(/decompose|workflow/i);
    expect(cmd.registeredArguments[0]?.name()).toBe('objective');
    expect(cmd.registeredArguments[0]?.required).toBe(true);
    const ws = cmd.options.find((o) => o.long === '--workspace');
    expect(ws).toBeDefined();
    expect(ws!.required).toBe(true);
  });

  it('exposes --auto-approve and --no-pattern flags', () => {
    const cmd = findCommand(programFor(registerRun), 'run')!;
    expect(cmd.options.some((o) => o.long === '--auto-approve')).toBe(true);
    expect(cmd.options.some((o) => o.long === '--no-pattern')).toBe(true);
  });

  it('rejects parse when --workspace is missing', () => {
    const p = programFor(registerRun);
    expect(() => p.parse(['run', 'do thing'], { from: 'user' })).toThrow();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// `omniforge daemon` — registration + pure-helper smoke
// ────────────────────────────────────────────────────────────────────────────

describe('omniforge daemon command', () => {
  it('registers parent with 4 subcommands, each with a description', () => {
    const cmd = findCommand(programFor(registerDaemon), 'daemon')!;
    expect(cmd).toBeDefined();
    const subNames = cmd.commands.map((c) => c.name());
    expect(subNames).toEqual(expect.arrayContaining(['start', 'stop', 'status', 'restart']));
    for (const sub of cmd.commands) {
      expect((sub.description() ?? '').length).toBeGreaterThan(0);
    }
  });

  it('runStartupSweeps returns shape with walTickStop and counters', () => {
    const db = initDb(':memory:');
    try {
      const result = runStartupSweeps(db);
      expect(typeof result.walTickStop).toBe('function');
      expect(typeof result.leasesRecovered).toBe('number');
      expect(typeof result.subagentOrphansFound).toBe('number');
      expect(typeof result.subagentOrphansRecovered).toBe('number');
      result.walTickStop();
    } finally {
      db.close();
    }
  });

  it('runStartupAsyncSweeps returns remediationPickedUp/Failed counters', async () => {
    const db = initDb(':memory:');
    try {
      const result = await runStartupAsyncSweeps(db);
      expect(typeof result.remediationPickedUp).toBe('number');
      expect(typeof result.remediationFailed).toBe('number');
    } finally {
      db.close();
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// `omniforge init`
// ────────────────────────────────────────────────────────────────────────────

describe('omniforge init command', () => {
  it('registers with required <workspace> positional', () => {
    const cmd = findCommand(programFor(registerInit), 'init')!;
    expect(cmd).toBeDefined();
    expect(cmd.description()).toMatch(/workspace/i);
    expect(cmd.registeredArguments[0]?.name()).toBe('workspace');
    expect(cmd.registeredArguments[0]?.required).toBe(true);
  });

  it('rejects parse when workspace argument is missing', () => {
    const p = programFor(registerInit);
    expect(() => p.parse(['init'], { from: 'user' })).toThrow();
  });

  it('creates workspace directory + .env + .hitl.json scaffolding', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'omniforge-init-smoke-'));
    const origCwd = process.cwd();
    try {
      process.chdir(tmp);
      const p = programFor(registerInit);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      await p.parseAsync(['init', 'smoketest'], { from: 'user' });
      logSpy.mockRestore();

      const wsDir = join(tmp, 'workspaces', 'smoketest');
      expect(existsSync(wsDir)).toBe(true);
      expect(existsSync(join(wsDir, '.env'))).toBe(true);
      expect(existsSync(join(wsDir, '.hitl.json'))).toBe(true);
      expect(existsSync(join(wsDir, 'patterns'))).toBe(true);
      const hitl = JSON.parse(readFileSync(join(wsDir, '.hitl.json'), 'utf8'));
      expect(hitl).toMatchObject({ channel: 'cli' });
    } finally {
      process.chdir(origCwd);
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// `omniforge list`
// ────────────────────────────────────────────────────────────────────────────

describe('omniforge list command', () => {
  it('registers with optional --workspace and --limit options (default limit=10)', () => {
    const cmd = findCommand(programFor(registerList), 'list')!;
    expect(cmd).toBeDefined();
    expect(cmd.description()).toMatch(/workflow/i);
    const ws = cmd.options.find((o) => o.long === '--workspace');
    const limit = cmd.options.find((o) => o.long === '--limit');
    expect(ws).toBeDefined();
    expect(limit).toBeDefined();
    expect(limit?.defaultValue).toBe('10');
    // Neither option is mandatory (operator can run bare `omniforge list`).
    expect(ws!.mandatory).toBe(false);
    expect(limit!.mandatory).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// `omniforge status`
// ────────────────────────────────────────────────────────────────────────────

describe('omniforge status command', () => {
  it('registers with optional workflow_id positional', () => {
    const cmd = findCommand(programFor(registerStatus), 'status')!;
    expect(cmd).toBeDefined();
    expect(cmd.description()).toMatch(/workflow/i);
    expect(cmd.registeredArguments[0]?.name()).toBe('workflow_id');
    expect(cmd.registeredArguments[0]?.required).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// `omniforge patterns`
// ────────────────────────────────────────────────────────────────────────────

describe('omniforge patterns command', () => {
  it('registers parent with 3 subcommands (list/save/delete)', () => {
    const cmd = findCommand(programFor(registerPatterns), 'patterns')!;
    expect(cmd).toBeDefined();
    const subNames = cmd.commands.map((c) => c.name());
    expect(subNames).toEqual(expect.arrayContaining(['list', 'save', 'delete']));
  });

  it('list requires --workspace, save takes <workflow_id> <name>, delete takes <pattern_id>', () => {
    const parent = findCommand(programFor(registerPatterns), 'patterns')!;
    const list = parent.commands.find((c) => c.name() === 'list')!;
    const save = parent.commands.find((c) => c.name() === 'save')!;
    const del = parent.commands.find((c) => c.name() === 'delete')!;

    const ws = list.options.find((o) => o.long === '--workspace');
    expect(ws?.required).toBe(true);

    expect(save.registeredArguments).toHaveLength(2);
    expect(save.registeredArguments[0]?.name()).toBe('workflow_id');
    expect(save.registeredArguments[1]?.name()).toBe('name');

    expect(del.registeredArguments[0]?.name()).toBe('pattern_id');
    expect(del.registeredArguments[0]?.required).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// `omniforge mcp-server`, `repl`, `doctor` — registration shape only
// ────────────────────────────────────────────────────────────────────────────

describe('omniforge mcp-server command', () => {
  it('registers with no positional arguments', () => {
    const cmd = findCommand(programFor(registerMcpServer), 'mcp-server')!;
    expect(cmd).toBeDefined();
    expect(cmd.description()).toMatch(/mcp|stdio|claude/i);
    expect(cmd.registeredArguments).toHaveLength(0);
  });
});

describe('omniforge doctor command', () => {
  it('registers with no positional arguments and a diagnostic description', () => {
    const cmd = findCommand(programFor(registerDoctor), 'doctor')!;
    expect(cmd).toBeDefined();
    expect(cmd.description()).toMatch(/diagnos/i);
    expect(cmd.registeredArguments).toHaveLength(0);
  });
});

describe('omniforge repl command', () => {
  it('registers with default --workspace=internal and a full option set', () => {
    const cmd = findCommand(programFor(registerRepl), 'repl')!;
    expect(cmd).toBeDefined();
    expect(cmd.description()).toMatch(/repl|interactive|tui/i);
    const longs = cmd.options.map((o) => o.long);
    expect(longs).toEqual(
      expect.arrayContaining([
        '--workspace',
        '--auto-approve',
        '--model',
        '--ephemeral',
        '--no-daemon',
        '--require-daemon',
      ]),
    );
    expect(cmd.options.find((o) => o.long === '--workspace')?.defaultValue).toBe('internal');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// `omniforge resume`
// ────────────────────────────────────────────────────────────────────────────

describe('omniforge resume command', () => {
  it('registers with required <workflow_id> positional + --skip-failed-steps/--auto-approve flags', () => {
    const cmd = findCommand(programFor(registerResume), 'resume')!;
    expect(cmd).toBeDefined();
    expect(cmd.description()).toMatch(/resume|paused|failed/i);
    expect(cmd.registeredArguments[0]?.name()).toBe('workflow_id');
    expect(cmd.registeredArguments[0]?.required).toBe(true);
    expect(cmd.options.some((o) => o.long === '--skip-failed-steps')).toBe(true);
    expect(cmd.options.some((o) => o.long === '--auto-approve')).toBe(true);
  });

  it('rejects parse when workflow_id is missing', () => {
    const p = programFor(registerResume);
    expect(() => p.parse(['resume'], { from: 'user' })).toThrow();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Full tree — all 10 commands coexist
// ────────────────────────────────────────────────────────────────────────────

describe('full Commander tree — all 10 register* calls coexist', () => {
  let originalCwd: string;
  beforeEach(() => {
    originalCwd = process.cwd();
  });
  afterEach(() => {
    process.chdir(originalCwd);
  });

  it('exposes all expected top-level command names with no duplicates', () => {
    const p = freshProgram();
    registerRun(p);
    registerDaemon(p);
    registerInit(p);
    registerList(p);
    registerStatus(p);
    registerPatterns(p);
    registerMcpServer(p);
    registerResume(p);
    registerDoctor(p);
    registerRepl(p);

    const names = p.commands.map((c) => c.name());
    const sorted = [...names].sort();
    expect(sorted).toEqual(
      [
        'daemon',
        'doctor',
        'init',
        'list',
        'mcp-server',
        'patterns',
        'repl',
        'resume',
        'run',
        'status',
      ].sort(),
    );
    expect(new Set(names).size).toBe(names.length);
  });
});
