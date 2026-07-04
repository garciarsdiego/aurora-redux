// Header — single-line top bar.
// Format:  omniforge · ws:<workspace> [· ▶ <wfId> (<done>/<total>)]
// "omniforge" is rendered with an ink-gradient (cyan → magenta).
// When a workflow is current, a spinner + progress fragment appears.
// Reads workspace via useSession() and current workflow via useWorkflow().
// Implementation phase: MA.
import React from 'react';
import { Box, Text } from 'ink';
import Gradient from 'ink-gradient';
import { Spinner } from '@inkjs/ui';
import { useSession, useWorkflow } from '../state/hooks.js';
import type { TaskRow } from '../state/store.js';

const SEP = ' · ';

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'success',
  'succeeded',
  'failed',
  'error',
  'cancelled',
  'canceled',
  'skipped',
]);

function progressOf(tasks: readonly TaskRow[]): { done: number; total: number } {
  const total = tasks.length;
  let done = 0;
  for (const t of tasks) {
    if (TERMINAL_STATUSES.has(t.status.toLowerCase())) done += 1;
  }
  return { done, total };
}

export function Header(): React.ReactElement {
  const { workspace } = useSession();
  const { currentWfId, tasksByWfId } = useWorkflow();

  const tasks = currentWfId ? tasksByWfId[currentWfId] ?? [] : [];
  const { done, total } = progressOf(tasks);
  const showWorkflow = currentWfId !== null && currentWfId.length > 0;

  return (
    <Box flexDirection="row">
      <Gradient colors={['cyan', 'magenta']}>
        <Text>omniforge</Text>
      </Gradient>
      <Text dimColor>{SEP}</Text>
      <Text dimColor>ws:</Text>
      <Text color="cyan">{workspace}</Text>
      {showWorkflow ? (
        <>
          <Text dimColor>{SEP}</Text>
          <Spinner />
          <Text> </Text>
          <Text color="cyan">{currentWfId}</Text>
          {total > 0 ? (
            <Text dimColor> ({done}/{total})</Text>
          ) : null}
        </>
      ) : null}
    </Box>
  );
}
