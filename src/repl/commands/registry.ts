// Slash command registry — Map<name, SlashCommand>; aliases populate the same map.
// 44 commands total (split: 15 primary + 29 advanced).
// See docs/plans/REPL-LEVEL-D.md § 6.
// Implementation phase: MA (10 MVP) → MB (full coverage) → MD (45+ with daemon).
import type { Category, SlashCommand } from './types.js';

const REGISTRY = new Map<string, SlashCommand>();

// Generic over Args so handlers with strongly-typed arg shapes (e.g.
// SlashCommand<RunArgs>) can be registered without manual `as SlashCommand`
// casts at call sites. Internally we widen to SlashCommand to keep the map
// invariant — the parser-binder layer is responsible for shape validation.
export function registerCommand<Args>(cmd: SlashCommand<Args>): void {
  const widened = cmd as unknown as SlashCommand;
  REGISTRY.set(cmd.name, widened);
  for (const alias of cmd.aliases ?? []) {
    REGISTRY.set(alias, widened);
  }
}

export function lookupCommand(name: string): SlashCommand | undefined {
  return REGISTRY.get(name);
}

export function listCommands(): readonly SlashCommand[] {
  return [...new Set(REGISTRY.values())];
}

/** Return all commands belonging to a given category (deduped by identity). */
export function listByCategory(category: Category): readonly SlashCommand[] {
  const seen = new Set<SlashCommand>();
  const result: SlashCommand[] = [];
  for (const cmd of REGISTRY.values()) {
    if (cmd.category === category && !seen.has(cmd)) {
      seen.add(cmd);
      result.push(cmd);
    }
  }
  return result;
}

/**
 * Return the canonical command name for a given alias OR command name.
 * - If `name` is a registered command (canonical), returns the canonical name.
 * - If `name` is a registered alias, returns the canonical name of its target.
 * - If unknown, returns undefined.
 */
export function resolveAlias(name: string): string | undefined {
  const cmd = REGISTRY.get(name);
  return cmd?.name;
}

/** Wipe the registry — intended for test isolation only. */
export function clearRegistry(): void {
  REGISTRY.clear();
}
