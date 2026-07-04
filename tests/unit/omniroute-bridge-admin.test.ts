import { describe, it, expect } from 'vitest';
import {
  getAdminConfig,
  providerKey,
  compactConnectionLabel,
  connectionStatus,
} from '../../src/v2/omniroute-bridge/admin.js';

describe('getAdminConfig', () => {
  it('returns baseUrl derived from OMNIROUTE_ADMIN_BASE_URL when set', () => {
    const original = process.env.OMNIROUTE_ADMIN_BASE_URL;
    process.env.OMNIROUTE_ADMIN_BASE_URL = 'http://localhost:9999/v1';
    const config = getAdminConfig();
    expect(config.baseUrl).toBe('http://localhost:9999');
    process.env.OMNIROUTE_ADMIN_BASE_URL = original;
  });

  it('uses a default password when OMNIROUTE_ADMIN_PASSWORD not set', () => {
    const original = process.env.OMNIROUTE_ADMIN_PASSWORD;
    delete process.env.OMNIROUTE_ADMIN_PASSWORD;
    const config = getAdminConfig();
    expect(typeof config.password).toBe('string');
    expect(config.password.length).toBeGreaterThan(0);
    process.env.OMNIROUTE_ADMIN_PASSWORD = original;
  });

  it('strips trailing /v1 from base URL', () => {
    const original = process.env.OMNIROUTE_ADMIN_BASE_URL;
    process.env.OMNIROUTE_ADMIN_BASE_URL = 'http://example.com/v1';
    const config = getAdminConfig();
    expect(config.baseUrl).not.toMatch(/\/v1$/);
    process.env.OMNIROUTE_ADMIN_BASE_URL = original;
  });
});

describe('providerKey', () => {
  it('lowercases and replaces non-alphanum with hyphens', () => {
    expect(providerKey('OpenAI GPT')).toBe('openai-gpt');
  });

  it('strips leading/trailing hyphens', () => {
    expect(providerKey('--test--')).toBe('test');
  });

  it('handles empty string', () => {
    expect(providerKey('')).toBe('');
  });
});

describe('compactConnectionLabel', () => {
  it('returns a string for any input', () => {
    expect(typeof compactConnectionLabel({ name: 'openai', model: 'gpt-4o' })).toBe('string');
  });

  it('handles empty object without throwing', () => {
    expect(() => compactConnectionLabel({})).not.toThrow();
  });
});

describe('connectionStatus', () => {
  it('returns a string status', () => {
    expect(typeof connectionStatus({ status: 'active' })).toBe('string');
  });

  it('returns a string for empty object', () => {
    expect(typeof connectionStatus({})).toBe('string');
  });
});
