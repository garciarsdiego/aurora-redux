import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { initDb } from '../../src/db/client.js';
import {
  createVersionedDefinition,
  findVersionedDefinition,
  getActiveVersionedDefinition,
  listVersionedDefinitions,
  pinVersionedDefinition,
  recordVersionedDefinitionUsage,
} from '../../src/v2/governance/versioned-registry.js';

describe('versioned governance registry', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(':memory:');
  });

  it('creates immutable versioned definitions for agents, tools and policies', () => {
    const agent = createVersionedDefinition(db, {
      workspace: 'internal',
      kind: 'agent',
      name: 'researcher',
      version: '1.0.0',
      spec: { role: 'researcher', model: 'cc/claude-sonnet-4-6' },
      createdBy: 'test',
      status: 'active',
    });
    const tool = createVersionedDefinition(db, {
      workspace: 'internal',
      kind: 'tool',
      name: 'file-write',
      version: '1.0.0',
      spec: { risk: 'write', args: ['path', 'content'] },
    });
    const policy = createVersionedDefinition(db, {
      workspace: 'internal',
      kind: 'policy',
      name: 'safe-tools',
      version: '1.0.0',
      spec: { tools: { allowed: ['file-read'], denied: ['bash'] } },
    });

    expect(agent.id).toMatch(/^vd_/);
    expect(agent.checksum_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(tool.kind).toBe('tool');
    expect(policy.kind).toBe('policy');

    const rows = listVersionedDefinitions(db, { workspace: 'internal' });
    expect(rows.map((r) => `${r.kind}:${r.name}@${r.version}`).sort()).toEqual([
      'agent:researcher@1.0.0',
      'policy:safe-tools@1.0.0',
      'tool:file-write@1.0.0',
    ]);
  });

  it('enforces unique workspace/kind/name/version and preserves the original spec', () => {
    createVersionedDefinition(db, {
      workspace: 'internal',
      kind: 'agent',
      name: 'coder',
      version: '1.0.0',
      spec: { model: 'cc/claude-sonnet-4-6' },
    });

    expect(() =>
      createVersionedDefinition(db, {
        workspace: 'internal',
        kind: 'agent',
        name: 'coder',
        version: '1.0.0',
        spec: { model: 'different' },
      }),
    ).toThrow(/already exists/i);

    const row = findVersionedDefinition(db, {
      workspace: 'internal',
      kind: 'agent',
      name: 'coder',
      version: '1.0.0',
    });
    expect(row?.spec).toEqual({ model: 'cc/claude-sonnet-4-6' });
  });

  it('pins an active version per workspace/kind/name and can move the pin forward', () => {
    const v1 = createVersionedDefinition(db, {
      workspace: 'internal',
      kind: 'policy',
      name: 'safe-tools',
      version: '1.0.0',
      spec: { tools: { allowed: ['file-read'] } },
    });
    const v2 = createVersionedDefinition(db, {
      workspace: 'internal',
      kind: 'policy',
      name: 'safe-tools',
      version: '1.1.0',
      spec: { tools: { allowed: ['file-read', 'file-write'] } },
      supersedesId: v1.id,
    });

    pinVersionedDefinition(db, {
      workspace: 'internal',
      kind: 'policy',
      name: 'safe-tools',
      versionId: v1.id,
      pinnedBy: 'test',
    });
    expect(getActiveVersionedDefinition(db, {
      workspace: 'internal',
      kind: 'policy',
      name: 'safe-tools',
    })?.version).toBe('1.0.0');

    pinVersionedDefinition(db, {
      workspace: 'internal',
      kind: 'policy',
      name: 'safe-tools',
      versionId: v2.id,
      pinnedBy: 'test',
    });
    expect(getActiveVersionedDefinition(db, {
      workspace: 'internal',
      kind: 'policy',
      name: 'safe-tools',
    })?.version).toBe('1.1.0');
  });

  it('records which version influenced a workflow for replay and audit', () => {
    const definition = createVersionedDefinition(db, {
      workspace: 'internal',
      kind: 'agent',
      name: 'reviewer',
      version: '2.0.0',
      spec: { role: 'reviewer' },
    });
    db.prepare(
      `INSERT INTO workflows (id, workspace, objective, status, created_at)
       VALUES ('wf_versioned', 'internal', 'test', 'pending', ?)`,
    ).run(Date.now());

    const usage = recordVersionedDefinitionUsage(db, {
      workflowId: 'wf_versioned',
      definitionId: definition.id,
      role: 'reviewer-agent',
      reason: 'selected by workflow policy',
    });

    expect(usage.id).toMatch(/^vdu_/);
    expect(usage.definition_id).toBe(definition.id);
    expect(usage.workflow_id).toBe('wf_versioned');
    expect(usage.reason).toBe('selected by workflow policy');
  });
});
