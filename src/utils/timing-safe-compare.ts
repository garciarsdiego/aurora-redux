import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string comparison that does NOT leak information via timing.
 *
 * Strategy (mirrors http-server.ts pattern):
 *  1. Always run timingSafeEqual (same wall-clock cost regardless of content).
 *  2. Perform the length check as a separate boolean so it cannot short-circuit
 *     the timingSafeEqual call.
 *  3. The incoming buffer is padded/truncated to expectedBuf.length before the
 *     equality check so timingSafeEqual always receives same-length buffers
 *     (it throws on length mismatch).
 *
 * NOTE: Callers must pass a non-empty string for `expected`. If `expected` is
 * the empty string the comparison degenerates and any empty incoming will pass —
 * callers should treat an unconfigured secret as a hard failure before calling
 * this function.
 */
export function constantTimeCompare(incoming: string, expected: string): boolean {
  const expectedBuf = Buffer.from(expected);
  const incomingBuf = Buffer.from(incoming);
  // Pad (or truncate) incoming to expected length so timingSafeEqual doesn't throw.
  const padded = Buffer.alloc(expectedBuf.length);
  incomingBuf.copy(padded, 0, 0, expectedBuf.length);
  const contentEq = timingSafeEqual(padded, expectedBuf);
  const lengthEq = incomingBuf.length === expectedBuf.length;
  return contentEq && lengthEq;
}
