// Empty stub for react-devtools-core.
// Ink imports this conditionally for dev UX; we never enable devtools in the
// REPL, so we alias the module to this stub at bundle time (tsup.config.ts).
// Avoids pulling a 30MB optional dep into the lockfile just to satisfy a
// runtime import that never fires.
export default function noop() {
  // Never called — Ink only invokes this when DEV env is set.
  throw new Error('react-devtools-core stub invoked — should be unreachable');
}
export const connectToDevTools = noop;
