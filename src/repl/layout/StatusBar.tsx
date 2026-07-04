// StatusBar — single-line status display below the OutputPane.
// Format (full):     ws:<X> · model:<Y> · cost:$Z.ZZ · gates:<N> · auto:<mode>
// Format (narrow):   ws:<X> · gates:<N> · auto:<mode>      (cols < TERMINAL_MIN_COLS)
// The narrow variant drops cost+model so the line never wraps in cramped terminals.
// Reads from session + gates slices via Zustand hooks.
// Color rules (per spec § 5):
//   ws/model: cyan
//   cost:     green if $0.00, yellow if > 0
//   gates:    yellow if > 0, dim if 0
//   auto:     red if not 'default', dim otherwise
// Implementation phase: MA.
import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { useSession, useGates } from '../state/hooks.js';
import { TERMINAL_MIN_COLS } from '../config.js';

const SEP = ' · ';

function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

function useColumns(): number {
  const { stdout } = useStdout();
  // Default to TERMINAL_MIN_COLS when stdout doesn't expose `columns` (rare).
  return stdout?.columns ?? TERMINAL_MIN_COLS;
}

export function StatusBar(): React.ReactElement {
  const { workspace, activeModel, costSession, permissionMode } = useSession();
  const { pendingQueue } = useGates();
  const columns = useColumns();

  const modelLabel = activeModel ?? 'unset';
  const gateCount = pendingQueue.length;
  const costLabel = formatCost(costSession);
  const isDefaultMode = permissionMode === 'default';
  const hasCost = costSession > 0;
  const hasGates = gateCount > 0;
  const compact = columns < TERMINAL_MIN_COLS;

  return (
    <Box flexDirection="row">
      <Text dimColor>ws:</Text>
      <Text color="cyan">{workspace}</Text>

      {!compact ? (
        <>
          <Text dimColor>{SEP}</Text>
          <Text dimColor>model:</Text>
          <Text color="cyan">{modelLabel}</Text>
          <Text dimColor>{SEP}</Text>
          <Text dimColor>cost:</Text>
          <Text color={hasCost ? 'yellow' : 'green'}>{costLabel}</Text>
        </>
      ) : null}

      <Text dimColor>{SEP}</Text>
      <Text dimColor>gates:</Text>
      <Text color={hasGates ? 'yellow' : undefined} dimColor={!hasGates}>
        {gateCount}
      </Text>
      <Text dimColor>{SEP}</Text>
      <Text dimColor>auto:</Text>
      <Text color={isDefaultMode ? undefined : 'red'} dimColor={isDefaultMode}>
        {permissionMode}
      </Text>
    </Box>
  );
}
