// /help [command_name?] — list all commands grouped by category, or show detail for one.
import type { SlashCommand, SlashResult, ReplCtx, Category } from '../types.js';
import { listCommands, lookupCommand } from '../registry.js';

interface HelpArgs {
  command?: string;
}

// Covers the full (closed) Category union — keep in sync if the union grows.
const CATEGORY_ORDER: readonly Category[] = [
  'workflow',
  'hitl',
  'patterns',
  'config',
  'state',
  'system',
  'debug',
];

function formatAll(): string {
  const byCategory = new Map<Category, SlashCommand[]>();

  for (const cmd of listCommands()) {
    const existing = byCategory.get(cmd.category) ?? [];
    existing.push(cmd);
    byCategory.set(cmd.category, existing);
  }

  const lines: string[] = [];

  for (const cat of CATEGORY_ORDER) {
    const cmds = byCategory.get(cat);
    if (!cmds || cmds.length === 0) continue;

    lines.push(cat.toUpperCase());
    for (const cmd of cmds) {
      const aliases = cmd.aliases && cmd.aliases.length > 0
        ? ` (${cmd.aliases.join(', ')})`
        : '';
      lines.push(`  /${cmd.name.padEnd(14)}${cmd.description}${aliases}`);
    }
    lines.push('');
  }

  lines.push('Type /help <command> for detailed usage.');
  return lines.join('\n').trimEnd();
}

function formatOne(name: string): SlashResult {
  const cmd = lookupCommand(name);
  if (!cmd) {
    return { error: new Error(`Unknown command: /${name}`) };
  }

  const lines: string[] = [
    `/${cmd.name} — ${cmd.description}`,
    '',
    cmd.helpText,
  ];

  if (cmd.argSpec.length > 0) {
    lines.push('', 'Arguments:');
    for (const arg of cmd.argSpec) {
      const req = arg.required ? '(required)' : '(optional)';
      const def = arg.default !== undefined ? ` [default: ${String(arg.default)}]` : '';
      lines.push(`  ${arg.name.padEnd(16)}${req} ${arg.type}${def}  ${arg.description}`);
    }
  }

  if (cmd.aliases && cmd.aliases.length > 0) {
    lines.push('', `Aliases: ${cmd.aliases.map((a) => `/${a}`).join(', ')}`);
  }

  return { output: lines.join('\n') };
}

export const helpCommand: SlashCommand<HelpArgs> = {
  name: 'help',
  category: 'system',
  description: 'Show available commands or detail for one command',
  helpText: 'Without arguments, lists all commands grouped by category.\nWith an argument, shows the full help for that command.',
  argSpec: [
    {
      name: 'command',
      type: 'string',
      required: false,
      description: 'Command name to inspect (without leading /)',
    },
  ],
  autoExecute: true,
  mutates: false,

  async handler(args: HelpArgs, _ctx: ReplCtx): Promise<SlashResult> {
    if (args.command) {
      return formatOne(args.command);
    }
    return { output: formatAll() };
  },
};
