import { describe, it, expect } from 'vitest';
import {
  PlattCalibration,
  CalibratedJudge,
  createCalibratedJudge,
  type CalibrationDataPoint,
} from '../../../../../dist/v2/evals/judges/calibration.js';
import { ExactMatchJudge } from '../../../../../dist/v2/evals/judges/deterministic.js';
import type { TestCase } from '../../../../../dist/v2/evals/types.js';

describe('PlattCalibration', () => {
  it('should train with calibration data', () => {
    const platt = new PlattCalibration();

    const data: CalibrationDataPoint[] = [
      { rawScore: 0.1, label: 0 },
      { rawScore: 0.3, label: 0 },
      { rawScore: 0.5, label: 1 },
      { rawScore: 0.7, label: 1 },
      { rawScore: 0.9, label: 1 },
    ];

    platt.train(data);

    expect(platt.isTrained()).toBe(true);
    const model = platt.getModel();
    expect(model.kind).toBe('platt');
    expect(model.a).toBeDefined();
    expect(model.b).toBeDefined();
    expect(model.fittedAt).toBeDefined();
  });

  it('should throw error when training with empty data', () => {
    const platt = new PlattCalibration();

    expect(() => platt.train([])).toThrow('Cannot train with empty data');
  });

  it('should calibrate scores after training', () => {
    const platt = new PlattCalibration();

    const data: CalibrationDataPoint[] = [
      { rawScore: 0.1, label: 0 },
      { rawScore: 0.9, label: 1 },
    ];

    platt.train(data);

    // Calibrated scores should still be in [0, 1] range
    const calibrated = platt.calibrate(0.5);
    expect(calibrated).toBeGreaterThanOrEqual(0);
    expect(calibrated).toBeLessThanOrEqual(1);
  });

  it('should return raw score when not trained', () => {
    const platt = new PlattCalibration();

    expect(platt.isTrained()).toBe(false);
    expect(platt.calibrate(0.7)).toBe(0.7);
  });

  it('should compute AUC after training', () => {
    const platt = new PlattCalibration();

    const data: CalibrationDataPoint[] = [
      { rawScore: 0.1, label: 0 },
      { rawScore: 0.2, label: 0 },
      { rawScore: 0.8, label: 1 },
      { rawScore: 0.9, label: 1 },
    ];

    platt.train(data);

    const model = platt.getModel();
    expect(model.auc).toBeDefined();
    expect(model.auc).toBeGreaterThan(0);
    expect(model.auc).toBeLessThanOrEqual(1);
  });

  it('should handle perfect separation', () => {
    const platt = new PlattCalibration();

    const data: CalibrationDataPoint[] = [
      { rawScore: 0.1, label: 0 },
      { rawScore: 0.2, label: 0 },
      { rawScore: 0.3, label: 0 },
      { rawScore: 0.8, label: 1 },
      { rawScore: 0.9, label: 1 },
      { rawScore: 1.0, label: 1 },
    ];

    platt.train(data);

    expect(platt.isTrained()).toBe(true);

    // Low raw scores should calibrate to low probabilities
    expect(platt.calibrate(0.1)).toBeLessThan(0.5);
    // High raw scores should calibrate to high probabilities
    expect(platt.calibrate(0.9)).toBeGreaterThan(0.5);
  });

  it('should handle edge cases (0 and 1)', () => {
    const platt = new PlattCalibration();

    const data: CalibrationDataPoint[] = [
      { rawScore: 0, label: 0 },
      { rawScore: 1, label: 1 },
    ];

    platt.train(data);

    // Should not throw on edge cases
    expect(() => platt.calibrate(0)).not.toThrow();
    expect(() => platt.calibrate(1)).not.toThrow();
  });

  it('should support custom training options', () => {
    const platt = new PlattCalibration();

    const data: CalibrationDataPoint[] = [
      { rawScore: 0.1, label: 0 },
      { rawScore: 0.9, label: 1 },
    ];

    platt.train(data, { learningRate: 0.5, iterations: 100 });

    expect(platt.isTrained()).toBe(true);
  });

  it('should return AUC of 0.5 when one class is missing', () => {
    const platt = new PlattCalibration();

    // All labels are 0
    const data: CalibrationDataPoint[] = [
      { rawScore: 0.1, label: 0 },
      { rawScore: 0.2, label: 0 },
      { rawScore: 0.3, label: 0 },
    ];

    platt.train(data);

    const model = platt.getModel();
    expect(model.auc).toBe(0.5);
  });
});

