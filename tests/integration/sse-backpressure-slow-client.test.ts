/**
 * M1 Wave 3 (F) — SSE event broker behaviour under a slow client.
 *
 * The event broker (`src/mcp/event-broker.ts`) is the fan-out point that
 * `insertEvent` calls to multicast workflow progress to SSE subscribers.
 * If one subscriber's callback is slow / throwing, the broker MUST:
 *
 *   1. Not block the publish call indefinitely (publish is sync — it iterates
 *      the subscriber set once and returns).
 *   2. Not starve other subscribers — each subscriber is invoked exactly
 *      once per publish, regardless of how slow the previous one was.
 *   3. Defensively eject a subscriber whose callback has thrown
 *      MAX_ERRORS_PER_CALLBACK (3) times consecutively.
 *
 * Note on framing: the broker does NOT itself "drop" or "coalesce" events;
 * that responsibility lives in the HTTP SSE handler's `res.write` path
 * which we cannot easily exercise without a slow-drain TCP harness. What
 * we CAN pin deterministically is the broker invariant under a slow / sticky
 * callback. This is the actual bottleneck on a slow client today — a stuck
 * `res.write` would block this callback, which blocks subsequent publishes
 * unless we eject the dead subscriber. We verify the broker keeps the
 * OTHER subscribers fed AND ejects the dead one after 3 throws.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { eventBroker } from '../../src/mcp/event-broker.js';

describe('SSE broker behaviour under slow / failing client (M1 W3 F)', () => {
  beforeEach(() => {
    eventBroker.reset();
  });

  it('one subscriber throwing 3x is ejected; other subscribers keep receiving events', () => {
    const wfId = 'wf_slow_client';
    let throwingDeliveries = 0;
    let healthyDeliveries = 0;
    const HEALTHY_TARGET = 10_000;

    // Subscriber A — always throws. After 3 deliveries the broker ejects it.
    const unsubA = eventBroker.subscribeWorkflow(wfId, () => {
      throwingDeliveries++;
      throw new Error('slow client: res.write would block');
    });
    // Subscriber B — healthy, must keep receiving.
    const unsubB = eventBroker.subscribeWorkflow(wfId, () => {
      healthyDeliveries++;
    });

    expect(eventBroker.stats().workflows).toBe(2);

    // Push 10k events synchronously — this models a busy executor emitting
    // events while the slow client never drains.
    for (let i = 0; i < HEALTHY_TARGET; i++) {
      eventBroker.publish(wfId, {
        type: 'task_started',
        workflow_id: wfId,
        payload: { seq: i },
      } as unknown as Parameters<typeof eventBroker.publish>[1]);
    }

    // Broker contract:
    // - Healthy subscriber B got every event (no starvation).
    // - Throwing subscriber A was ejected after 3 throws (MAX_ERRORS_PER_CALLBACK).
    expect(healthyDeliveries).toBe(HEALTHY_TARGET);
    expect(throwingDeliveries).toBeGreaterThanOrEqual(3);
    expect(throwingDeliveries).toBeLessThan(HEALTHY_TARGET);

    // Subscriber A is gone — only B remains.
    expect(eventBroker.stats().workflows).toBe(1);

    // Unsubscribe is idempotent / safe to call post-eviction.
    expect(() => unsubA()).not.toThrow();
    expect(() => unsubB()).not.toThrow();
  });

  it('publish to a workflow with no subscribers is a no-op (does not throw)', () => {
    // Defensive sanity — fan-out to an empty subscriber set must not crash.
    expect(() => eventBroker.publish('wf_no_subs', {
      type: 'task_started',
      workflow_id: 'wf_no_subs',
      payload: {},
    } as unknown as Parameters<typeof eventBroker.publish>[1])).not.toThrow();
    expect(eventBroker.stats().workflows).toBe(0);
  });

  it('publish is bounded: 10k events to 1 subscriber finishes synchronously', () => {
    // Pin a critical timing property: each publish() is O(subscribers) and
    // does NOT buffer / queue / spawn microtasks. If a future regression
    // makes publish async-batched, this test catches it via a wall-clock
    // budget.
    const wfId = 'wf_bounded';
    let count = 0;
    eventBroker.subscribeWorkflow(wfId, () => { count++; });

    const t0 = Date.now();
    for (let i = 0; i < 10_000; i++) {
      eventBroker.publish(wfId, {
        type: 'task_started',
        workflow_id: wfId,
        payload: { seq: i },
      } as unknown as Parameters<typeof eventBroker.publish>[1]);
    }
    const elapsed = Date.now() - t0;

    expect(count).toBe(10_000);
    // Generous budget — 10k publish() calls + 10k cb invocations should
    // complete well under 2s even on a slow CI runner. This is a regression
    // canary for accidental async batching, not a perf test.
    expect(elapsed).toBeLessThan(2_000);
  });

  it('gate subscribers and workflow subscribers are isolated (slow gate sub does not starve workflow)', () => {
    // The gate stream uses a separate Set (gateSubs). Pin that a flood of
    // workflow events does not interleave with gate cb errors and that the
    // two subscriber pools are truly independent.
    let gateThrows = 0;
    let workflowHits = 0;

    eventBroker.subscribeGates(null, () => {
      gateThrows++;
      throw new Error('gate cb explodes');
    });
    eventBroker.subscribeWorkflow('wf_iso', () => { workflowHits++; });

    for (let i = 0; i < 100; i++) {
      eventBroker.publish('wf_iso', {
        type: 'task_completed',
        workflow_id: 'wf_iso',
        payload: {},
      } as unknown as Parameters<typeof eventBroker.publish>[1]);
    }
    expect(workflowHits).toBe(100);
    // Gate sub was never invoked because we only published workflow events.
    expect(gateThrows).toBe(0);

    // Now flood gates. The gate cb throws on every call → ejected after 3.
    for (let i = 0; i < 10; i++) {
      eventBroker.publishGate({
        type: 'gate_pending',
        gate_id: 'hg_x',
        workflow_id: 'wf_iso',
        workspace: 'internal',
        payload: {},
      });
    }
    expect(gateThrows).toBeGreaterThanOrEqual(3);
    expect(eventBroker.stats().gates).toBe(0);
    // Workflow subscriber unaffected.
    expect(workflowHits).toBe(100);
  });
});
