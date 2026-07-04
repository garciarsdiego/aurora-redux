// Zustand vanilla store — 4 slices (D-H2.029): session, workflow, gates, ui.
// TokenBuffer and events ring buffer stay OUTSIDE this store (singleton ESM).
// See docs/plans/REPL-LEVEL-D.md § 3.3.

import { create } from 'zustand';
import { createSessionSlice } from './sessionSlice.js';
import { createWorkflowSlice } from './workflowSlice.js';
import { createGatesSlice } from './gatesSlice.js';
import { createUiSlice } from './uiSlice.js';
import type { SessionSlice } from './sessionSlice.js';
import type { WorkflowSlice } from './workflowSlice.js';
import type { GatesSlice } from './gatesSlice.js';
import type { UiSlice } from './uiSlice.js';

export type { SessionSlice, PermissionMode } from './sessionSlice.js';
export type { WorkflowSlice, TaskRow, WorkflowEntry } from './workflowSlice.js';
export type { GatesSlice, Gate, HitlPromptInfo } from './gatesSlice.js';
export type { UiSlice, FocusedPane, Notification } from './uiSlice.js';

export interface ReplStore {
  readonly session: SessionSlice;
  readonly workflow: WorkflowSlice;
  readonly gates: GatesSlice;
  readonly ui: UiSlice;
}

export const useReplStore = create<ReplStore>()((set, get) => ({
  session: createSessionSlice(
    set as (updater: (prev: { session: SessionSlice }) => { session: SessionSlice }) => void,
  ),
  workflow: createWorkflowSlice(
    set as (updater: (prev: { workflow: WorkflowSlice }) => { workflow: WorkflowSlice }) => void,
  ),
  gates: createGatesSlice(
    set as (updater: (prev: { gates: GatesSlice }) => { gates: GatesSlice }) => void,
    get as () => { gates: GatesSlice },
  ),
  ui: createUiSlice(
    set as (updater: (prev: { ui: UiSlice }) => { ui: UiSlice }) => void,
    get as () => { ui: UiSlice },
  ),
}));
