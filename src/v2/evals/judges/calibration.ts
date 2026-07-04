/**
 * Calibration for judge scores.
 *
 * Implements Platt scaling to calibrate raw judge scores into well-calibrated probabilities.
 * A calibrated judge wraps another judge and applies the calibration transformation.
 */

import type { Judge, JudgeInput, JudgeOutput } from '../types.js';
import type { CalibrationModel, CalibratedJudge as ICalibratedJudge } from '../types.js';

/**
 * Training data point for calibration.
 */
export interface CalibrationDataPoint {
  /** Raw score from the judge (0..1) */
  rawScore: number;
  /** Ground truth label (0 = incorrect, 1 = correct) */
  label: 0 | 1;
}

/**
 * Platt scaling calibration model.
 *
 * Uses logistic regression to map raw scores to calibrated probabilities:
 * P(correct | score) = sigmoid(a * score + b) = 1 / (1 + exp(-(a * score + b)))
 */
export class PlattCalibration {
  private a: number = 1;  // Slope parameter
  private b: number = 0;  // Intercept parameter
  private trained: boolean = false;
  private auc: number | undefined;

  /**
   * Train the calibration model using historical data.
   *
   * Uses a simple gradient descent approach to optimize the logistic regression parameters.
   *
   * @param data - Array of (rawScore, label) pairs
   * @param options - Training options
   */
  train(
    data: CalibrationDataPoint[],
    options: {
      learningRate?: number;
      iterations?: number;
    } = {},
  ): void {
    if (data.length === 0) {
      throw new Error('Cannot train with empty data');
    }

    const { learningRate = 0.1, iterations = 1000 } = options;

    // Initialize parameters
    this.a = 1;
    this.b = 0;

    // Gradient descent
    for (let iter = 0; iter < iterations; iter++) {
      let gradA = 0;
      let gradB = 0;

      for (const point of data) {
        const { rawScore, label } = point;
        const z = this.a * rawScore + this.b;
        const predicted = this.sigmoid(z);
        const error = predicted - label;

        gradA += error * rawScore;
        gradB += error;
      }

      // Update parameters
      this.a -= learningRate * (gradA / data.length);
      this.b -= learningRate * (gradB / data.length);

      // Early stopping if gradients are small
      if (Math.abs(gradA) < 1e-6 && Math.abs(gradB) < 1e-6) {
        break;
      }
    }

    this.trained = true;
    this.auc = this.computeAUC(data);
  }

  /**
   * Calibrate a raw score using the trained model.
   *
   * @param raw - Raw score (0..1)
   * @returns Calibrated probability (0..1)
   */
  calibrate(raw: number): number {
    if (!this.trained) {
      // If not trained, return the raw score (identity)
      return raw;
    }

    const z = this.a * raw + this.b;
    return this.sigmoid(z);
  }

  /**
   * Get the calibration model metadata.
   */
  getModel(): CalibrationModel {
    return {
      kind: 'platt',
      a: this.a,
      b: this.b,
      auc: this.auc,
      fittedAt: Date.now(),
    };
  }

  /**
   * Check if the model has been trained.
   */
  isTrained(): boolean {
    return this.trained;
  }

  /**
   * Sigmoid function.
   */
  private sigmoid(x: number): number {
    // Clamp to avoid numerical overflow
    const clamped = Math.max(-500, Math.min(500, x));
    return 1 / (1 + Math.exp(-clamped));
  }

  /**
   * Compute AUC (Area Under the ROC Curve) for the calibration data.
   */
  private computeAUC(data: CalibrationDataPoint[]): number {
    // Sort by predicted score
    const sorted = [...data].sort((a, b) => {
      const scoreA = this.calibrate(a.rawScore);
      const scoreB = this.calibrate(b.rawScore);
      return scoreB - scoreA; // Descending
    });

    // Compute AUC using trapezoidal rule
    let auc = 0;
    let tp = 0;
    let fp = 0;
    let prevTp = 0;
    let prevFp = 0;

    const positives = data.filter((d) => d.label === 1).length;
    const negatives = data.filter((d) => d.label === 0).length;

    if (positives === 0 || negatives === 0) {
      return 0.5; // Undefined AUC when one class is missing
    }

    for (const point of sorted) {
      if (point.label === 1) {
        tp++;
      } else {
        fp++;
      }

      // Add area of trapezoid
      const tpr = tp / positives;
      const fpr = fp / negatives;
      const prevTpr = prevTp / positives;
      const prevFpr = prevFp / negatives;

      auc += (tpr + prevTpr) * (fpr - prevFpr) / 2;

      prevTp = tp;
      prevFp = fp;
    }

    return auc;
  }
}

/**
 * A calibrated judge that wraps another judge and applies Platt scaling.
 *
 * This decorator applies calibration to the scores returned by the base judge.
 * The calibration model must be trained before use.
 */
export class CalibratedJudge implements ICalibratedJudge {
  readonly name: string;
  readonly version: string;
  readonly calibration: CalibrationModel;

  constructor(
    private readonly baseJudge: Judge,
    private readonly platt: PlattCalibration,
  ) {
    this.name = `${baseJudge.name}-calibrated`;
    this.version = `${baseJudge.version}-calibrated`;
    this.calibration = platt.getModel();
  }

  async evaluate(input: JudgeInput): Promise<JudgeOutput> {
    const result = await this.baseJudge.evaluate(input);

    // Apply calibration to the score
    const calibratedScore = this.platt.calibrate(result.score);

    return {
      ...result,
      score: calibratedScore,
      reason: `[Calibrated] ${result.reason}`,
    };
  }

  /**
   * Calibrate a raw score.
   */
  calibrate(raw: number): number {
    return this.platt.calibrate(raw);
  }

  /**
   * Get the underlying base judge.
   */
  getBaseJudge(): Judge {
    return this.baseJudge;
  }
}

/**
 * Create a calibrated judge from a base judge and training data.
 *
 * @param baseJudge - The judge to calibrate
 * @param trainingData - Historical data for training
 * @param options - Training options
 * @returns A calibrated judge
 */
export function createCalibratedJudge(
  baseJudge: Judge,
  trainingData: CalibrationDataPoint[],
  options?: { learningRate?: number; iterations?: number },
): CalibratedJudge {
  const platt = new PlattCalibration();
  platt.train(trainingData, options);
  return new CalibratedJudge(baseJudge, platt);
}