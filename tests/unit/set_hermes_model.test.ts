import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/home/user'),
}));

import { readFileSync, writeFileSync } from 'node:fs';
import { setHermesModelTool } from '../../src/mcp/tools/set_hermes_model.js';

const mockRead = readFileSync as ReturnType<typeof vi.fn>;
const mockWrite = writeFileSync as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('setHermesModelTool — YAML single-quoting', () => {
  it('replaces existing model line with single-quoted value', async () => {
    mockRead.mockReturnValue('model: old-model\nsome_other: value\n');

    await setHermesModelTool({ model_id: 'cc/claude-sonnet-4-6' });

    expect(mockWrite).toHaveBeenCalledOnce();
    const written: string = mockWrite.mock.calls[0][1];
    expect(written).toContain("model: 'cc/claude-sonnet-4-6'");
    expect(written).not.toContain('model: cc/claude-sonnet-4-6\n');
  });

  it('prepends single-quoted model line when key is absent', async () => {
    mockRead.mockReturnValue('some_other: value\n');

    await setHermesModelTool({ model_id: 'cc/claude-sonnet-4-6' });

    expect(mockWrite).toHaveBeenCalledOnce();
    const written: string = mockWrite.mock.calls[0][1];
    expect(written).toMatch(/^model: 'cc\/claude-sonnet-4-6'\n/);
  });

  it('handles model IDs with colon (provider/foo:bar) safely', async () => {
    mockRead.mockReturnValue('model: old\n');

    await setHermesModelTool({ model_id: 'provider/foo:bar' });

    const written: string = mockWrite.mock.calls[0][1];
    expect(written).toContain("model: 'provider/foo:bar'");
  });

  it('rejects model_id containing a single quote', async () => {
    await expect(
      setHermesModelTool({ model_id: "bad'id" }),
    ).rejects.toThrow();
    expect(mockWrite).not.toHaveBeenCalled();
  });
});
