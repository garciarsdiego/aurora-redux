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
import { PNG } from 'pngjs';

export interface PlaywrightHarnessInput {
  projectRoot: string;
  objective: string;
  expectedSelectors: string[];
  expectedTextChecks?: Array<{ selector: string; textIncludes: string }>;
  startCommand?: string;
  startTimeoutMs?: number;
  startReadyPattern?: RegExp;
  /**
   * Q4a: Deterministic canvas region checks (no LLM cost). Runs against the
   * screenshot the harness already captures — Playwright rasterizes <canvas>
   * elements correctly, so no separate canvas.toDataURL() extraction is
   * needed. Catches regressions like a scene rendered upside down (sky at
   * the bottom, ground at the top) via average luminance/hue per region.
   */
  canvasRegionChecks?: CanvasRegionCheck[];
  /**
   * FASE C item 1: Deterministic before/after interaction checks (no LLM
   * cost). Runs inside the harness's own Playwright page — for each check,
   * reads a value BEFORE, dispatches a key press or click, waits `waitMs`,
   * reads the value AFTER, and compares per `expect`. Catches regressions
   * like "pressing space no longer makes the player jump" without ever
   * spending an LLM call.
   */
  interactionChecks?: InteractionCheck[];
}

/**
 * FASE C item 1: Comparison mode for an InteractionCheck's before/after
 * values. 'increase'/'decrease' require both values to be finite numbers
 * (fail-closed otherwise); `{ equals }` is a strict comparison via
 * `Object.is` (NO loose/coerced matching) — so it is meaningful only for
 * primitives (numbers, strings, booleans). Objects/arrays never match by
 * value here, only by reference identity, which the harness's serialized
 * before/after reads will never produce — use a primitive for `equals`.
 */
export type InteractionExpect = 'increase' | 'decrease' | { equals: unknown };

/**
 * FASE C item 1: A single deterministic "do something, check something
 * changed" assertion. Exactly one of `key` / `clickSelector` should be
 * supplied to decide how the interaction is dispatched — `key` goes through
 * `page.keyboard.press`, `clickSelector` through `page.click`. At least one
 * of `domAssertion` / `debugHookAssertion` should be supplied so there is
 * something to compare before/after; a check with neither is a no-op that
 * always reports pass (nothing to assert is not a failure by itself here,
 * unlike CanvasRegionCheck, because dispatching the interaction alone can
 * still be a meaningful smoke test when screenshotBeforeAfter is set).
 */
export interface InteractionCheck {
  label: string;
  /** Keyboard key to press via page.keyboard.press (e.g. 'Space', 'ArrowRight'). */
  key?: string;
  /** CSS selector to click via page.click. */
  clickSelector?: string;
  /** Milliseconds to wait between dispatching the interaction and reading "after". */
  waitMs: number;
  /** Compares a DOM property (e.g. element.style.left) before vs after. */
  domAssertion?: {
    selector: string;
    property: string;
    expect: InteractionExpect;
  };
  /** Compares a value reached via a dotted path off `window` (e.g. 'window.__debug.player.x'). */
  debugHookAssertion?: {
    path: string;
    expect: InteractionExpect;
  };
  /** When true, captures a screenshot immediately before and after the interaction. */
  screenshotBeforeAfter?: boolean;
}

/**
 * FASE C item 1: Structured, per-check result of an InteractionCheck
 * evaluation. Always produced — even on error — so the harness never
 * throws for a missing selector/debug hook; it reports a failed check with
 * `error` set instead.
 */
export interface InteractionCheckResult {
  label: string;
  pass: boolean;
  before?: unknown;
  after?: unknown;
  reason?: string;
  error?: string;
  screenshotBeforePath?: string;
  screenshotAfterPath?: string;
}

/**
 * Q4a: A single deterministic assertion about a rectangular region of the
 * captured screenshot. `region` is either a named half ('top' | 'bottom' |
 * 'left' | 'right') or an explicit pixel rectangle. At least one of
 * `expectedHueRange` / `expectedLuminanceAbove` should be supplied — a check
 * with neither always reports fail with a descriptive reason (fail-closed,
 * never silently no-ops).
 */
export interface CanvasRegionCheck {
  selector: string;
  region: 'top' | 'bottom' | 'left' | 'right' | { x: number; y: number; w: number; h: number };
  /** Inclusive [minDegrees, maxDegrees) range on the 0-360 HSL hue wheel. */
  expectedHueRange?: [number, number];
  /** Average luminance (0-255) must be strictly above this threshold. */
  expectedLuminanceAbove?: number;
  label: string;
}

