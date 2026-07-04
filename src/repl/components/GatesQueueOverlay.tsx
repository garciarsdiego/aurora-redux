// GatesQueueOverlay — Ctrl+G overlay listing all pending gates FIFO.
// Selecting a non-head gate doesn't reorder the queue (FIFO is sacred for
// audit). Instead it pops back to the HITL modal which still shows the head;
// the user must resolve the head before others (or background it). This
// matches D-H2.029: head only advances on resolveHead.
//
// Hotkeys:
//   ↑ / ↓     — move selection
//   Enter     — close overlay (modal returns to HITL flow on the head gate)
//   Shift+A   — push a confirm modal that approves all gates in order
//   Esc       — close overlay (no action)
import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useReplStore } from '../state/store.js';

export function GatesQueueOverlay(): React.ReactElement {
  const pendingQueue = useReplStore((s) => s.gates.pendingQueue);
  const popModal = useReplStore((s) => s.ui.popModal);
  const pushModal = useReplStore((s) => s.ui.pushModal);

  const [selectedIdx, setSelectedIdx] = useState(0);

  // Clamp selection if queue shrinks underneath us.
  useEffect(() => {
    if (selectedIdx >= pendingQueue.length) {
      setSelectedIdx(Math.max(0, pendingQueue.length - 1));
    }
  }, [pendingQueue.length, selectedIdx]);

  useInput((input, key) => {
    if (key.escape) {
      popModal();
      return;
    }
    if (key.upArrow) {
      setSelectedIdx((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIdx((i) => Math.min(pendingQueue.length - 1, i + 1));
      return;
    }
    if (key.return) {
      // Closing the overlay returns the user to the HITL flow which always
      // operates on the head — no head reordering is allowed via this UI.
      popModal();
      return;
    }
    // Shift+A — bulk approve. Shift detection in Ink is best-effort: capital
    // A typically arrives as input='A' with key.shift true on most terminals.
    if (input === 'A' && key.shift) {
      pushModal('confirm:approve-all', {
        prompt: `Approve all ${pendingQueue.length} pending gates?`,
        destructive: false,
        defaultAction: 'n' as const,
        onConfirm: () => {
          // Deferred to App-level: only the App has access to the daemon
          // client to dispatch resolves. We just close the overlay.
        },
        onCancel: () => {
          // noop
        },
      });
      return;
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      paddingY={0}
    >
      <Box>
        <Text color="cyan" bold>Gates Queue</Text>
        <Text dimColor>{` \u00B7 ${pendingQueue.length} pending`}</Text>
      </Box>

      {pendingQueue.length === 0 ? (
        <Box>
          <Text dimColor>(no pending gates)</Text>
        </Box>
      ) : (
        pendingQueue.map((gate, i) => {
          const isSelected = i === selectedIdx;
          const isHead = i === 0;
          const marker = isSelected ? '\u25B6' : ' ';
          const headTag = isHead ? ' (focused)' : '';
          const wfShort = gate.wfId.length > 16 ? gate.wfId.slice(0, 16) + '\u2026' : gate.wfId;
          const taskShort = gate.taskId.length > 12 ? gate.taskId.slice(0, 12) + '\u2026' : gate.taskId;
          return (
            <Box key={gate.id}>
              <Text color={isSelected ? 'cyan' : undefined}>{marker}</Text>
              <Text> </Text>
              <Text dimColor>{(i + 1).toString().padStart(2)}</Text>
              <Text dimColor>{' \u00B7 '}</Text>
              <Text color="cyan">{wfShort}</Text>
              <Text dimColor>{' \u00B7 '}</Text>
              <Text>{taskShort}</Text>
              <Text dimColor>{' \u00B7 '}</Text>
              <Text>{gate.info.kind}</Text>
              {headTag ? <Text color="green">{headTag}</Text> : null}
            </Box>
          );
        })
      )}

      <Box>
        <Text dimColor>[</Text>
        <Text color="cyan">{'\u2191\u2193'}</Text>
        <Text dimColor>] select \u00B7 [</Text>
        <Text color="green" bold>Enter</Text>
        <Text dimColor>] back to head \u00B7 [</Text>
        <Text color="yellow" bold>Shift+A</Text>
        <Text dimColor>] approve all \u00B7 [</Text>
        <Text color="cyan" bold>Esc</Text>
        <Text dimColor>] hide</Text>
      </Box>
    </Box>
  );
}
