// ErrorBoundary — React class boundary that catches render errors anywhere below.
// Fallback UI is intentionally minimal (red text, exit hint) — REPL must remain usable.
// Error is also written to stderr so external log capture sees the trace.
// Class component is required: hooks cannot subscribe to React's error lifecycle.
// See docs/plans/REPL-LEVEL-D.md § MA (resilience).
import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import { Box, Text } from 'ink';

export interface ErrorBoundaryProps {
  readonly children: ReactNode;
  /** Optional override for the fallback renderer (used by tests). */
  readonly fallback?: (error: Error) => ReactNode;
}

interface ErrorBoundaryState {
  readonly error: Error | null;
}

const INITIAL_STATE: ErrorBoundaryState = { error: null };

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public readonly state: ErrorBoundaryState = INITIAL_STATE;

  public static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  public componentDidCatch(error: Error, info: ErrorInfo): void {
    // Always log to stderr — silent failures are forbidden by project Tier-0 rules.
    const componentStack = info.componentStack ?? '(no component stack)';
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[repl] render error: ${message}\n${componentStack}\n`,
    );
  }

  public render(): ReactNode {
    const { error } = this.state;
    const { children, fallback } = this.props;

    if (error === null) {
      return children;
    }

    if (fallback) {
      return fallback(error);
    }

    return (
      <Box flexDirection="column" borderStyle="single" borderColor="red" padding={1}>
        <Text color="red" bold>
          REPL crashed: {error.message}
        </Text>
        <Text dimColor>Press Ctrl+D to exit.</Text>
      </Box>
    );
  }
}
