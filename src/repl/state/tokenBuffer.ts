// TokenBuffer — singleton ESM, OUTSIDE Zustand (D-H2.029).
//
// Why outside the store? Token streams arrive at 60-150 events/sec. Each
// Zustand setState invalidates all subscribers of the slice — even with shallow
// equality selectors, the cost of cloning a 5000-element array per chunk
// degrades to ~10ms p99. React's recommended pattern for high-frequency
// external state is useSyncExternalStore (since React 18) consuming a
// MUTABLE source via cheap version snapshots. That's this module.
//
// Batching: multiple push() calls within the same event-loop tick coalesce
// into a single notify via setImmediate. So 100 tokens arriving inside one
// async-iteration block cause exactly 1 React render, not 100.
//
// Cap: TOKEN_BUFFER_CAP (5000) tokens. FIFO drop on overflow with a counter
// (droppedFromCap) for debugging.

import { TOKEN_BUFFER_CAP } from '../config.js';
import { errorMessage } from '../utils/errors.js';

type Listener = () => void;

class TokenBuffer {
  private _tokens: string[] = [];
  private _version = 0;
  private _flushScheduled = false;
  private readonly _listeners = new Set<Listener>();
  private _droppedFromCap = 0;
  private _flushesCoalesced = 0;
  private _streamingTaskId: string | null = null;

  /** Append one token. O(1). Schedules a single flush per tick. */
  push(token: string): void {
    if (token.length === 0) return;
    if (this._tokens.length >= TOKEN_BUFFER_CAP) {
      this._tokens.shift();
      this._droppedFromCap++;
    }
    this._tokens.push(token);
    this._scheduleFlush();
  }

  /** Append a multi-line text block (from cli_spawn NDJSON, etc.) atomically. */
  pushBlock(text: string): void {
    // Same mechanics as push — the separate name expresses the semantic intent
    // (one atomic multi-line block instead of a single token).
    this.push(text);
  }

  /** Clear buffer + metrics. Used when starting a new stream or test isolation. */
  reset(streamingTaskId: string | null = null): void {
    this._tokens = [];
    this._version++;
    this._streamingTaskId = streamingTaskId;
    this._droppedFromCap = 0;
    this._flushesCoalesced = 0;
    this._notifyNow();
  }

  /** Mark current stream as ended (clears streamingTaskId, keeps tokens). */
  finalize(): void {
    this._streamingTaskId = null;
    this._version++;
    this._notifyNow();
  }

  /** Subscribe — useSyncExternalStore-compatible. Returns unsubscribe. */
  subscribe(listener: Listener): () => void {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  }

  /**
   * Snapshot. CRITICAL: returns a stable primitive (number) so React's
   * Object.is comparison correctly skips renders when nothing changed.
   * Returning the array reference would cause re-renders forever (new
   * snapshot each call ≠ previous snapshot).
   */
  getSnapshot(): number {
    return this._version;
  }

  /** Read current tokens (immutable view). Stable until next push/reset. */
  read(): readonly string[] {
    return this._tokens;
  }

  /** Concatenated text view — convenience for components that render the joined output. */
  readJoined(): string {
    return this._tokens.join('');
  }

  /** Currently-streaming task id, or null when idle. */
  get streamingTaskId(): string | null {
    return this._streamingTaskId;
  }

  /** Diagnostic metrics — not part of the React subscription path. */
  metrics(): {
    readonly count: number;
    readonly droppedFromCap: number;
    readonly flushesCoalesced: number;
    readonly version: number;
  } {
    return {
      count: this._tokens.length,
      droppedFromCap: this._droppedFromCap,
      flushesCoalesced: this._flushesCoalesced,
      version: this._version,
    };
  }

  private _scheduleFlush(): void {
    if (this._flushScheduled) {
      // Counted for diagnostics — multiple pushes coalesce into one render.
      this._flushesCoalesced++;
      return;
    }
    this._flushScheduled = true;
    setImmediate(() => {
      this._flushScheduled = false;
      this._version++;
      this._notifyNow();
    });
  }

  private _notifyNow(): void {
    for (const listener of this._listeners) {
      try { listener(); } catch (err) {
        // Listener errors are not the buffer's problem; surface to stderr.
        process.stderr.write(`[tokenBuffer] listener error: ${errorMessage(err)}\n`);
      }
    }
  }
}

// Singleton — one buffer per process. Tests can call resetTokenBuffer between cases.
export const tokenBuffer = new TokenBuffer();

/** Test-only: replaces the singleton state without re-creating it. */
export function resetTokenBuffer(): void {
  tokenBuffer.reset(null);
}
