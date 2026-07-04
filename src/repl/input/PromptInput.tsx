// PromptInput — controlled text input using @inkjs/ui TextInput.
// Pure component: parent owns the dispatch logic; PromptInput only:
//   - reads user keystrokes
//   - navigates history via ↑/↓
//   - handles `\<Enter>` multi-line continuation (MA escape; richer editor in MB)
//   - calls onSubmit(value) on Enter (non-empty only)
//   - reports current text via onChange (for the slash menu in App)
// Disabled state: shows `·` (gray) prefix and ignores keystrokes.
// History source is supplied by parent — no IO performed here.
// See docs/plans/REPL-LEVEL-D.md § MA.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput } from '@inkjs/ui';

const DEFAULT_PLACEHOLDER = 'Type / for commands or describe an objective';
const CONTINUATION_SUFFIX = '\\';

export interface PromptInputProps {
  /** Called when user presses Enter on a non-empty, non-continuation line. */
  readonly onSubmit: (text: string) => void;
  /** When true, input is read-only and the prompt prefix is dimmed `·`. */
  readonly disabled?: boolean;
  /** History snapshot (oldest → newest); arrow keys browse it. */
  readonly history: readonly string[];
  /** Placeholder shown when the field is empty. */
  readonly placeholder?: string;
  /** Called on every keystroke with the current value (for SlashMenu visibility). */
  readonly onChange?: (value: string) => void;
  /**
   * When true, the ↑/↓ arrow handler inside this component is suppressed so
   * the parent App can use them to navigate the SlashMenu. History navigation
   * is only meaningful when the user is NOT in the middle of a `/`-prefixed
   * command, so ceding the keys there is the right behavior.
   */
  readonly slashMenuActive?: boolean;
  /**
   * Programmatic value injection. PromptInput is uncontrolled internally
   * (TextInput from @inkjs/ui owns its state). To let the parent inject text
   * — e.g. Tab autocomplete fills `/<command> ` from the highlighted SlashMenu
   * row — we accept a (value, key) pair: when `injectValueKey` bumps to a
   * fresh number, the input contents are replaced with `injectValue`.
   * Watching only the key (not the value) means parents can re-set the same
   * string twice in a row by bumping the key.
   */
  readonly injectValue?: string;
  readonly injectValueKey?: number;
}

interface HistoryNav {
  /** -1 means "not browsing"; >= 0 indexes from newest end. */
  readonly idx: number;
  /** Snapshot of `value` before the user started navigating. */
  readonly draft: string;
}

const HISTORY_NAV_INITIAL: HistoryNav = { idx: -1, draft: '' };

export function PromptInput({
  onSubmit,
  disabled = false,
  history,
  placeholder = DEFAULT_PLACEHOLDER,
  onChange,
  slashMenuActive = false,
  injectValue,
  injectValueKey,
}: PromptInputProps): React.ReactElement {
  const [value, setValue] = useState('');
  const [pendingLines, setPendingLines] = useState<readonly string[]>([]);
  const [resetKey, setResetKey] = useState(0);
  const [nav, setNav] = useState<HistoryNav>(HISTORY_NAV_INITIAL);

  const isContinuing = pendingLines.length > 0;
  const isBrowsingHistory = nav.idx >= 0;

  // Replace the input contents — TextInput is uncontrolled so we bump `resetKey`
  // to force a remount with a fresh `defaultValue`.
  const replaceValue = useCallback((next: string): void => {
    setValue(next);
    setResetKey((k) => k + 1);
    onChange?.(next);
  }, [onChange]);

  // Programmatic injection from parent (e.g. Tab autocomplete). We track the
  // key so the same string can be re-injected by bumping the key without
  // requiring a different value.
  const lastInjectKey = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (injectValueKey === undefined || injectValue === undefined) return;
    if (injectValueKey === lastInjectKey.current) return;
    lastInjectKey.current = injectValueKey;
    replaceValue(injectValue);
  }, [injectValue, injectValueKey, replaceValue]);

  const handleChange = useCallback((next: string): void => {
    setValue(next);
    // Typing exits history browse mode without losing the draft.
    if (isBrowsingHistory) setNav(HISTORY_NAV_INITIAL);
    onChange?.(next);
  }, [isBrowsingHistory, onChange]);

  const handleSubmit = useCallback((submitted: string): void => {
    const line = submitted.trimEnd();

    // Multi-line continuation: trailing `\` accumulates lines and clears input.
    if (line.endsWith(CONTINUATION_SUFFIX)) {
      const withoutSuffix = line.slice(0, -CONTINUATION_SUFFIX.length);
      setPendingLines((prev) => [...prev, withoutSuffix]);
      replaceValue('');
      return;
    }

    const fullInput = pendingLines.length > 0
      ? [...pendingLines, line].join('\n')
      : line;

    setPendingLines([]);
    setNav(HISTORY_NAV_INITIAL);
    replaceValue('');

    if (fullInput.length === 0) return; // empty submit is noop

    onSubmit(fullInput);
  }, [onSubmit, pendingLines, replaceValue]);

  // Keyboard intercepts that TextInput doesn't expose:
  //   ↑ / ↓        — history navigation (suppressed when slashMenuActive)
  //   Ctrl+J / \  — soft newline (best-effort; TextInput limitations apply)
  useInput((_input, key) => {
    if (disabled) return;

    if (key.upArrow) {
      // SlashMenu owns ↑/↓ when visible — App handles selection there.
      if (slashMenuActive) return;
      if (history.length === 0) return;
      const nextIdx = nav.idx === -1 ? history.length - 1 : Math.max(0, nav.idx - 1);
      const draftSnapshot = nav.idx === -1 ? value : nav.draft;
      const next = history[nextIdx] ?? '';
      setNav({ idx: nextIdx, draft: draftSnapshot });
      replaceValue(next);
      return;
    }

    if (key.downArrow) {
      if (slashMenuActive) return; // SlashMenu owns ↓ when visible
      if (nav.idx === -1) return; // not browsing
      const nextIdx = nav.idx + 1;
      if (nextIdx >= history.length) {
        // Stepped past the newest entry → restore the user's original draft.
        replaceValue(nav.draft);
        setNav(HISTORY_NAV_INITIAL);
        return;
      }
      const next = history[nextIdx] ?? '';
      setNav({ idx: nextIdx, draft: nav.draft });
      replaceValue(next);
      return;
    }

    // Ctrl+J — best-effort soft newline. Ink's `useInput` reports it as input='\n'.
    // We append it to the visible value; full-fidelity editor support arrives in MB.
    if (key.ctrl && _input === 'j') {
      replaceValue(value + '\n');
      return;
    }
  }, { isActive: !disabled });

  const promptPrefix = disabled ? '· ' : isContinuing ? '... ' : '> ';
  const promptColor = disabled ? 'gray' : 'cyan';

  return (
    <Box flexDirection="row" flexShrink={0}>
      <Text color={promptColor}>{promptPrefix}</Text>
      <TextInput
        key={resetKey}
        isDisabled={disabled}
        defaultValue={value}
        placeholder={isContinuing ? '' : placeholder}
        onChange={handleChange}
        onSubmit={handleSubmit}
      />
    </Box>
  );
}
