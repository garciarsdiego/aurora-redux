import { getProviderManager } from '../providers/index.js';
import { getBenchmarkStore } from './BenchmarkStore.js';
import type { BenchmarkSuite, BenchmarkRun, QualityEvaluation, BenchmarkReport } from './types.js';

export class BenchmarkRunner {
  private benchmarkStore = getBenchmarkStore();
  private providerManager = getProviderManager();

  /**
   * Run a benchmark suite for a provider and model
   */
  async runSuite(
    provider: string,
    model: string,
    suite: BenchmarkSuite
  ): Promise<BenchmarkRun[]> {
    const runs: BenchmarkRun[] = [];

    for (const testCase of suite.test_cases) {
      const runId = this.generateRunId();

      const startTime = Date.now();
      let output: string;
      let success = false;
      let costUsd = 0;

      try {
        const request = {
          model,
          messages: [{ role: 'user' as const, content: testCase.input }]
        };

        const response = await this.providerManager.call(model, request, {
          provider,
          fallbackToOmniroute: false
        });

        output = response.content;
        costUsd = response.cost_usd || 0;
        success = true;
      } catch (error) {
        output = `Error: ${error}`;
        success = false;
      }

      const endTime = Date.now();
      const latencyMs = endTime - startTime;

      // Evaluate quality
      const quality = await this.evaluateQuality(
        testCase.input,
        output,
        suite.use_cases[0] // Use first use case for simplicity
      );

      const run: BenchmarkRun = {
        id: runId,
        provider,
        model,
        use_case: suite.use_cases[0],
        input: testCase.input,
        output,
        quality_score: quality.score,
        cost_usd: costUsd,
        latency_ms: latencyMs,
        success,
        timestamp: Math.floor(endTime / 1000)
      };

      runs.push(run);
      await this.benchmarkStore.recordRun(run);
    }

    return runs;
  }

