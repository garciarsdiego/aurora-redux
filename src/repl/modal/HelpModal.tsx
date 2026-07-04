// HelpModal — F1 overlay listing key bindings and registered slash commands by
// category. Pure / props-driven so the App owns modal-stack mutations and the
// component stays testable with ink-testing-library.
// See docs/plans/REPL-LEVEL-D.md § MB and D-H2.022.
import React from 'react';
import { Box, Text } from 'ink';
import type { Category, SlashCommand } from '../commands/types.js';
import { listByCategory } from '../commands/registry.js';

export interface HelpModalProps {
  /** Optional context label shown in the title (e.g. "running workflow"). */
  readonly contextLabel?: string;
  /**
   * Override the registry lookup — used by unit tests so the modal can render
   * without populating the global registry. Production callers omit this.
   */
  readonly commandsByCategory?: ReadonlyMap<Category, readonly SlashCommand[]>;
}

interface KeyBinding {
  readonly keys: string;
  readonly description: string;
}

const NAVIGATION_BINDINGS: readonly KeyBinding[] = [
  { keys: 'Tab',     description: 'autocomplete / queue input' },
  { keys: '↑/↓',     description: 'history / scroll' },
  { keys: 'Ctrl+R',  description: 'history search' },
  { keys: 'Ctrl+L',  description: 'redraw' },
  { keys: 'Ctrl+G',  description: 'open gates queue' },
  { keys: 'Ctrl+C',  description: 'cancel current (2× exits)' },
  { keys: 'Shift+Tab', description: 'cycle permission mode' },
  { keys: 'F1',      description: 'this help' },
  { keys: 'Esc',     description: 'close modal' },
];

const CATEGORY_ORDER: readonly Category[] = [
  'workflow',
  'state',
  'hitl',
  'patterns',
  'config',
  'system',
  'debug',
];

const CATEGORY_LABEL: Readonly<Record<Category, string>> = {
  workflow: 'Workflow',
  state:    'State',
  hitl:     'HITL',
  patterns: 'Patterns',
  config:   'Config',
  system:   'System',
  debug:    'Debug',
};

function commandsForCategory(
  override: HelpModalProps['commandsByCategory'],
  cat: Category,
): readonly SlashCommand[] {
  if (override) return override.get(cat) ?? [];
  return listByCategory(cat);
}

function totalCommands(
  override: HelpModalProps['commandsByCategory'],
): number {
  let n = 0;
  for (const cat of CATEGORY_ORDER) {
    n += commandsForCategory(override, cat).length;
  }
  return n;
}

function CategoryRow({
  cat,
  commands,
}: {
  readonly cat: Category;
  readonly commands: readonly SlashCommand[];
}): React.ReactElement | null {
  if (commands.length === 0) return null;
  const names = commands.map((c) => `/${c.name}`).join(' ');
  return (
    <Box>
      <Text color="cyan">{`  ${CATEGORY_LABEL[cat]}:`.padEnd(12)}</Text>
      <Text>{names}</Text>
    </Box>
  );
}

export function HelpModal({
  contextLabel,
  commandsByCategory,
}: HelpModalProps = {}): React.ReactElement {
  const total = totalCommands(commandsByCategory);
  const titleSuffix = contextLabel ? ` · context: ${contextLabel}` : '';

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="magenta"
      paddingX={1}
      paddingY={0}
    >
      <Box>
        <Text color="cyan" bold>{`Help${titleSuffix}`}</Text>
      </Box>
      <Box>
        <Text> </Text>
      </Box>

      <Box>
        <Text color="cyan" bold>Navigation</Text>
      </Box>
      {NAVIGATION_BINDINGS.map((kb) => (
        <Box key={kb.keys}>
          <Text dimColor>{`  ${kb.keys}`.padEnd(16)}</Text>
          <Text>{kb.description}</Text>
        </Box>
      ))}

      <Box>
        <Text> </Text>
      </Box>
      <Box>
        <Text color="cyan" bold>{`Slash Commands (${total} total)`}</Text>
      </Box>
      {CATEGORY_ORDER.map((cat) => (
        <CategoryRow
          key={cat}
          cat={cat}
          commands={commandsForCategory(commandsByCategory, cat)}
        />
      ))}

      <Box>
        <Text> </Text>
      </Box>
      <Box>
        <Text dimColor>Press Esc to close</Text>
      </Box>
    </Box>
  );
}
