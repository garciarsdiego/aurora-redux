// HitlSubModes — sub-mode bodies for HitlModal (reject confirm + modify text).
// Split out so HitlModal stays under the 250 LOC ceiling and these
// sub-renderers can be unit-tested in isolation later (M E hardening phase).
import React from 'react';
import { Box, Text } from 'ink';
import { TextInput } from '@inkjs/ui';

export interface RejectConfirmProps {
  readonly onConfirmReject: (reason?: string) => void;
  readonly onCancel: () => void;
}

export function RejectConfirmBody({
  onConfirmReject,
  onCancel,
}: RejectConfirmProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Box>
        <Text color="red" bold>Confirm reject?</Text>
        <Text dimColor> Type </Text>
        <Text color="red" bold>y</Text>
        <Text dimColor>+Enter to abort the workflow, Esc to keep the gate.</Text>
      </Box>
      <Box>
        <Text color="red">{'> '}</Text>
        <TextInput
          placeholder="y"
          onSubmit={(value) => {
            const lower = value.trim().toLowerCase();
            if (lower === 'y') {
              onConfirmReject();
              return;
            }
            onCancel();
          }}
        />
      </Box>
    </Box>
  );
}

export interface ModifyBodyProps {
  readonly draft: string;
  readonly onChange: (next: string) => void;
  readonly onSubmit: (text: string) => void;
}

export function ModifyBody({
  draft,
  onChange,
  onSubmit,
}: ModifyBodyProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Box>
        <Text color="yellow" bold>Modify task</Text>
        <Text dimColor> · type a refinement, Enter to send, Esc to cancel:</Text>
      </Box>
      <Box>
        <Text color="yellow">{'> '}</Text>
        <TextInput
          defaultValue={draft}
          placeholder="extra constraints, hints, etc."
          onChange={onChange}
          onSubmit={onSubmit}
        />
      </Box>
    </Box>
  );
}
