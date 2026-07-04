// ModalHost — central portal that renders the top-of-stack modal.
// Subscribes to ui.modalStack and ui.modalProps from Zustand. Only one modal is
// visible at a time; LIFO via popModal. Renders null when the stack is empty so
// it never interferes with the surrounding layout.
//
// Ink does NOT support CSS-style position:absolute. Modals are placed in
// document order — by convention App mounts <ModalHost/> AFTER the rest of the
// layout. With Ink's Yoga renderer that puts the modal at the bottom of the
// rendered output, which the operator perceives as a popup near the prompt.
// We do not attempt to overlay the entire screen because doing so would erase
// streaming output mid-frame; the modal stays compact and re-renders cleanly
// on Ctrl+L (redraw).
//
// Stack name conventions:
//   "hitl"           → HitlModal (props derive from useGates().head)
//   "help"           → HelpModal (no props required)
//   "confirm:<id>"   → ConfirmModal (props from ui.modalProps[<full-name>])
//   "gates-overlay"  → GatesQueueOverlay
import React from 'react';
import { Box } from 'ink';
import { useReplStore } from '../state/store.js';
import { HitlModal } from './HitlModal.js';
import { ConfirmModal, type ConfirmModalProps } from './ConfirmModal.js';
import { HelpModal } from './HelpModal.js';
import { ModelPickerModal } from './ModelPickerModal.js';
import { GatesQueueOverlay } from '../components/GatesQueueOverlay.js';
import { appendOutput } from '../state/outputBuffer.js';

export function ModalHost(): React.ReactElement | null {
  const modalStack = useReplStore((s) => s.ui.modalStack);
  const modalProps = useReplStore((s) => s.ui.modalProps);
  const head = useReplStore((s) => s.gates.head);
  const queueDepth = useReplStore((s) => s.gates.pendingQueue.length);
  const resolveHead = useReplStore((s) => s.gates.resolveHead);
  const popModal = useReplStore((s) => s.ui.popModal);

  if (modalStack.length === 0) return null;
  const top = modalStack[modalStack.length - 1]!;

  // Help modal — no props required.
  if (top === 'help') {
    return (
      <Box flexDirection="column">
        <HelpModal />
      </Box>
    );
  }

  // Gates queue overlay (Ctrl+G).
  if (top === 'gates-overlay') {
    return (
      <Box flexDirection="column">
        <GatesQueueOverlay />
      </Box>
    );
  }

  // Model picker (cascade: target → provider → model). Volatile per session.
  if (top === 'model-picker') {
    return (
      <Box flexDirection="column">
        <ModelPickerModal
          onClose={popModal}
          onAppliedNotify={(msg) => appendOutput(`[model] ${msg}`, 'output')}
        />
      </Box>
    );
  }

  // HITL gate.
  if (top === 'hitl') {
    if (head === null) {
      // Defensive: a stale modal stack with no head — pop it next tick.
      // Returning null avoids rendering a half-empty modal.
      return null;
    }
    return (
      <Box flexDirection="column">
        <HitlModal
          gate={head}
          queueDepth={queueDepth}
          onApprove={() => {
            resolveHead('approved');
            popModal();
          }}
          onReject={() => {
            resolveHead('rejected');
            popModal();
          }}
          onModify={(_refinement) => {
            // The actual refinement is dispatched by the App via daemon — here
            // we only resolve the head and pop the modal.
            resolveHead('modify');
            popModal();
          }}
          onBackground={() => {
            popModal();
          }}
        />
      </Box>
    );
  }

  // Confirm modal — keyed as "confirm:<id>" so multiple confirms can stack.
  if (top.startsWith('confirm')) {
    const props = modalProps[top] as ConfirmModalProps | undefined;
    if (!props) {
      // No props registered → silently pop on next tick (defensive).
      return null;
    }
    const wrapped: ConfirmModalProps = {
      ...props,
      onConfirm: () => {
        try {
          props.onConfirm();
        } finally {
          popModal();
        }
      },
      onCancel: () => {
        try {
          props.onCancel();
        } finally {
          popModal();
        }
      },
    };
    return (
      <Box flexDirection="column">
        <ConfirmModal {...wrapped} />
      </Box>
    );
  }

  // Unknown modal name → render nothing (ErrorBoundary catches anything worse).
  return null;
}
