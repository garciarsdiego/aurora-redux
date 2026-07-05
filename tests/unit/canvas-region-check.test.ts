/**
 * Q4c: Unit tests for the deterministic CanvasRegionCheck logic (Q4a).
 *
 * Regression fixture: a 3D scene rendered upside down — sky at the bottom,
 * ground at the top — because a rotation.z overwrote the camera orientation.
 * A simple average-color-per-region check (top should be bright/sky-like,
 * bottom should be dark/ground-like) catches this without any LLM call.
 *
 * These tests exercise the pure functions directly (decodePng,
 * computeRegionStats, evaluateCanvasRegionCheck) against PNGs generated
 * on-the-fly with pngjs — no Chromium, no filesystem screenshot needed for
 * the core logic. A small set of tests also exercises the filesystem-robust
 * wrapper behavior (missing screenshot / corrupt PNG) indirectly through
 * runPlaywrightProductHarness's exported pure helpers.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { afterEach, describe, expect, it } from 'vitest';

import {
  computeRegionStats,
  decodePng,
  evaluateCanvasRegionCheck,
  runCanvasRegionChecks,
  type CanvasRegionCheck,
} from '../../src/quality/playwright-product-harness.js';

const SIZE = 64;

/** Sky-blue-ish bright color for the "correct" top half. */
const SKY_COLOR = { r: 135, g: 206, b: 250 }; // light sky blue, high luminance
/** Dark ground/ soil color for the "correct" bottom half. */
const GROUND_COLOR = { r: 60, g: 40, b: 20 }; // dark brown, low luminance

