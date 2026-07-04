// gatesSlice — FIFO pending gates queue + head (D-H2.029).

export interface HitlPromptInfo {
  readonly name: string;
  readonly kind: string;
  readonly model?: string;
  readonly executorHint?: string;
  readonly timeoutSeconds?: number;
  readonly acceptanceCriteria?: string;
}

export interface Gate {
  readonly id: string;
  readonly wfId: string;
  readonly taskId: string;
  readonly ts: number;
  readonly info: HitlPromptInfo;
}

export interface GatesSlice {
  readonly pendingQueue: readonly Gate[];
  readonly head: Gate | null;
  readonly enqueueGate: (gate: Gate) => void;
  readonly resolveHead: (decision: string) => void;
  readonly peekHead: () => Gate | null;
  readonly removeGate: (id: string) => void;
}

type SetFn = (updater: (prev: { gates: GatesSlice }) => { gates: GatesSlice }) => void;
type GetFn = () => { gates: GatesSlice };

export function createGatesSlice(set: SetFn, get: GetFn): GatesSlice {
  return {
    pendingQueue: [],
    head: null,

    enqueueGate(gate: Gate) {
      set((prev) => {
        // Insert sorted by ts ascending (FIFO by arrival time).
        const queue = [...prev.gates.pendingQueue, gate].sort((a, b) => a.ts - b.ts);
        const head = queue[0] ?? null;
        return {
          ...prev,
          gates: { ...prev.gates, pendingQueue: queue, head },
        };
      });
    },

    resolveHead(_decision: string) {
      set((prev) => {
        if (prev.gates.pendingQueue.length === 0) return prev;
        const [, ...rest] = prev.gates.pendingQueue;
        const head = rest[0] ?? null;
        return {
          ...prev,
          gates: { ...prev.gates, pendingQueue: rest, head },
        };
      });
    },

    peekHead(): Gate | null {
      return get().gates.head;
    },

    removeGate(id: string) {
      set((prev) => {
        if (!prev.gates.pendingQueue.some((g) => g.id === id)) return prev;
        const queue = prev.gates.pendingQueue.filter((g) => g.id !== id);
        const head = queue[0] ?? null;
        return {
          ...prev,
          gates: { ...prev.gates, pendingQueue: queue, head },
        };
      });
    },
  };
}
