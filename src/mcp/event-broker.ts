// Event broker — module-level pub/sub for SSE subscribers (D-H2.027).
//
// Used by the daemon HTTP server to multicast workflow progress events and
// HITL gate lifecycle events to multiple SSE clients (REPL + Hermes + curl).
// Hooked into insertEvent() in db/persist.ts so every persisted event also
// fans out to subscribed clients in real time.
//
// Design notes:
//   - In-process only. Cross-process broadcast would need Redis/PG NOTIFY;
//     not needed today since daemon is single-process.
//   - Subscriptions are tracked by callback identity (Set). Each subscribe()
//     returns an unsubscribe function the caller MUST invoke on disconnect.
//   - Dead subscriber sweep: a callback that throws 3 times is removed
//     defensively. The sweep runs every 30s.
//   - Workspace filter for gate events is applied at delivery time (cheap)
//     rather than maintaining per-workspace maps (more complex, not worth it
//     for the expected number of subscribers).

import type { WorkflowProgressEvent } from '../brain/executor/types.js';

export interface GateEvent {
  readonly type: 'gate_pending' | 'gate_resolved';
  readonly gate_id: string;
  readonly workflow_id: string;
  readonly workspace: string | null;
  readonly payload: Record<string, unknown>;
}

export interface NotificationEvent {
  readonly id: string;
  readonly user_id: string;
  readonly type: string;
  readonly title: string;
  readonly body: string;
  readonly priority: string;
  readonly metadata: Record<string, unknown>;
  readonly workflow_id: string | null;
  readonly task_id: string | null;
  readonly created_at: number;
}

export interface EventBroker {
  publish(workflowId: string, event: WorkflowProgressEvent): void;
  publishGate(event: GateEvent): void;
  publishNotification(event: NotificationEvent): void;
  subscribeWorkflow(
    workflowId: string,
    callback: (event: WorkflowProgressEvent) => void,
  ): () => void;
  subscribeGates(
    workspace: string | null,
    callback: (event: GateEvent) => void,
  ): () => void;
  subscribeNotifications(
    userId: string,
    callback: (event: NotificationEvent) => void,
  ): () => void;
  /** For tests: drop all subscribers and reset error counters. */
  reset(): void;
  /** For tests: snapshot current subscriber counts. */
  stats(): { workflows: number; gates: number; notifications: number };
}

const MAX_ERRORS_PER_CALLBACK = 3;
const SWEEP_INTERVAL_MS = 30_000;

type WorkflowCallback = (event: WorkflowProgressEvent) => void;
type GateCallback = (event: GateEvent) => void;
type NotificationCallback = (event: NotificationEvent) => void;

interface GateSubscription {
  readonly workspace: string | null;
  readonly cb: GateCallback;
}

interface NotificationSubscription {
  readonly user_id: string;
  readonly cb: NotificationCallback;
}

const workflowSubs = new Map<string, Set<WorkflowCallback>>();
const gateSubs = new Set<GateSubscription>();
const notificationSubs = new Map<string, Set<NotificationCallback>>();
const errorCounts = new WeakMap<object, number>();

let sweepTimer: ReturnType<typeof setInterval> | null = null;

function ensureSweep(): void {
  if (sweepTimer !== null) return;
  sweepTimer = setInterval(() => {
    // Sweep workflow maps that have become empty (orphaned Set instances).
    for (const [wfId, set] of workflowSubs) {
      if (set.size === 0) workflowSubs.delete(wfId);
    }
  }, SWEEP_INTERVAL_MS);
  // Don't keep the process alive solely for this timer.
  if (typeof sweepTimer === 'object' && sweepTimer !== null && 'unref' in sweepTimer) {
    (sweepTimer as { unref: () => void }).unref();
  }
}

function recordError(cb: object): boolean {
  const count = (errorCounts.get(cb) ?? 0) + 1;
  errorCounts.set(cb, count);
  return count >= MAX_ERRORS_PER_CALLBACK;
}

function safeInvokeWorkflow(cb: WorkflowCallback, event: WorkflowProgressEvent): boolean {
  try {
    cb(event);
    return true;
  } catch {
    return !recordError(cb);
  }
}

function safeInvokeGate(sub: GateSubscription, event: GateEvent): boolean {
  try {
    sub.cb(event);
    return true;
  } catch {
    return !recordError(sub.cb);
  }
}

function safeInvokeNotification(cb: NotificationCallback, event: NotificationEvent): boolean {
  try {
    cb(event);
    return true;
  } catch {
    return !recordError(cb);
  }
}

export const eventBroker: EventBroker = {
  publish(workflowId, event) {
    ensureSweep();
    const set = workflowSubs.get(workflowId);
    if (!set || set.size === 0) return;
    const dead: WorkflowCallback[] = [];
    for (const cb of set) {
      if (!safeInvokeWorkflow(cb, event)) dead.push(cb);
    }
    for (const cb of dead) set.delete(cb);
  },
  publishGate(event) {
    ensureSweep();
    if (gateSubs.size === 0) return;
    const dead: GateSubscription[] = [];
    for (const sub of gateSubs) {
      if (sub.workspace !== null && event.workspace !== null && sub.workspace !== event.workspace) {
        continue;
      }
      if (!safeInvokeGate(sub, event)) dead.push(sub);
    }
    for (const sub of dead) gateSubs.delete(sub);
  },
  publishNotification(event) {
    ensureSweep();
    const set = notificationSubs.get(event.user_id);
    if (!set || set.size === 0) return;
    const dead: NotificationCallback[] = [];
    for (const cb of set) {
      if (!safeInvokeNotification(cb, event)) dead.push(cb);
    }
    for (const cb of dead) set.delete(cb);
  },
  subscribeWorkflow(workflowId, callback) {
    ensureSweep();
    let set = workflowSubs.get(workflowId);
    if (!set) {
      set = new Set();
      workflowSubs.set(workflowId, set);
    }
    set.add(callback);
    return (): void => {
      const s = workflowSubs.get(workflowId);
      if (!s) return;
      s.delete(callback);
      if (s.size === 0) workflowSubs.delete(workflowId);
    };
  },
  subscribeGates(workspace, callback) {
    ensureSweep();
    const sub: GateSubscription = { workspace, cb: callback };
    gateSubs.add(sub);
    return (): void => {
      gateSubs.delete(sub);
    };
  },
  subscribeNotifications(userId, callback) {
    ensureSweep();
    let set = notificationSubs.get(userId);
    if (!set) {
      set = new Set();
      notificationSubs.set(userId, set);
    }
    set.add(callback);
    return (): void => {
      const s = notificationSubs.get(userId);
      if (!s) return;
      s.delete(callback);
      if (s.size === 0) notificationSubs.delete(userId);
    };
  },
  reset() {
    workflowSubs.clear();
    gateSubs.clear();
    notificationSubs.clear();
    if (sweepTimer !== null) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  },
  stats() {
    let workflows = 0;
    for (const set of workflowSubs.values()) workflows += set.size;
    let notifications = 0;
    for (const set of notificationSubs.values()) notifications += set.size;
    return { workflows, gates: gateSubs.size, notifications };
  },
};
