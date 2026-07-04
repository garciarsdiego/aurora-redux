import { afterEach, describe, expect, it } from 'vitest';

import { getUsePersonas } from '../../src/utils/config.js';

describe('config', () => {
  const originalUsePersonas = process.env.OMNIFORGE_USE_PERSONAS;

  afterEach(() => {
    if (originalUsePersonas === undefined) delete process.env.OMNIFORGE_USE_PERSONAS;
    else process.env.OMNIFORGE_USE_PERSONAS = originalUsePersonas;
  });

  it('enables persona paths by default', () => {
    delete process.env.OMNIFORGE_USE_PERSONAS;

    expect(getUsePersonas()).toBe(true);
  });

  it('allows persona paths to be disabled explicitly', () => {
    process.env.OMNIFORGE_USE_PERSONAS = 'false';

    expect(getUsePersonas()).toBe(false);
  });
});
