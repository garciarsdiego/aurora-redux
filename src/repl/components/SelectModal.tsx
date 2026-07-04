// SelectModal — generic single-selection list with viewport scroll, fuzzy
// type-to-search, and optional external filter (e.g. tier filter for /model).
//
// Keys:
//   ↑/↓        navigate (viewport follows the marker)
//   PgUp/PgDn  jump by visible page
//   Home/End   first / last item
//   Enter      onSelect(filteredItems[selectedIdx])
//   Esc        clear search if non-empty, else onCancel
//   Backspace  delete one search char
//   <printable chars> append to search filter (case-insensitive substring)
//
// Viewport: max VISIBLE_ROWS items shown at once; viewport offset auto-scrolls
// so the marker stays in view (Example smoke #4: don't snap to start of list).
//
// Search: callers pass `searchableText(item)` so the modal knows what string
// to match against. Default falls back to JSON.stringify which is dumb but
// keeps the component plug-and-play for trivial uses.

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';

const MARKER = '▶';
const NO_MARKER = ' ';
const VISIBLE_ROWS = 12;

/**
 * One cycleable filter bound to a Ctrl+<char> keystroke. The owner component
 * holds the cycle state + implements the step logic; SelectModal only dispatches.
 * Label is rendered in the title so user sees the active state.
 */
export interface ToggleBinding {
  /** Single lowercase letter. `Ctrl+<char>` fires onCycle. */
  readonly char: string;
  /** Called on Ctrl+<char> press. */
  readonly onCycle: () => void;
  /** Label shown in title when filter is non-default (e.g. "tier:S+"). */
  readonly label?: string;
}

export interface SelectModalProps<T> {
  readonly title: string;
  readonly items: readonly T[];
  readonly onSelect: (item: T, index: number) => void;
  readonly onCancel: () => void;
  /** Custom row renderer. Receives item + whether it's currently highlighted. */
  readonly renderItem?: (item: T, isSelected: boolean) => React.ReactNode;
  /** Footer hint line. Default includes search + viewport hints. */
  readonly footer?: string;
  /** Border color. Default 'cyan'. */
  readonly borderColor?: string;
  /** Initial selected index. Default 0. */
  readonly initialSelectedIdx?: number;
  /** Empty state message when items.length === 0. */
  readonly emptyMessage?: string;
  /**
   * Returns the substring matched against typed search query. If omitted,
   * falls back to JSON.stringify(item) which works but is noisy. Always
   * provide for production-quality matching.
   */
  readonly searchableText?: (item: T) => string;
  /** Optional filter applied BEFORE search (e.g. tier filter from /model). */
  readonly externalFilter?: (item: T) => boolean;
  /**
   * Toggle bindings — zero or more Ctrl+<char> combos that cycle caller-owned
   * filter state. Label of each active binding joins in the title as
   * "tier:S+ · kind:cli". Example:
   *   [{char:'t', label:'tier:S+', onCycle: cycleTier},
   *    {char:'k', label:'kind:cli', onCycle: cycleKind}]
   */
  readonly toggleBindings?: readonly ToggleBinding[];
}

