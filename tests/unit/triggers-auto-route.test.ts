import { describe, it, expect } from 'vitest';
import { detectTriggers, suggestSpecialistAdvisor } from '../../src/v2/triggers/auto-route.js';

describe('detectTriggers', () => {
  it('detects image attachment', () => {
    const results = detectTriggers('hello', [{ mime_type: 'image/png', name: 'photo.png' }]);
    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe('image');
    expect(results[0].specialist_persona_hint).toBe('worker.advisor_call');
  });

  it('detects pdf attachment', () => {
    const results = detectTriggers('see attached', [{ mime_type: 'application/pdf', name: 'doc.pdf' }]);
    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe('pdf');
  });

  it('detects code block in prompt', () => {
    const results = detectTriggers('Check this:\n```typescript\nconst x = 1;\n```');
    expect(results.some(r => r.kind === 'code_block')).toBe(true);
  });

  it('detects URL in prompt', () => {
    const results = detectTriggers('See https://example.com for details');
    expect(results.some(r => r.kind === 'url')).toBe(true);
    expect(results.find(r => r.kind === 'url')?.payload).toContain('example.com');
  });

  it('detects multiple triggers at once', () => {
    const results = detectTriggers('See https://foo.com\n```js\nconsole.log(1)\n```', [
      { mime_type: 'image/jpeg', name: 'img.jpg' },
    ]);
    const kinds = results.map(r => r.kind);
    expect(kinds).toContain('image');
    expect(kinds).toContain('url');
    expect(kinds).toContain('code_block');
  });

  it('returns empty array for plain prompt with no attachments', () => {
    const results = detectTriggers('just text here');
    expect(results).toHaveLength(0);
  });
});

describe('suggestSpecialistAdvisor', () => {
  it('image → analyze', () => {
    expect(suggestSpecialistAdvisor([{ kind: 'image', payload: 'x.png' }])).toBe('analyze');
  });

  it('pdf → apilookup', () => {
    expect(suggestSpecialistAdvisor([{ kind: 'pdf', payload: 'x.pdf' }])).toBe('apilookup');
  });

  it('code_block → codereview', () => {
    expect(suggestSpecialistAdvisor([{ kind: 'code_block', payload: '```ts' }])).toBe('codereview');
  });

  it('empty → null', () => {
    expect(suggestSpecialistAdvisor([])).toBeNull();
  });
});
