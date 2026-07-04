// Layout — split horizontal+vertical responsive (D-H2.022).
// Detects terminal size, chooses 1/2/3/4-pane layout via breakpoints.
// See docs/plans/REPL-LEVEL-D.md § 5 (UX spec).
// Implementation phase: MD (responsive); MA boots single-pane only.
import React from 'react';
import { Box } from 'ink';

export function Layout({ children }: { children?: React.ReactNode }): React.ReactElement {
  return <Box flexDirection="column">{children}</Box>;
}
