import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { ZodError } from 'zod';
import { TOOLS } from '../../src/mcp/server.js';
import {
  RegisterVersionedDefinitionSchema,
  registerVersionedDefinitionTool,
} from '../../src/mcp/tools/register_versioned_definition.js';
import {
  listVersionedDefinitionsTool,
} from '../../src/mcp/tools/list_versioned_definitions.js';
import {
  pinVersionedDefinitionTool,
} from '../../src/mcp/tools/pin_versioned_definition.js';

describe('MCP versioned governance registry tools', () => {
  let tempDir: string;
  let originalDbPath: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'omniforge-versioned-mcp-'));
    originalDbPath = process.env.DB_PATH;
    process.env.DB_PATH = join(tempDir, 'omniforge.db');
  });

  afterEach(async () => {
    if (originalDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = originalDbPath;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('registers all three tools in the MCP tool list', () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toContain('omniforge_register_versioned_definition');
    expect(names).toContain('omniforge_list_versioned_definitions');
    expect(names).toContain('omniforge_pin_versioned_definition');
  });

  it('validates register input with kind restricted to agent/tool/policy', () => {
    const parsed = RegisterVersionedDefinitionSchema.parse({
      workspace: 'internal',
      kind: 'agent',
      name: 'researcher',
      version: '1.0.0',
      spec: { role: 'researcher' },
    });
    expect(parsed.kind).toBe('agent');

    expect(() =>
      RegisterVersionedDefinitionSchema.parse({
        workspace: 'internal',
        kind: 'workflow',
        name: 'x',
        version: '1.0.0',
        spec: {},
      }),
    ).toThrow(ZodError);
  });

  it('registers and lists a versioned policy definition', async () => {
    const created = JSON.parse(await registerVersionedDefinitionTool({
      workspace: 'internal',
      kind: 'policy',
      name: 'safe-tools',
      version: '1.0.0',
      status: 'active',
      spec: { tools: { allowed: ['file-read'], denied: ['bash'] } },
      created_by: 'mcp-test',
    })) as { id: string; checksum_sha256: string };

    expect(created.id).toMatch(/^vd_/);
    expect(created.checksum_sha256).toMatch(/^[a-f0-9]{64}$/);

    const listed = JSON.parse(await listVersionedDefinitionsTool({
      workspace: 'internal',
      kind: 'policy',
    })) as Array<{ id: string; name: string; version: string; spec: unknown }>;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: created.id,
      name: 'safe-tools',
      version: '1.0.0',
      spec: { tools: { allowed: ['file-read'], denied: ['bash'] } },
    });
  });

  it('pins a registered definition as active and reports the active version', async () => {
    const created = JSON.parse(await registerVersionedDefinitionTool({
      workspace: 'internal',
      kind: 'agent',
      name: 'coder',
      version: '2.0.0',
      spec: { role: 'coder', model: 'cc/claude-sonnet-4-6' },
    })) as { id: string };

    const pinned = JSON.parse(await pinVersionedDefinitionTool({
      workspace: 'internal',
      kind: 'agent',
      name: 'coder',
      version_id: created.id,
      pinned_by: 'mcp-test',
    })) as { active: { id: string; version: string } };

    expect(pinned.active.id).toBe(created.id);
    expect(pinned.active.version).toBe('2.0.0');
  });
});