function buildHalfSplitPng(topColor: typeof SKY_COLOR, bottomColor: typeof SKY_COLOR): Buffer {
  const png = new PNG({ width: SIZE, height: SIZE });
  for (let y = 0; y < SIZE; y++) {
    const color = y < SIZE / 2 ? topColor : bottomColor;
    for (let x = 0; x < SIZE; x++) {
      const idx = (SIZE * y + x) << 2;
      png.data[idx] = color.r;
      png.data[idx + 1] = color.g;
      png.data[idx + 2] = color.b;
      png.data[idx + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

describe('decodePng + computeRegionStats (pure, no I/O)', () => {
  it('decodes a solid-color PNG and reports its exact luminance', () => {
    const png = new PNG({ width: 4, height: 4 });
    for (let i = 0; i < png.data.length; i += 4) {
      png.data[i] = 255;
      png.data[i + 1] = 255;
      png.data[i + 2] = 255;
      png.data[i + 3] = 255;
    }
    const buffer = PNG.sync.write(png);
    const decoded = decodePng(buffer);
    expect(decoded.width).toBe(4);
    expect(decoded.height).toBe(4);

    const stats = computeRegionStats(decoded, { x: 0, y: 0, w: 4, h: 4 });
    expect(stats.avgLuminance).toBeCloseTo(255, 5);
    // Pure white is achromatic — hue is undefined.
    expect(stats.avgHue).toBeUndefined();
  });

  it('computes distinct luminance for top vs bottom half of a split image', () => {
    const buffer = buildHalfSplitPng(SKY_COLOR, GROUND_COLOR);
    const decoded = decodePng(buffer);

    const topStats = computeRegionStats(decoded, { x: 0, y: 0, w: SIZE, h: SIZE / 2 });
    const bottomStats = computeRegionStats(decoded, { x: 0, y: SIZE / 2, w: SIZE, h: SIZE / 2 });

    expect(topStats.avgLuminance).toBeGreaterThan(bottomStats.avgLuminance);
  });
});

describe('evaluateCanvasRegionCheck — correct orientation (regression: OK case)', () => {
  const buffer = buildHalfSplitPng(SKY_COLOR, GROUND_COLOR);
  const image = decodePng(buffer);

  it('passes a top-region luminance check when the top is bright sky', () => {
    const check: CanvasRegionCheck = {
      selector: 'canvas',
      region: 'top',
      expectedLuminanceAbove: 150,
      label: 'sky should be bright at the top',
    };
    const result = evaluateCanvasRegionCheck(image, check);
    expect(result.pass).toBe(true);
    expect(result.label).toBe(check.label);
    expect(result.selector).toBe('canvas');
    expect(result.measuredLuminance).toBeGreaterThan(150);
    expect(result.error).toBeUndefined();
  });

  it('passes a bottom-region luminance check when the bottom is dark ground', () => {
    const check: CanvasRegionCheck = {
      selector: 'canvas',
      region: 'bottom',
      expectedLuminanceAbove: 0,
      label: 'ground exists at the bottom',
    };
    // Sanity-check inverse: ground luminance should be well under sky.
    const result = evaluateCanvasRegionCheck(image, check);
    expect(result.pass).toBe(true);
    expect(result.measuredLuminance).toBeLessThan(150);
  });

  it('passes a hue-range check on the blue sky region', () => {
    const check: CanvasRegionCheck = {
      selector: 'canvas',
      region: 'top',
      expectedHueRange: [180, 240], // blue range
      label: 'top hue should be blue-ish',
    };
    const result = evaluateCanvasRegionCheck(image, check);
    expect(result.pass).toBe(true);
    expect(result.measuredHue).toBeGreaterThanOrEqual(180);
    expect(result.measuredHue).toBeLessThan(240);
  });
});

describe('evaluateCanvasRegionCheck — inverted orientation (regression: FAIL case)', () => {
  // This reproduces the real bug: rotation.z overwrote camera orientation,
  // flipping the scene so sky is at the bottom and ground is at the top.
  const invertedBuffer = buildHalfSplitPng(GROUND_COLOR, SKY_COLOR);
  const invertedImage = decodePng(invertedBuffer);

  it('fails the top-luminance check because the top is now dark ground', () => {
    const check: CanvasRegionCheck = {
      selector: 'canvas',
      region: 'top',
      expectedLuminanceAbove: 150,
      label: 'sky should be bright at the top',
    };
    const result = evaluateCanvasRegionCheck(invertedImage, check);
    expect(result.pass).toBe(false);
    expect(result.measuredLuminance).toBeLessThan(150);
  });

  it('fails the top hue-range check because the top is no longer blue', () => {
    const check: CanvasRegionCheck = {
      selector: 'canvas',
      region: 'top',
      expectedHueRange: [180, 240],
      label: 'top hue should be blue-ish',
    };
    const result = evaluateCanvasRegionCheck(invertedImage, check);
    expect(result.pass).toBe(false);
  });
});

describe('evaluateCanvasRegionCheck — explicit rectangle region', () => {
  it('evaluates an explicit {x,y,w,h} rectangle rather than a named half', () => {
    const buffer = buildHalfSplitPng(SKY_COLOR, GROUND_COLOR);
    const image = decodePng(buffer);
    const check: CanvasRegionCheck = {
      selector: 'canvas',
      region: { x: 0, y: 0, w: SIZE, h: 4 }, // just the very top sliver
      expectedLuminanceAbove: 150,
      label: 'top sliver bright',
    };
    const result = evaluateCanvasRegionCheck(image, check);
    expect(result.pass).toBe(true);
  });

  it('clamps an out-of-bounds rectangle instead of throwing', () => {
    const buffer = buildHalfSplitPng(SKY_COLOR, GROUND_COLOR);
    const image = decodePng(buffer);
    const check: CanvasRegionCheck = {
      selector: 'canvas',
      region: { x: -10, y: -10, w: 999, h: 999 },
      expectedLuminanceAbove: 0,
      label: 'clamped region does not throw',
    };
    expect(() => evaluateCanvasRegionCheck(image, check)).not.toThrow();
  });
});

describe('evaluateCanvasRegionCheck — fail-closed with no assertion configured', () => {
  it('fails with a descriptive error when neither hue nor luminance thresholds are set', () => {
    const buffer = buildHalfSplitPng(SKY_COLOR, GROUND_COLOR);
    const image = decodePng(buffer);
    const check: CanvasRegionCheck = {
      selector: 'canvas',
      region: 'top',
      label: 'misconfigured check',
    };
    const result = evaluateCanvasRegionCheck(image, check);
    expect(result.pass).toBe(false);
    expect(result.error).toMatch(/nothing to assert/i);
  });
});

describe('runCanvasRegionChecks — robustness (screenshot missing / canvas not found)', () => {
  const cleanup: string[] = [];

  afterEach(() => {
    while (cleanup.length > 0) {
      const dir = cleanup.pop()!;
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it('reports a structured error per check (never throws) when the screenshot path is undefined', () => {
    const checks: CanvasRegionCheck[] = [
      { selector: 'canvas', region: 'top', expectedLuminanceAbove: 150, label: 'sky bright' },
      { selector: 'canvas', region: 'bottom', expectedLuminanceAbove: 0, label: 'ground exists' },
    ];

    let results: ReturnType<typeof runCanvasRegionChecks> = [];
    expect(() => { results = runCanvasRegionChecks(undefined, checks); }).not.toThrow();

    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.pass).toBe(false);
      expect(result.error).toMatch(/screenshot not found/i);
    }
  });

  it('reports a structured error per check (never throws) when the screenshot file does not exist on disk', () => {
    const dir = makeTempDirLocal('missing-screenshot');
    cleanup.push(dir);
    const missingPath = join(dir, 'does-not-exist.png');
    const checks: CanvasRegionCheck[] = [
      { selector: 'canvas', region: 'top', expectedLuminanceAbove: 150, label: 'sky bright' },
    ];

    const results = runCanvasRegionChecks(missingPath, checks);
    expect(results).toHaveLength(1);
    expect(results[0]!.pass).toBe(false);
    expect(results[0]!.error).toMatch(/screenshot not found/i);
  });

  it('reports a structured error per check (never throws) when the screenshot file is not a valid PNG', () => {
    const dir = makeTempDirLocal('corrupt-png');
    cleanup.push(dir);
    const corruptPath = join(dir, 'corrupt.png');
    writeFileSync(corruptPath, Buffer.from('this is not a png file'), 'utf8');
    const checks: CanvasRegionCheck[] = [
      { selector: 'canvas', region: 'top', expectedLuminanceAbove: 150, label: 'sky bright' },
    ];

    let results: ReturnType<typeof runCanvasRegionChecks> = [];
    expect(() => { results = runCanvasRegionChecks(corruptPath, checks); }).not.toThrow();

    expect(results).toHaveLength(1);
    expect(results[0]!.pass).toBe(false);
    expect(results[0]!.error).toMatch(/failed to decode screenshot PNG/i);
  });

  it('returns real pass/fail results (not errors) when given a valid screenshot', () => {
    const dir = makeTempDirLocal('valid-screenshot');
    cleanup.push(dir);
    const validPath = join(dir, 'index.png');
    writeFileSync(validPath, buildHalfSplitPng(SKY_COLOR, GROUND_COLOR));
    const checks: CanvasRegionCheck[] = [
      { selector: 'canvas', region: 'top', expectedLuminanceAbove: 150, label: 'sky bright' },
    ];

    const results = runCanvasRegionChecks(validPath, checks);
    expect(results).toHaveLength(1);
    expect(results[0]!.pass).toBe(true);
    expect(results[0]!.error).toBeUndefined();
  });
});

function makeTempDirLocal(label: string): string {
  const dir = join(
    tmpdir(),
    `omniforge-canvas-check-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}
