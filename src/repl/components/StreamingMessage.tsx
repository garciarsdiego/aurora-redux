// StreamingMessage — renders TokenBuffer contents incrementally via
// useSyncExternalStore. NOT a child of <Static/>: this component re-renders
// every time tokenBuffer.version bumps (~30fps via setImmediate batching).
//
// Layout (single-pane MA / live area MD):
//   ⏵⏵ <task_name>  (cyan animated)
//   <streamed text...>
//
// When streamingTaskId === null, renders nothing — App swaps it out for an
// idle state.

import React, { useSyncExternalStore } from 'react';
import { Box, Text } from 'ink';
import { tokenBuffer } from '../state/tokenBuffer.js';

export function StreamingMessage(): React.ReactElement | null {
  // Subscribe to version bumps. getSnapshot returns a number → React skips
  // renders when the value is unchanged (Object.is comparison).
  useSyncExternalStore(
    tokenBuffer.subscribe.bind(tokenBuffer),
    tokenBuffer.getSnapshot.bind(tokenBuffer),
    tokenBuffer.getSnapshot.bind(tokenBuffer), // server snapshot (Node === client here)
  );

  const taskId = tokenBuffer.streamingTaskId;
  if (taskId === null) return null;

  const text = tokenBuffer.readJoined();

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan">⏵⏵ </Text>
        <Text color="cyan" dimColor>{taskId}</Text>
      </Box>
      <Box>
        <Text>{text}</Text>
      </Box>
    </Box>
  );
}
