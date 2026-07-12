// Small text/number helpers shared by handlers, completers, and modals.

/** Truncate `text` to at most `max` chars, ending with a single '…' when cut. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)) + '…';
}

/** Clamp `value` into the inclusive [min, max] range. */
export function clampInt(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
