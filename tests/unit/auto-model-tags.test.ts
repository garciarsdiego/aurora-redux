import { afterEach, describe, expect, it } from 'vitest';
import {
  AUTO_TAG_DEFAULTS,
  resolveAutoTag,
} from '../../src/v2/models/auto-tags.js';
import { getAutoTagOverrides } from '../../src/utils/config.js';

describe('auto model tags', () => {
  afterEach(() => {
    delete process.env.OMNIFORGE_AUTO_TAG_OVERRIDES;
  });

  it('resolves auto to the default general model', () => {
    expect(resolveAutoTag('auto')).toBe(AUTO_TAG_DEFAULTS.auto);
  });

  it('resolves auto:vision to the default vision model', () => {
    expect(resolveAutoTag('auto:vision')).toBe(AUTO_TAG_DEFAULTS['auto:vision']);
  });

  it('lets explicit overrides win for an auto tag', () => {
    expect(resolveAutoTag('auto:fast', {
      'auto:fast': 'test/fast-model',
    })).toBe('test/fast-model');
  });

  it('returns concrete model ids unchanged', () => {
    expect(resolveAutoTag('cc/claude-sonnet-4-6')).toBe('cc/claude-sonnet-4-6');
  });

  it('reads JSON overrides lazily from the environment', () => {
    process.env.OMNIFORGE_AUTO_TAG_OVERRIDES = JSON.stringify({
      'auto:cheap': 'test/cheap-model',
    });

    expect(getAutoTagOverrides()).toEqual({
      'auto:cheap': 'test/cheap-model',
    });
  });
});
