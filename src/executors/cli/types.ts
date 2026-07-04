// =============================================================================
// types.ts — shared types for the cli executor module.
//
// Scope: pure type/interface declarations consumed by every other file under
// `src/executors/cli/`. No runtime code, no imports beyond the ambient
// `Task` shape. Splitting types out lets adapters import what they need
// without dragging the orchestrator into a circular-import graph.
//
// IMPORTANT — preserve EVERY load-bearing comment block. Each interface here
// documents semantic invariants discovered through field debugging:
//   • CliSpec.extraEnv     — cursor hang root cause (D-H2.074 Issue 1)
//   • CliSpec.promptDelivery — Windows cmd.exe quoting rules
//   • CliSpec.streamJson   — H16 native-subagent-delegation observability
//   • RunCliOpts.runtime   — Wave 2 Agents G/H gemini stream-json resume wiring
// =============================================================================

export interface CliSpec {
  bin: string;
  /**
   * Args passed before the prompt. When `promptDelivery === 'arg'`, the
   * resolved prompt is appended as the LAST element at spawn time by
   * runCliTask — resolveCliSpec never embeds the prompt in args itself.
   */
  args: string[];
  /**
   * When true, the CLI emits NDJSON via `--output-format stream-json`. Stdout
   * must be parsed line-by-line; tool_use events become observable, not
   * hidden inside the model's final text. Required to verify H16
   * (native-subagent-delegation) tasks — without this we can't tell whether
   * the Agent tool was actually invoked or whether the model fabricated a
   * synthesis report.
   *
   * Today only `cli:claude-code` uses this. Cursor has a documented
   * `--output-format stream-json` but its event shape differs from Claude
   * Code's and the current parser would yield empty toolCalls; enabling
   * stream-json for Cursor requires writing a Cursor-specific parser first
   * (see docs/09-H2-ROADMAP-DETAILED.md § "CLI observability").
   */
  streamJson: boolean;
  /**
   * How the built prompt reaches the CLI:
   * - `'stdin'` — written to child.stdin and stdin is ended (legacy 4 CLIs).
   *   Safest on Windows where cmd.exe quoting rules are hostile to multi-line
   *   strings embedded in argv.
   * - `'arg'`   — appended as the final positional argument (Cursor, Kilo,
   *   OpenCode). Node's spawn escaping on Windows handles spaces/newlines in
   *   argv elements for us when shell:false + args:string[]; known edge case
   *   is prompts with `"` which we passthrough today and will revisit if
   *   dogfood reveals issues.
   */
  promptDelivery: 'stdin' | 'arg';
  /**
   * Optional per-CLI environment overrides. Merged into the spawn env AFTER
   * the standard buildCliSpawnOptions baseline (NO_COLOR / UTF-8 / CLAUDECODE
   * stripping). Used by CLIs whose .cmd / .ps1 launcher sets env vars that
   * the inner program relies on — when resolveSpawnTarget unwraps the shim,
   * those vars vanish and the program may hang silently. Cursor is the
   * canonical case (CURSOR_INVOKED_AS / NODE_COMPILE_CACHE; root cause of
   * the 2026-05-01 cursor-hang debugging round).
   */
  extraEnv?: Record<string, string>;
}

export type CliPermissionMode = 'safe' | 'autonomous';

// =============================================================================
// stream-json parser types
// =============================================================================

export interface ToolCallRecord {
  name: string;
  input: Record<string, unknown>;
}

export interface ParsedClaudeOutput {
  toolCalls: ToolCallRecord[];
  finalText: string;
  isError: boolean;
  errorReason: string | null;
}

/**
 * Parsed shape of a Gemini stream-json response (Wave 2 Agent H, Task 8A.2).
 * Mirrors ParsedClaudeOutput so geminiParsedToClaudeShape can convert without
 * downstream wrapClaudeOutput needing changes.
 *
 * EVENT SHAPE VERIFIED via _artifacts/runtime-resume-harness/gemini-stream-json-sample.txt
 * captured from gemini-cli 0.41.2 on 2026-05-10. Six event types observed in
 * the wild:
 *
 *   { type: "init",        session_id, model, timestamp }
 *   { type: "message",     role: "user"|"assistant", content, delta?, timestamp }
 *   { type: "tool_use",    tool_name, tool_id, parameters, timestamp }
 *   { type: "tool_result", tool_id, status, output?, timestamp }
 *   { type: "result",      status: "success"|..., stats: {...}, timestamp }
 *
 * Defensive against:
 *   - banner lines on stdout BEFORE NDJSON ("YOLO mode is enabled..." etc.
 *     gemini 0.41.2 prints these to stdout, not stderr — the parser must
 *     skip non-JSON lines silently)
 *   - missing init event (sessionId returns null, caller falls back to the
 *     UUID supplied via --session-id at turn 1)
 *   - future schema additions (unknown event types accumulated into
 *     unknownTypes for surfaced telemetry rather than parser breakage)
 */
export interface ParsedGeminiOutput {
  sessionId: string | null;
  finalText: string;
  toolCalls: ToolCallRecord[];
  isError: boolean;
  errorReason: string | null;
  unknownTypes: string[];
}

// =============================================================================
// runCliTask options
// =============================================================================

export interface RunCliOpts {
  /**
   * Per-tool-call event emitter (MC). Fires once per Agent/Read/Bash/Write/etc
   * dispatch as soon as its NDJSON line arrives — enables live "Agent (Explore)"
   * display in the REPL without waiting for the CLI to finish. Only meaningful
   * when streamJson=true (claude-code default). Non-streamJson CLIs (codex,
   * gemini, kimi) ignore this opt.
   */
  onEvent?: (event: import('../../brain/executor/types.js').WorkflowProgressEvent) => void | Promise<void>;
  /**
   * Optional runtime adapter overrides for two-turn / resume flows. Wave 2
   * Agents G/H wire this to their respective harness paths (claude / gemini).
   * Production runCliTask still defaults to one-shot oneshot mode; this field
   * is opt-in and the shape below is intentionally minimal so cluster work
   * across executors can converge later without renaming.
   *
   *   nativeSessionId : if set, the executor injects its CLI's resume flag
   *                     (claude: --resume <id>, gemini: --resume <id>) BEFORE
   *                     the prompt arg. Verified with each CLI's --help and
   *                     captured stream-json sample.
   *   streamJson      : opt-in stream-json for CLIs whose default is text
   *                     (gemini's text-pty-fallback verified protocol stays
   *                     the production default; this flips on the experimental
   *                     jsonl-headless tier when callers know they want
   *                     structured events).
   *   runtimeMode     : labels the run for runtime store telemetry. Stays
   *                     'oneshot' by default. Harness / future persistent-
   *                     session callers pass 'persistent' so the runtime
   *                     store row carries the right mode for the dashboard.
   *                     Values mirror RuntimeSessionInput.runtimeMode in
   *                     src/runtime/store.ts to avoid schema duplication.
   */
  runtime?: {
    nativeSessionId?: string | null;
    streamJson?: boolean;
    runtimeMode?: 'oneshot' | 'persistent' | 'auto';
  };
}

// =============================================================================
// internal spawn-target shape
// =============================================================================

export interface SpawnTarget {
  executable: string;
  finalArgs: string[];
  windowsVerbatimArguments: boolean;
}
