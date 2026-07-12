// Error-normalization helpers shared across REPL handlers, services and state.
// Centralizes the `unknown` → Error/message coercion every catch block needs
// (handlers return { error: Error }; services/loggers want a plain message).

/** Coerce an unknown thrown value into an Error instance. */
export function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** Extract a human-readable message from an unknown thrown value. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