/**
 * Q4a: Structured, per-check result of a CanvasRegionCheck evaluation.
 * Always produced — even on error — so the harness never throws for a
 * missing screenshot/canvas; it reports a failed check with `error` set.
 */
export interface CanvasRegionCheckResult {
  label: string;
  selector: string;
  pass: boolean;
  measuredLuminance?: number;
  measuredHue?: number;
  error?: string;
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
  /**
   * Q4a: Populated only when `canvasRegionChecks` was supplied on the input.
   * Deterministic — no LLM call is ever made to produce these results.
   */
  canvasRegionCheckResults?: CanvasRegionCheckResult[];
  /**
   * FASE C item 1: Populated only when `interactionChecks` was supplied on
   * the input. Deterministic — no LLM call is ever made to produce these
   * results.
   */
  interactionCheckResults?: InteractionCheckResult[];
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

/**
 * FASE C item 1: The minimal slice of the Playwright page surface that the
 * interaction-check flow (readInteractionValue -> dispatch -> read again)
 * needs. Exported so unit tests can inject a fake page and exercise the
 * full before/after flow — including the real-world "inverted controls"
 * bug (pressing a key moved the player the WRONG way) — without launching
 * Chromium. `PageLike` (the full harness surface) satisfies this.
 */
export interface InteractionPageLike {
  screenshot: (opts: { path: string; fullPage?: boolean }) => Promise<unknown>;
  $eval: (selector: string, pageFunction: (el: Element, property: string) => unknown, arg: string) => Promise<unknown>;
  evaluate: <T>(pageFunction: (path: string) => T, arg: string) => Promise<T>;
  keyboard: { press: (key: string) => Promise<void> };
  click: (selector: string) => Promise<void>;
  waitForTimeout: (ms: number) => Promise<void>;
}

interface PageLike extends InteractionPageLike {
  goto: (url: string, opts?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle'; timeout?: number }) => Promise<unknown>;
  locator: (selector: string) => { first: () => LocatorLike };
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

/**
 * Q4a: Resolves a CanvasRegionCheck's `region` (named half or explicit rect)
 * into absolute pixel bounds against the given image dimensions. Named
 * regions are clamped to the image size; explicit rects are clamped too so a
 * bad {x,y,w,h} never reads out of bounds.
 */
function resolveRegionBounds(
  region: CanvasRegionCheck['region'],
  imageWidth: number,
  imageHeight: number,
): { x: number; y: number; w: number; h: number } {
  if (typeof region === 'string') {
    switch (region) {
      case 'top':
        return { x: 0, y: 0, w: imageWidth, h: Math.max(1, Math.floor(imageHeight / 2)) };
      case 'bottom': {
        const h = Math.max(1, Math.ceil(imageHeight / 2));
        return { x: 0, y: imageHeight - h, w: imageWidth, h };
      }
      case 'left':
        return { x: 0, y: 0, w: Math.max(1, Math.floor(imageWidth / 2)), h: imageHeight };
      case 'right': {
        const w = Math.max(1, Math.ceil(imageWidth / 2));
        return { x: imageWidth - w, y: 0, w, h: imageHeight };
      }
    }
  }
  const x = Math.max(0, Math.min(region.x, imageWidth - 1));
  const y = Math.max(0, Math.min(region.y, imageHeight - 1));
  const w = Math.max(1, Math.min(region.w, imageWidth - x));
  const h = Math.max(1, Math.min(region.h, imageHeight - y));
  return { x, y, w, h };
}

/** Rec. 601 luma approximation — cheap and adequate for a bright/dark check. */
function rgbToLuminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Standard RGB (0-255) -> hue-degrees (0-360) conversion, achromatic -> 0. */
function rgbToHueDegrees(r: number, g: number, b: number): number {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  if (delta === 0) return 0;
  let hue: number;
  if (max === rn) {
    hue = ((gn - bn) / delta) % 6;
  } else if (max === gn) {
    hue = (bn - rn) / delta + 2;
  } else {
    hue = (rn - gn) / delta + 4;
  }
  hue *= 60;
  if (hue < 0) hue += 360;
  return hue;
}

interface DecodedPng {
  width: number;
  height: number;
  data: Buffer;
}

/**
 * Q4a: Pure, synchronous decode of a PNG buffer via pngjs. Exported so unit
 * tests can build fixture PNGs and feed them straight into
 * `evaluateCanvasRegionCheck` without needing pngjs in the test file.
 */
export function decodePng(buffer: Buffer): DecodedPng {
  const png = PNG.sync.read(buffer);
  return { width: png.width, height: png.height, data: png.data };
}

/**
 * Q4a: Pure function — computes average luminance (0-255) and average hue
 * (0-360 degrees, undefined if fully achromatic) over a rectangular region
 * of a decoded PNG. No I/O, no Playwright — directly unit-testable.
 */
export function computeRegionStats(
  image: DecodedPng,
  bounds: { x: number; y: number; w: number; h: number },
): { avgLuminance: number; avgHue: number | undefined } {
  let luminanceSum = 0;
  let hueSumSin = 0;
  let hueSumCos = 0;
  let chromaticCount = 0;
  let pixelCount = 0;

  const x0 = Math.max(0, bounds.x);
  const y0 = Math.max(0, bounds.y);
  const x1 = Math.min(image.width, bounds.x + bounds.w);
  const y1 = Math.min(image.height, bounds.y + bounds.h);

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const idx = (image.width * y + x) << 2;
      const r = image.data[idx] ?? 0;
      const g = image.data[idx + 1] ?? 0;
      const b = image.data[idx + 2] ?? 0;
      luminanceSum += rgbToLuminance(r, g, b);
      pixelCount++;

      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (max !== min) {
        // Average hue via circular mean (sum of unit vectors) so hues that
        // straddle the 0/360 boundary (e.g. reds) don't cancel out.
        const hueDeg = rgbToHueDegrees(r, g, b);
        const hueRad = (hueDeg * Math.PI) / 180;
        hueSumSin += Math.sin(hueRad);
        hueSumCos += Math.cos(hueRad);
        chromaticCount++;
      }
    }
  }

