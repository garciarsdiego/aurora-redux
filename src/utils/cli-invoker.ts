// CLI-backed brain invoker (Aurora-Redux, 2026-07-04).
//
// Lets the single LLM chokepoint (`callOmnirouteWithUsage`) satisfy a brain
// role (decomposer / reviewer / consolidator / any llm_call) by spawning a
// local coding CLI instead of making an HTTP call — using the operator's OAuth
// subscriptions at zero marginal cost. Routed by model-id prefix:
//   claude-cli/*      -> `claude --print`   (Claude Max; fast ~60s)
//   codex-cli/<model> -> `codex exec ...`   (GPT via Codex; STRONG but SLOW, minutes)
//
// The prompt is delivered on stdin (mirrors the proven reviewer `spawnClaude`
// path and each adapter's `promptDelivery: 'stdin'`), so there is no Windows
// arg-quoting limit and no temp file to leak. Spawn primitives are reused from
// executors/cli (shell:false, CLAUDECODE strip, .cmd-shim resolution).
//
// Import note: `isCliSafeMode` is imported from permission-context (NOT from
// reviewer.ts) to avoid the cycle omniroute-call → cli-invoker → reviewer →
// omniroute-call (reviewer imports callOmniroute).

import { spawn, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { claudeBin, codexBin } from '../executors/cli/bin-resolver.js';
import { resolveSpawnTarget, buildCliSpawnOptions } from '../executors/cli/spawn-common.js';
import { buildCodexSpec } from '../executors/cli/adapters/codex.js';
import { isCliSafeMode } from '../executors/cli/permission-context.js';
import type { OmniroutePromptInput, OmnirouteCallResult } from './omniroute-call.js';

const CLAUDE_CLI_RE = /^claude-cli\//i;
const CODEX_CLI_RE = /^codex-cli\//i;

/** True when a model id targets a local CLI transport rather than HTTP. */
export function isCliModel(model: string): boolean {
  return CLAUDE_CLI_RE.test(model) || CODEX_CLI_RE.test(model);
}

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

interface CliSpec {
  bin: string;
  args: string[];
  provider: 'claude' | 'codex';
  timeoutMs: number;
}

function resolveCliSpec(model: string): CliSpec {
  const safeMode = isCliSafeMode();
  if (CLAUDE_CLI_RE.test(model)) {
    // claude --print reads the prompt from stdin and prints the reply. No
    // --model: uses the logged-in Max session's default. The
    // --dangerously-skip-permissions flag matches how the engine spawns claude
    // elsewhere (reviewer getReviewerClaudeArgs) so a large prompt never blocks
    // on a permission prompt.
    const args = safeMode ? ['--print'] : ['--print', '--dangerously-skip-permissions'];
    // Configurable ceiling — 60s is the median, not the worst case; a large
    // decomposer prompt (few-shots + reflection block) can exceed it. (M3.)
    const timeoutMs = envInt('CLAUDE_CLI_TIMEOUT_MS', 180_000);
    return { bin: claudeBin(), args, provider: 'claude', timeoutMs };
  }
  // codex-cli/<model>: the suffix after the prefix is the codex model id.
  const cliModel = model.slice('codex-cli/'.length).trim() || null;
  const spec = buildCodexSpec({ cliModel, safeMode });
  const timeoutMs = envInt('CODEX_CLI_TIMEOUT_MS', 600_000);
  return { bin: spec.bin, args: spec.args, provider: 'codex', timeoutMs };
}

/** Spawn the CLI, feed `prompt` on stdin, collect stdout with a hard timeout. */
function spawnCliCollect(
  spec: CliSpec,
  prompt: string,
  externalSignal?: AbortSignal,
): Promise<string> {
  const target = resolveSpawnTarget(spec.bin, spec.args);
  const options: SpawnOptionsWithoutStdio = {
    ...buildCliSpawnOptions(),
    windowsVerbatimArguments: target.windowsVerbatimArguments,
    stdio: 'pipe',
  };
  return new Promise((resolve, reject) => {
    const child = spawn(target.executable, target.finalArgs, options);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener('abort', onAbort);
    };
    const kill = () => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const timer = setTimeout(() => {
      kill();
      finish(() => reject(new Error(
        `${spec.provider} CLI timed out after ${spec.timeoutMs}ms`,
      )));
    }, spec.timeoutMs);

    const onAbort = () => {
      kill();
      finish(() => {
        const err = new Error(`${spec.provider} CLI aborted by external signal`);
        (err as Error & { name: string }).name = 'AbortError';
        reject(err);
      });
    };
    if (externalSignal) {
      if (externalSignal.aborted) { onAbort(); return; }
      externalSignal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.on('data', (c: Buffer) => stdout.push(c));
    child.stderr.on('data', (c: Buffer) => stderr.push(c));
    // A large brain-role prompt exceeds the pipe buffer, so the stdin write
    // stays pending. If the child dies early (not logged in, bad flag) or the
    // timeout SIGKILLs it mid-write, EPIPE surfaces as a stdin 'error' event —
    // without this listener that becomes an uncaughtException and takes down the
    // whole daemon. Swallow it; the 'close'/timeout path settles the promise. (A2.)
    child.stdin.on('error', () => { /* EPIPE on dead child — handled via close/timeout */ });
    child.on('error', (err: Error) =>
      finish(() => reject(new Error(`${spec.provider} CLI spawn failed: ${err.message}`))),
    );
    child.on('close', (code) => {
      const out = Buffer.concat(stdout).toString('utf8');
      if (code === 0) {
        finish(() => resolve(out));
      } else {
        const errText = Buffer.concat(stderr).toString('utf8').slice(0, 500);
        finish(() => reject(new Error(
          `${spec.provider} CLI exited ${String(code)}: ${errText}`,
        )));
      }
    });

    try {
      child.stdin.write(prompt, 'utf8');
      child.stdin.end();
    } catch (err) {
      kill();
      finish(() => reject(new Error(
        `${spec.provider} CLI stdin write failed: ${(err as Error).message}`,
      )));
    }
  });
}

/**
 * Extract the model's actual reply from raw CLI stdout.
 * - claude --print returns clean text: trim.
 * - codex exec wraps the reply in chrome (header block, echoed prompt, skill
 *   warnings, a `codex` marker line, then the reply, then `tokens used\n<n>`).
 *   The reply is the text between the LAST `codex` marker line and the
 *   `tokens used` line. Downstream JSON extraction is defensive, so residual
 *   noise is tolerated; this just removes the bulk of the chrome.
 */
export function extractCliContent(raw: string, provider: 'claude' | 'codex'): string {
  if (provider === 'claude') return raw.trim();
  const lines = raw.split(/\r?\n/);
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === 'codex') { start = i + 1; break; }
  }
  let end = lines.length;
  for (let i = start >= 0 ? start : 0; i < lines.length; i++) {
    if (/^tokens used$/i.test(lines[i].trim())) { end = i; break; }
  }
  if (start >= 0) return lines.slice(start, end).join('\n').trim();
  // Fallback: strip obvious chrome lines and return the rest.
  return lines
    .filter((l) => !/^(tokens used|user|codex|warning:|reading additional input|openai codex|--------|workdir:|model:|provider:|approval:|sandbox:|reasoning|session id:|[\d,]+)\b/i.test(l.trim()))
    .join('\n')
    .trim();
}

function estimateUsage(inputChars: number, outputChars: number) {
  return {
    input_tokens: Math.ceil(inputChars / 4),
    output_tokens: Math.ceil(outputChars / 4),
    total_cost_usd: 0, // OAuth subscription — no per-token cost.
  };
}

/**
 * Satisfy a brain-role LLM call by spawning a local CLI. Returns the same
 * shape as the HTTP path so the chokepoint's downstream finalize (cost
 * tracking, trace span) treats both identically.
 */
export async function callViaCli(input: OmniroutePromptInput): Promise<OmnirouteCallResult> {
  const spec = resolveCliSpec(input.model);
  const combined = `${input.systemPrompt}\n\n${input.userPrompt}`;
  const raw = await spawnCliCollect(spec, combined, input.signal);
  const content = extractCliContent(raw, spec.provider);
  if (content.trim() === '') {
    throw new Error(`${spec.provider} CLI returned empty content for model ${input.model}`);
  }
  return {
    content,
    model_used: input.model,
    usage: estimateUsage(combined.length, content.length),
  };
}