describe('CalibratedJudge', () => {
  const createTestCase = (input: unknown, expected: unknown): TestCase<unknown, unknown> => ({
    id: 'test-1',
    workspace: 'test',
    suite: 'custom',
    name: 'Test case',
    input,
    expected,
    created_at: Date.now(),
  });

  it('should wrap a base judge and apply calibration', async () => {
    const baseJudge = new ExactMatchJudge();
    const platt = new PlattCalibration();

    const data: CalibrationDataPoint[] = [
      { rawScore: 0, label: 0 },
      { rawScore: 1, label: 1 },
    ];

    platt.train(data);

    const calibratedJudge = new CalibratedJudge(baseJudge, platt);

    expect(calibratedJudge.name).toBe('exact-match-calibrated');
    expect(calibratedJudge.version).toBe('v1-calibrated');
    expect(calibratedJudge.calibration.kind).toBe('platt');
  });

  it('should apply calibration to evaluation results', async () => {
    const baseJudge = new ExactMatchJudge();
    const platt = new PlattCalibration();

    const data: CalibrationDataPoint[] = [
      { rawScore: 0, label: 0 },
      { rawScore: 1, label: 1 },
    ];

    platt.train(data);

    const calibratedJudge = new CalibratedJudge(baseJudge, platt);

    const testCase = createTestCase('hello', 'hello');
    const result = await calibratedJudge.evaluate({
      testCase,
      output: 'hello',
      expected: 'hello',
      rubric: 'Exact match',
    });

    // Score should be calibrated (still in [0, 1] range)
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
    expect(result.reason).toContain('[Calibrated]');
  });

  it('should provide calibrate method', () => {
    const baseJudge = new ExactMatchJudge();
    const platt = new PlattCalibration();

    const data: CalibrationDataPoint[] = [
      { rawScore: 0, label: 0 },
      { rawScore: 1, label: 1 },
    ];

    platt.train(data);

    const calibratedJudge = new CalibratedJudge(baseJudge, platt);

    const calibrated = calibratedJudge.calibrate(0.5);
    expect(calibrated).toBeGreaterThanOrEqual(0);
    expect(calibrated).toBeLessThanOrEqual(1);
  });

  it('should expose base judge', () => {
    const baseJudge = new ExactMatchJudge();
    const platt = new PlattCalibration();

    platt.train([
      { rawScore: 0, label: 0 },
      { rawScore: 1, label: 1 },
    ]);

    const calibratedJudge = new CalibratedJudge(baseJudge, platt);

    expect(calibratedJudge.getBaseJudge()).toBe(baseJudge);
  });
});

describe('createCalibratedJudge', () => {
  it('should create a calibrated judge from base judge and data', () => {
    const baseJudge = new ExactMatchJudge();

    const data: CalibrationDataPoint[] = [
      { rawScore: 0, label: 0 },
      { rawScore: 1, label: 1 },
    ];

    const calibratedJudge = createCalibratedJudge(baseJudge, data);

    expect(calibratedJudge).toBeInstanceOf(CalibratedJudge);
    expect(calibratedJudge.getBaseJudge()).toBe(baseJudge);
    expect(calibratedJudge.calibration.kind).toBe('platt');
  });

  it('should pass training options to PlattCalibration', () => {
    const baseJudge = new ExactMatchJudge();

    const data: CalibrationDataPoint[] = [
      { rawScore: 0, label: 0 },
      { rawScore: 1, label: 1 },
    ];

    const calibratedJudge = createCalibratedJudge(baseJudge, data, {
      learningRate: 0.5,
      iterations: 50,
    });

    expect(calibratedJudge).toBeInstanceOf(CalibratedJudge);
  });
});