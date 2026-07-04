// ConfirmModal — generic confirmation dialog for destructive actions
// (kill workflow, drop pattern, /reject without an active gate, etc.).
// requireText is used for high-stakes prompts (e.g. /danger-auto-approve must
// type "I understand"). When set, the user must type the exact string before
// onConfirm fires.
// ENTER on an empty line falls back to defaultAction (default 'n'). Esc always
// cancels. See docs/plans/REPL-LEVEL-D.md § 5 (state 11 cost-limit reuses this).
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput } from '@inkjs/ui';

export interface ConfirmModalProps {
  readonly prompt: string;
  /** Border red when true; yellow otherwise. */
  readonly destructive?: boolean;
  /** Exact text the user must type before onConfirm fires (e.g. "I understand"). */
  readonly requireText?: string;
  /** Decision when ENTER hits an empty line. Default 'n'. */
  readonly defaultAction?: 'y' | 'n';
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

export function ConfirmModal({
  prompt,
  destructive = false,
  requireText,
  defaultAction = 'n',
  onConfirm,
  onCancel,
}: ConfirmModalProps): React.ReactElement {
  const [mismatch, setMismatch] = useState(false);

  // Esc → onCancel always. Y/N intercepts only when no requireText is set.
  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }

    if (requireText !== undefined) return; // input handled by TextInput below

    const lower = input.toLowerCase();
    if (lower === 'y') {
      onConfirm();
      return;
    }
    if (lower === 'n') {
      onCancel();
      return;
    }
  });

  const borderColor = destructive ? 'red' : 'yellow';

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
      paddingY={0}
    >
      <Box>
        <Text color={borderColor} bold>
          {destructive ? '\u26A0  ' : '? '}
        </Text>
        <Text>{prompt}</Text>
      </Box>

      {requireText !== undefined ? (
        <Box flexDirection="column">
          <Box>
            <Text dimColor>Type exactly </Text>
            <Text color={borderColor} bold>{requireText}</Text>
            <Text dimColor> then Enter to confirm. Esc to cancel.</Text>
          </Box>
          {mismatch ? (
            <Box>
              <Text color="red">exact match required</Text>
            </Box>
          ) : null}
          <Box>
            <Text color={borderColor}>{'> '}</Text>
            <TextInput
              placeholder={requireText}
              onSubmit={(value) => {
                if (value === requireText) {
                  setMismatch(false);
                  onConfirm();
                  return;
                }
                setMismatch(true);
              }}
            />
          </Box>
        </Box>
      ) : (
        <Box>
          <Text dimColor>[</Text>
          <Text color={defaultAction === 'y' ? borderColor : undefined} bold={defaultAction === 'y'}>
            y
          </Text>
          <Text dimColor>/</Text>
          <Text color={defaultAction === 'n' ? borderColor : undefined} bold={defaultAction === 'n'}>
            n
          </Text>
          <Text dimColor>] (Enter = </Text>
          <Text color={borderColor}>{defaultAction}</Text>
          <Text dimColor>) </Text>
          <DefaultActionInput
            defaultAction={defaultAction}
            onConfirm={onConfirm}
            onCancel={onCancel}
          />
        </Box>
      )}
    </Box>
  );
}

interface DefaultActionInputProps {
  readonly defaultAction: 'y' | 'n';
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/**
 * Captures a one-shot Enter so the parent can wire ENTER → defaultAction.
 * The visible y/n hint above already reflects the default; the input itself
 * is silent (no placeholder rendered).
 */
function DefaultActionInput({
  defaultAction,
  onConfirm,
  onCancel,
}: DefaultActionInputProps): React.ReactElement {
  return (
    <TextInput
      placeholder=""
      onSubmit={(value) => {
        const trimmed = value.trim().toLowerCase();
        if (trimmed === '') {
          if (defaultAction === 'y') onConfirm();
          else onCancel();
          return;
        }
        if (trimmed === 'y') {
          onConfirm();
          return;
        }
        if (trimmed === 'n') {
          onCancel();
          return;
        }
        // Any other text → treat as cancel (safest default for destructive ops).
        onCancel();
      }}
    />
  );
}
