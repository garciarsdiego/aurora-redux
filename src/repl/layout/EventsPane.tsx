// EventsPane — tail dos últimos N events (ring buffer FORA do Zustand).
// Ring cap em src/repl/config.ts EVENT_RING_CAP.
// Implementation phase: MD.
import React from 'react';
import { Box, Text } from 'ink';

export function EventsPane(): React.ReactElement {
  return (
    <Box>
      <Text dimColor>(events pane placeholder)</Text>
    </Box>
  );
}
