// HitlModal — central modal for an active HITL gate.
// FIFO by gate timestamp + Ctrl+G overlay to skip (Example decision 2026-04-23).
// Approval requires `y` + Enter (not a single keystroke); empty ENTER = noop.
// Three internal modes: idle (Y/R/M/Esc), confirming-reject (y/Esc), modifying (text + Enter).
// Pure / props-driven — App owns gate state mutation; this component only renders
// and dispatches the four callbacks (onApprove/onReject/onModify/onBackground).
// See docs/plans/REPL-LEVEL-D.md § 5 (states 3 plan-gate, 8 background gate).
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Gate, HitlPromptInfo } from '../state/gatesSlice.js';
import type { PlanContext } from '../../hitl/cli.js';
import { renderPlanContextLines, formatDuration } from './planContext.js';
import { RejectConfirmBody, ModifyBody } from './HitlSubModes.js';

export interface HitlModalProps {
  readonly gate: Gate;
  /** Total pending gates including the current head — drives "1/N" display. */
  readonly queueDepth: number;
  readonly onApprove: () => void;
  readonly onReject: (reason?: string) => void;
  readonly onModify: (refinement: string) => void;
  readonly onBackground: () => void;
}

type Mode = 'idle' | 'confirming-reject' | 'modifying';

// `gatesSlice.HitlPromptInfo` is the slim slice contract; the executor enriches
// `info` with `planContext` only for plan-review gates (t0). Reading it through
// a structural alias keeps gatesSlice immutable per task spec while still
// letting us render the DAG block when present.
type HitlPromptInfoWithPlan = HitlPromptInfo & {
  readonly planContext?: PlanContext;
};

function readPlanContext(info: HitlPromptInfo): PlanContext | undefined {
  return (info as HitlPromptInfoWithPlan).planContext;
}

export function HitlModal({
  gate,
  queueDepth,
  onApprove,
  onReject,
  onModify,
  onBackground,
}: HitlModalProps): React.ReactElement {
  const [mode, setMode] = useState<Mode>('idle');
  const [modifyDraft, setModifyDraft] = useState('');

  useInput((input, key) => {
    // Esc — universal cancel:
    //   idle → background the gate
    //   sub-modes → return to idle
    if (key.escape) {
      if (mode === 'idle') {
        onBackground();
        return;
      }
      setMode('idle');
      setModifyDraft('');
      return;
    }

    // ENTER alone is intentionally a no-op in idle (Example decision 2026-04-23).
    if (key.return && mode === 'idle') return;

    // Sub-modes own their own input via TextInput onSubmit.
    if (mode !== 'idle') return;

    const lower = input.toLowerCase();
    if (lower === 'y') {
      onApprove();
      return;
    }
    if (lower === 'r') {
      setMode('confirming-reject');
      return;
    }
    if (lower === 'm') {
      setMode('modifying');
      setModifyDraft('');
      return;
    }
  });

  const headerLabel = `gate ${queueDepth > 0 ? 1 : 0}/${queueDepth}`;
  const wfLabel = gate.wfId.length > 24 ? gate.wfId.slice(0, 24) + '\u2026' : gate.wfId;
  const planContext = readPlanContext(gate.info);
  const planLines = planContext
    ? renderPlanContextLines(planContext, gate.info.name)
    : null;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      paddingY={0}
    >
      <Box>
        <Text color="magenta" bold>{'\u25C6 '}</Text>
        <Text color="magenta" bold>HITL Gate</Text>
        <Text dimColor>{` \u00B7 ${headerLabel} \u00B7 wf:`}</Text>
        <Text color="cyan">{wfLabel}</Text>
      </Box>

      <Box>
        <Text dimColor>Task:</Text>
        <Text> </Text>
        <Text>{gate.info.name}</Text>
      </Box>

      <Box>
        <Text dimColor>Kind:</Text>
        <Text> </Text>
        <Text color="cyan">{gate.info.kind}</Text>
        {gate.info.model ? (
          <>
            <Text dimColor>{' \u00B7 model:'}</Text>
            <Text> </Text>
            <Text color="cyan">{gate.info.model}</Text>
          </>
        ) : null}
        {gate.info.executorHint ? (
          <>
            <Text dimColor>{' \u00B7 hint:'}</Text>
            <Text> </Text>
            <Text>{gate.info.executorHint}</Text>
          </>
        ) : null}
      </Box>

      <Box>
        <Text dimColor>Timeout máx:</Text>
        <Text> </Text>
        <Text color="yellow">{formatDuration(gate.info.timeoutSeconds)}</Text>
      </Box>

      {gate.info.acceptanceCriteria ? (
        <Box flexDirection="column">
          <Text dimColor>Critério:</Text>
          <Text>{gate.info.acceptanceCriteria}</Text>
        </Box>
      ) : null}

      {planLines ? (
        <Box flexDirection="column">
          {planLines.map((line, i) => (
            <Text key={i} dimColor={line.startsWith('   ')}>
              {line}
            </Text>
          ))}
        </Box>
      ) : null}

      {mode === 'confirming-reject' ? (
        <RejectConfirmBody
          onConfirmReject={(reason) => {
            onReject(reason);
            setMode('idle');
          }}
          onCancel={() => setMode('idle')}
        />
      ) : null}

      {mode === 'modifying' ? (
        <ModifyBody
          draft={modifyDraft}
          onChange={setModifyDraft}
          onSubmit={(text) => {
            if (text.trim().length === 0) return;
            onModify(text);
            setMode('idle');
            setModifyDraft('');
          }}
        />
      ) : null}

      {mode === 'idle' ? (
        <Box>
          <Text dimColor>[</Text>
          <Text color="green" bold>Y</Text>
          <Text dimColor>]es approve · [</Text>
          <Text color="red" bold>R</Text>
          <Text dimColor>]eject · [</Text>
          <Text color="yellow" bold>M</Text>
          <Text dimColor>]odify · [</Text>
          <Text color="cyan" bold>Esc</Text>
          <Text dimColor>] background</Text>
        </Box>
      ) : null}
    </Box>
  );
}
