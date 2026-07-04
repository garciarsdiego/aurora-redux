/**
 * Wave 3.G — persona versioning + replay-against-version helpers.
 *
 * The audit (§13 P3 #21) called for "Persona versioning + replay-against-
 * version: bump versão e diff outputs antigos vs novos". We already have
 * versioned_definitions infrastructure (migration 013, kind='agent'); this
 * module is the persona-shaped layer on top:
 *
 *   1. snapshotPersona(persona) — extract the prompt-shape fields that
 *      define how the persona thinks (identity, mission, rules, prompt
 *      template, default model). NON-prompt fields (Zod schemas, hooks,
 *      failureModes, tool gates) are intentionally NOT snapshotted: they
 *      are runtime contracts that must stay aligned with the live code,
 *      not historical state we want to replay.
 *   2. registerPersonaVersion(db, persona) — write the snapshot into
 *      versioned_definitions(kind='agent') with stable checksum.
 *   3. getPersonaVersionSnapshot(db, name, version) — read it back.
 *   4. buildAmendedPersona(livePersona, snapshot) — return a new
 *      AgentPersona that uses the snapshot's prompt fields layered over
 *      the live persona's runtime contracts. The runner accepts this
 *      transparently; replay is just `runAgent(amended, input, ctx, opts)`.
 *   5. diffPersonaOutputs(a, b) — small structural diff for the dashboard
 *      / CLI to render "v1.0.0 said X; v1.1.0 says Y" without reaching
 *      for a full diff library.
 *
 * Why snapshot only prompt fields: replay's value is "the SAME runtime
 * harness, but with the OLD prompt". If we pickled the full persona
 * including hooks (which are JS closures), we'd either freeze code or
 * silently fail to re-execute behaviour that changed in TS but not in
 * the snapshot. Prompt-only is honest about the boundary.
 */

import type Database from 'better-sqlite3';

import {
  createVersionedDefinition,
  findVersionedDefinition,
  type VersionedDefinition,
} from '../governance/versioned-registry.js';
import type { AgentPersona } from './types.js';

export interface PersonaSnapshot {
  /** Stable id used in events / logs. */
  readonly id: string;
  /** Persona schema/version — bumped when prompt or contract changes. */
  readonly version: string;
  /** Human-readable name (for the dashboard). */
  readonly name: string;
  /** Identity string copied verbatim into the system prompt. */
  readonly identity: string;
  /** Mission — single sentence the agent measures itself against. */
  readonly mission: string;
  readonly hardRules: readonly string[];
  readonly forbidden: readonly string[];
  readonly ambiguityProtocol: ReadonlyArray<{
    condition: string;
    resolution: string;
    escalate: boolean;
  }>;
  /** Tool allowlist at this snapshot. */
  readonly tools: readonly string[];
  /** Default model used when the input does not specify one. */
  readonly defaultModel: string | null;
  /** The system prompt template (interpolated by renderSystemPrompt). */
  readonly systemPromptTemplate: string;
}

export function snapshotPersona<I, O>(
  persona: AgentPersona<I, O>,
): PersonaSnapshot {
  return {
    id: persona.id,
    version: persona.version,
    name: persona.name,
    identity: persona.identity,
    mission: persona.mission,
    hardRules: [...persona.hardRules],
    forbidden: [...persona.forbidden],
    ambiguityProtocol: persona.ambiguityProtocol.map((r) => ({
      condition: r.condition,
      resolution: r.resolution,
      escalate: r.escalate ?? false,
    })),
    tools: [...persona.tools],
    defaultModel: persona.defaultModel,
    systemPromptTemplate: persona.systemPromptTemplate,
  };
}

/**
 * Persist a persona snapshot in versioned_definitions(kind='agent'). The
 * underlying registry rejects duplicates by (workspace, kind, name,
 * version); callers should bump persona.version before re-registering.
 *
 * `workspace` defaults to 'global' so the same persona snapshot serves
 * every run. Operators may override per-tenant by passing a workspace.
 */