  /**
   * Run A/B test between two models
   */
  async runABTest(
    modelA: string,
    modelB: string,
    testCases: string[],
    useCase: string = 'code'
  ): Promise<{
    modelA: BenchmarkRun[];
    modelB: BenchmarkRun[];
    comparison: {
      avgQualityA: number;
      avgQualityB: number;
      avgCostA: number;
      avgCostB: number;
      winner: string;
    };
  }> {
    const suite: BenchmarkSuite = {
      name: `A/B Test: ${modelA} vs ${modelB}`,
      use_cases: [useCase],
      test_cases: testCases.map(input => ({
        id: `test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        input,
        expected_quality: 0.8
      }))
    };

    const [modelARuns, modelBRuns] = await Promise.all([
      this.runSuite('omniroute', modelA, suite),
      this.runSuite('omniroute', modelB, suite)
    ]);

    const avgQualityA = modelARuns.reduce((sum, r) => sum + r.quality_score, 0) / modelARuns.length;
    const avgQualityB = modelBRuns.reduce((sum, r) => sum + r.quality_score, 0) / modelBRuns.length;
    const avgCostA = modelARuns.reduce((sum, r) => sum + r.cost_usd, 0) / modelARuns.length;
    const avgCostB = modelBRuns.reduce((sum, r) => sum + r.cost_usd, 0) / modelBRuns.length;

    let winner = 'tie';
    if (avgQualityA > avgQualityB && avgCostA <= avgCostB * 1.2) {
      winner = modelA;
    } else if (avgQualityB > avgQualityA && avgCostB <= avgCostA * 1.2) {
      winner = modelB;
    }

    return {
      modelA: modelARuns,
      modelB: modelBRuns,
      comparison: {
        avgQualityA,
        avgQualityB,
        avgCostA,
        avgCostB,
        winner
      }
    };
  }

  /**
   * Detect performance regression
   */
  async detectRegression(
    provider: string,
    model: string,
    threshold: number = 0.1
  ): Promise<boolean> {
    const currentBenchmark = this.benchmarkStore.getBenchmark(provider, model, 'code');
    
    if (!currentBenchmark) {
      return false; // No baseline to compare
    }

    // Get recent runs
    const recentRuns = this.benchmarkStore.getRunsForModel(model, 10);
    
    if (recentRuns.length < 5) {
      return false; // Not enough data
    }

    const recentAvgQuality = recentRuns.reduce((sum, r) => sum + r.quality_score, 0) / recentRuns.length;
    const qualityDrop = currentBenchmark.avg_quality - recentAvgQuality;

    return qualityDrop > threshold;
  }

  /**
   * Generate benchmark report
   */
  async generateReport(): Promise<BenchmarkReport> {
    const allBenchmarks = this.benchmarkStore.getAllBenchmarks();
    const allRuns = this.benchmarkStore.getRunsForProvider('omniroute', 100);

    // Calculate overall stats
    const totalRuns = allRuns.length;
    const successfulRuns = allRuns.filter(r => r.success).length;
    const overallSuccessRate = totalRuns > 0 ? successfulRuns / totalRuns : 0;

    // Group by provider
    const byProvider: Record<string, any> = {};
    for (const benchmark of allBenchmarks) {
      if (!byProvider[benchmark.provider]) {
        byProvider[benchmark.provider] = {
          avg_quality: 0,
          avg_cost: 0,
          avg_latency: 0,
          success_rate: 0,
          count: 0
        };
      }
      const stats = byProvider[benchmark.provider];
      stats.avg_quality += benchmark.avg_quality;
      stats.avg_cost += benchmark.avg_cost_usd;
      stats.avg_latency += benchmark.avg_latency_ms;
      stats.success_rate += benchmark.success_rate;
      stats.count += 1;
    }

    // Calculate averages
    for (const provider in byProvider) {
      const stats = byProvider[provider];
      stats.avg_quality /= stats.count;
      stats.avg_cost /= stats.count;
      stats.avg_latency /= stats.count;
      stats.success_rate /= stats.count;
    }

    // Group by use case
    const byUseCase: Record<string, any> = {};
    for (const benchmark of allBenchmarks) {
      if (!byUseCase[benchmark.use_case]) {
        byUseCase[benchmark.use_case] = {
          best_provider: '',
          best_model: '',
          avg_quality: 0,
          count: 0
        };
      }
      const uc = byUseCase[benchmark.use_case];
      if (benchmark.avg_quality > uc.avg_quality) {
        uc.best_provider = benchmark.provider;
        uc.best_model = benchmark.model;
        uc.avg_quality = benchmark.avg_quality;
      }
      uc.count++;
    }

    // Generate recommendations
    const recommendations: string[] = [];
    
    if (overallSuccessRate < 0.9) {
      recommendations.push('Overall success rate is below 90%. Consider investigating provider reliability.');
    }

    for (const provider in byProvider) {
      const stats = byProvider[provider];
      if (stats.avg_latency > 5000) {
        recommendations.push(`${provider} has high latency (${Math.round(stats.avg_latency)}ms). Consider caching or switching providers.`);
      }
      if (stats.avg_cost > 0.1) {
        recommendations.push(`${provider} has high average cost ($${stats.avg_cost.toFixed(4)}). Consider cost optimization strategies.`);
      }
    }

    return {
      generated_at: Math.floor(Date.now() / 1000),
      total_runs: totalRuns,
      overall_success_rate: overallSuccessRate,
      by_provider: byProvider,
      by_use_case: byUseCase,
      recommendations
    };
  }

  /**
   * Evaluate quality of a response.
   *
   * De-mock (MCP-06/OPS-10): the provider call, cost_usd and latency_ms in a
   * benchmark run are REAL. The quality dimension, however, is NOT a measured
   * benchmark score — it is a coarse heuristic (length + error-string + a few
   * keyword checks). We therefore label it as a placeholder so callers never
   * mistake it for a real quality measurement. A real implementation would
   * plug in LLM-as-judge or task-specific graders here.
   */
  private async evaluateQuality(input: string, output: string, useCase: string): Promise<QualityEvaluation> {
    // Heuristic placeholder score — see the de-mock note above.
    let score = 0.5; // Base score

    // Length check (output should not be empty)
    if (output.length > 10) {
      score += 0.1;
    }

    // Length check (output should not be too short)
    if (output.length > 50) {
      score += 0.1;
    }

    // Error check (should not contain error messages)
    if (!output.toLowerCase().includes('error') && !output.toLowerCase().includes('failed')) {
      score += 0.2;
    }

    // Use case specific evaluation
    if (useCase === 'code') {
      // Check for code-like content
      if (output.includes('function') || output.includes('const ') || output.includes('let ')) {
        score += 0.1;
      }
    } else if (useCase === 'debug') {
      // Check for debugging keywords
      if (output.includes('error') || output.includes('fix') || output.includes('solution')) {
        score += 0.1;
      }
    }

    return {
      score: Math.min(1.0, score),
      metrics: {
        correctness: score,
        completeness: score * 0.9,
        efficiency: score * 0.8,
        style: score * 0.7
      },
      reasoning:
        'PLACEHOLDER quality (heuristic: length/error-string/keyword checks). ' +
        'cost_usd and latency_ms are real; quality_score is NOT a measured benchmark.'
    };
  }

  /**
   * Generate unique run ID
   */
  private generateRunId(): string {
    return `run-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}