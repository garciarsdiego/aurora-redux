// outputBuffer — append-only ring buffer singleton for OutputPane.
// Intentionally OUTSIDE Zustand: Static items do not participate in React state,
// they are append-only; Zustand would cause O(n) re-renders on every append.
// Consumers use useSyncExternalStore for React 18 concurrent-mode safety.
// Cap: OUTPUT_BUFFER_CAP items; oldest are dropped (FIFO) when cap is exceeded.
// See docs/plans/REPL-LEVEL-D.md § 3.3 (OutputPane singleton note).

const OUTPUT_BUFFER_CAP = 200 as const;

export type OutputKind = 'info' | 'cmd' | 'output' | 'error';

export interface OutputItem {
  readonly id: string;
  readonly ts: number;
  readonly text: string;
  readonly kind: OutputKind;
}

type Listener = () => void;

// Internal mutable state — intentionally NOT exported; mutations go via appendOutput().
let _items: OutputItem[] = [];
let _version = 0;
const _listeners = new Set<Listener>();

let _flushScheduled = false;

function scheduleFlush(): void {
  if (_flushScheduled) return;
  _flushScheduled = true;
  setImmediate(() => {
    _flushScheduled = false;
    for (const listener of _listeners) {
      listener();
    }
  });
}

/** Append a new item to the buffer. Drops oldest item if at capacity. */
export function appendOutput(text: string, kind: OutputKind = 'info'): void {
  const item: OutputItem = {
    id: `out_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
    text,
    kind,
  };

  if (_items.length >= OUTPUT_BUFFER_CAP) {
    // FIFO: drop the oldest item.
    _items = [..._items.slice(1), item];
  } else {
    _items = [..._items, item];
  }

  _version++;
  scheduleFlush();
}

/** useSyncExternalStore-compatible subscribe. Returns an unsubscribe function. */
export function subscribeOutput(listener: Listener): () => void {
  _listeners.add(listener);
  return () => {
    _listeners.delete(listener);
  };
}

/** useSyncExternalStore-compatible getSnapshot — returns a stable snapshot array. */
export function getOutputSnapshot(): readonly OutputItem[] {
  return _items;
}

/** Reset buffer — intended for test isolation. */
export function resetOutputBuffer(): void {
  _items = [];
  _version = 0;
  scheduleFlush();
}

/** Expose version for debugging / testing. */
export function getOutputVersion(): number {
  return _version;
}