  const avgLuminance = pixelCount > 0 ? luminanceSum / pixelCount : 0;
  let avgHue: number | undefined;
  if (chromaticCount > 0) {
    const meanRad = Math.atan2(hueSumSin / chromaticCount, hueSumCos / chromaticCount);
    let meanDeg = (meanRad * 180) / Math.PI;
    if (meanDeg < 0) meanDeg += 360;
    avgHue = meanDeg;
  }
  return { avgLuminance, avgHue };
}

/** Handles hue ranges that wrap past 360 (e.g. [350, 10) covering red). */
function hueInRange(hue: number, range: [number, number]): boolean {
  const [min, max] = range;
  if (min <= max) return hue >= min && hue < max;
  return hue >= min || hue < max;
}

/**
 * Q4a: Pure evaluation of a single CanvasRegionCheck against an already
 * decoded PNG. No filesystem, no Playwright, no LLM — fully unit-testable.
 * A check with neither `expectedHueRange` nor `expectedLuminanceAbove` fails
 * closed with a descriptive error rather than silently passing.
 */
export function evaluateCanvasRegionCheck(
  image: DecodedPng,
  check: CanvasRegionCheck,
): CanvasRegionCheckResult {
  if (!check.expectedHueRange && check.expectedLuminanceAbove === undefined) {
    return {
      label: check.label,
      selector: check.selector,
      pass: false,
      error: 'CanvasRegionCheck has neither expectedHueRange nor expectedLuminanceAbove; nothing to assert.',
    };
  }

  const bounds = resolveRegionBounds(check.region, image.width, image.height);
  const stats = computeRegionStats(image, bounds);

  let pass = true;
  if (check.expectedLuminanceAbove !== undefined) {
    pass = pass && stats.avgLuminance > check.expectedLuminanceAbove;
  }
  if (check.expectedHueRange) {
    pass = pass && stats.avgHue !== undefined && hueInRange(stats.avgHue, check.expectedHueRange);
  }

  return {
    label: check.label,
    selector: check.selector,
    pass,
    measuredLuminance: stats.avgLuminance,
    measuredHue: stats.avgHue,
  };
}

/**
 * Q4a: Reads a screenshot PNG from disk and evaluates every configured
 * CanvasRegionCheck against it. Robust by construction — a missing/corrupt
 * screenshot yields one failed CanvasRegionCheckResult per configured check
 * (with `error` set), never a thrown exception.
 */
/**
 * Q4a: Exported (not just used internally) so unit tests can exercise the
 * "missing screenshot" / "corrupt PNG" robustness paths directly, without
 * spinning up Playwright/Chromium.
 */
export function runCanvasRegionChecks(
  screenshotPath: string | undefined,
  checks: CanvasRegionCheck[],
): CanvasRegionCheckResult[] {
  if (!screenshotPath || !existsSync(screenshotPath)) {
    return checks.map((check) => ({
      label: check.label,
      selector: check.selector,
      pass: false,
      error: `screenshot not found at ${screenshotPath ?? '(none captured)'}`,
    }));
  }

  let image: DecodedPng;
  try {
    image = decodePng(readFileSync(screenshotPath));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return checks.map((check) => ({
      label: check.label,
      selector: check.selector,
      pass: false,
      error: `failed to decode screenshot PNG: ${message}`,
    }));
  }

  return checks.map((check) => {
    try {
      return evaluateCanvasRegionCheck(image, check);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        label: check.label,
        selector: check.selector,
        pass: false,
        error: `canvas region check threw: ${message}`,
      };
    }
  });
}

