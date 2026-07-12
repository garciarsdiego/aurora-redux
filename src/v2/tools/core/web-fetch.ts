import { lookup } from 'node:dns/promises';
import { isIPv4 } from 'node:net';
import { z } from 'zod';
import { registerTool, type ToolResult, type ToolContext } from '../registry.js';

const DEFAULT_UA = 'Omniforge/0.3 (web-fetch native tool)';

const BLOCKED_LITERAL_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '[::1]',
  '::1',
]);

/** Parse WEB_FETCH_ALLOWLIST="a.com,b.com" → lowercase host set (unset = no allowlist restriction). */
function readWebFetchAllowlist(): Set<string> | null {
  const raw = process.env.WEB_FETCH_ALLOWLIST;
  if (!raw?.trim()) return null;
  return new Set(
    raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
}

function ipv4ToU32(ip: string): number {
  const octets = ip.split('.').map((p) => Number(p));
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error(`Invalid IPv4: ${ip}`);
  }
  return (((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0);
}

/** True if IPv4 is loopback / RFC1918 / link-local / unspecified 0.0.0.0. */
function isBlockedIPv4Address(ip: string): boolean {
  const n = ipv4ToU32(ip);
  // 127.0.0.0/8
  if ((n & 0xff00_0000) === 0x7f00_0000) return true;
  // 10.0.0.0/8
  if ((n & 0xff00_0000) === 0x0a00_0000) return true;
  // 172.16.0.0/12
  if ((n & 0xfff0_0000) === 0xac10_0000) return true;
  // 192.168.0.0/16
  if ((n & 0xffff_0000) === 0xc0a8_0000) return true;
  // 169.254.0.0/16 link-local IPv4
  if ((n & 0xffff_0000) === 0xa9fe_0000) return true;
  // 0.0.0.0/32
  return n === 0;
}

function normalizeIPv6Hextets(ip: string): string[] | null {
  const lower = ip.toLowerCase();
  if (lower.includes('.')) return null;
  if (lower.includes('::')) {
    const [lhs, rhs = ''] = lower.split('::');
    const left = lhs ? lhs.split(':').filter(Boolean) : [];
    const right = rhs ? rhs.split(':').filter(Boolean) : [];
    const missing = 8 - left.length - right.length;
    if (missing < 0) return null;
    const mid = Array<string>(missing).fill('0000');
    const all = [...left, ...mid, ...right];
    if (all.length !== 8) return null;
    return all.map((h) => h.padStart(4, '0'));
  }
  const parts = lower.split(':');
  if (parts.length !== 8) return null;
  return parts.map((h) => h.padStart(4, '0'));
}

/** True for ::1/128, fc00::/7, fe80::/10, plus IPv4-mapped private addresses. */
function isBlockedIPv6Address(ip: string): boolean {
  const bare = ip.toLowerCase();

  const mapped = /^::ffff:(\d{1,3}(\.\d{1,3}){3})$/i.exec(bare)?.[1]
    ?? /^0:0:0:0:0:ffff:(\d{1,3}(\.\d{1,3}){3})$/i.exec(bare)?.[1];
  if (mapped && isIPv4(mapped)) {
    try {
      return isBlockedIPv4Address(mapped);
    } catch {
      return true;
    }
  }

  const hextets = normalizeIPv6Hextets(bare);
  if (!hextets) return true;

  const h0 = parseInt(hextets[0]!, 16);

  const isLoopbackLocalhost =
    hextets.slice(0, 7).every((h) => h === '0000') && hextets[7] === '0001';
  if (isLoopbackLocalhost) return true;

  // fc00::/7 — first hextet 0xfc00–0xfdff (unique local IPv6)
  if (h0 >= 0xfc00 && h0 <= 0xfdff) return true;
  // fe80::/10 — first hextet 0xfe80–0xfebf (link-local)
  if (h0 >= 0xfe80 && h0 <= 0xfebf) return true;

  return false;
}

/**
 * True when `ip` (a literal IPv4/IPv6 address — not a hostname) falls in a
 * blocked range (loopback / RFC1918 / link-local / unique-local / etc).
 * Exported so other SSRF guards in this package (index.ts's http-request
 * tool) can reuse this address-range logic instead of a hand-rolled regex.
 */
export function isBlockedResolvedAddress(ip: string): boolean {
  if (isIPv4(ip)) {
    try {
      return isBlockedIPv4Address(ip);
    } catch {
      return true;
    }
  }
  if (ip.includes(':')) {
    return isBlockedIPv6Address(ip);
  }
  return true;
}

async function assertSsrfAllows(urlLike: URL): Promise<void> {
  if (urlLike.protocol === 'file:')
    throw new Error('web-fetch: file:// URLs are blocked');
  if (urlLike.protocol !== 'http:' && urlLike.protocol !== 'https:') {
    throw new Error(`web-fetch: scheme not allowed (${urlLike.protocol}); only http/https`);
  }

  let host = urlLike.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);

  // BLOCKED_LITERAL_HOSTS carries both the bracketed and bare IPv6 forms
  // ('[::1]' and '::1'), so checking the bracket-stripped `host` alone is
  // sufficient — it matches whichever form was actually blocked.
  if (BLOCKED_LITERAL_HOSTS.has(host)) {
    throw new Error(`web-fetch: blocked host '${urlLike.hostname}'`);
  }

  const allowlist = readWebFetchAllowlist();
  if (allowlist) {
    if (!allowlist.has(host)) {
      throw new Error(
        `web-fetch: hostname '${host}' not in WEB_FETCH_ALLOWLIST (${[...allowlist.values()].join(', ')})`,
      );
    }
  }

  try {
    const records = await lookup(host, { all: true, verbatim: true });
    if (!records.length) throw new Error('web-fetch: DNS returned no addresses');
    for (const record of records) {
      // lookup() with {all: true} always resolves LookupAddress[], so
      // record.address is directly typed — no runtime shape guard needed.
      const addr = record.address;
      if (isBlockedResolvedAddress(addr)) {
        throw new Error(`web-fetch: DNS resolves '${host}' to blocked address '${addr}'`);
      }
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.message.startsWith('web-fetch:')) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`web-fetch: DNS lookup failed for '${host}': ${msg}`);
  }
}

