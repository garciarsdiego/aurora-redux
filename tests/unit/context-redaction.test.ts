import { describe, expect, it } from 'vitest';
import { redactContextBody, redactContextJson, redactContextText } from '../../src/context/redaction.js';

describe('context redaction', () => {
  it('redacts common API key and bearer token shapes', () => {
    const input = [
      'Authorization: Bearer abc.def.ghi',
      'Authorization: Basic dXNlcjpwYXNz',
      'Cookie: omniforge_daemon_token=daemon-secret; session_id=visible',
      'DATABASE_URL=postgres://user:pass@localhost:5432/db',
      'OPENAI_API_KEY=sk-secret123456789',
      'api_key=lov_real_value',
      'access_token=token_real_value',
      'password: plain-secret',
    ].join('\n');
    const redacted = redactContextText(input);

    expect(redacted).toContain('Bearer ***');
    expect(redacted).toContain('Authorization: Basic ***');
    expect(redacted).toContain('Cookie: ***');
    expect(redacted).toContain('DATABASE_URL=***');
    expect(redacted).toContain('OPENAI_API_KEY=***');
    expect(redacted).not.toContain('sk-secret123456789');
    expect(redacted).not.toContain('lov_real_value');
    expect(redacted).not.toContain('token_real_value');
    expect(redacted).not.toContain('abc.def.ghi');
    expect(redacted).not.toContain('plain-secret');
    expect(redacted).not.toContain('user:pass');
  });

  it('redacts nested JSON before persistence', () => {
    const value = redactContextJson({
      env: { LOVABLE_API_KEY: 'lov_real_value' },
      token: 'Bearer abc123456789',
      nested: [{ password: 'plain-secret' }],
    });
    const serialized = JSON.stringify(value);

    expect(serialized).not.toContain('lov_real_value');
    expect(serialized).not.toContain('plain-secret');
    expect(serialized).toContain('Bearer ***');
  });

  it('applies key-aware redaction to JSON-shaped text bodies', () => {
    const redacted = redactContextBody(JSON.stringify({
      api_key: 'lov_real_value',
      nested: { password: 'plain-secret' },
      visible: 'keep-me',
    }));

    expect(redacted).toContain('keep-me');
    expect(redacted).not.toContain('lov_real_value');
    expect(redacted).not.toContain('plain-secret');
    expect(redacted).toContain('***');
  });
});
