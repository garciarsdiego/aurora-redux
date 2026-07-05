/**
 * FASE C item 1 — inverted-controls regression coverage for
 * `runInteractionChecks`, the integration counterpart to the pure
 * `evaluateInteraction` tests (interaction-check.test.ts).
 *
 * This is the interaction-side parity for the inverted-CAMERA canvas
 * regression in canvas-region-check.test.ts: there, a rotation bug flipped
 * the scene; here, an inverted-controls bug makes "press ArrowRight" move
 * the player the WRONG way (to the LEFT). We drive the FULL flow
 * (readInteractionValue BEFORE -> dispatch -> readInteractionValue AFTER ->
 * compare) against a fake Playwright page, NOT the pure comparison
 * function, and assert the interaction check FAILS.
 */
import { describe, expect, it } from 'vitest';

import {
  runInteractionChecks,
  type InteractionCheck,
  type InteractionPageLike,
} from '../../src/quality/playwright-product-harness.js';

/**
 * Minimal fake Playwright page. Holds a mutable `player.x`. Pressing
 * ArrowRight applies `moveDelta` — a CORRECT app uses +1, the buggy
 * inverted-controls app uses -1 (right key moves the player left). The
 * debug-hook path 'window.__debug.player.x' is resolved against this
 * fake's own state via the `evaluate` stub, mirroring how the real hook
 * walks globalThis in the browser context.
 */
function makeFakePage(moveDelta: number): { page: InteractionPageLike; pressed: string[] } {
  const state = { player: { x: 100 } };
  const pressed: string[] = [];
  const page: InteractionPageLike = {
    // No screenshots exercised in these tests.
    screenshot: async () => undefined,
    // domAssertion path — not used here (we use debugHookAssertion), but
    // must exist to satisfy the surface.
    $eval: async () => undefined,
    // Resolves 'window.__debug.player.x' style paths against our fake state.
    evaluate: async <T>(_fn: (path: string) => T, path: string): Promise<T> => {
      // The last two segments of the path are player.x on our fake root.
      const segments = path.split('.');
      const key = segments[segments.length - 1]!;
      return state.player[key as 'x'] as unknown as T;
    },
    keyboard: {
      press: async (key: string) => {
        pressed.push(key);
        if (key === 'ArrowRight') state.player.x += moveDelta;
      },
    },
    click: async () => undefined,
    waitForTimeout: async () => undefined,
  };
  return { page, pressed };
}

const RIGHT_MOVES_PLAYER_RIGHT: InteractionCheck = {
  label: 'ArrowRight moves the player right (player.x increases)',
  key: 'ArrowRight',
  waitMs: 50,
  debugHookAssertion: { path: 'window.__debug.player.x', expect: 'increase' },
};

describe('runInteractionChecks — inverted controls regression (full read->dispatch->read flow)', () => {
  it('PASSES when ArrowRight correctly increases player.x', async () => {
    const { page, pressed } = makeFakePage(+1); // correct controls
    const [result] = await runInteractionChecks(page, [RIGHT_MOVES_PLAYER_RIGHT], '/tmp/ignored');

    expect(pressed).toEqual(['ArrowRight']); // the key was actually dispatched
    expect(result!.pass).toBe(true);
    expect(result!.before).toBe(100);
    expect(result!.after).toBe(101);
    expect(result!.error).toBeUndefined();
  });

  it('FAILS the inverted-controls bug: ArrowRight moved the player LEFT (player.x decreased)', async () => {
    const { page, pressed } = makeFakePage(-1); // inverted controls bug
    const [result] = await runInteractionChecks(page, [RIGHT_MOVES_PLAYER_RIGHT], '/tmp/ignored');

    // The key WAS pressed — this is not a missing-dispatch failure, it's a
    // genuine "the app moved the player the wrong way" failure caught by
    // the deterministic before/after comparison.
    expect(pressed).toEqual(['ArrowRight']);
    expect(result!.pass).toBe(false);
    expect(result!.before).toBe(100);
    expect(result!.after).toBe(99); // moved LEFT instead of right
    expect(result!.reason).toMatch(/did not increase/i);
    expect(result!.error).toBeUndefined();
  });

  it('FAILS the frozen-controls bug: ArrowRight did nothing (player.x unchanged)', async () => {
    const { page } = makeFakePage(0); // controls do nothing at all
    const [result] = await runInteractionChecks(page, [RIGHT_MOVES_PLAYER_RIGHT], '/tmp/ignored');

    expect(result!.pass).toBe(false);
    expect(result!.before).toBe(100);
    expect(result!.after).toBe(100);
    expect(result!.reason).toMatch(/did not increase/i);
  });
});
