// workflowSlice — active workflows + tasks per wfId (D-H2.029).

export interface TaskRow {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly status: string;
  readonly model?: string;
  readonly depends_on?: readonly string[];
}

export interface WorkflowEntry {
  readonly id: string;
  readonly status: string;
}

export interface WorkflowSlice {
  readonly activeWfIds: readonly string[];
  readonly currentWfId: string | null;
  readonly tasksByWfId: Readonly<Record<string, readonly TaskRow[]>>;
  readonly setCurrent: (id: string | null) => void;
  readonly addWorkflow: (entry: WorkflowEntry) => void;
  readonly upsertTask: (wfId: string, task: TaskRow) => void;
  readonly removeWorkflow: (id: string) => void;
}

type SetFn = (
  updater: (prev: { workflow: WorkflowSlice }) => { workflow: WorkflowSlice },
) => void;

export function createWorkflowSlice(set: SetFn): WorkflowSlice {
  return {
    activeWfIds: [],
    currentWfId: null,
    tasksByWfId: {},

    setCurrent(id: string | null) {
      set((prev) => ({
        ...prev,
        workflow: { ...prev.workflow, currentWfId: id },
      }));
    },

    addWorkflow(entry: WorkflowEntry) {
      set((prev) => {
        const already = prev.workflow.activeWfIds.includes(entry.id);
        if (already) return prev;
        return {
          ...prev,
          workflow: {
            ...prev.workflow,
            activeWfIds: [...prev.workflow.activeWfIds, entry.id],
            tasksByWfId: { ...prev.workflow.tasksByWfId, [entry.id]: [] },
          },
        };
      });
    },

    upsertTask(wfId: string, task: TaskRow) {
      set((prev) => {
        const existing = prev.workflow.tasksByWfId[wfId] ?? [];
        const idx = existing.findIndex((t) => t.id === task.id);
        const next: readonly TaskRow[] =
          idx === -1
            ? [...existing, task]
            : [...existing.slice(0, idx), task, ...existing.slice(idx + 1)];
        return {
          ...prev,
          workflow: {
            ...prev.workflow,
            tasksByWfId: { ...prev.workflow.tasksByWfId, [wfId]: next },
          },
        };
      });
    },

    removeWorkflow(id: string) {
      set((prev) => {
        const { [id]: _removed, ...rest } = prev.workflow.tasksByWfId;
        const nextCurrent =
          prev.workflow.currentWfId === id ? null : prev.workflow.currentWfId;
        return {
          ...prev,
          workflow: {
            ...prev.workflow,
            activeWfIds: prev.workflow.activeWfIds.filter((wid) => wid !== id),
            currentWfId: nextCurrent,
            tasksByWfId: rest,
          },
        };
      });
    },
  };
}
