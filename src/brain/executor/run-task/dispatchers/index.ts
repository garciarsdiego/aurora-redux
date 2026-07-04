// Barrel re-export for the run-task dispatchers. Each dispatcher exposes a
// small kind-specific preprocessing helper that runs around the
// `doExecute(task, signal)` callback that the actual executor wiring lives
// behind. Kept as a barrel so callers can import a single namespace and
// future dispatcher additions land here without touching the index.
export * from './llm-call.js';
export * from './cli-spawn.js';
export * from './tool-call.js';
export * from './advisor-call.js';
