// SlashMenu — fuzzy-filtered popup shown when the prompt starts with `/`.
// Two render stages:
//   Stage 1 (no command yet)   — fuzzy list of matching commands.
//   Stage 2 (command recognised) — usage line for the command, with the next
//                                  expected arg highlighted in magenta and any
//                                  remaining args shown dimmed.
// Controlled component: parent owns `filter`, `commands`, `selectedIdx`,
// `recognisedCommand` (Stage 2 trigger) and `argCursor` (which slot the user
// is currently typing into). Selection (Enter) is dispatched via
// `onSelect(cmd)` — keyboard handling lives upstream.
// Fuzzy match: chars from filter must appear IN ORDER in the command name.
//   - Prefix matches rank highest.
//   - Then "all chars match in order".
// Ranking ties broken by command name length ascending (shorter = better).
// Empty filter shows the first 8 registered commands; 0 matches shows a hint.
// See docs/plans/REPL-LEVEL-D.md § MA + § 6 (MB refinements).
import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { ArgSpec, SlashCommand } from '../commands/types.js';

const MAX_RESULTS = 8 as const;
const MARKER = '▶';
const NO_MARKER = ' ';

export interface SlashMenuProps {
  /** Substring after the leading `/` — empty string means "show all". */
  readonly filter: string;
  /** Commands to filter against — caller passes registry contents. */
  readonly commands: readonly SlashCommand[];
  /** Currently highlighted index (0-based) within the visible filtered list. */
  readonly selectedIdx: number;
  /** Stage 2 trigger — when set, the menu renders a usage hint instead. */
  readonly recognisedCommand?: SlashCommand | null;
  /** Index of the arg slot currently being typed (0-based). */
  readonly argCursor?: number;
  /** Invoked when user activates a command (Enter / click). */
  readonly onSelect?: (cmd: SlashCommand) => void;
}

interface RankedCommand {
  readonly cmd: SlashCommand;
  readonly score: number;
}

/**
 * Returns a score >= 0 if `filter` matches `name`, or -1 if no match.
 * Lower score = better match.
 *   - 0   : exact prefix match
 *   - 1   : substring match
 *   - 2+  : in-order char match (score = gap distance)
 *   - -1  : no match
 */
export function fuzzyScore(name: string, filter: string): number {
  if (filter.length === 0) return 0;

  const lowerName = name.toLowerCase();
  const lowerFilter = filter.toLowerCase();

  if (lowerName.startsWith(lowerFilter)) return 0;
  if (lowerName.includes(lowerFilter)) return 1;

  let nameIdx = 0;
  let filterIdx = 0;
  let firstMatchAt = -1;
  let lastMatchAt = -1;

  while (nameIdx < lowerName.length && filterIdx < lowerFilter.length) {
    if (lowerName[nameIdx] === lowerFilter[filterIdx]) {
      if (firstMatchAt === -1) firstMatchAt = nameIdx;
      lastMatchAt = nameIdx;
      filterIdx++;
    }
    nameIdx++;
  }

  if (filterIdx < lowerFilter.length) return -1;

  // 2 + gap distance (smaller window = better).
  const span = lastMatchAt - firstMatchAt;
  return 2 + span;
}

export function rankCommands(
  commands: readonly SlashCommand[],
  filter: string,
): readonly RankedCommand[] {
  const ranked: RankedCommand[] = [];
  for (const cmd of commands) {
    const score = fuzzyScore(cmd.name, filter);
    if (score < 0) continue;
    ranked.push({ cmd, score });
  }
  ranked.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    return a.cmd.name.length - b.cmd.name.length;
  });
  return ranked.slice(0, MAX_RESULTS);
}

function renderArgSlot(
  arg: ArgSpec,
  state: 'past' | 'current' | 'future',
): React.ReactElement {
  const wrap = arg.required ? ['<', '>'] : ['[', ']'];
  const display = `${wrap[0]}${arg.name}${wrap[1]}`;
  if (state === 'current') {
    return <Text color="magenta" dimColor>{display}</Text>;
  }
  return <Text dimColor>{display}</Text>;
}

function CommandUsage({
  cmd,
  argCursor,
}: {
  readonly cmd: SlashCommand;
  readonly argCursor: number;
}): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      <Box>
        <Text color="cyan" bold>/{cmd.name}</Text>
        {cmd.argSpec.map((arg, i) => {
          const state: 'past' | 'current' | 'future' =
            i < argCursor ? 'past' : i === argCursor ? 'current' : 'future';
          return (
            <React.Fragment key={arg.name}>
              <Text> </Text>
              {renderArgSlot(arg, state)}
            </React.Fragment>
          );
        })}
      </Box>
      <Box>
        <Text dimColor>{cmd.description}</Text>
      </Box>
      {cmd.argSpec[argCursor] ? (
        <Box>
          <Text color="magenta">{cmd.argSpec[argCursor]!.name}</Text>
          <Text dimColor>{`: ${cmd.argSpec[argCursor]!.description} (${cmd.argSpec[argCursor]!.type})`}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

export function SlashMenu({
  filter,
  commands,
  selectedIdx,
  recognisedCommand = null,
  argCursor = 0,
}: SlashMenuProps): React.ReactElement | null {
  // Stage 2: command identified and we're inside its arg list — show usage.
  if (recognisedCommand && recognisedCommand.argSpec.length > 0) {
    return <CommandUsage cmd={recognisedCommand} argCursor={argCursor} />;
  }

  const ranked = useMemo(() => rankCommands(commands, filter), [commands, filter]);

  if (ranked.length === 0) {
    const msg = filter.length === 0
      ? 'no commands registered'
      : `no commands match "${filter}"`;
    return (
      <Box borderStyle="single" borderColor="gray" paddingX={1}>
        <Text dimColor>{msg}</Text>
      </Box>
    );
  }

  const clampedIdx = Math.max(0, Math.min(selectedIdx, ranked.length - 1));

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      {ranked.map((entry, idx) => {
        const isSelected = idx === clampedIdx;
        return (
          <Box key={entry.cmd.name}>
            <Text color={isSelected ? 'cyan' : undefined}>
              {isSelected ? MARKER : NO_MARKER}
            </Text>
            <Text> </Text>
            <Text color="cyan" bold={isSelected}>
              /{entry.cmd.name}
            </Text>
            <Text> </Text>
            <Text dimColor>{entry.cmd.description}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