/** True for finite numbers only — NaN, Infinity, and non-numbers all fail this. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * FASE C item 1: Pure comparison of a before/after pair against an
 * InteractionExpect. No I/O, no Playwright — directly unit-testable.
 *
 * 'increase'/'decrease' fail closed (pass=false, descriptive reason) when
 * either value is not a finite number — an interaction check must never
 * silently pass just because the underlying value turned out to be a
 * string, undefined, or NaN. `{ equals }` uses `Object.is` so it also
 * distinguishes NaN/-0 correctly and works for non-numeric values (strings,
 * booleans, etc.) without a fail-closed numeric requirement.
 */
export function evaluateInteraction(
  before: unknown,
  after: unknown,
  expectation: InteractionExpect,
): { pass: boolean; reason?: string } {
  if (typeof expectation === 'object' && expectation !== null) {
    return Object.is(after, expectation.equals)
      ? { pass: true }
      : { pass: false, reason: `value did not equal ${JSON.stringify(expectation.equals)} (got ${JSON.stringify(after)})` };
  }

  if (!isFiniteNumber(before) || !isFiniteNumber(after)) {
    return {
      pass: false,
      reason: `expected numeric before/after values for '${expectation}' comparison, got before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
    };
  }

  if (expectation === 'increase') {
    return after > before
      ? { pass: true }
      : { pass: false, reason: `value did not increase (before=${before}, after=${after})` };
  }

  // expectation === 'decrease'
  return after < before
    ? { pass: true }
    : { pass: false, reason: `value did not decrease (before=${before}, after=${after})` };
}

/**
 * FASE C item 1: Reads the "current value" for a single InteractionCheck,
 * preferring domAssertion when both are configured. Returns `undefined` (not
 * a throw) when neither assertion is configured — evaluateInteraction then
 * fails closed on the non-numeric undefined value for increase/decrease, or
 * fails the equals comparison, so a misconfigured check never silently
 * passes.
 */
async function readInteractionValue(
  page: InteractionPageLike,
  check: InteractionCheck,
): Promise<unknown> {
  if (check.domAssertion) {
    const { selector, property } = check.domAssertion;
    return page.$eval(selector, (el, prop) => (el as unknown as Record<string, unknown>)[prop], property);
  }
  if (check.debugHookAssertion) {
    const { path } = check.debugHookAssertion;
    // Walks a dotted property path (e.g. 'window.__debug.player.x') off
    // `globalThis` inside the page context via plain property lookups —
    // no eval, no Function constructor, so this is safe against injection.
    return page.evaluate((p) => {
      return p.split('.').reduce<unknown>((acc, key) => {
        if (acc === undefined || acc === null) return undefined;
        return (acc as Record<string, unknown>)[key];
      }, globalThis as unknown);
    }, path);
  }
  return undefined;
}

/**
 * FASE C item 1: Dispatches the interaction (key press OR click) for a
 * single check. Exactly one of key/clickSelector should be set; if both are
 * set, key takes precedence; if neither is set, this is a no-op (the check
 * still reads before/after, which will be identical, so it fails naturally
 * unless the assertion is genuinely a no-op-tolerant `equals`).
 */
async function dispatchInteraction(page: InteractionPageLike, check: InteractionCheck): Promise<void> {
  if (check.key) {
    await page.keyboard.press(check.key);
    return;
  }
  if (check.clickSelector) {
    await page.click(check.clickSelector);
  }
}

/**
 * FASE C item 1: Runs every configured InteractionCheck against the live
 * Playwright page: read BEFORE, dispatch, wait, read AFTER, compare. NEVER
 * throws — any failure (missing selector, bad debug-hook path, dispatch
 * error) is captured per-check as `{ pass: false, error }` so one bad check
 * can never abort the whole harness run.
 */
export async function runInteractionChecks(
  page: InteractionPageLike,
  checks: InteractionCheck[],
  artifactDir: string,
): Promise<InteractionCheckResult[]> {
  const results: InteractionCheckResult[] = [];
  for (const check of checks) {
    try {
      const before = await readInteractionValue(page, check);

      let screenshotBeforePath: string | undefined;
      let screenshotAfterPath: string | undefined;
      if (check.screenshotBeforeAfter) {
        ensureDir(artifactDir);
        const safeLabel = check.label.replace(/[^a-z0-9_-]+/gi, '_').slice(0, 60);
        screenshotBeforePath = join(artifactDir, `interaction-${safeLabel}-before.png`);
        try { await page.screenshot({ path: screenshotBeforePath }); } catch { /* best-effort */ }
      }

      await dispatchInteraction(page, check);
      await page.waitForTimeout(check.waitMs);

      const after = await readInteractionValue(page, check);

      if (check.screenshotBeforeAfter) {
        const safeLabel = check.label.replace(/[^a-z0-9_-]+/gi, '_').slice(0, 60);
        screenshotAfterPath = join(artifactDir, `interaction-${safeLabel}-after.png`);
        try { await page.screenshot({ path: screenshotAfterPath }); } catch { /* best-effort */ }
      }

      const expectation = check.domAssertion?.expect ?? check.debugHookAssertion?.expect;
      if (!expectation) {
        results.push({
          label: check.label,
          pass: false,
          before,
          after,
          error: 'InteractionCheck has neither domAssertion nor debugHookAssertion; nothing to assert.',
          ...(screenshotBeforePath ? { screenshotBeforePath } : {}),
          ...(screenshotAfterPath ? { screenshotAfterPath } : {}),
        });
        continue;
      }

      const { pass, reason } = evaluateInteraction(before, after, expectation);
      results.push({
        label: check.label,
        pass,
        before,
        after,
        ...(reason ? { reason } : {}),
        ...(screenshotBeforePath ? { screenshotBeforePath } : {}),
        ...(screenshotAfterPath ? { screenshotAfterPath } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        label: check.label,
        pass: false,
        error: `interaction check threw: ${message}`,
      });
    }
  }
  return results;
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

    // FASE C item 1: Interaction checks need the live page (keyboard/click
    // dispatch), so they must run BEFORE page/context teardown below. Never
    // throws — runInteractionChecks captures per-check errors internally.
    let interactionCheckResults: InteractionCheckResult[] | undefined;
    if (input.interactionChecks && input.interactionChecks.length > 0) {
      interactionCheckResults = await runInteractionChecks(page, input.interactionChecks, artifactDir);
    }

    try { await page.close(); } catch { /* best-effort */ }
    try { await context.close(); } catch { /* best-effort */ }

    // Q4a: Deterministic canvas region checks — evaluated against the
    // screenshot we already captured above. No LLM call is ever made here.
    let canvasRegionCheckResults: CanvasRegionCheckResult[] | undefined;
    if (input.canvasRegionChecks && input.canvasRegionChecks.length > 0) {
      canvasRegionCheckResults = runCanvasRegionChecks(screenshotPaths[0], input.canvasRegionChecks);
    }

    const drained = mismatches.drain();
    const canvasChecksFailed = (canvasRegionCheckResults ?? []).some((result) => !result.pass);
    const interactionChecksFailed = (interactionCheckResults ?? []).some((result) => !result.pass);
    return {
      status: drained.length === 0 && !canvasChecksFailed && !interactionChecksFailed ? 'passed' : 'failed',
      mismatches: drained,
      screenshotPaths,
      appUrl: server.url,
      ...(canvasRegionCheckResults ? { canvasRegionCheckResults } : {}),
      ...(interactionCheckResults ? { interactionCheckResults } : {}),
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
