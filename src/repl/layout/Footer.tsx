// Footer — single-line bottom bar with static hotkey hints.
// All text is dimmed; no store subscription needed in MA (hints are static).
// Contextual variants (mode-aware hints) ship in MB.
// See docs/plans/REPL-LEVEL-D.md § MA.
import React from 'react';
import { Box, Text } from 'ink';

const SEP = ' · ';

const HINTS: readonly string[] = [
  'F1 help',
  'Ctrl+G gates',
  'Tab autocomplete',
  '/ commands',
  'Ctrl+D exit',
];

export function Footer(): React.ReactElement {
  return (
    <Box flexDirection="row">
      {HINTS.map((hint, i) => (
        <Text key={hint} dimColor>
          {i > 0 ? SEP : ''}
          {hint}
        </Text>
      ))}
    </Box>
  );
}
