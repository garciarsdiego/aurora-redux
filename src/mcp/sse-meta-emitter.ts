// W5-backend (2026-05-11): synthetic SSE events that ride the existing
// workflow event channel so the dashboard's 8s `getDashboardSummary` poll
// becomes a backstop only.
//
// The dashboard comment at apps/dashboard-v2/src/state/QueryStateProvider.tsx
// lines 204-217 says the poll is "purely a backstop for events the daemon
// doesn't push (cost deltas, latest_event metadata)". This module pushes both.
//
// Design choices:
//
//   * In-memory only. We publish through `eventBroker` but DO NOT persist
//     into the `events` table. The events table is the source of truth for
//     historical replay; these synthetic events are real-time signals for
//     UI invalidation only. Reconnecting clients just refetch the snapshot.
//
//   * Throttle per workflow at 500 ms. A single chatty workflow can emit
//     dozens of `insertEvent` calls per second (CLI tail events, streaming
//     chunks, supervisor iterations). Without the throttle the SSE channel
//     storms the dashboard. The throttle is per-workflow so two concurrent
//     workflows each get their own stream cadence.
//
//   * Two-map design (one per event type) so a `cost_delta` doesn't block
//     a `latest_event_metadata` and vice-versa. Each event type has its own
//     500 ms window.
//
//   * Recursion safety. The wrapping in `insertEvent` MUST NOT trigger
//     itself: we skip synthetic types (`latest_event_metadata`, `cost_delta`)
//     before scheduling the throttle. Synthetic events go straight to the
//     broker without going through insertEvent.
//
//   * Redaction. Payloads only carry numeric, string-typed scalars from the
//     events / model_calls rows that are themselves already redacted via
//     deepRedactPayload in insertEvent. We do NOT include free-form payload
//     content in the synthetic events — only the event PK, type, timestamp,
//     and task_id. No raw secrets can leak through this path.

import { eventBroker } from './event-broker.js';
import type { WorkflowProgressEvent } from '../brain/executor/types.js';

const THROTTLE_WINDOW_MS = 500;

/** Per-workflow last emission timestamps. Keys evict naturally when the
 *  workflow is no longer hot. We cap the map size defensively to prevent
 *  unbounded growth across days of uptime. */
const MAX_THROTTLE_ENTRIES = 4_096;

const latestEventThrottle = new Map<string, number>();
const costDeltaThrottle = new Map<string, number>();

/** Synthetic event type literals shared with consumers + tests. */
export const SYNTHETIC_EVENT_TYPES = ['latest_event_metadata', 'cost_delta'] as const;
export type SyntheticEventType = (typeof SYNTHETIC_EVENT_TYPES)[number];

const SYNTHETIC_EVENT_TYPE_SET: ReadonlySet<string> = new Set(SYNTHETIC_EVENT_TYPES);

/** Returns true when `type` is one of the synthetic types this module emits.
 *  Callers use this to short-circuit and avoid recursion. */
export function isSyntheticEventType(type: string): type is SyntheticEventType {
  return SYNTHETIC_EVENT_TYPE_SET.has(type);
}

function shouldEmit(throttle: Map<string, number>, workflowId: string, now: number): boolean {
  const last = throttle.get(workflowId);
  if (last !== undefined && now - last < THROTTLE_WINDOW_MS) return false;
  // Cap eviction — drop the oldest entry on insert when full.
  if (throttle.size >= MAX_THROTTLE_ENTRIES && !throttle.has(workflowId)) {
    const oldestKey = throttle.keys().next().value;
    if (oldestKey !== undefined) throttle.delete(oldestKey);
  }
  throttle.set(workflowId, now);
  return true;
}

export interface LatestEventMetadataPayload {
  readonly workflow_id: string;
  readonly event_id: number;
  readonly event_type: string;
  readonly timestamp_ms: number;
  readonly task_id: string | null;
}

export interface CostDeltaPayload {
  readonly workflow_id: string;
  readonly delta_usd: number;
  readonly cumulative_usd: number;
  readonly source: 'llm_call' | 'cli_spawn' | 'pal_call' | 'tool_call';
}

/** Publish a `latest_event_metadata` SSE event for the given workflow.
 *  Respects the 500 ms per-workflow throttle. No-op when throttled or when
 *  the input itself is a synthetic event type (recursion guard). */
export function emitLatestEventMetadata(
  workflowId: string,
  eventId: number,
  eventType: string,
  timestampMs: number,
  taskId: string | null,
): void {
  if (isSyntheticEventType(eventType)) return;
  if (!shouldEmit(latestEventThrottle, workflowId, Date.now())) return;

  const payload: LatestEventMetadataPayload = {
    workflow_id: workflowId,
    event_id: eventId,
    event_type: eventType,
    timestamp_ms: timestampMs,
    task_id: taskId,
  };

  const broker: WorkflowProgressEvent = {
    type: 'latest_event_metadata',
    workflow_id: workflowId,
    payload: payload as unknown as Record<string, unknown>,
  };
  try {
    eventBroker.publish(workflowId, broker);
  } catch {
    /* broker isolation — never bubble back to persistence */
  }
}

/** Publish a `cost_delta` SSE event for the given workflow. Respects the
 *  500 ms per-workflow throttle. Skipped when delta is 0 (no useful signal). */
export function emitCostDelta(
  workflowId: string,
  deltaUsd: number,
  cumulativeUsd: number,
  source: CostDeltaPayload['source'],
): void {
  if (!Number.isFinite(deltaUsd) || !Number.isFinite(cumulativeUsd)) return;
  if (deltaUsd === 0) return;
  if (!shouldEmit(costDeltaThrottle, workflowId, Date.now())) return;

  const payload: CostDeltaPayload = {
    workflow_id: workflowId,
    delta_usd: deltaUsd,
    cumulative_usd: cumulativeUsd,
    source,
  };

  const broker: WorkflowProgressEvent = {
    type: 'cost_delta',
    workflow_id: workflowId,
    payload: payload as unknown as Record<string, unknown>,
  };
  try {
    eventBroker.publish(workflowId, broker);
  } catch {
    /* broker isolation — never bubble back to persistence */
  }
}

/** Test-only: reset both throttles between tests so windows don't leak
 *  across `it()` blocks. Production code never needs this. */
export function resetSseMetaEmitterForTests(): void {
  latestEventThrottle.clear();
  costDeltaThrottle.clear();
}

/** Test-only: snapshot throttle state for assertions. */
export function getThrottleStateForTests(): {
  latestEvent: ReadonlyMap<string, number>;
  costDelta: ReadonlyMap<string, number>;
} {
  return { latestEvent: latestEventThrottle, costDelta: costDeltaThrottle };
}
