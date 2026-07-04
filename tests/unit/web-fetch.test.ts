import type { LookupAddress } from 'node:dns';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const lookupMock = vi.hoisted(() => vi.fn());

vi.mock('node:dns/promises', () => ({
  lookup: (...args: Parameters<typeof import('node:dns/promises').lookup>) => lookupMock(...args),
}));

import type { ToolContext } from '../../src/v2/tools/registry.js';
import { resolveTool } from '../../src/v2/tools/registry.js';
import { webFetch } from '../../src/v2/tools/core/web-fetch.js';

const ctxStub = {
  workspace: 'internal',
  workflowId: 'wf_test_web_fetch',
  workspaceRoot: '/tmp',
} satisfies ToolContext;

beforeEach(() => {
  lookupMock.mockReset();
  vi.stubGlobal('fetch', undefined as unknown as typeof fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.WEB_FETCH_ALLOWLIST;
});

describe('webFetch', () => {
  it('throws for file:// URL', async () => {
    await expect(
      webFetch({
        url: 'file:///etc/passwd',
        method: 'GET',
        timeout: 1000,
      }),
    ).rejects.toThrow(/file:\/\//i);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('throws for localhost', async () => {
    await expect(
      webFetch({
        url: 'http://localhost/foo',
        method: 'GET',
        timeout: 1000,
      }),
    ).rejects.toThrow(/blocked host/i);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('throws for 127.0.0.1', async () => {
    await expect(
      webFetch({
        url: 'http://127.0.0.1/foo',
        method: 'GET',
        timeout: 1000,
      }),
    ).rejects.toThrow(/blocked host/i);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('throws for 0.0.0.0', async () => {
    await expect(
      webFetch({
        url: 'http://0.0.0.0/foo',
        method: 'GET',
        timeout: 1000,
      }),
    ).rejects.toThrow(/blocked host/i);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('throws for [::1] URL', async () => {
    await expect(
      webFetch({
        url: 'http://[::1]/',
        method: 'GET',
        timeout: 1000,
      }),
    ).rejects.toThrow(/blocked host/i);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('throws when DNS resolves to RFC1918 (mocked dns.lookup)', async () => {
    delete process.env.WEB_FETCH_ALLOWLIST;
    lookupMock.mockResolvedValue([{ address: '10.44.55.66', family: 4 }] satisfies LookupAddress[]);
    await expect(
      webFetch({
        url: 'http://evil.example.invalid/',
        method: 'GET',
        timeout: 1000,
      }),
    ).rejects.toThrow(/blocked address/i);
    expect(lookupMock).toHaveBeenCalledWith('evil.example.invalid', { all: true, verbatim: true });
  });

  it('allows allowlisted host after public DNS resolve (mocked fetch + dns)', async () => {
    process.env.WEB_FETCH_ALLOWLIST = 'allowed.test';
    lookupMock.mockResolvedValue([{ address: '203.0.113.44', family: 4 }] satisfies LookupAddress[]);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('payload', {
        status: 200,
        headers: new Headers({ 'content-type': 'text/plain', 'content-length': '7' }),
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const out = await webFetch({
      url: 'http://allowed.test/hello',
      method: 'GET',
      timeout: 5000,
    });

    expect(out.status).toBe(200);
    expect(out.body).toBe('payload');
    expect(out.headers['content-type']).toBe('text/plain');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws when WEB_FETCH_ALLOWLIST is set but hostname misses', async () => {
    process.env.WEB_FETCH_ALLOWLIST = 'other.com';
    await expect(
      webFetch({
        url: 'https://disallowed.example/',
        method: 'GET',
        timeout: 1000,
      }),
    ).rejects.toThrow(/not in WEB_FETCH_ALLOWLIST/i);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('happy path GET returns status, body, headers', async () => {
    delete process.env.WEB_FETCH_ALLOWLIST;
    lookupMock.mockResolvedValue([{ address: '198.51.100.9', family: 4 }] satisfies LookupAddress[]);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('hello world', {
        status: 200,
        headers: new Headers({ 'x-test': '1' }),
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const out = await webFetch({
      url: 'http://PUBLIC.EXAMPLE/hello',
      method: 'GET',
      timeout: 5000,
    });

    expect(out).toMatchObject({
      status: 200,
      body: 'hello world',
    });
    expect(out.headers['x-test']).toBe('1');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.signal?.aborted).toBe(false);
  });

  it('throws AbortError when timeout exceeds (mock stalled fetch)', async () => {
    delete process.env.WEB_FETCH_ALLOWLIST;
    lookupMock.mockResolvedValue([{ address: '198.51.100.22', family: 4 }] satisfies LookupAddress[]);
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      }),
    );

    await expect(
      webFetch({
        url: 'http://stall.example/delay',
        method: 'GET',
        timeout: 40,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('4xx yields status and keeps body without throwing', async () => {
    delete process.env.WEB_FETCH_ALLOWLIST;
    lookupMock.mockResolvedValue([{ address: '198.51.100.77', family: 4 }] satisfies LookupAddress[]);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('not authorized', {
          status: 403,
          statusText: 'Forbidden',
          headers: new Headers({ 'x-rate-limit': '0' }),
        }),
      ),
    );

    const out = await webFetch({
      url: 'http://forbidden.example/private',
      method: 'GET',
      timeout: 5000,
    });

    expect(out.status).toBe(403);
    expect(out.body).toBe('not authorized');
    expect(out.headers['x-rate-limit']).toBe('0');
  });

  it('5xx yields status and keeps body without throwing', async () => {
    delete process.env.WEB_FETCH_ALLOWLIST;
    lookupMock.mockResolvedValue([{ address: '198.51.100.88', family: 4 }] satisfies LookupAddress[]);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('bad gateway', { status: 502 })),
    );

    const out = await webFetch({
      url: 'http://badgw.example/down',
      method: 'HEAD',
      timeout: 5000,
    });
    expect(out.status).toBe(502);
    expect(out.body).toBe('bad gateway');
  });
});

describe('web-fetch registry tool execute', () => {
  it('returns success envelope with JSON output', async () => {
    delete process.env.WEB_FETCH_ALLOWLIST;
    lookupMock.mockResolvedValue([{ address: '203.0.113.58', family: 4 }] satisfies LookupAddress[]);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ a: 1 }), { status: 200 })),
    );

    const tool = resolveTool('web-fetch');
    const parsed = tool.argsSchema.parse({
      url: 'http://api.example/obj',
      method: 'GET',
      timeout: 5000,
    });
    const res = await tool.execute(parsed, ctxStub);
    expect(res.success).toBe(true);
    const outer = JSON.parse(res.output ?? '{}') as { status: number; body: string; headers: Record<string, string> };
    expect(outer.status).toBe(200);
    expect(outer.body).toBe('{"a":1}');
  });
});
