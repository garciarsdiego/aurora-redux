// Slash command types (D-H2.022 + D-H2.029 + § 6).
// ReplCtx carries optional db + store handles so handlers can integrate with
// the runtime when wired by the REPL bootstrap, but unit tests can construct
// a minimal ctx with just workspace+model.

import type Database from 'better-sqlite3';
import type { ReplStore } from '../state/store.js';

export type Category = 'workflow' | 'state' | 'hitl' | 'patterns' | 'config' | 'system' | 'debug';

export type ArgType =
  | 'string' | 'number' | 'boolean'
  | 'workflow_id' | 'workspace_name' | 'file_path' | 'pattern_name'
  | 'gate_id' | 'task_id' | 'model_id' | 'config_key' | 'enum';

export interface ArgSpec {
  readonly name: string;
  readonly type: ArgType;
  readonly required: boolean;
  readonly variadic?: boolean;
  readonly description: string;
  readonly enum?: readonly string[];
  readonly default?: unknown;
}

export interface ConfirmSpec {
  readonly prompt: string;
  readonly destructive: boolean;
  readonly requireText?: string;
  readonly default: 'y' | 'n';
}

export interface SlashResult {
  readonly output?: string;
  readonly events?: ReadonlyArray<{ type: string; payload?: unknown }>;
  readonly error?: Error;
  readonly exitCode?: number;
}

export interface ReplCtx {
  readonly workspace: string;
  readonly model: string;
  // Optional runtime handles. Wired by REPL bootstrap; tests may omit either.
  readonly db?: Database.Database;
  readonly store?: ReplStore;
}

export interface SlashCommand<Args = Record<string, unknown>> {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly category: Category;
  readonly description: string;
  readonly helpText: string;
  readonly argSpec: readonly ArgSpec[];
  readonly autoExecute: boolean;
  readonly mutates: boolean;
  readonly requiresDaemon?: boolean;
  readonly requiresWorkspace?: boolean;
  readonly requiresConfirm?: (args: Args, ctx: ReplCtx) => Promise<ConfirmSpec | null>;
  readonly handler: (args: Args, ctx: ReplCtx) => Promise<SlashResult>;
}
