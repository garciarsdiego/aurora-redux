// React-friendly selectors using shallow equality (D-H2.029).
// Each hook subscribes to one slice only — avoids cross-slice re-renders.
//
// Note: Zustand 4.5 deprecated the 3-arg `useStore(store, selector, equalityFn)`
// shape. The replacement is `useStoreWithEqualityFn(store, selector, equalityFn)`
// from 'zustand/traditional'. Same runtime behavior; only the import path
// + call site change. Migrating here silences the boot warning.

import { useStoreWithEqualityFn } from 'zustand/traditional';
import { shallow } from 'zustand/shallow';
import { useReplStore } from './store.js';
import type { SessionSlice } from './sessionSlice.js';
import type { WorkflowSlice } from './workflowSlice.js';
import type { GatesSlice, Gate } from './gatesSlice.js';
import type { UiSlice, FocusedPane } from './uiSlice.js';

export function useSession(): SessionSlice {
  return useStoreWithEqualityFn(useReplStore, (s) => s.session, shallow);
}

export function useWorkflow(): WorkflowSlice {
  return useStoreWithEqualityFn(useReplStore, (s) => s.workflow, shallow);
}

export function useGates(): GatesSlice {
  return useStoreWithEqualityFn(useReplStore, (s) => s.gates, shallow);
}

export function useUi(): UiSlice {
  return useStoreWithEqualityFn(useReplStore, (s) => s.ui, shallow);
}

// Fine-grained selectors for hot render paths.

export function useCurrentWfId(): string | null {
  return useReplStore((s) => s.workflow.currentWfId);
}

export function useGateHead() {
  return useReplStore((s) => s.gates.head);
}

export function useFocusedPane() {
  return useReplStore((s) => s.ui.focusedPane);
}

export function useWorkspace(): string {
  return useReplStore((s) => s.session.workspace);
}

export function usePermissionMode() {
  return useReplStore((s) => s.session.permissionMode);
}

export function useCostSession(): number {
  return useReplStore((s) => s.session.costSession);
}

// Aggregate actions across all 4 slices — for components that dispatch multiple
// kinds of mutations (e.g., command handlers). Returns a stable shape; the
// underlying functions never change identity since they're set in slice
// factories at store init.
export interface ReplActions {
  // session
  readonly setWorkspace: (name: string) => void;
  readonly setModel: (id: string | null) => void;
  readonly cyclePermissionMode: () => void;
  readonly addCost: (usd: number) => void;
  readonly resetSession: () => void;
  // workflow
  readonly setCurrent: (id: string | null) => void;
  readonly addWorkflow: (entry: { id: string; status: string }) => void;
  readonly removeWorkflow: (id: string) => void;
  // gates
  readonly enqueueGate: (gate: Gate) => void;
  readonly resolveHead: (decision: string) => void;
  readonly removeGate: (id: string) => void;
  // ui
  readonly setFocus: (zone: FocusedPane) => void;
  readonly pushModal: (name: string, props?: unknown) => void;
  readonly popModal: () => void;
}

export function useReplActions(): ReplActions {
  return useReplStore(
    (s) => ({
      setWorkspace: s.session.setWorkspace,
      setModel: s.session.setModel,
      cyclePermissionMode: s.session.cyclePermissionMode,
      addCost: s.session.addCost,
      resetSession: s.session.resetSession,
      setCurrent: s.workflow.setCurrent,
      addWorkflow: s.workflow.addWorkflow,
      removeWorkflow: s.workflow.removeWorkflow,
      enqueueGate: s.gates.enqueueGate,
      resolveHead: s.gates.resolveHead,
      removeGate: s.gates.removeGate,
      setFocus: s.ui.setFocus,
      pushModal: s.ui.pushModal,
      popModal: s.ui.popModal,
    }),
    shallow,
  );
}