export function SelectModal<T>({
  title,
  items,
  onSelect,
  onCancel,
  renderItem,
  footer,
  borderColor = 'cyan',
  initialSelectedIdx = 0,
  emptyMessage = '(no items)',
  searchableText,
  externalFilter,
  toggleBindings,
}: SelectModalProps<T>): React.ReactElement {
  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(initialSelectedIdx);

  // Filter pipeline: external filter → search query (case-insensitive substring).
  const filtered = useMemo(() => {
    let pool: readonly T[] = items;
    if (externalFilter) pool = pool.filter(externalFilter);
    if (query.length === 0) return pool;
    const lower = query.toLowerCase();
    const fn = searchableText ?? ((item: T) => JSON.stringify(item));
    return pool.filter((item) => fn(item).toLowerCase().includes(lower));
  }, [items, query, searchableText, externalFilter]);

  // Clamp selectedIdx whenever the filtered set shrinks below it.
  // This MUST be a useEffect (not a side-effect during render) — otherwise the
  // setState race with the Ink reconciler can drop characters typed during the
  // same frame that the filter recomputes, making the search appear to "not
  // match" when it actually does. See Example bug report 2026-04-24.
  useEffect(() => {
    if (selectedIdx > 0 && selectedIdx >= filtered.length) {
      setSelectedIdx(Math.max(0, filtered.length - 1));
    }
  }, [filtered.length, selectedIdx]);

  // Compute viewport offset so the marker stays in view.
  const visibleRows = Math.min(VISIBLE_ROWS, filtered.length);
  let viewportOffset = 0;
  if (filtered.length > visibleRows) {
    if (selectedIdx < visibleRows) {
      viewportOffset = 0;
    } else if (selectedIdx >= filtered.length - 1) {
      viewportOffset = filtered.length - visibleRows;
    } else {
      // Center-ish: keep marker around 1/3 from top while space allows.
      viewportOffset = Math.max(
        0,
        Math.min(
          filtered.length - visibleRows,
          selectedIdx - Math.floor(visibleRows / 3),
        ),
      );
    }
  }
  const visibleSlice = filtered.slice(viewportOffset, viewportOffset + visibleRows);

  useInput((input, key) => {
    // Esc: clear non-empty search first, then cancel.
    if (key.escape) {
      if (query.length > 0) {
        setQuery('');
        setSelectedIdx(0);
        return;
      }
      onCancel();
      return;
    }

    // Cycle any registered toggle binding (Ctrl+<char>).
    if (key.ctrl && toggleBindings) {
      for (const tb of toggleBindings) {
        if (input === tb.char) {
          tb.onCycle();
          setSelectedIdx(0);
          return;
        }
      }
    }

    if (filtered.length === 0) {
      // Allow backspace / typing to mutate query even when zero matches —
      // user can recover from over-typing without canceling out.
      if (key.backspace || key.delete) {
        setQuery((q) => q.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta && input.length === 1 && /[\x20-\x7e]/.test(input)) {
        setQuery((q) => q + input);
      }
      return;
    }

    if (key.upArrow) {
      setSelectedIdx((idx) => Math.max(0, idx - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIdx((idx) => Math.min(filtered.length - 1, idx + 1));
      return;
    }
    if (key.pageUp) {
      setSelectedIdx((idx) => Math.max(0, idx - visibleRows));
      return;
    }
    if (key.pageDown) {
      setSelectedIdx((idx) => Math.min(filtered.length - 1, idx + visibleRows));
      return;
    }
    // Home / End: Ink doesn't expose these directly; keep as no-op for now.
    if (key.return) {
      const item = filtered[selectedIdx];
      if (item !== undefined) onSelect(item, selectedIdx);
      return;
    }
    if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1));
      setSelectedIdx(0);
      return;
    }
    // Printable ASCII → append to search query.
    if (input && !key.ctrl && !key.meta && input.length === 1 && /[\x20-\x7e]/.test(input)) {
      setQuery((q) => q + input);
      setSelectedIdx(0);
    }
  });

  const defaultRender = (item: T, isSelected: boolean): React.ReactNode => (
    <Text color={isSelected ? 'cyan' : undefined} bold={isSelected}>
      {String(item)}
    </Text>
  );
  const render = renderItem ?? defaultRender;

  // Build header with active filter labels collected from toggleBindings.
  const activeLabels = (toggleBindings ?? [])
    .map((tb) => tb.label)
    .filter((l): l is string => typeof l === 'string' && l.length > 0);
  const titleLine = `${title}${activeLabels.length > 0 ? ' · ' + activeLabels.join(' · ') : ''}`;

  // Footer hints. Include a "Ctrl+X cycle <name>" fragment for each binding
  // so discoverability doesn't depend on reading the source.
  const toggleHints = (toggleBindings ?? [])
    .map((tb) => `Ctrl+${tb.char.toUpperCase()} cycle`)
    .join(' · ');
  const defaultFooter = toggleHints
    ? `↑↓ navigate · Enter select · type to search · ${toggleHints} · Esc back`
    : '↑↓ navigate · Enter select · type to search · Esc back';
  const footerLine = footer ?? defaultFooter;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={borderColor} paddingX={1}>
      <Box>
        <Text color={borderColor} bold>{titleLine}</Text>
      </Box>

      {query.length > 0 ? (
        <Box>
          <Text dimColor>Search: </Text>
          <Text color="cyan">{query}</Text>
          <Text dimColor>{`  (${filtered.length} match${filtered.length === 1 ? '' : 'es'})`}</Text>
        </Box>
      ) : null}

      {filtered.length === 0 ? (
        <Box>
          <Text dimColor>{query.length > 0 ? `no matches for "${query}"` : emptyMessage}</Text>
        </Box>
      ) : (
        <>
          {viewportOffset > 0 ? (
            <Box>
              <Text dimColor>{`  ↑ ${viewportOffset} more above`}</Text>
            </Box>
          ) : null}
          {visibleSlice.map((item, i) => {
            const absoluteIdx = viewportOffset + i;
            const isSelected = absoluteIdx === selectedIdx;
            return (
              <Box key={absoluteIdx}>
                <Text color={isSelected ? 'cyan' : undefined}>
                  {isSelected ? MARKER : NO_MARKER}
                </Text>
                <Text> </Text>
                {render(item, isSelected)}
              </Box>
            );
          })}
          {viewportOffset + visibleRows < filtered.length ? (
            <Box>
              <Text dimColor>{`  ↓ ${filtered.length - viewportOffset - visibleRows} more below`}</Text>
            </Box>
          ) : null}
        </>
      )}

      <Box>
        <Text dimColor>{footerLine}</Text>
      </Box>
    </Box>
  );
}
