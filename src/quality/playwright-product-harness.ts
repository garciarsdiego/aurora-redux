/**
 * F6-1: Playwright-backed product harness.
 *
 * Spawns the generated app's dev server, drives it via Playwright/Chromium,
 * verifies the architecture-contract testSelectors, captures screenshots, and
 * tears down cleanly. Wiring into final-reviewer.ts / final-evidence.ts is a
 * separate task (F6-2) — this module only exposes the harness API.
 *
 * Design constraints:
 *   - NEVER orphan the dev server. All spawn/launch state goes through a
 *     try/finally cleanup block.
 *   - Playwright is not declared in package.json deps explicitly; it ships
 *     transitively via @playwright/test. If `import('playwright')` fails at
 *     runtime, gracefully degrade to status='skipped'.
 *   - Workspace boundary: do NOT exec arbitrary commands. Only `pnpm dev` /
 *     `npm run dev` / `pnpm start` / `npm start` derived from the project's
 *     own package.json scripts. Path resolution mirrors the v2/tools/core
 *     pattern (resolve absolute, no traversal).
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { join, resolve } from 'node:path';
import treeKill from 'tree-kill';

export interface PlaywrightHarnessInput {
  projectRoot: string;
  objective: string;
  expectedSelectors: string[];
  expectedTextChecks?: Array<{ selector: string; textIncludes: string }>;
  startCommand?: string;
  startTimeoutMs?: number;
  startReadyPattern?: RegExp;
}

export interface PlaywrightHarnessResult {
  status: 'passed' | 'failed' | 'skipped';
  reason?: string;
  mismatches: Array<{
    kind: 'selector_missing' | 'text_mismatch';
    selector: string;
    expectedText?: string;
    actualText?: string;
  }>;
  screenshotPaths: string[];
  appUrl?: string;
}

interface PlaywrightHarnessOptions {
  artifactDir?: string;
}

const DEFAULT_START_TIMEOUT_MS = 30_000;
const DEFAULT_READY_PATTERN = /(localhost:\d+|Local:\s*http|ready\s+in|listening on|server running)/i;
const DEFAULT_PORTS = [3000, 5173, 8080, 4200, 4173, 8000] as const;
const MAX_SCREENSHOTS = 3;
const SHELL_METACHAR_RE = /[&|;<>()\r\n]/;

interface ParsedStartCommand {
  bin: string;
  args: string[];
}

interface PackageJsonScripts {
  dev?: string;
  start?: string;
  preview?: string;
  serve?: string;
}

interface PackageJsonShape {
  scripts?: PackageJsonScripts;
}

function readPackageJson(projectRoot: string): PackageJsonShape | null {
  const path = join(projectRoot, 'package.json');
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as PackageJsonShape;
  } catch {
    return null;
  }
}

function pickPackageManager(projectRoot: string): 'pnpm' | 'npm' {
  if (existsSync(join(projectRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  return 'npm';
}

function pickStartScript(scripts: PackageJsonScripts | undefined): 'dev' | 'start' | null {
  if (scripts?.dev) return 'dev';
  if (scripts?.start) return 'start';
  return null;
}

function parseStartCommand(raw: string): ParsedStartCommand | null {
  if (SHELL_METACHAR_RE.test(raw)) return null;
  const tokens = raw.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  if (tokens.length === 0) return null;
  const stripped = tokens.map((tok) =>
    (tok.startsWith('"') && tok.endsWith('"')) || (tok.startsWith("'") && tok.endsWith("'"))
      ? tok.slice(1, -1)
      : tok,
  );
  const [bin, ...args] = stripped;
  if (!bin) return null;
  return { bin, args };
}

function resolveBinForPlatform(bin: string): string {
  if (process.platform === 'win32' && /^(npm|pnpm|npx|yarn)$/i.test(bin)) {
    return `${bin}.cmd`;
  }
  return bin;
}

function extractPortFromOutput(output: string): number | null {
  const match = output.match(/localhost:(\d{2,5})/i)
    ?? output.match(/127\.0\.0\.1:(\d{2,5})/i)
    ?? output.match(/0\.0\.0\.0:(\d{2,5})/i)
    ?? output.match(/Local:\s*https?:\/\/[^:]+:(\d{2,5})/i)
    ?? output.match(/listening on\s+(?:port\s+)?(\d{2,5})/i);
  if (!match) return null;
  const port = Number(match[1]);
  if (!Number.isFinite(port) || port < 1 || port > 65535) return null;
  return port;
}

function buildAppUrl(port: number): string {
  return `http://localhost:${port}`;
}

interface DevServerHandle {
  child: ChildProcess;
  url: string;
  output: string;
}

async function waitForDevServer(
  child: ChildProcess,
  readyPattern: RegExp,
  timeoutMs: number,
): Promise<{ url: string; output: string }> {
  return new Promise<{ url: string; output: string }>((resolvePromise, rejectPromise) => {
    let combinedOutput = '';
    let resolved = false;

    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      combinedOutput += text;
      // Cap retained output to avoid unbounded growth on noisy dev servers.
      if (combinedOutput.length > 64 * 1024) {
        combinedOutput = combinedOutput.slice(-32 * 1024);
      }
      if (resolved) return;
      if (!readyPattern.test(combinedOutput)) return;
      const port = extractPortFromOutput(combinedOutput);
      if (port === null) {
        // Ready pattern matched but no port discoverable yet — fall back to
        // the most common dev port heuristic.
        const fallbackPort = DEFAULT_PORTS[0]!;
        resolved = true;
        resolvePromise({ url: buildAppUrl(fallbackPort), output: combinedOutput });
        return;
      }
      resolved = true;
      resolvePromise({ url: buildAppUrl(port), output: combinedOutput });
    };

    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    child.once('error', (err) => {
      if (resolved) return;
      resolved = true;
      rejectPromise(new Error(`dev server spawn error: ${err.message}`));
    });

    child.once('exit', (code, signal) => {
      if (resolved) return;
      resolved = true;
      rejectPromise(
        new Error(
          `dev server exited before becoming ready (code=${code}, signal=${signal}). Output tail:\n${combinedOutput.slice(-2000)}`,
        ),
      );
    });

    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      rejectPromise(
        new Error(
          `dev server did not match readyPattern within ${timeoutMs}ms. Output tail:\n${combinedOutput.slice(-2000)}`,
        ),
      );
    }, timeoutMs);
    timer.unref?.();
  });
}

async function killDevServer(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  await new Promise<void>((resolveKill) => {
    treeKill(child.pid!, 'SIGKILL', (err) => {
      if (err) {
        try { child.kill('SIGKILL'); } catch { /* best-effort */ }
      }
      resolveKill();
    });
  });
}

