// =============================================================================
// cli/index.ts — main `runCliTask` orchestrator + module-level re-exports.
//
// Scope:
//   • Resolve spec via `resolveCliSpec`, apply runtime injections, route
//     opencode-ACP through its dedicated module, otherwise spawn the child
//     directly via `resolveSpawnTarget` + `buildCliSpawnOptions`.
//   • Wire abort/cancel → tree-kill (sub-agents included).
//   • Stream stdout/stderr to `opts.onEvent` (REPL/Dashboard SSE) and the
//     runtime store, with secret redaction on the live + final paths.
//   • On exit: parse stream-json (Claude/Gemini) or return raw text; emit
//     completion event; close the tracing span.
//
// The re-exports below preserve the public surface every external caller
// imports from `../../executors/cli.js`. The facade file `cli.ts` simply
// re-exports this index so consumers don't need to update their imports.
//
// IMPORTANT — preserve every Example smoke-test comment block inside
// `runCliTask`. Each one anchors a specific Windows / Node spawn bug that
// drove a change still active in the current code. Removing the rationale
// will make a future re-investigation 10x harder.
// =============================================================================

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — tree-kill has no published @types package, own typings are bundled but vary
import treeKill from 'tree-kill';

import type { Task } from '../../types/index.js';
import { resolveTaskExecutionContext } from '../../utils/execution-context.js';
import {
  startTraceSpan,
  endTraceSpan,
  spanContextStorage,
} from '../../v2/observability/tracing.js';
import { runtimeError, type RuntimeRunEvent } from '../../runtime/events.js';
import {
  appendRuntimeStreamEvent,
  completeRuntimeTurn,
  createRuntimeSession,
  startRuntimeTurn,
} from '../../runtime/store.js';
import { applySecretPatterns } from '../../v2/security/patterns.js';

import type { RunCliOpts } from './types.js';
import { resolveCliSpec } from './resolve-spec.js';
import { inferCliIdFromTask, runtimeFormatForCli } from './cli-inference.js';
import { isCliSafeMode } from './permission-context.js';
import { buildCliSpawnOptions, resolveSpawnTarget } from './spawn-common.js';
import { buildPrompt } from './prompt-builder.js';
import { applyRuntimeInjections } from './runtime-injection.js';
import {
  parseClaudeStreamJson,
  parseGeminiStreamJson,
  geminiParsedToClaudeShape,
  wrapClaudeOutput,
} from './jsonl-parser.js';
import { runOpencodeViaAcp, shouldUseOpencodeAcp } from './opencode-acp.js';

// =============================================================================
// Public re-exports — preserve the entire surface area that downstream
// callers (`brain/validator.ts`, `mcp/tools/run_workflow.ts`, the test suite,
// etc.) import from `executors/cli.js`.
// =============================================================================
export type { CliSpec, CliPermissionMode, ParsedClaudeOutput, ParsedGeminiOutput, RunCliOpts } from './types.js';
export { withCliPermissionMode, isCliSafeMode } from './permission-context.js';
export { resolveCliSpec } from './resolve-spec.js';
export { inferCliIdFromTask } from './cli-inference.js';
export { buildCliSpawnOptions, resolveSpawnTarget } from './spawn-common.js';
export {
  parseClaudeStreamJson,
  parseGeminiStreamJson,
  formatToolCallSummary,
  geminiParsedToClaudeShape,
  wrapClaudeOutput,
} from './jsonl-parser.js';

