// Shared terminal summary + error reporting for the workflow-running commands
// (run, run-dag, resume). Each command prints the same aligned block after a
// run; the fields actually shown vary slightly per command, so everything
// beyond title/ID/Status/Duração is opt-in.

export interface WorkflowSummary {
  /** Linha de título, ex.: '✓ Workflow completado'. */
  title: string;
  id: string;
  workspace?: string;
  status: string;
  tasks?: number;
  durationMs: number;
  pattern?: string;
  artifacts?: string;
}

export function printWorkflowSummary(s: WorkflowSummary): void {
  console.log('');
  console.log(s.title);
  console.log(`  ID:        ${s.id}`);
  if (s.workspace !== undefined) console.log(`  Workspace: ${s.workspace}`);
  console.log(`  Status:    ${s.status}`);
  if (s.tasks !== undefined) console.log(`  Tasks:     ${s.tasks}`);
  console.log(`  Duração:   ${s.durationMs}ms`);
  if (s.pattern !== undefined) console.log(`  Pattern:   ${s.pattern}`);
  if (s.artifacts !== undefined) console.log(`  Artefatos: ${s.artifacts}`);
}

export function reportRunError(err: unknown): void {
  console.error('Erro:', err instanceof Error ? err.message : String(err));
  // Set exitCode rather than calling process.exit() — this lets the event
  // loop drain naturally so any in-flight Omniroute fetch / better-sqlite3
  // worker handle finishes closing before Node shuts down. Calling
  // process.exit(1) here triggers libuv "Assertion failed: !(handle->flags
  // & UV_HANDLE_CLOSING)" on Windows when an async handle is mid-close.
  process.exitCode = 1;
}
