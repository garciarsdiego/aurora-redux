// OutputPane — append-only display using Ink <Static>.
// <Static> renders items once and never re-renders them; correct for REPL output.
// Two modes:
//   - Controlled  : caller passes `items` prop (App-level orchestration).
//   - Singleton   : caller omits `items` → subscribes to outputBuffer ESM singleton.
// Singleton mode is what M0 / current MA wires; controlled mode is for tests + future.
// Uses useSyncExternalStore so React 18 concurrent rendering is safe.
// See docs/plans/REPL-LEVEL-D.md § 5 (OutputPane singleton note).
import React, { useSyncExternalStore } from 'react';
import { Static, Box, Text } from 'ink';
import {
  subscribeOutput,
  getOutputSnapshot,
  type OutputItem,
  type OutputKind,
} from '../state/outputBuffer.js';

export type { OutputItem, OutputKind };

export interface OutputPaneProps {
  /** When provided, OutputPane renders these items and bypasses the singleton. */
  readonly items?: readonly OutputItem[];
}

/** Map output kind to an Ink color string. */
function colorFor(kind: OutputKind): string {
  switch (kind) {
    case 'cmd':
      return 'cyan';
    case 'output':
      return 'green';
    case 'error':
      return 'red';
    case 'info':
    default:
      return 'gray';
  }
}

/** Format a Unix timestamp as HH:MM:SS. */
function formatTime(ts: number): string {
  return new Date(ts).toISOString().slice(11, 19);
}

function OutputRow({ item }: { item: OutputItem }): React.ReactElement {
  return (
    <Box>
      <Text dimColor>[{formatTime(item.ts)}]</Text>
      <Text> </Text>
      <Text color={colorFor(item.kind)}>{item.text}</Text>
    </Box>
  );
}

export function OutputPane({ items }: OutputPaneProps = {}): React.ReactElement {
  // Subscribe to the singleton when no explicit items prop was passed.
  const subscribed = useSyncExternalStore(
    subscribeOutput,
    getOutputSnapshot,
    getOutputSnapshot,
  );
  const list: readonly OutputItem[] = items ?? subscribed;

  // <Static> requires a mutable array per Ink's typed signature; the cast is safe
  // because Static only iterates without mutating.
  return (
    <Static items={list as OutputItem[]}>
      {(item: OutputItem) => <OutputRow key={item.id} item={item} />}
    </Static>
  );
}
