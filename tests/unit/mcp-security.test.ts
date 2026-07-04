import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SetConfigSchema, setConfigTool } from '../../src/mcp/tools/set_config.js';
import { SetHermesModelSchema } from '../../src/mcp/tools/set_hermes_model.js';
import { readFileTool } from '../../src/mcp/tools/read_file.js';

describe('MCP security hardening', () => {
  let originalCwd: string;
  let tempRoot: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempRoot = await mkdtemp(path.join(tmpdir(), 'omniforge-mcp-security-'));
    process.chdir(tempRoot);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempRoot, { recursive: true, force: true });
    delete process.env.OMNIFORGE_MAX_PARALLEL_TASKS;
    delete process.env.OMNIFORGE_QUOTA_GUARD;
    vi.restoreAllMocks();
  });

  it('set_config rejects newline injection before writing .env', async () => {
    expect(() =>
      SetConfigSchema.parse({
        key: 'TASK_MODEL',
        value: 'cc/claude-sonnet-4-6\nCLI_SAFE_MODE=false',
      }),
    ).toThrow(/invalid/i);

    await expect(
      setConfigTool({
        key: 'TASK_MODEL',
        value: 'cc/claude-sonnet-4-6\nCLI_SAFE_MODE=false',
      }),
    ).rejects.toThrow(/invalid/i);
  });

  it('set_config accepts operational limits but validates unsafe limit values', async () => {
    await expect(
      setConfigTool({
        key: 'OMNIFORGE_MAX_PARALLEL_TASKS',
        value: '3',
      }),
    ).resolves.toContain('OMNIFORGE_MAX_PARALLEL_TASKS');
    expect(process.env.OMNIFORGE_MAX_PARALLEL_TASKS).toBe('3');

    expect(() =>
      SetConfigSchema.parse({
        key: 'OMNIFORGE_MAX_PARALLEL_TASKS',
        value: 'many',
      }),
    ).toThrow(/numeric/i);

    expect(() =>
      SetConfigSchema.parse({
        key: 'OMNIFORGE_QUOTA_GUARD',
        value: 'block-hard',
      }),
    ).toThrow(/off, warn or enforce/i);
  });

  it('set_hermes_model rejects newline injection', () => {
    expect(() =>
      SetHermesModelSchema.parse({
        model_id: 'cc/claude-sonnet-4-6\nsystem: pwned',
      }),
    ).toThrow(/invalid/i);
  });

  it('read_file rejects secret-like files even inside the project root', () => {
    const secretPath = path.join(tempRoot, '.env');
    writeFileSync(secretPath, 'OMNIROUTE_API_KEY=should-not-be-read', 'utf8');

    const parsed = JSON.parse(readFileTool({ path: secretPath })) as { error?: string; content?: string };
    expect(parsed.error).toMatch(/denied|secret/i);
    expect(parsed.content).toBeUndefined();
  });

  it('read_file rejects absolute paths outside the project root by default', () => {
    const outsideDir = path.join(tmpdir(), `omniforge-outside-${Date.now()}`);
    mkdirSync(outsideDir, { recursive: true });
    const outsidePath = path.join(outsideDir, 'outside.txt');
    writeFileSync(outsidePath, 'outside', 'utf8');

    try {
      const parsed = JSON.parse(readFileTool({ path: outsidePath })) as { error?: string; content?: string };
      expect(parsed.error).toMatch(/outside|allowlist|workspace/i);
      expect(parsed.content).toBeUndefined();
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
