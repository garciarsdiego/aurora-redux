import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerCommand,
  lookupCommand,
  listCommands,
  listByCategory,
  resolveAlias,
  clearRegistry,
} from '../../../src/repl/commands/registry.js';
import type { SlashCommand } from '../../../src/repl/commands/types.js';

function makeCmd(overrides: Partial<SlashCommand> = {}): SlashCommand {
  return {
    name: 'test-cmd',
    category: 'system',
    description: 'Test command',
    helpText: 'A test command for unit tests.',
    argSpec: [],
    autoExecute: true,
    mutates: false,
    async handler() { return { output: 'ok' }; },
    ...overrides,
  };
}

beforeEach(() => {
  clearRegistry();
});

describe('registerCommand + lookupCommand', () => {
  it('registers a command and retrieves it by name', () => {
    const cmd = makeCmd({ name: 'greet' });
    registerCommand(cmd);
    expect(lookupCommand('greet')).toBe(cmd);
  });

  it('returns undefined for unknown command', () => {
    expect(lookupCommand('nonexistent')).toBeUndefined();
  });

  it('lookup by alias returns the same command object', () => {
    const cmd = makeCmd({ name: 'exit', aliases: ['quit'] });
    registerCommand(cmd);
    expect(lookupCommand('quit')).toBe(cmd);
    expect(lookupCommand('exit')).toBe(cmd);
  });

  it('multiple aliases all populate the map', () => {
    const cmd = makeCmd({ name: 'run', aliases: ['r', 'go'] });
    registerCommand(cmd);
    expect(lookupCommand('r')).toBe(cmd);
    expect(lookupCommand('go')).toBe(cmd);
    expect(lookupCommand('run')).toBe(cmd);
  });
});

describe('resolveAlias', () => {
  it('returns canonical name when looking up by alias', () => {
    registerCommand(makeCmd({ name: 'exit', aliases: ['quit'] }));
    expect(resolveAlias('quit')).toBe('exit');
  });

  it('returns the same name when looking up canonical name', () => {
    registerCommand(makeCmd({ name: 'help' }));
    expect(resolveAlias('help')).toBe('help');
  });

  it('returns undefined for unknown name', () => {
    expect(resolveAlias('nope')).toBeUndefined();
  });
});

describe('listCommands', () => {
  it('deduplicates aliased commands (returns unique by identity)', () => {
    const cmd = makeCmd({ name: 'exit', aliases: ['quit'] });
    registerCommand(cmd);
    const all = listCommands();
    expect(all).toHaveLength(1);
    expect(all[0]).toBe(cmd);
  });

  it('returns all registered distinct commands', () => {
    registerCommand(makeCmd({ name: 'alpha', category: 'system' }));
    registerCommand(makeCmd({ name: 'beta', category: 'workflow' }));
    expect(listCommands()).toHaveLength(2);
  });
});

describe('listByCategory', () => {
  it('filters correctly by category', () => {
    registerCommand(makeCmd({ name: 'run', category: 'workflow' }));
    registerCommand(makeCmd({ name: 'status', category: 'workflow' }));
    registerCommand(makeCmd({ name: 'help', category: 'system' }));

    const workflow = listByCategory('workflow');
    expect(workflow).toHaveLength(2);
    expect(workflow.map((c) => c.name)).toContain('run');
    expect(workflow.map((c) => c.name)).toContain('status');

    const system = listByCategory('system');
    expect(system).toHaveLength(1);
    expect(system[0]!.name).toBe('help');
  });

  it('returns empty array for category with no commands', () => {
    expect(listByCategory('debug')).toHaveLength(0);
  });

  it('deduplicates aliased commands per category', () => {
    const cmd = makeCmd({ name: 'exit', aliases: ['quit'], category: 'system' });
    registerCommand(cmd);
    expect(listByCategory('system')).toHaveLength(1);
  });
});

describe('clearRegistry', () => {
  it('empties the registry so lookups return undefined', () => {
    registerCommand(makeCmd({ name: 'run' }));
    clearRegistry();
    expect(lookupCommand('run')).toBeUndefined();
    expect(listCommands()).toHaveLength(0);
  });

  it('allows re-registration after clear', () => {
    registerCommand(makeCmd({ name: 'run' }));
    clearRegistry();
    registerCommand(makeCmd({ name: 'run' }));
    expect(lookupCommand('run')).toBeDefined();
  });
});
