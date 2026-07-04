/**
 * Wave 3.G — persona versioning + replay-against-version tests.
 *
 * Covers:
 *   - snapshotPersona extracts the prompt-shape fields and skips non-
 *     serialisable runtime fields (schemas / hooks / failureModes).
 *   - registerPersonaVersion writes into versioned_definitions(kind='agent')
 *     and round-trips through getPersonaVersionSnapshot.
 *   - Duplicate (workspace, name, version) inserts throw a clear error
 *     so callers know to bump the persona's version.
 *   - buildAmendedPersona produces a persona that pairs the old prompt
 *     with the live runtime contracts; runAgent on it succeeds and the
 *     emitted persona_version reflects the snapshot, not the live one.
 *   - diffPersonaOutputs reports identical when JSON-byte-equal,
 *     surfaces changed/added/removed keys for object outputs, and
 *     gracefully handles non-objects.
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  buildAmendedPersona,
  diffPersonaOutputs,
  getPersonaVersionSnapshot,
  registerPersonaVersion,
  snapshotPersona,
} from '../../src/v2/agents/version-registry.js';
import {
  createInMemoryContext,
  runAgent,
  type AgentInvoker,
} from '../../src/v2/agents/runner.js';
import type { AgentPersona } from '../../src/v2/agents/types.js';

interface ReplayInput { topic: string }
interface ReplayOutput { result: string }

const LIVE_PERSONA: AgentPersona<ReplayInput, ReplayOutput> = {
  id: 'replay.test',
  version: '2.0.0',
  name: 'Replay Test (live)',
  identity: 'Live identity, v2.0.0.',
  mission: 'Echo topic.',
  inputSchema: z.object({ topic: z.string() }),
  outputSchema: z.object({ result: z.string() }),
  hardRules: ['Be brief.'],
  forbidden: ['No fences.'],
  ambiguityProtocol: [
    { condition: 'topic empty', resolution: 'return empty result', escalate: false },
  ],
  tools: ['Read'],
  defaultModel: 'cc/claude-sonnet-4-6',
  systemPromptTemplate: 'V2 prompt: ${INPUT.topic}',
  failureModes: [],
};

function v1Snapshot(): AgentPersona<ReplayInput, ReplayOutput> {
  return {
    ...LIVE_PERSONA,
    version: '1.0.0',
    name: 'Replay Test (v1)',
    identity: 'V1 identity.',
    mission: 'V1 mission.',
    hardRules: ['v1 only rule'],
    forbidden: ['v1 only forbidden'],
    ambiguityProtocol: [],
    systemPromptTemplate: 'V1 prompt: ${INPUT.topic}',
  };
}

function makeDbWithSchema(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE versioned_definitions (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('agent','tool','policy')),
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','active','deprecated','archived')),
      spec_json TEXT NOT NULL,
      checksum_sha256 TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      created_by TEXT,
      supersedes_id TEXT,
      notes TEXT,
      UNIQUE(workspace, kind, name, version)
    );
  `);
  return db;
}

describe('snapshotPersona', () => {
  it('captures prompt fields and ignores schemas / hooks', () => {
    const snap = snapshotPersona(LIVE_PERSONA);
    expect(snap.id).toBe('replay.test');
    expect(snap.version).toBe('2.0.0');
    expect(snap.identity).toBe('Live identity, v2.0.0.');
    expect(snap.systemPromptTemplate).toContain('V2 prompt');
    expect(snap.tools).toEqual(['Read']);
    // Round-trip JSON must be lossless — proves no closures leaked in.
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
  });

  it('normalises ambiguityProtocol entries to always carry escalate', () => {
    const snap = snapshotPersona(LIVE_PERSONA);
    expect(snap.ambiguityProtocol[0]?.escalate).toBe(false);
  });
});

describe('registerPersonaVersion + getPersonaVersionSnapshot', () => {
  let db: Database.Database;

  beforeEach(() => { db = makeDbWithSchema(); });
  afterEach(() => { db.close(); });

  it('writes a row in versioned_definitions and reads it back', () => {
    registerPersonaVersion(db, LIVE_PERSONA, { createdBy: 'tester' });
    const back = getPersonaVersionSnapshot(db, 'replay.test', '2.0.0');
    expect(back).not.toBeNull();
    expect(back?.systemPromptTemplate).toBe('V2 prompt: ${INPUT.topic}');
  });

  it('uses workspace=global by default; honours overrides', () => {
    registerPersonaVersion(db, LIVE_PERSONA);
    expect(getPersonaVersionSnapshot(db, 'replay.test', '2.0.0')).not.toBeNull();
    expect(
      getPersonaVersionSnapshot(db, 'replay.test', '2.0.0', { workspace: 'tenant_a' }),
    ).toBeNull();
  });

  it('returns null for unknown (name, version)', () => {
    expect(getPersonaVersionSnapshot(db, 'unknown', '0.0.1')).toBeNull();
  });

  it('rejects duplicate (workspace, name, version) — caller must bump', () => {
    registerPersonaVersion(db, LIVE_PERSONA);
    expect(() => registerPersonaVersion(db, LIVE_PERSONA)).toThrow(/already exists/);
  });
});

describe('buildAmendedPersona + runAgent replay', () => {
  it('runs runAgent with the snapshot prompt and emits the snapshot version', async () => {
    const db = makeDbWithSchema();
    try {
      registerPersonaVersion(db, v1Snapshot());
      const snap = getPersonaVersionSnapshot(db, 'replay.test', '1.0.0');
      expect(snap).not.toBeNull();
      const amended = buildAmendedPersona(LIVE_PERSONA, snap!);

      const ctx = createInMemoryContext({ workflowId: 'wf_z', taskId: 'tk_z' });
      const seenSystemPrompts: string[] = [];
      const invoke: AgentInvoker = async (args) => {
        seenSystemPrompts.push(args.systemPrompt);
        return '{"result":"replayed"}';
      };

      const out = await runAgent(amended, { topic: 'demo' }, ctx, {
        invoke,
        parseJson: true,
      });

      expect(out.result).toBe('replayed');
      expect(seenSystemPrompts[0]).toContain('V1 prompt: demo');

      const started = ctx.events.find((e) => e.event === 'agent_started');
      expect(started?.payload['persona_version']).toBe('1.0.0');
      const completed = ctx.events.find((e) => e.event === 'agent_completed');
      expect(completed?.payload['persona_version']).toBe('1.0.0');
    } finally {
      db.close();
    }
  });

  it('keeps the live runtime contracts (schemas, hooks)', async () => {
    const ctx = createInMemoryContext({ workflowId: 'wf_z', taskId: 'tk_z' });
    const amended = buildAmendedPersona(LIVE_PERSONA, snapshotPersona(v1Snapshot()));

    // Output that DOES NOT match the live outputSchema — should hit the
    // one-shot retry; second invoke recovers. Proves the schema is from
    // the live persona, not the snapshot.
    let calls = 0;
    const invoke: AgentInvoker = async () => {
      calls++;
      return calls === 1 ? '{}' : '{"result":"rescued"}';
    };
    const out = await runAgent(amended, { topic: 't' }, ctx, {
      invoke,
      parseJson: true,
    });
    expect(out.result).toBe('rescued');
    expect(calls).toBe(2);
  });
});

describe('diffPersonaOutputs', () => {
  it('returns identical when both outputs are JSON-byte-equal', () => {
    expect(diffPersonaOutputs({ result: 'a' }, { result: 'a' })).toEqual({ identical: true });
  });

  it('reports changed/added/removed keys for plain objects', () => {
    const diff = diffPersonaOutputs(
      { keep: 'same', changed: 'old', removed: 'gone' },
      { keep: 'same', changed: 'new', added: 'fresh' },
    );
    expect(diff.identical).toBe(false);
    expect(diff.changedKeys).toEqual(['changed']);
    expect(diff.addedKeys).toEqual(['added']);
    expect(diff.removedKeys).toEqual(['removed']);
  });

  it('falls back to identical=false for non-object inputs', () => {
    expect(diffPersonaOutputs('a', 'b').identical).toBe(false);
    expect(diffPersonaOutputs('a', 'b').changedKeys).toBeUndefined();
    expect(diffPersonaOutputs([1, 2], [1, 2]).identical).toBe(true);
    expect(diffPersonaOutputs([1, 2], [1, 3]).identical).toBe(false);
  });
});
