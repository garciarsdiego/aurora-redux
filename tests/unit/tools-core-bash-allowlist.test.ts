/**
 * tests/unit/tools-core-bash-allowlist.test.ts
 *
 * Unit tests for the bash tool's allowlist and metacharacter guard.
 * F-LIVE-22: date/printf/awk/sed/sort/uniq/tr/cut added to BASH_ALLOWED_BINS;
 * backtick added to SHELL_METACHAR_RE.
 *
 * Strategy: import the bash ToolDefinition via the registry and call execute()
 * directly. Blocked cases never reach execFileAsync so no process is spawned.
 * Allowed cases that pass the guard may still fail at the OS exec level (binary
 * absent) — we only assert they are NOT rejected by the guard layer itself.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── Mocks (must be declared before any static imports of the modules they mock)

// Stub out the DB: isToolEnabledForWorkspace catches all errors and fails open,
// so throwing here causes the tool to be treated as enabled — which is what we want.
vi.mock('../../src/db/client.js', () => ({
  initDb: () => { throw new Error('db-stub'); },
}));
vi.mock('../../src/db/persist.js', () => ({ insertEvent: vi.fn() }));
vi.mock('../../src/utils/config.js', () => ({ getDbPath: () => ':memory:' }));

// Stub the side-effect sub-tools so their imports don't fail in the unit test env.
vi.mock('../../src/v2/tools/core/web-fetch.js', () => ({}));
vi.mock('../../src/v2/tools/core/web-search.js', () => ({}));
vi.mock('../../src/v2/tools/core/glob.js', () => ({}));
vi.mock('../../src/v2/tools/core/grep.js', () => ({}));
vi.mock('../../src/v2/tools/core/apply-patch.js', () => ({}));

// Stub external-mcp so ExternalMcpManager constructor/getInstance doesn't try
// to connect to live MCP servers.
vi.mock('../../src/v2/external-mcp/client.js', () => ({
  ExternalMcpManager: { getInstance: () => ({ callPrefixedTool: vi.fn() }) },
}));
vi.mock('../../src/v2/external-mcp/types.js', () => ({
  parsePrefixedToolName: vi.fn().mockReturnValue(null),
}));

// Static imports come after vi.mock declarations (Vitest hoists vi.mock calls).
import { resolveTool } from '../../src/v2/tools/registry.js';
import '../../src/v2/tools/core/index.js';
import type { ToolContext } from '../../src/v2/tools/registry.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

let ctx: ToolContext;

beforeAll(async () => {
  const sandboxDir = await mkdtemp(join(tmpdir(), 'bash-allowlist-test-'));
  ctx = { workspaceRoot: sandboxDir, workspace: '__test__', workflowId: 'wf_test' };
});

type BashArgs = { command: string; cwd?: string; timeout_ms?: number };
type BashResult = { success: boolean; output: string; error?: string; exitCode?: number };

function getBashExecute() {
  const tool = resolveTool('bash');
  return (args: BashArgs) => tool.execute(args, ctx) as Promise<BashResult>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const GUARD_ERROR_PATTERNS = ['not in allowlist', 'metacharacter', 'empty command'];

function isGuardBlock(result: BashResult): boolean {
  return !result.success && GUARD_ERROR_PATTERNS.some(p => result.error?.includes(p));
}

async function assertNotGuardBlocked(command: string) {
  const result = await getBashExecute()({ command });
  expect(
    isGuardBlock(result),
    `Guard unexpectedly blocked "${command}" — error: ${result.error}`,
  ).toBe(false);
}

async function assertGuardBlocked(command: string) {
  const result = await getBashExecute()({ command });
  expect(result.success, `Expected guard block but command passed: "${command}"`).toBe(false);
  expect(
    isGuardBlock(result),
    `Expected guard-block error but got: "${result.error}"`,
  ).toBe(true);
}

// ─── Tests: F-LIVE-22 newly added bins ────────────────────────────────────────

describe('F-LIVE-22: newly added bins pass the allowlist guard', () => {
  it("date with relative-date arg is not guard-blocked", async () => {
    // "date -d '137 days ago' +%Y-%m-%d"
    // Single-quoted arg contains spaces but no SHELL_METACHAR_RE chars.
    await assertNotGuardBlocked("date -d '137 days ago' +%Y-%m-%d");
  });

  it("printf with format string is not guard-blocked", async () => {
    await assertNotGuardBlocked("printf '%s\\n' hello");
  });

  it("awk with print program is not guard-blocked", async () => {
    // Curly braces and $ are NOT in SHELL_METACHAR_RE — they are safe here.
    await assertNotGuardBlocked("awk '{print $1}' file");
  });

  it("sed with substitution expression is not guard-blocked", async () => {
    await assertNotGuardBlocked("sed 's/foo/bar/' file.txt");
  });

  it("sort on a file is not guard-blocked", async () => {
    await assertNotGuardBlocked("sort file.txt");
  });

  it("uniq with count flag is not guard-blocked", async () => {
    await assertNotGuardBlocked("uniq -c file.txt");
  });

  it("tr character translation is not guard-blocked", async () => {
    // tr with no file reads stdin and would block; use a very short timeout
    // so execFileAsync times out at the OS level rather than in the guard.
    // A timeout error proves we reached exec (i.e., passed the guard layer).
    const result = await getBashExecute()({ command: "tr 'a-z' 'A-Z'", timeout_ms: 200 });
    // If the guard blocked it, error contains 'not in allowlist' or 'metacharacter'.
    // A timeout exits with a different error message.
    expect(isGuardBlock(result), `Guard unexpectedly blocked tr: ${result.error}`).toBe(false);
  });

  it("cut with delimiter is not guard-blocked", async () => {
    await assertNotGuardBlocked("cut -d ',' -f1 file.csv");
  });
});

// ─── Tests: pre-existing allowed bins still pass ──────────────────────────────

describe('pre-existing allowed bins still pass the allowlist guard', () => {
  it('node --version', async () => { await assertNotGuardBlocked('node --version'); });
  it('git status', async () => { await assertNotGuardBlocked('git status'); });
  it('rg pattern file', async () => { await assertNotGuardBlocked('rg pattern file'); });
  it('jq .foo file.json (pre-existing entry)', async () => { await assertNotGuardBlocked('jq .foo file.json'); });
  it('wc -l file (F-LIVE-4)', async () => { await assertNotGuardBlocked('wc -l file'); });
  it('cat file (F-LIVE-4)', async () => { await assertNotGuardBlocked('cat file'); });
  it('head -n 5 file (F-LIVE-4)', async () => { await assertNotGuardBlocked('head -n 5 file'); });
  it('tail -n 5 file (F-LIVE-4)', async () => { await assertNotGuardBlocked('tail -n 5 file'); });
  it('ls -la (F-LIVE-4)', async () => { await assertNotGuardBlocked('ls -la'); });
  it('grep pattern file (F-LIVE-4)', async () => { await assertNotGuardBlocked('grep pattern file'); });
});

// ─── Tests: dangerous commands still blocked ──────────────────────────────────

describe('dangerous commands are still guard-blocked', () => {
  it('semicolon command chaining is blocked', async () => {
    await assertGuardBlocked('echo hi; rm -rf /');
  });

  it('pipe is blocked', async () => {
    await assertGuardBlocked('cat file | grep pattern');
  });

  it('unquoted $() command substitution is blocked (( in SHELL_METACHAR_RE)', async () => {
    await assertGuardBlocked('date $(whoami)');
  });

  it('backtick command substitution is blocked (F-LIVE-22 addition)', async () => {
    // backtick ` added to SHELL_METACHAR_RE
    await assertGuardBlocked('date `whoami`');
  });

  it('stdout redirect > is blocked', async () => {
    await assertGuardBlocked('cat file > /etc/passwd');
  });

  it('stdin redirect < is blocked', async () => {
    await assertGuardBlocked('cat < /etc/shadow');
  });

  it('background & is blocked', async () => {
    await assertGuardBlocked('sleep 999 &');
  });

  it('&& chain is blocked', async () => {
    await assertGuardBlocked('git status && rm -rf /');
  });

  it('binary not in allowlist is blocked (sudo)', async () => {
    await assertGuardBlocked('sudo rm -rf /');
  });

  it('nmap (not in allowlist) is blocked', async () => {
    await assertGuardBlocked('nmap http://evil.com');
  });

  it('empty/whitespace-only command is blocked', async () => {
    await assertGuardBlocked('   ');
  });
});