export function runCliTask(
  task: Task,
  signal?: AbortSignal,
  opts: RunCliOpts = {},
): Promise<string> {
  // EXEC-03 — resolve executionContext FIRST so the per-task run dir (cwd) can be
  // threaded into resolveCliSpec (kimi --add-dir scopes scratch/output writes).
  const executionContext = resolveTaskExecutionContext(task);
  const { bin, args, streamJson, promptDelivery, extraEnv } = resolveCliSpec(task.executor_hint, task, executionContext?.cwd ?? null);
  const prompt = buildPrompt(task, executionContext);
  const cliId = inferCliIdFromTask(task.executor_hint, task);
  const runtimeExecutorId = `cli:${cliId}`;

  // Wave D — opencode ACP routing.
  // When `cli:opencode` is selected AND ACP transport is on (default), delegate
  // to the AcpClientLike pool. This bypasses `opencode run` spawn-and-pray.
  // A live span context is required because the pool persists rows in the DB.
  if (cliId === 'opencode' && shouldUseOpencodeAcp() && spanContextStorage.getStore()) {
    const cwd = executionContext?.cwd ?? process.cwd();
    return runOpencodeViaAcp(task, signal, opts, cwd, prompt, runtimeExecutorId);
  }

  // Apply opt-in runtime-mode argv mutations. Today only gemini has injection
  // rules (stream-json + --resume). See runtime-injection.ts for the contract.
  const injection = applyRuntimeInjections({
    cliId,
    baseArgs: args,
    baseStreamJson: streamJson,
    opts,
  });
  const effectiveArgs = injection.args;
  const effectiveStreamJson = injection.streamJson;

  const runtimeFormat = runtimeFormatForCli(cliId, effectiveStreamJson);

  // When the CLI expects the prompt as a positional argument (Cursor, Kilo,
  // OpenCode) we append it to args. When it expects stdin (Claude Code, Gemini,
  // Codex, Kimi) args are unchanged and we write to child.stdin below.
  const spawnArgs = promptDelivery === 'arg' ? [...effectiveArgs, prompt] : effectiveArgs;

  const spanCtx = spanContextStorage.getStore();
  let spanId: string | undefined;
  if (spanCtx) {
    try {
      const span = startTraceSpan(spanCtx.db, {
        workflowId: task.workflow_id,
        taskId: task.id,
        parentSpanId: spanCtx.parentSpanId,
        name: `cli_spawn:${cliId}`,
        kind: 'cli_spawn',
        attributes: { bin, model: task.model ?? null },
      });
      spanId = span.id;
    } catch { /* tracing must not break execution */ }
  }

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let cumulativeChars = 0;
    let chunkSeq = 0;
    let firstChunkAt: number | null = null;
    let runtimeSessionId: string | null = null;
    let runtimeTurnId: string | null = null;
    const appendRuntime = (event: RuntimeRunEvent): void => {
      if (!spanCtx || !runtimeSessionId || !runtimeTurnId) return;
      try {
        appendRuntimeStreamEvent(spanCtx.db, {
          sessionId: runtimeSessionId,
          turnId: runtimeTurnId,
          workflowId: task.workflow_id,
          taskId: task.id,
          event: {
            ...event,
            executorId: event.executorId || runtimeExecutorId,
            sessionId: event.sessionId ?? runtimeSessionId,
            turnId: event.turnId ?? runtimeTurnId,
          },
        });
      } catch {
        // Runtime recording is observability only; never break CLI execution.
      }
    };
    const completeRuntime = (
      status: 'completed' | 'failed' | 'canceled',
      resultSummary?: string | null,
      errorMessage?: string,
    ): void => {
      if (!spanCtx || !runtimeTurnId) return;
      try {
        completeRuntimeTurn(spanCtx.db, runtimeTurnId, {
          status,
          resultSummary,
          error: errorMessage
            ? {
              code: 'cli_spawn_failed',
              origin: `task:${task.id}`,
              message: errorMessage,
              suggestedAction: 'Inspect the task terminal, runtime tab, and CLI fallback reason before retrying.',
              safeContext: {
                executorId: runtimeExecutorId,
                model: task.model ?? null,
                fallbackReason: runtimeFormat.fallbackReason,
              },
            }
            : null,
        });
      } catch {
        // Runtime recording is best-effort.
      }
    };
    if (spanCtx) {
      try {
        const session = createRuntimeSession(spanCtx.db, {
          workflowId: task.workflow_id,
          taskId: task.id,
          executorId: runtimeExecutorId,
          protocolTier: runtimeFormat.protocolTier,
          streamFormat: runtimeFormat.streamFormat,
          nativeSessionId: opts.runtime?.nativeSessionId ?? null,
          runtimeMode: opts.runtime?.runtimeMode ?? 'oneshot',
          status: 'active',
          workspacePath: executionContext?.cwd ?? null,
          fallbackReason: runtimeFormat.fallbackReason,
          approvalStatus: isCliSafeMode() ? 'not_required' : 'approved',
          auditStatus: 'recorded',
          runMode: isCliSafeMode() ? 'dry-run' : 'approved-run',
          metadata: {
            model: task.model ?? null,
            executor_hint: task.executor_hint ?? null,
            bin,
            prompt_delivery: promptDelivery,
          },
        });
        const turn = startRuntimeTurn(spanCtx.db, {
          sessionId: session.id,
          workflowId: task.workflow_id,
          taskId: task.id,
          attempt: task.retry_count + 1,
          promptSummary: `${task.name} (${task.kind})`,
          metadata: {
            timeout_seconds: task.timeout_seconds,
            max_retries: task.max_retries,
          },
        });
        runtimeSessionId = session.id;
        runtimeTurnId = turn.id;
        appendRuntime({
          type: 'runtime.turn.started',
          ts: startedAt,
          executorId: runtimeExecutorId,
          raw: {
            protocolTier: runtimeFormat.protocolTier,
            streamFormat: runtimeFormat.streamFormat,
            fallbackReason: runtimeFormat.fallbackReason,
            runtimeMode: opts.runtime?.runtimeMode ?? 'oneshot',
          },
        });
      } catch {
        // Runtime recording is best-effort and intentionally non-blocking.
      }
    }
    void opts.onEvent?.({
      type: 'task_streaming_start',
      workflow_id: task.workflow_id,
      payload: { task_id: task.id, task_name: task.name, ts: startedAt },
    });

    // Example smoke test 2026-04-30 round 11 — THE ROOT CAUSE of the entire
    // ENOENT saga (rounds 1–10):
    //
    // CreateProcessW on Windows returns ERROR_DIRECTORY (267) when its
    // lpCurrentDirectory argument points to a non-existent directory.
    // libuv translates that error into ENOENT, but it formats the user-
    // facing message with the EXECUTABLE path (lpApplicationName), making
    // it appear as if the executable is missing. Reproducible:
    //   spawn(node.exe, ['--version'], { cwd: 'C:\\does\\not\\exist' })
    //   → Error: spawn C:\Program Files\nodejs\node.exe ENOENT
    //
    // The execution context'\''s cwd is `workspaces/<ws>/runs/<wfId>/`, which
    // mkdir-recursive in run-task.ts handles for the run root but not for
    // freshly-cleaned dashboards (Example cleaned runs/ via the cleanup
    // session earlier). Ensure the cwd exists right before spawn so the
    // task can land in it. mkdirSync recursive is idempotent and cheap.
    if (executionContext?.cwd) {
      try {
        mkdirSync(executionContext.cwd, { recursive: true });
      } catch (err) {
        // Surface the mkdir failure rather than letting it bubble up as
        // a misleading ENOENT-on-executable.
        const e = err as NodeJS.ErrnoException;
        const message = `CLI cwd mkdir failed for ${executionContext.cwd}: ${e.code ?? 'unknown'} ${e.message ?? ''}`;
        appendRuntime(runtimeError(runtimeExecutorId, 'cli_cwd_mkdir_failed', message, 'Verify the execution context cwd exists and is writable.', {
          cwd: executionContext.cwd,
        }));
        completeRuntime('failed', null, message);
        reject(new Error(message));
        return;
      }
    }

    const { executable, finalArgs, windowsVerbatimArguments } = resolveSpawnTarget(bin, spawnArgs);
    const child = spawn(
      executable,
      finalArgs,
      buildCliSpawnOptions(executionContext?.cwd, windowsVerbatimArguments, extraEnv),
    );

    // tree-kill walks the full process tree and terminates descendants if the
    // CLI wrapper spawns child processes of its own.
    signal?.addEventListener(
      'abort',
      () => {
        // Sprint 2.3 (D-H2.066): emit observable event so the dashboard /
        // REPL can show that the cancel propagated to the actual child.
        // Before Sprint 2 the cancel was DB-only; this event is proof of
        // real termination at the OS level.
        void opts.onEvent?.({
          type: 'cli_killed_on_cancel',
          workflow_id: task.workflow_id,
          payload: {
            task_id: task.id,
            task_name: task.name,
            bin,
            pid: child.pid ?? null,
            elapsed_ms: Date.now() - startedAt,
          },
        });
        if (child.pid) {
          treeKill(child.pid, 'SIGKILL', (err: Error | undefined) => {
            if (err) child.kill(); // fallback if tree-kill failed
          });
        } else {
          child.kill();
        }
      },
      { once: true },
    );

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const emitChunk = (chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
      const rawText = chunk.toString('utf8');
      if (!rawText) return;
      if (firstChunkAt === null) firstChunkAt = Date.now();
      // Tier-0 Wave 4 (0.15) — redact known secret SHAPES (API keys, bearer
      // tokens, JWTs, etc.) before the chunk crosses any logging / SSE
      // boundary. The pattern set lives in `src/v2/security/patterns.ts` and
      // is the same one used by runtime/events.ts for runtime_stream_events
      // persistence — applying it here is defence-in-depth AND covers the
      // opts.onEvent path (event broker → REPL/Dashboard SSE) which bypasses
      // appendRuntime's storage-layer redaction.
      //
      // Trade-off: SECRET_PATTERNS use \b word boundaries. A chunk boundary
      // that splits a secret mid-string emits unredacted halves; neither
      // half is a usable secret on its own and the final concatenated buffer
      // (`out`) is redacted again before persist/resolve, so the canonical
      // record is always scrubbed. The chunk-level pass is a best-effort
      // guard on the live UI / SSE path. cumulativeChars counts the redacted
      // text so consumer progress matches what they actually see.
      //
      // False-positive note: code-review style outputs that legitimately
      // discuss patterns (e.g. a reviewer worker pasting a sample regex
      // into its prose) MAY match a pattern and see `***REDACTED***` in
      // place of an inert example. We accept that trade-off — on by default
      // for safety; opting out per-chunk would require a way to express
      // trust upstream and is out of scope here.
      const text = applySecretPatterns(rawText);
      cumulativeChars += text.length;
      chunkSeq += 1;
      void opts.onEvent?.({
        type: 'task_streaming_chunk',
        workflow_id: task.workflow_id,
        payload: {
          task_id: task.id,
          task_name: task.name,
          chunk: stream === 'stderr' ? `[stderr] ${text}` : text,
          stream,
          cumulative_chars: cumulativeChars,
          seq: chunkSeq,
        },
      });
      appendRuntime({
        type: stream === 'stderr' ? 'runtime.meta' : 'assistant.delta',
        ts: Date.now(),
        executorId: runtimeExecutorId,
        text,
        raw: { stream, seq: chunkSeq, cumulative_chars: cumulativeChars },
      });
    };

    // MC: realtime NDJSON parser. We accumulate complete lines and try to
    // extract `tool_use` blocks as soon as they arrive, emitting cli_tool_call
    // events live. The full stdout buffer is still concatenated below for the
    // existing wrapClaudeOutput pass — this is purely additive observability.
    let lineBuffer = '';
    const emitToolCall = (toolName: string, input: Record<string, unknown>): void => {
      if (!opts.onEvent) return;
      // Build a tiny human-readable input summary — full input in the buffered
      // wrap that the reviewer sees; this is just for live UI.
      const summary = toolName === 'Agent'
        ? `subagent_type=${String(input['subagent_type'] ?? 'general-purpose')}`
        : Object.keys(input).slice(0, 3).join(',');
      void opts.onEvent({
        type: 'cli_tool_call',
        workflow_id: task.workflow_id,
        payload: {
          task_id: task.id,
          tool_name: toolName,
          input_summary: summary,
        },
      });
    };

    const tryParseLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event: unknown;
      try { event = JSON.parse(trimmed); } catch { return; }
      if (typeof event !== 'object' || event === null) return;
      const ev = event as Record<string, unknown>;
      if (ev['type'] !== 'assistant') return;
      const message = ev['message'] as Record<string, unknown> | undefined;
      const content = message?.['content'];
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (typeof block !== 'object' || block === null) continue;
        const b = block as Record<string, unknown>;
        if (b['type'] === 'tool_use' && typeof b['name'] === 'string') {
          emitToolCall(b['name'], (b['input'] as Record<string, unknown> | undefined) ?? {});
        }
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      emitChunk(chunk, 'stdout');
      // Realtime line-wise parsing (only if streamJson + onEvent supplied).
      // tryParseLine matches Claude's `type === "assistant"` shape; gemini's
      // shape (`type === "message"`) is silently ignored by the parser, so the
      // gate stays scoped to claude-code to avoid wasted CPU on other CLIs'
      // NDJSON streams.
      if (!effectiveStreamJson || !opts.onEvent || cliId !== 'claude-code') return;
      lineBuffer += chunk.toString('utf8');
      const newlineIdx = lineBuffer.lastIndexOf('\n');
      if (newlineIdx === -1) return;
      const completeLines = lineBuffer.slice(0, newlineIdx).split('\n');
      lineBuffer = lineBuffer.slice(newlineIdx + 1);
      for (const line of completeLines) {
        tryParseLine(line);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      emitChunk(chunk, 'stderr');
    });

    // For stdin delivery: pipe the full prompt in, then close stdin. For arg
    // delivery: still close stdin so the CLI doesn't wait on reads (some CLIs
    // block on stdin.isTTY checks when stdin is open but empty).
    if (promptDelivery === 'stdin') {
      child.stdin.write(prompt, 'utf8');
    }
    child.stdin.end();

    // Sprint 3.8 (D-H2.066, F-REL-7): use `once` for terminal events to
     // prevent listener accumulation if abort fires after rapid retries.
     // 'close' and 'error' fire exactly once per child lifecycle.
    child.once('close', (code) => {
      const durationMs = Date.now() - startedAt;
      void opts.onEvent?.({
        type: 'task_streaming_end',
        workflow_id: task.workflow_id,
        payload: {
          task_id: task.id,
          task_name: task.name,
          total_chars: cumulativeChars,
          total_chunks: chunkSeq,
          duration_ms: durationMs,
          ttft_ms: firstChunkAt === null ? Date.now() - startedAt : firstChunkAt - startedAt,
          exit_code: code,
        },
      });
      if (spanId && spanCtx) {
        try {
          endTraceSpan(spanCtx.db, spanId, {
            status: code === 0 && !signal?.aborted ? 'ok' : 'error',
            attributes: {
              exit_code: code ?? null,
              duration_ms: durationMs,
            },
          });
        } catch { /* tracing must not break execution */ }
      }
      if (signal?.aborted) {
        const message = `CLI ${bin} killed (timeout)`;
        appendRuntime(runtimeError(runtimeExecutorId, 'cli_killed_timeout', message, 'Retry with a higher timeout or inspect the task terminal for the last emitted line.', {
          bin,
          elapsed_ms: durationMs,
        }));
        completeRuntime('canceled', null, message);
        reject(new Error(message));
        return;
      }
      if (code === 0) {
        // Tier-0 Wave 4 (0.15) — final-buffer redaction. The chunked
        // redaction in emitChunk is best-effort (a secret split across two
        // chunks can survive the per-chunk \b boundary check); the joined
        // buffer below is the canonical record persisted as task.output_json
        // (via setTaskCompleted in run-task.ts) and is also the input the
        // stream-json parser preserves verbatim into wrapClaudeOutput. Apply
        // the same pattern set so the final string is reliably scrubbed.
        const out = applySecretPatterns(
          Buffer.concat(stdoutChunks).toString('utf8').trim(),
        );
        if (effectiveStreamJson) {
          // Gemini takes the same wrapping route via the
          // geminiParsedToClaudeShape adapter so wrapClaudeOutput can stay
          // unchanged. The cliId === 'gemini' branch is the Wave 2 Agent H
          // wiring; defaultProtocolTier remains text-pty-fallback so this
          // branch only fires when opts.runtime.streamJson is opted in
          // (typically by the two-turn harness or future runtime adapters).
          const isGemini = cliId === 'gemini';
          // Parse failure here is non-fatal: fall back to raw text rather
          // than dropping the work the CLI just did.
          try {
            const parsed = isGemini
              ? geminiParsedToClaudeShape(parseGeminiStreamJson(out))
              : parseClaudeStreamJson(out);
            if (parsed.isError) {
              const reason = parsed.errorReason ? ` (${parsed.errorReason})` : '';
              // Tier-0 Wave 4 (0.15) — redact stderr before it lands in the
              // rejected Error.message (which propagates through every event
              // and exception path the caller logs).
              const stderrTail = applySecretPatterns(
                Buffer.concat(stderrChunks).toString('utf8').slice(-200),
              );
              const message = `CLI ${bin} reported is_error${reason}. stderr tail: ${stderrTail}`;
              appendRuntime(runtimeError(runtimeExecutorId, 'cli_stream_json_error', message, 'Inspect stream-json events and retry with corrected task context.', {
                bin,
                reason: parsed.errorReason,
              }));
              completeRuntime('failed', null, message);
              reject(new Error(message));
              return;
            }
            const wrapped = wrapClaudeOutput(parsed);
            appendRuntime({
              type: 'runtime.result',
              ts: Date.now(),
              executorId: runtimeExecutorId,
              text: wrapped.slice(0, 500),
              result: { chars: wrapped.length, tool_calls: parsed.toolCalls.length },
            });
            completeRuntime('completed', wrapped.slice(0, 500));
            resolve(wrapped);
            return;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`[cli] stream-json parse failed (${msg}); returning raw output\n`);
            appendRuntime({
              type: 'runtime.result',
              ts: Date.now(),
              executorId: runtimeExecutorId,
              text: (out || '(empty output)').slice(0, 500),
              result: { chars: (out || '(empty output)').length, parse_fallback: msg },
            });
            completeRuntime('completed', (out || '(empty output)').slice(0, 500));
            resolve(out || '(empty output)');
            return;
          }
        }
        appendRuntime({
          type: 'runtime.result',
          ts: Date.now(),
          executorId: runtimeExecutorId,
          text: (out || '(empty output)').slice(0, 500),
          result: { chars: (out || '(empty output)').length },
        });
        completeRuntime('completed', (out || '(empty output)').slice(0, 500));
        resolve(out || '(empty output)');
      } else {
        // Tier-0 Wave 4 (0.15) — stderr-tail redaction. The error message is
        // both rejected (caller observes it) and recorded via runtimeError;
        // both paths must scrub before secrets are observable downstream.
        const errText = applySecretPatterns(
          Buffer.concat(stderrChunks).toString('utf8').slice(0, 300),
        );
        const message = `CLI ${bin} failed (exit ${code ?? '?'}): ${errText}`;
        appendRuntime(runtimeError(runtimeExecutorId, 'cli_exit_nonzero', message, 'Inspect stderr, model/executor routing, and task working directory before retrying.', {
          bin,
          exit_code: code,
        }));
        completeRuntime('failed', null, message);
        reject(new Error(message));
      }
    });

    child.once('error', (err: NodeJS.ErrnoException) => {
      if (spanId && spanCtx) {
        try {
          endTraceSpan(spanCtx.db, spanId, {
            status: 'error',
            attributes: {
              error: err.message,
              duration_ms: Date.now() - startedAt,
            },
          });
        } catch { /* tracing must not break execution */ }
      }
      const message = `CLI ${bin} spawn error: ${err.message}`;
      appendRuntime(runtimeError(runtimeExecutorId, 'cli_spawn_error', message, 'Verify the CLI binary path and spawn target resolution.', {
        bin,
        error_code: err.code ?? null,
      }));
      completeRuntime('failed', null, message);
      reject(new Error(message));
    });
  });
}
