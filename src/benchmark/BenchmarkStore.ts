import { Database } from 'better-sqlite3';
import { initDb } from '../db/client.js';
import { getDbPath } from '../utils/config.js';
import type { ProviderBenchmark, BenchmarkRun } from './types.js';

// Database row types for type safety
interface BenchmarkRow {
  provider: string;
  model: string;
  use_case: string;
  avg_quality: number;
  avg_cost_usd: number;
  avg_latency_ms: number;
  success_rate: number;
  total_runs: number;
  last_updated: number;
}

interface BenchmarkRunRow {
  id: string;
  provider: string;
  model: string;
  use_case: string;
  input: string;
  output: string;
  quality_score: number;
  cost_usd: number;
  latency_ms: number;
  success: number;
  timestamp: number;
}

export class BenchmarkStore {
  private db: Database;

  constructor() {
    this.db = initDb(getDbPath());
  }

  /**
   * Record a benchmark run
   */
  async recordRun(run: BenchmarkRun): Promise<void> {
    this.db.prepare(
      `INSERT INTO benchmark_runs (id, provider, model, use_case, input, output, quality_score, cost_usd, latency_ms, success, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      run.id,
      run.provider,
      run.model,
      run.use_case,
      run.input,
      run.output,
      run.quality_score,
      run.cost_usd,
      run.latency_ms,
      run.success ? 1 : 0,
      run.timestamp
    );

    // Update aggregate benchmark
    await this.updateBenchmark(run.provider, run.model, run.use_case);
  }

  /**
   * Get benchmark for a specific provider/model/use_case
   */
  getBenchmark(provider: string, model: string, use_case: string): ProviderBenchmark | null {
    const row = this.db.prepare(
      'SELECT provider, model, use_case, avg_quality, avg_cost_usd, avg_latency_ms, success_rate, total_runs, last_updated FROM provider_benchmarks WHERE provider = ? AND model = ? AND use_case = ?'
    ).get(provider, model, use_case) as BenchmarkRow | undefined;

    if (!row) {
      return null;
    }

    return {
      provider: row.provider,
      model: row.model,
      use_case: row.use_case,
      avg_quality: row.avg_quality,
      avg_cost_usd: row.avg_cost_usd,
      avg_latency_ms: row.avg_latency_ms,
      success_rate: row.success_rate,
      total_runs: row.total_runs,
      last_updated: row.last_updated
    };
  }

  /**
   * Get all benchmarks
   */
  getAllBenchmarks(): ProviderBenchmark[] {
    const rows = this.db.prepare(
      'SELECT provider, model, use_case, avg_quality, avg_cost_usd, avg_latency_ms, success_rate, total_runs, last_updated FROM provider_benchmarks'
    ).all() as BenchmarkRow[];

    return rows.map(row => ({
      provider: row.provider,
      model: row.model,
      use_case: row.use_case,
      avg_quality: row.avg_quality,
      avg_cost_usd: row.avg_cost_usd,
      avg_latency_ms: row.avg_latency_ms,
      success_rate: row.success_rate,
      total_runs: row.total_runs,
      last_updated: row.last_updated
    }));
  }

  /**
   * Get best provider for a use case (optionally with max cost constraint)
   */
  getBestForUseCase(use_case: string, max_cost?: number): ProviderBenchmark | null {
    let query = 'SELECT provider, model, use_case, avg_quality, avg_cost_usd, avg_latency_ms, success_rate, total_runs, last_updated FROM provider_benchmarks WHERE use_case = ?';
    const params: any[] = [use_case];

    if (max_cost !== undefined) {
      query += ' AND avg_cost_usd <= ?';
      params.push(max_cost);
    }

    query += ' ORDER BY avg_quality DESC LIMIT 1';

    const row = this.db.prepare(query).get(...params) as BenchmarkRow | undefined;

    if (!row) {
      return null;
    }

    return {
      provider: row.provider,
      model: row.model,
      use_case: row.use_case,
      avg_quality: row.avg_quality,
      avg_cost_usd: row.avg_cost_usd,
      avg_latency_ms: row.avg_latency_ms,
      success_rate: row.success_rate,
      total_runs: row.total_runs,
      last_updated: row.last_updated
    } as ProviderBenchmark;
  }

  /**
   * Update aggregate benchmark after a run
   */
  private async updateBenchmark(provider: string, model: string, use_case: string): Promise<void> {
    // Get recent runs for this provider/model/use_case
    const recentRuns = this.db.prepare(
      `SELECT quality_score, cost_usd, latency_ms, success FROM benchmark_runs 
       WHERE provider = ? AND model = ? AND use_case = ? 
       ORDER BY timestamp DESC LIMIT 100`
    ).all(provider, model, use_case);

    if (recentRuns.length === 0) {
      return;
    }

    const totalRuns = recentRuns.length;
    const successfulRuns = recentRuns.filter((r: unknown) => (r as BenchmarkRunRow).success === 1).length;
    const avgQuality = recentRuns.reduce((sum: number, r: unknown) => sum + (r as BenchmarkRunRow).quality_score, 0) / totalRuns;
    const avgCost = recentRuns.reduce((sum: number, r: unknown) => sum + (r as BenchmarkRunRow).cost_usd, 0) / totalRuns;
    const avgLatency = recentRuns.reduce((sum: number, r: unknown) => sum + (r as BenchmarkRunRow).latency_ms, 0) / totalRuns;
    const successRate = successfulRuns / totalRuns;

    this.db.prepare(
      `INSERT INTO provider_benchmarks (provider, model, use_case, avg_quality, avg_cost_usd, avg_latency_ms, success_rate, total_runs, last_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, model, use_case) DO UPDATE SET
         avg_quality = excluded.avg_quality,
         avg_cost_usd = excluded.avg_cost_usd,
         avg_latency_ms = excluded.avg_latency_ms,
         success_rate = excluded.success_rate,
         total_runs = excluded.total_runs,
         last_updated = excluded.last_updated`
    ).run(
      provider,
      model,
      use_case,
      avgQuality,
      avgCost,
      avgLatency,
      successRate,
      totalRuns,
      Math.floor(Date.now() / 1000)
    );
  }

  /**
   * Get benchmark runs for a specific provider
   */
  getRunsForProvider(provider: string, limit: number = 50): BenchmarkRun[] {
    const rows = this.db.prepare(
      `SELECT id, provider, model, use_case, input, output, quality_score, cost_usd, latency_ms, success, timestamp
       FROM benchmark_runs
       WHERE provider = ?
       ORDER BY timestamp DESC
       LIMIT ?`
    ).all(provider, limit) as BenchmarkRunRow[];

    return rows.map(row => ({
      id: row.id,
      provider: row.provider,
      model: row.model,
      use_case: row.use_case,
      input: row.input,
      output: row.output,
      quality_score: row.quality_score,
      cost_usd: row.cost_usd,
      latency_ms: row.latency_ms,
      success: row.success === 1,
      timestamp: row.timestamp
    }));
  }

  /**
   * Get benchmark runs for a specific model
   */
  getRunsForModel(model: string, limit: number = 50): BenchmarkRun[] {
    const rows = this.db.prepare(
      `SELECT id, provider, model, use_case, input, output, quality_score, cost_usd, latency_ms, success, timestamp
       FROM benchmark_runs
       WHERE model = ?
       ORDER BY timestamp DESC
       LIMIT ?`
    ).all(model, limit) as BenchmarkRunRow[];

    return rows.map(row => ({
      id: row.id,
      provider: row.provider,
      model: row.model,
      use_case: row.use_case,
      input: row.input,
      output: row.output,
      quality_score: row.quality_score,
      cost_usd: row.cost_usd,
      latency_ms: row.latency_ms,
      success: row.success === 1,
      timestamp: row.timestamp
    }));
  }

  /**
   * Delete old benchmark runs (cleanup)
   */
  async deleteOldRuns(daysOld: number = 30): Promise<number> {
    const cutoffTimestamp = Math.floor(Date.now() / 1000) - (daysOld * 24 * 60 * 60);

    const result = this.db.prepare(
      'DELETE FROM benchmark_runs WHERE timestamp < ?'
    ).run(cutoffTimestamp);

    return result.changes;
  }

  close(): void {
    if (this.db) {
      this.db.close();
    }
  }
}

// Singleton instance
let benchmarkStoreInstance: BenchmarkStore | null = null;

export function getBenchmarkStore(): BenchmarkStore {
  if (!benchmarkStoreInstance) {
    benchmarkStoreInstance = new BenchmarkStore();
  }
  return benchmarkStoreInstance;
}