export const WebFetchInputSchema = z.object({
  url: z.string().url(),
  method: z.enum(['GET', 'POST', 'HEAD']).default('GET'),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
  timeout: z.number().int().positive().max(60000).default(30000),
});

export type WebFetchInput = z.infer<typeof WebFetchInputSchema>;

export interface WebFetchOutput {
  status: number;
  body: string;
  headers: Record<string, string>;
}

export async function webFetch(input: WebFetchInput): Promise<WebFetchOutput> {
  const url = new URL(input.url);

  await assertSsrfAllows(url);

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), input.timeout);

  try {
    const hdrs = new Headers();
    if (input.headers) {
      for (const [k, v] of Object.entries(input.headers)) hdrs.set(k, v);
    }
    if (!hdrs.has('user-agent')) hdrs.set('user-agent', DEFAULT_UA);

    const res = await fetch(input.url, {
      method: input.method,
      headers: hdrs,
      body:
        input.method === 'POST' && input.body !== undefined
          ? input.body
          : undefined,
      signal: controller.signal,
    });

    const bodyText = await res.text();
    const outHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      outHeaders[k] = v;
    });

    return { status: res.status, body: bodyText, headers: outHeaders };
  } finally {
    clearTimeout(t);
  }
}

registerTool({
  name: 'web-fetch',
  description: 'HTTP fetch with SSRF guard',
  argsSchema: WebFetchInputSchema,
  async execute(args, _ctx: ToolContext): Promise<ToolResult> {
    try {
      const out = await webFetch(args);
      return { success: true, output: JSON.stringify(out) };
    } catch (err) {
      return { success: false, output: '', error: err instanceof Error ? err.message : String(err) };
    }
  },
});
