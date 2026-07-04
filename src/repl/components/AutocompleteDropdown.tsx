// AutocompleteDropdown — overlay rendered below the prompt when the user presses
// Tab inside an argument (e.g. `/run <workspace>`). Distinct from SlashMenu, which
// fires only when the input begins with `/` and we're matching a command name.
// Pure / controlled — no internal state. Selection lives in the parent.
// See docs/plans/REPL-LEVEL-D.md § 6 (autocomplete) + MB phase.
import React from 'react';
import { Box, Text } from 'ink';
import type { Completion } from '../input/completer.js';
import type { ArgType } from '../commands/types.js';

const MAX_VISIBLE = 8 as const;
const MARKER = '▶';
const NO_MARKER = ' ';

export interface AutocompleteDropdownProps {
  /** ArgType being completed; rendered as a dim label above the list. */
  readonly kind: ArgType;
  /** Suggestions returned by the completer (already filtered + sorted). */
  readonly items: readonly Completion[];
  /** Currently highlighted index — clamped on render. */
  readonly selectedIdx: number;
}

export function AutocompleteDropdown({
  kind,
  items,
  selectedIdx,
}: AutocompleteDropdownProps): React.ReactElement | null {
  if (items.length === 0) {
    return (
      <Box borderStyle="single" borderColor="gray" paddingX={1}>
        <Text dimColor>no completions for &lt;{kind}&gt;</Text>
      </Box>
    );
  }

  const visible = items.slice(0, MAX_VISIBLE);
  const clampedIdx = Math.max(0, Math.min(selectedIdx, visible.length - 1));

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      <Box>
        <Text dimColor>&lt;{kind}&gt;</Text>
      </Box>
      {visible.map((item, idx) => {
        const isSelected = idx === clampedIdx;
        return (
          <Box key={`${item.value}:${idx}`}>
            <Text color={isSelected ? 'cyan' : undefined}>
              {isSelected ? MARKER : NO_MARKER}
            </Text>
            <Text> </Text>
            <Text color="cyan" bold={isSelected}>
              {item.value}
            </Text>
            {item.hint ? (
              <>
                <Text> </Text>
                <Text dimColor>{item.hint}</Text>
              </>
            ) : null}
          </Box>
        );
      })}
      {items.length > MAX_VISIBLE ? (
        <Box>
          <Text dimColor> … {items.length - MAX_VISIBLE} more</Text>
        </Box>
      ) : null}
    </Box>
  );
}
