import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock omniroute-call before importing compaction
vi.mock('../../src/utils/omniroute-call.js', () => ({
  callOmnirouteWithUsage: vi.fn(),
}));

import { callOmnirouteWithUsage } from '../../src/utils/omniroute-call.js';
import {
  maybeCompact,
  smartTruncate,
  DEFAULT_COMPACTION_SETTINGS,
  type CompactionSettings,
} from '../../src/v2/context-engine/compaction.js';

const mockCall = callOmnirouteWithUsage as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('smartTruncate', () => {
  it('returns text unchanged when under maxChars', () => {
    const text = 'hello world';
    expect(smartTruncate(text, 1000)).toBe(text);
  });

  it('inserts omission marker when truncating', () => {
    const text = 'A'.repeat(1000);
    const result = smartTruncate(text, 200);
    expect(result).toContain('chars omitted');
    expect(result.length).toBeLessThan(text.length);
  });
});

describe('maybeCompact — under threshold (no-op)', () => {
  it('returns original context unchanged when chars <= threshold', async () => {
    const ctx = 'short context';
    const settings: CompactionSettings = {
      ...DEFAULT_COMPACTION_SETTINGS,
      autoCompactThreshold: 100_000,
    };
    const result = await maybeCompact(ctx, [], settings, 'model', 'sess1');
    expect(result.contextText).toBe(ctx);
    expect(result.compactStats.stage).toBe('none');
    expect(mockCall).not.toHaveBeenCalled();
  });

  it('returns no-op when autoCompactEnabled is false even if over threshold', async () => {
    const ctx = 'X'.repeat(200_000);
    const settings: CompactionSettings = {
      autoCompactEnabled: false,
      autoCompactThreshold: 100_000,
    };
    const result = await maybeCompact(ctx, [], settings, 'model', 'sess2');
    expect(result.compactStats.stage).toBe('none');
    expect(mockCall).not.toHaveBeenCalled();
  });
});

describe('maybeCompact — stage1 trim succeeds', () => {
  it('uses stage1 when trim achieves >= 20% savings', async () => {
    // Build a text that smartTruncate will reduce by >20% when truncated to threshold
    const threshold = 50_000;
    const ctx = 'A'.repeat(200_000); // 300% of threshold; trim to 50K = 75% savings
    const settings: CompactionSettings = {
      autoCompactEnabled: true,
      autoCompactThreshold: threshold,
    };
    const result = await maybeCompact(ctx, [], settings, 'model', 'sess3');
    expect(result.compactStats.stage).toBe('stage1');
    expect(result.compactStats.reductionPct).toBeGreaterThanOrEqual(20);
    expect(mockCall).not.toHaveBeenCalled();
  });
});

describe('maybeCompact — stage1 below 20% savings falls through to stage2', () => {
  it('calls LLM when trim savings < 20%', async () => {
    // Text is just barely over threshold; smartTruncate won't cut 20%
    const threshold = 100_000;
    // 101K chars — trim to 100K = ~1% savings, falls through to stage2
    const ctx = 'B'.repeat(101_000);

    mockCall.mockResolvedValueOnce({
      content: 'summarized content',
      model_used: 'haiku',
      usage: {},
    });

    const settings: CompactionSettings = {
      autoCompactEnabled: true,
      autoCompactThreshold: threshold,
    };
    const result = await maybeCompact(ctx, [], settings, 'model', 'sess4');
    expect(result.compactStats.stage).toBe('stage2');
    expect(mockCall).toHaveBeenCalledOnce();
    expect(result.contextText).toBe('summarized content');
  });
});

describe('maybeCompact — stage2 archives to data/vault/compaction_archives/', () => {
  it('sets archivePath in result when stage2 runs', async () => {
    const threshold = 100_000;
    const ctx = 'C'.repeat(101_000);

    mockCall.mockResolvedValueOnce({
      content: 'summary',
      model_used: 'haiku',
      usage: {},
    });

    const settings: CompactionSettings = {
      autoCompactEnabled: true,
      autoCompactThreshold: threshold,
    };
    const result = await maybeCompact(ctx, [], settings, 'model', 'sess5');
    expect(result.archivePath).toBeDefined();
    expect(result.archivePath).toContain('compaction_archives');
    expect(result.archivePath).toContain('sess5');
  });
});

describe('maybeCompact — LLM failure graceful fallback', () => {
  it('falls back to trimmed text when LLM call throws', async () => {
    const threshold = 100_000;
    const ctx = 'D'.repeat(101_000);

    mockCall.mockRejectedValueOnce(new Error('LLM unavailable'));

    const settings: CompactionSettings = {
      autoCompactEnabled: true,
      autoCompactThreshold: threshold,
    };
    const result = await maybeCompact(ctx, [], settings, 'model', 'sess6');
    // Should not throw; returns stage2 with fallback trimmed content
    expect(result.compactStats.stage).toBe('stage2');
    expect(result.contextText).toBeTruthy();
    expect(result.contextText.length).toBeLessThan(ctx.length);
  });
});
