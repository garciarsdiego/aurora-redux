// App — root Ink component for the Omniforge REPL.
// MA single-pane vertical layout (D-H2.030):
//   Header → OutputPane (flexGrow=1) → StatusBar → PromptInput → SlashMenu (cond) → Footer → ModalHost
// Wrapped in ErrorBoundary so a single bad render doesn't kill the whole REPL.
// App owns:
//   - the live prompt value (mirror, for SlashMenu visibility)
//   - the local history snapshot passed to PromptInput
//   - dispatch from raw text → command lookup / objective trigger
//   - global hotkeys F1 (help) / Ctrl+G (gates) / Esc (popModal)
// Components below are pure: they read props/hooks and never reach into siblings.
// See docs/plans/REPL-LEVEL-D.md § MA.
import React, { useCallback, useEffect, useState } from 'react';
import { Box, useInput } from 'ink';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { Header } from './layout/Header.js';
import { Footer } from './layout/Footer.js';
import { StatusBar } from './layout/StatusBar.js';
import { OutputPane } from './components/OutputPane.js';
import { PromptInput } from './input/PromptInput.js';
import { SlashMenu } from './components/SlashMenu.js';
import { ModalHost } from './modal/ModalHost.js';
import { parseInput } from './input/parser.js';
import { lookupCommand, listCommands } from './commands/registry.js';
import { fuzzyScore, rankCommands } from './components/SlashMenu.js';
import { getBootResult } from './bootstrap.js';
import { useReplStore } from './state/store.js';
import { appendOutput } from './state/outputBuffer.js';
import { useSession, useGateHead, useUi } from './state/hooks.js';
import { errorMessage } from './utils/errors.js';
import type { ReplCtx, SlashCommand } from './commands/types.js';

export interface AppProps {
  /** History snapshot loaded at boot (newest last). MA only — MB persists live. */
  readonly initialHistory?: readonly string[];
}

export function App({ initialHistory = [] }: AppProps): React.ReactElement {
  return (
    <ErrorBoundary>
      <AppInner initialHistory={initialHistory} />
    </ErrorBoundary>
  );
}

function AppInner({ initialHistory }: { initialHistory: readonly string[] }): React.ReactElement {
  const { workspace, activeModel } = useSession();
  const gateHead = useGateHead();
  const { modalStack, pushModal, popModal } = useUi();
  const [promptText, setPromptText] = useState('');
  const [history, setHistory] = useState<readonly string[]>(initialHistory);
  const [slashSelectedIdx, setSlashSelectedIdx] = useState(0);
  // Programmatic injection into PromptInput — bump `key` to force replace.
  const [injectValue, setInjectValue] = useState('');
  const [injectValueKey, setInjectValueKey] = useState(0);

  const slashFilter = promptText.startsWith('/') ? promptText.slice(1) : '';
  const slashMenuVisible = promptText.startsWith('/');
  const modalOpen = modalStack.length > 0;

  // SlashMenu navigation needs to know how many items are visible to clamp
  // selectedIdx. We replicate the registry filter the SlashMenu uses internally
  // (sliceToMax 8 + fuzzy ranking) so the App's bounds match what's rendered.
  const slashCommandCount = slashMenuVisible
    ? Math.min(8, listCommands().filter((c) => fuzzyScore(c.name, slashFilter) >= 0).length)
    : 0;

  // Reset selection to top whenever the filter changes (so typing more chars
  // doesn't leave the marker pointing past the new shorter result list).
  useEffect(() => {
    setSlashSelectedIdx(0);
  }, [slashFilter]);

  // Auto-open the HITL modal when a new gate becomes head and no modal is on
  // top yet. Backgrounding a gate (Esc inside the modal) won't re-trigger this
  // until the head id changes — see HitlModal onBackground (popModal only).
  useEffect(() => {
    if (gateHead === null) return;
    if (modalStack.includes('hitl')) return;
    pushModal('hitl');
  }, [gateHead?.id, modalStack, pushModal]);

  // Global hotkeys. Disabled while typing into TextInput is unaffected because
  // useInput on the same key still fires; Ink delivers to all listeners in
  // mount order.
  useInput((input, key) => {
    // Esc inside a modal pops it (modals already handle their own Esc, this is
    // the safety net when no inner handler captures the key).
    if (key.escape && modalOpen) {
      // Modals handle Esc internally first; this branch is rarely reached.
      return;
    }
    // F1 anywhere → open help modal (toggle).
    if ('f1' in key && (key as typeof key & { f1?: boolean }).f1) {
      if (modalStack[modalStack.length - 1] === 'help') popModal();
      else pushModal('help');
      return;
    }
    // Ctrl+G → toggle gates queue overlay.
    if (key.ctrl && input === 'g') {
      if (modalStack[modalStack.length - 1] === 'gates-overlay') popModal();
      else pushModal('gates-overlay');
      return;
    }
    // SlashMenu navigation — only when menu is visible AND no modal is on top.
    if (slashMenuVisible && !modalOpen) {
      if (key.upArrow) {
        setSlashSelectedIdx((idx) => Math.max(0, idx - 1));
        return;
      }
      if (key.downArrow) {
        setSlashSelectedIdx((idx) => Math.min(Math.max(0, slashCommandCount - 1), idx + 1));
        return;
      }
      // Tab → complete with the highlighted command name + trailing space so
      // the user can immediately type args. Same ranking the SlashMenu uses,
      // so what's displayed === what gets selected.
      if (key.tab) {
        const ranked = rankCommands(listCommands(), slashFilter);
        if (ranked.length > 0) {
          const clampedIdx = Math.min(slashSelectedIdx, ranked.length - 1);
          const picked = ranked[clampedIdx]!.cmd;
          // If the command has any args, add a trailing space so typing
          // continues into argument text. Otherwise drop the space — user
          // can just hit Enter to execute.
          const suffix = picked.argSpec.length > 0 ? ' ' : '';
          setInjectValue(`/${picked.name}${suffix}`);
          setInjectValueKey((k) => k + 1);
        }
        return;
      }
    }
  });

  // Build ctx with live DB handle + store snapshot. Bootstrap stashes the DB
  // in module state via getBootResult() so we can read it without prop-drilling.
  const bootDb = getBootResult()?.db;
  const ctx: ReplCtx = {
    workspace,
    model: activeModel ?? 'unset',
    ...(bootDb ? { db: bootDb } : {}),
    store: useReplStore.getState(),
  };

  const handleSubmit = useCallback(
    (text: string): void => {
      // Push into local history immediately (file persistence is handled elsewhere).
      setHistory((prev) => [...prev, text]);
      void dispatchInput(text, ctx);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspace, activeModel, bootDb],
  );

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Header />
      <Box flexGrow={1}>
        <OutputPane />
      </Box>
      <StatusBar />
      <PromptInput
        onSubmit={handleSubmit}
        history={history}
        onChange={setPromptText}
        disabled={modalOpen}
        slashMenuActive={slashMenuVisible}
        injectValue={injectValue}
        injectValueKey={injectValueKey}
      />
      {slashMenuVisible && !modalOpen ? (
        <SlashMenu
          filter={slashFilter}
          commands={listCommands()}
          selectedIdx={slashSelectedIdx}
        />
      ) : null}
      <Footer />
      <ModalHost />
    </Box>
  );
}

