// Keymap: raw keypresses → semantic intents.
// Single source of truth so individual components (App, PromptInput, modals) all
// agree on which physical chord triggers which behaviour. Avoids the trap where
// each component implements its own `useInput` and bindings drift apart.
// See docs/plans/REPL-LEVEL-D.md § MA + MB and D-H2.022.

import type { Key } from 'ink';

export type Intent =
  | 'cancel-current'
  | 'exit'
  | 'redraw'
  | 'help'
  | 'gates-overlay'
  | 'history-search'
  | 'cycle-permission-mode'
  | 'submit'
  | 'newline'
  | 'autocomplete'
  | 'autocomplete-next'
  | 'autocomplete-prev'
  | 'modal-close';

/**
 * Translate an Ink keypress (raw input + Key flags) into a semantic intent.
 * Returns null when no intent matches — the caller is free to handle the raw
 * input itself (e.g. plain typing into PromptInput).
 *
 * Pure: never reads global state. Same input → same output.
 */
export function classifyKey(input: string, key: Key): Intent | null {
  if (key.ctrl && input === 'c') return 'cancel-current';
  if (key.ctrl && input === 'd') return 'exit';
  if (key.ctrl && input === 'l') return 'redraw';
  if (key.ctrl && input === 'g') return 'gates-overlay';
  if (key.ctrl && input === 'r') return 'history-search';
  if (key.ctrl && input === 'j') return 'newline';
  if (key.shift && key.tab) return 'cycle-permission-mode';
  if (key.tab) return 'autocomplete';
  if (key.escape) return 'modal-close';
  // Ink reports F1 as `key.f1` on most terminals; fall back to escape sequence.
  if ('f1' in key && (key as Key & { f1?: boolean }).f1) return 'help';
  return null;
}

export const KEYMAP_PLACEHOLDER = false;
