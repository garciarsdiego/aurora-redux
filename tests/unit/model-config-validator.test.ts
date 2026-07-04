import { describe, it, expect, vi, afterEach } from 'vitest';

// Mock BEFORE importing the module under test so the import graph is intercepted
vi.mock('../../src/repl/services/modelCatalog.js', () => ({
  loadCatalog: vi.fn(),
}));

// Mock config getters so defaults don't pollute catalog validation tests.
// The real getters fall back to non-empty defaults which would trigger
// spurious "not in catalog" failures for unset env vars.
vi.mock('../../src/utils/config.js', () => ({
  getDecomposerModel: vi.fn(() => process.env.DECOMPOSER_MODEL ?? ''),
  getTaskModel: vi.fn(() => process.env.TASK_MODEL ?? ''),
  getReviewerModel: vi.fn(() => process.env.REVIEWER_MODEL ?? ''),
  getConsolidatorModel: vi.fn(() => process.env.CONSOLIDATOR_MODEL ?? ''),
}));

import { validateModelEnvsAgainstCatalog } from '../../src/v2/governance/model-config-validator.js';
import { loadCatalog } from '../../src/repl/services/modelCatalog.js';

const mockLoadCatalog = loadCatalog as ReturnType<typeof vi.fn>;

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.DECOMPOSER_MODEL;
  delete process.env.TASK_MODEL;
  delete process.env.REVIEWER_MODEL;
  delete process.env.CONSOLIDATOR_MODEL;
});

describe('validateModelEnvsAgainstCatalog', () => {
  it('returns valid=true when all configured models exist in catalog', async () => {
    process.env.TASK_MODEL = 'cc/claude-sonnet-4-6';
    mockLoadCatalog.mockResolvedValue({
      models: [
        { model_id: 'cc/claude-sonnet-4-6', kind: 'llm' },
      ],
    });
    const result = await validateModelEnvsAgainstCatalog();
    expect(result.valid).toBe(true);
    expect(result.failures).toHaveLength(0);
    expect(result.catalogReachable).toBe(true);
  });

  it('returns valid=false with failure when model not in catalog', async () => {
    process.env.TASK_MODEL = 'cc/nonexistent-model';
    mockLoadCatalog.mockResolvedValue({
      models: [{ model_id: 'cc/claude-sonnet-4-6', kind: 'llm' }],
    });
    const result = await validateModelEnvsAgainstCatalog();
    expect(result.valid).toBe(false);
    expect(result.failures.length).toBeGreaterThan(0);
    const failure = result.failures.find((f) => f.env === 'TASK_MODEL');
    expect(failure).toBeDefined();
    expect(failure?.value).toBe('cc/nonexistent-model');
  });

  it('returns valid=true with catalogReachable=false when catalog throws', async () => {
    process.env.TASK_MODEL = 'cc/some-model';
    mockLoadCatalog.mockRejectedValue(new Error('network error'));
    const result = await validateModelEnvsAgainstCatalog();
    expect(result.valid).toBe(true);
    expect(result.catalogReachable).toBe(false);
  });

  it('provides suggestions for typo-like model IDs', async () => {
    process.env.TASK_MODEL = 'cc/claude-sonnet';
    mockLoadCatalog.mockResolvedValue({
      models: [
        { model_id: 'cc/claude-sonnet-4-6', kind: 'llm' },
        { model_id: 'cc/claude-opus-4-6', kind: 'llm' },
      ],
    });
    const result = await validateModelEnvsAgainstCatalog();
    const failure = result.failures.find((f) => f.env === 'TASK_MODEL');
    expect(failure?.suggestions.length).toBeGreaterThan(0);
    // Should suggest the closest match
    expect(failure?.suggestions.some((s) => s.includes('claude-sonnet'))).toBe(true);
  });
});