interface PlaywrightModule {
  chromium: {
    launch: (opts?: { headless?: boolean }) => Promise<{
      newContext: () => Promise<{
        newPage: () => Promise<unknown>;
        close: () => Promise<void>;
      }>;
      close: () => Promise<void>;
    }>;
  };
}

async function loadPlaywright(): Promise<PlaywrightModule | null> {
  try {
    // Dynamic import via variable — TS does NOT statically resolve the module,
    // so `playwright` is treated as a soft optional dependency at compile time.
    // At runtime, gracefully fails (returns null) if the resolver can't find it.
    const moduleName = 'playwright';
    const mod = (await import(moduleName)) as unknown as PlaywrightModule;
    if (!mod || typeof mod !== 'object' || !('chromium' in mod)) return null;
    return mod;
  } catch {
    return null;
  }
}

function buildArtifactDir(opts: PlaywrightHarnessOptions): string {
  if (opts.artifactDir) return resolve(opts.artifactDir);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return resolve(process.cwd(), '_artifacts', 'quality-harness', ts);
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

interface MismatchAccumulator {
  push(entry: PlaywrightHarnessResult['mismatches'][number]): void;
  drain(): PlaywrightHarnessResult['mismatches'];
}

function createMismatchAccumulator(): MismatchAccumulator {
  const items: PlaywrightHarnessResult['mismatches'] = [];
  return {
    push(entry) { items.push(entry); },
    drain() { return [...items]; },
  };
}

interface LocatorLike {
  count: () => Promise<number>;
  textContent: () => Promise<string | null>;
}

interface PageLike {
  goto: (url: string, opts?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle'; timeout?: number }) => Promise<unknown>;
  locator: (selector: string) => { first: () => LocatorLike };
  screenshot: (opts: { path: string; fullPage?: boolean }) => Promise<unknown>;
  close: () => Promise<void>;
}

async function verifySelectors(
  page: PageLike,
  expectedSelectors: string[],
  mismatches: MismatchAccumulator,
): Promise<void> {
  for (const selector of expectedSelectors) {
    try {
      const locator = page.locator(selector).first();
      const count = await locator.count();
      if (count <= 0) {
        mismatches.push({ kind: 'selector_missing', selector });
      }
    } catch {
      mismatches.push({ kind: 'selector_missing', selector });
    }
  }
}

async function verifyTextChecks(
  page: PageLike,
  checks: NonNullable<PlaywrightHarnessInput['expectedTextChecks']>,
  mismatches: MismatchAccumulator,
): Promise<void> {
  for (const check of checks) {
    try {
      const locator = page.locator(check.selector).first();
      const count = await locator.count();
      if (count <= 0) {
        mismatches.push({
          kind: 'selector_missing',
          selector: check.selector,
          expectedText: check.textIncludes,
        });
        continue;
      }
      const actual = (await locator.textContent()) ?? '';
      if (!actual.includes(check.textIncludes)) {
        mismatches.push({
          kind: 'text_mismatch',
          selector: check.selector,
          expectedText: check.textIncludes,
          actualText: actual.length > 200 ? `${actual.slice(0, 200)}…` : actual,
        });
      }
    } catch {
      mismatches.push({
        kind: 'text_mismatch',
        selector: check.selector,
        expectedText: check.textIncludes,
      });
    }
  }
}

async function captureScreenshots(
  page: PageLike,
  artifactDir: string,
  cap: number,
): Promise<string[]> {
  const paths: string[] = [];
  if (cap <= 0) return paths;
  ensureDir(artifactDir);
  // Currently only the index/home view is captured; retained as a list to
  // make later multi-route extension cheap (F6-2 may extend).
  const target = join(artifactDir, 'index.png');
  try {
    await page.screenshot({ path: target, fullPage: true });
    paths.push(target);
  } catch {
    // Screenshot failure is non-fatal — the harness still reports selector
    // mismatches as the primary signal.
  }
  return paths.slice(0, cap);
}

function buildSkipped(reason: string): PlaywrightHarnessResult {
  return {
    status: 'skipped',
    reason,
    mismatches: [],
    screenshotPaths: [],
  };
}

function resolveStartCommand(input: PlaywrightHarnessInput): ParsedStartCommand | null {
  if (input.startCommand) {
    return parseStartCommand(input.startCommand);
  }
  const pkg = readPackageJson(input.projectRoot);
  const script = pickStartScript(pkg?.scripts);
  if (!script) return null;
  const pm = pickPackageManager(input.projectRoot);
  return { bin: pm, args: ['run', script] };
}

export async function runPlaywrightProductHarness(
  input: PlaywrightHarnessInput,
  opts: PlaywrightHarnessOptions = {},
): Promise<PlaywrightHarnessResult> {
  // 1. projectRoot must exist + contain package.json (unless an explicit
  //    startCommand is supplied — that case still requires the directory).
  const projectRoot = resolve(input.projectRoot);
  if (!existsSync(projectRoot)) {
    return buildSkipped(`projectRoot does not exist: ${projectRoot}`);
  }
  if (!existsSync(join(projectRoot, 'package.json'))) {
    return buildSkipped('no package.json');
  }

  // 2. Determine start command.
  const parsed = resolveStartCommand(input);
  if (!parsed) {
    return buildSkipped('no dev/start script in package.json and no startCommand override');
  }

  // 3. Load Playwright. Skip if not resolvable at runtime.
  const playwright = await loadPlaywright();
  if (!playwright) {
    return buildSkipped('playwright not installed');
  }

  const startTimeoutMs = input.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  const readyPattern = input.startReadyPattern ?? DEFAULT_READY_PATTERN;

  // 4. Spawn the dev server. shell:false is mandatory — we never pass an
  //    LLM-provided string through a shell.
  let child: ChildProcess | null = null;
  let server: DevServerHandle | null = null;
  let browser: Awaited<ReturnType<PlaywrightModule['chromium']['launch']>> | null = null;
  const mismatches = createMismatchAccumulator();
  const artifactDir = buildArtifactDir(opts);

  try {
    try {
      child = spawn(resolveBinForPlatform(parsed.bin), parsed.args, {
        cwd: projectRoot,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, BROWSER: 'none', CI: 'true' },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return buildSkipped(`failed to spawn dev server: ${message}`);
    }

    try {
      const ready = await waitForDevServer(child, readyPattern, startTimeoutMs);
      server = { child, url: ready.url, output: ready.output };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: 'failed',
        reason: `dev server failed to start: ${message}`,
        mismatches: [],
        screenshotPaths: [],
      };
    }

    // 5. Launch Chromium and verify.
    try {
      browser = await playwright.chromium.launch({ headless: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return buildSkipped(`failed to launch chromium (browser binary missing?): ${message}`);
    }

    const context = await browser.newContext();
    const page = (await context.newPage()) as unknown as PageLike;

    try {
      await page.goto(server.url, { waitUntil: 'load', timeout: 15_000 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try { await context.close(); } catch { /* best-effort */ }
      return {
        status: 'failed',
        reason: `page.goto failed for ${server.url}: ${message}`,
        mismatches: [],
        screenshotPaths: [],
        appUrl: server.url,
      };
    }

    await verifySelectors(page, input.expectedSelectors, mismatches);
    if (input.expectedTextChecks && input.expectedTextChecks.length > 0) {
      await verifyTextChecks(page, input.expectedTextChecks, mismatches);
    }

    const screenshotPaths = await captureScreenshots(page, artifactDir, MAX_SCREENSHOTS);

    try { await page.close(); } catch { /* best-effort */ }
    try { await context.close(); } catch { /* best-effort */ }

    const drained = mismatches.drain();
    return {
      status: drained.length === 0 ? 'passed' : 'failed',
      mismatches: drained,
      screenshotPaths,
      appUrl: server.url,
    };
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* best-effort */ }
    }
    if (child) {
      try { await killDevServer(child); } catch { /* best-effort */ }
    }
  }
}