/**
 * Convert a raw input line into a side effect.
 * Errors are caught and reported to the output pane — never thrown.
 */
async function dispatchInput(text: string, ctx: ReplCtx): Promise<void> {
  const parsed = parseInput(text);
  if (parsed.kind === 'noop') return;

  if (parsed.kind === 'slash') {
    await dispatchSlash(parsed.command, parsed.args, ctx);
    return;
  }

  if (parsed.kind === 'bash') {
    appendOutput(`!${parsed.command}`, 'cmd');
    appendOutput('Bash mode not yet enabled (coming in MB).', 'info');
    return;
  }

  // Free text → implicit /run with the text as objective.
  // This is the primary "just type what you want" UX of every Claude-Code-style
  // CLI: user doesn't have to remember `/run "..."` for the most common action.
  await dispatchSlash('run', [parsed.text], ctx);
}

async function dispatchSlash(
  name: string,
  args: readonly string[],
  ctx: ReplCtx,
): Promise<void> {
  const cmd: SlashCommand | undefined = lookupCommand(name);
  const display = `/${name}${args.length > 0 ? ' ' + args.join(' ') : ''}`;
  appendOutput(display, 'cmd');

  if (!cmd) {
    appendOutput(`Unknown command: /${name}`, 'error');
    return;
  }

  try {
    const argsMap = bindArgsToSpec(cmd.argSpec, args);
    const result = await cmd.handler(argsMap, ctx);
    if (result.output) appendOutput(result.output, 'output');
    if (result.error) appendOutput(result.error.message, 'error');
    if (typeof result.exitCode === 'number') {
      // /exit and /quit return exitCode. Real teardown (history flush, DB close,
      // Ink unmount) runs in shutdown.ts — wired in MA Wire-up.
      process.exit(result.exitCode);
    }
  } catch (err: unknown) {
    appendOutput(`Command error: ${errorMessage(err)}`, 'error');
  }
}

/**
 * Map positional CLI args to argSpec slots, prioritizing REQUIRED slots.
 *
 * Naive position-by-position binding fails when the user types `/run "objective"`
 * but argSpec begins with optional `workspace` — it would map "objective" to
 * workspace and leave the required slot undefined.
 *
 * Strategy:
 *   1. Required slots get filled first, in declaration order.
 *   2. Optional slots get filled with whatever args remain, in declaration order.
 *   3. argSpec entries that don't get an arg are omitted (handler sees undefined,
 *      can fall back to its declared default or ctx-derived value).
 *
 * Flag-style args (--auto-approve, --workspace=X) are NOT supported here yet —
 * that lives in the parser layer (src/repl/input/parser.ts) and would land in
 * a follow-up. For MA we accept positional only.
 */
function bindArgsToSpec(
  argSpec: SlashCommand['argSpec'],
  args: readonly string[],
): Record<string, unknown> {
  const required = argSpec.filter((a) => a.required);
  const optional = argSpec.filter((a) => !a.required);
  const out: Record<string, unknown> = {};

  let idx = 0;
  for (const slot of required) {
    if (idx >= args.length) break;
    out[slot.name] = args[idx]!;
    idx++;
  }
  for (const slot of optional) {
    if (idx >= args.length) break;
    out[slot.name] = args[idx]!;
    idx++;
  }
  return out;
}