export function registerPersonaVersion<I, O>(
  db: Database.Database,
  persona: AgentPersona<I, O>,
  options: { workspace?: string; createdBy?: string; notes?: string } = {},
): VersionedDefinition {
  const snapshot = snapshotPersona(persona);
  return createVersionedDefinition(db, {
    workspace: options.workspace ?? 'global',
    kind: 'agent',
    name: persona.id,
    version: persona.version,
    status: 'active',
    spec: snapshot,
    ...(options.createdBy ? { createdBy: options.createdBy } : {}),
    ...(options.notes ? { notes: options.notes } : {}),
  });
}

/**
 * Read a persona snapshot back. Returns null when no row exists for the
 * (workspace, name, version) tuple. Callers can then either fall back to
 * the live persona or report "version not found".
 */
export function getPersonaVersionSnapshot(
  db: Database.Database,
  name: string,
  version: string,
  options: { workspace?: string } = {},
): PersonaSnapshot | null {
  const row = findVersionedDefinition(db, {
    workspace: options.workspace ?? 'global',
    kind: 'agent',
    name,
    version,
  });
  if (!row) return null;
  return row.spec as PersonaSnapshot;
}

/**
 * Layer the snapshot's prompt fields over the live persona's runtime
 * contracts (schemas, hooks, failureModes, tool gates). The result is a
 * fully-typed AgentPersona that the runner can consume transparently.
 *
 * Replay's contract: SAME runtime harness, OLD prompt. If you want
 * "fully old behaviour" you need to also pin the calling code at the
 * matching git commit — that's outside this module's scope by design.
 */
export function buildAmendedPersona<I, O>(
  livePersona: AgentPersona<I, O>,
  snapshot: PersonaSnapshot,
): AgentPersona<I, O> {
  return {
    ...livePersona,
    version: snapshot.version,
    name: snapshot.name,
    identity: snapshot.identity,
    mission: snapshot.mission,
    hardRules: snapshot.hardRules,
    forbidden: snapshot.forbidden,
    ambiguityProtocol: snapshot.ambiguityProtocol,
    // Tools list is part of the snapshot for prompt accuracy, but we keep
    // the live permissions map: prompts referencing a tool that the live
    // permissions don't allow would just emit deny, which is the correct
    // safety contract.
    tools: snapshot.tools as readonly AgentPersona<I, O>['tools'][number][],
    defaultModel: snapshot.defaultModel,
    systemPromptTemplate: snapshot.systemPromptTemplate,
  };
}

export interface PersonaOutputDiff {
  /** True when JSON.stringify of both outputs is byte-equal. */
  readonly identical: boolean;
  /** Field-level changes when both outputs are JSON objects. */
  readonly changedKeys?: readonly string[];
  readonly addedKeys?: readonly string[];
  readonly removedKeys?: readonly string[];
}

/**
 * Tiny structural diff so the dashboard / CLI can render
 * "v1.0.0 said X; v1.1.0 says Y" without reaching for jsondiffpatch.
 * Falls back to identical=false when either side isn't a plain object.
 */
export function diffPersonaOutputs(a: unknown, b: unknown): PersonaOutputDiff {
  if (JSON.stringify(a) === JSON.stringify(b)) return { identical: true };
  if (!isPlainObject(a) || !isPlainObject(b)) return { identical: false };

  const aKeys = new Set(Object.keys(a));
  const bKeys = new Set(Object.keys(b));
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];

  for (const key of bKeys) {
    if (!aKeys.has(key)) added.push(key);
    else if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) changed.push(key);
  }
  for (const key of aKeys) {
    if (!bKeys.has(key)) removed.push(key);
  }

  return {
    identical: false,
    ...(changed.length > 0 ? { changedKeys: changed } : {}),
    ...(added.length > 0 ? { addedKeys: added } : {}),
    ...(removed.length > 0 ? { removedKeys: removed } : {}),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
