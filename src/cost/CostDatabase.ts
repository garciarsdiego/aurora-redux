import type Database from 'better-sqlite3';
import { initDb } from '../db/client.js';
import { getDbPath } from '../utils/config.js';
import type { CostRecord, CostEstimate } from './types.js';

/**
 * Shape of a model_costs SELECT row — the queries always project exactly the
 * CostRecord columns, so the row shares the record's shape.
 */
type ModelCostRow = CostRecord;

export class CostDatabase {
  private db: Database.Database;

  constructor() {
    this.db = initDb(getDbPath());
  }

  /**
   * Get cost information for a specific model
   */
  getCost(model: string, provider: string = 'omniroute'): CostRecord | null {
    const row = this.db.prepare(
      'SELECT model, provider, input_cost_per_1k, output_cost_per_1k, avg_tokens_per_request, max_tokens, last_updated FROM model_costs WHERE model = ? AND provider = ?'
    ).get(model, provider) as ModelCostRow | undefined;

    if (!row) {
      // Try to find by model only (any provider)
      const anyProviderRow = this.db.prepare(
        'SELECT model, provider, input_cost_per_1k, output_cost_per_1k, avg_tokens_per_request, max_tokens, last_updated FROM model_costs WHERE model = ? LIMIT 1'
      ).get(model) as ModelCostRow | undefined;

      return anyProviderRow ? this.rowToCostRecord(anyProviderRow) : null;
    }

    return this.rowToCostRecord(row);
  }

  /**
   * Get all cost records
   */
  getAllCosts(): CostRecord[] {
    const rows = this.db.prepare(
      'SELECT model, provider, input_cost_per_1k, output_cost_per_1k, avg_tokens_per_request, max_tokens, last_updated FROM model_costs'
    ).all() as ModelCostRow[];

    return rows.map(row => this.rowToCostRecord(row));
  }

  /**
   * Update or insert cost record
   */
  updateCost(cost: CostRecord): void {
    this.db.prepare(
      `INSERT INTO model_costs (model, provider, input_cost_per_1k, output_cost_per_1k, avg_tokens_per_request, max_tokens, last_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(model, provider) DO UPDATE SET
         input_cost_per_1k = excluded.input_cost_per_1k,
         output_cost_per_1k = excluded.output_cost_per_1k,
         avg_tokens_per_request = excluded.avg_tokens_per_request,
         max_tokens = excluded.max_tokens,
         last_updated = excluded.last_updated`
    ).run(
      cost.model,
      cost.provider,
      cost.input_cost_per_1k,
      cost.output_cost_per_1k,
      cost.avg_tokens_per_request,
      cost.max_tokens,
      cost.last_updated
    );
  }

  /**
   * Estimate number of tokens for a prompt (simple heuristic)
   */
  estimateTokens(prompt: string): number {
    // Rough estimation: ~4 characters per token for English text
    // This is a simple heuristic - in production, use tokenizer
    return Math.ceil(prompt.length / 4);
  }

  /**
   * Calculate cost based on token counts
   */
  calculateCost(
    model: string,
    input_tokens: number,
    output_tokens: number,
    provider: string = 'omniroute'
  ): number {
    const cost = this.getCost(model, provider);
    if (!cost) {
      // Default to conservative estimate if model not found
      return (input_tokens + output_tokens) * 0.00001; // $0.01 per 1K tokens
    }

    const input_cost = (input_tokens / 1000) * cost.input_cost_per_1k;
    const output_cost = (output_tokens / 1000) * cost.output_cost_per_1k;
    
    return input_cost + output_cost;
  }

  /**
   * Estimate total cost for a request (input + estimated output)
   */
  estimateCost(
    model: string,
    prompt: string,
    estimated_output_tokens?: number,
    provider: string = 'omniroute'
  ): CostEstimate {
    const cost = this.getCost(model, provider);
    const input_tokens = this.estimateTokens(prompt);
    
    // Estimate output tokens (default to avg if not provided)
    const output_tokens = estimated_output_tokens || (cost?.avg_tokens_per_request || 500);
    
    const total_cost = this.calculateCost(model, input_tokens, output_tokens, provider);
    
    return {
      model,
      input_tokens,
      output_tokens,
      total_cost_usd: total_cost,
      confidence: 0.7 // 70% confidence with simple heuristic
    };
  }

  /**
   * Get models sorted by cost (ascending)
   */
  getModelsByCost(limit: number = 10): CostRecord[] {
    const rows = this.db.prepare(
      `SELECT model, provider, input_cost_per_1k, output_cost_per_1k, avg_tokens_per_request, max_tokens, last_updated
       FROM model_costs
       ORDER BY (input_cost_per_1k + output_cost_per_1k) ASC
       LIMIT ?`
    ).all(limit) as ModelCostRow[];

    return rows.map(row => this.rowToCostRecord(row));
  }

  /**
   * Get models for a specific provider
   */
  getModelsByProvider(provider: string): CostRecord[] {
    const rows = this.db.prepare(
      'SELECT model, provider, input_cost_per_1k, output_cost_per_1k, avg_tokens_per_request, max_tokens, last_updated FROM model_costs WHERE provider = ?'
    ).all(provider) as ModelCostRow[];

    return rows.map(row => this.rowToCostRecord(row));
  }

  /**
   * Update average tokens per request based on actual usage
   */
  updateAvgTokens(model: string, actual_tokens: number, provider: string = 'omniroute'): void {
    const current = this.getCost(model, provider);
    if (!current) {
      return;
    }

    // Exponential moving average with alpha = 0.1
    const new_avg = Math.round(current.avg_tokens_per_request * 0.9 + actual_tokens * 0.1);

    this.db.prepare(
      `UPDATE model_costs SET avg_tokens_per_request = ?, last_updated = ? WHERE model = ? AND provider = ?`
    ).run(new_avg, Math.floor(Date.now() / 1000), model, provider);
  }

  /**
   * Record actual usage cost for historical analysis
   */
  recordUsageCost(params: {
    model: string;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
    workflow_id?: string;
    task_id?: string;
    task_type?: string;
    timestamp: number;
  }): void {
    this.db.prepare(
      `INSERT INTO usage_costs (model, input_tokens, output_tokens, cost_usd, workflow_id, task_id, task_type, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      params.model,
      params.input_tokens,
      params.output_tokens,
      params.cost_usd,
      params.workflow_id || null,
      params.task_id || null,
      params.task_type || 'general',
      params.timestamp
    );
  }

  /**
   * Aggregate REAL spend from the usage ledger.
   *
   * De-mock (MCP-01/02/03): cost analytics must report money actually spent,
   * not a sum of pricing rates. This reads the `usage_costs` ledger (populated
   * live from omniroute-call.ts on every LLM call) and the `model_calls`
   * ledger (populated by the executor's success-finalize path). Both carry the
   * provider-reported `cost_usd` per call. We UNION them so analytics work
   * whether a deployment writes one ledger, the other, or both, while
   * de-duplicating is unnecessary because the two ledgers are written from
   * different code paths and a single workflow uses one of them consistently.
   *
   * Returns a per-model rollup of true spend plus token totals.
   */
  getRealSpendByModel(opts?: {
    model?: string;
    workflow_id?: string;
    since?: number;
    limit?: number;
  }): Array<{
    model: string;
    total_cost_usd: number;
    total_input_tokens: number;
    total_output_tokens: number;
    call_count: number;
    last_used: number | null;
  }> {
    const usageRows = this.aggregateLedger('usage_costs', 'timestamp', opts);
    const callRows = this.aggregateLedger('model_calls', 'created_at', opts);

    // Merge the two ledgers keyed by model.
    const merged = new Map<string, {
      model: string;
      total_cost_usd: number;
      total_input_tokens: number;
      total_output_tokens: number;
      call_count: number;
      last_used: number | null;
    }>();

    for (const row of [...usageRows, ...callRows]) {
      const existing = merged.get(row.model);
      if (existing) {
        existing.total_cost_usd += row.total_cost_usd;
        existing.total_input_tokens += row.total_input_tokens;
        existing.total_output_tokens += row.total_output_tokens;
        existing.call_count += row.call_count;
        existing.last_used = Math.max(existing.last_used ?? 0, row.last_used ?? 0) || null;
      } else {
        merged.set(row.model, { ...row });
      }
    }

    let result = Array.from(merged.values()).sort(
      (a, b) => b.total_cost_usd - a.total_cost_usd
    );

    const limit = opts?.limit;
    if (limit && limit > 0) {
      result = result.slice(0, limit);
    }
    return result;
  }

  /**
   * Aggregate a single usage ledger table by model. Tolerant of missing tables
   * (a fresh DB without one of the migrations applied returns []).
   */
  private aggregateLedger(
    table: 'usage_costs' | 'model_calls',
    tsColumn: 'timestamp' | 'created_at',
    opts?: { model?: string; workflow_id?: string; since?: number }
  ): Array<{
    model: string;
    total_cost_usd: number;
    total_input_tokens: number;
    total_output_tokens: number;
    call_count: number;
    last_used: number | null;
  }> {
    const filters: string[] = [];
    const params: Array<string | number> = [];
    if (opts?.model) {
      filters.push('model = ?');
      params.push(opts.model);
    }
    if (opts?.workflow_id) {
      filters.push('workflow_id = ?');
      params.push(opts.workflow_id);
    }
    if (opts?.since !== undefined) {
      filters.push(`${tsColumn} >= ?`);
      params.push(opts.since);
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

    try {
      const rows = this.db.prepare(
        `SELECT model,
                COALESCE(SUM(cost_usd), 0) AS total_cost_usd,
                COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
                COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
                COUNT(*) AS call_count,
                MAX(${tsColumn}) AS last_used
         FROM ${table}
         ${where}
         GROUP BY model`
      ).all(...params) as Array<{
        model: string;
        total_cost_usd: number;
        total_input_tokens: number;
        total_output_tokens: number;
        call_count: number;
        last_used: number | null;
      }>;
      return rows;
    } catch {
      // Missing table (migration not applied) — fail safe with no rows so a
      // fresh DB never throws "no such table" through the analytics tool.
      return [];
    }
  }

  /**
   * Real average latency (ms) for a model, measured from the model_calls
   * ledger. Returns null when no measured latency exists for the model so
   * callers can fall back to a heuristic. Fail-safe on a missing table.
   */
  getRealAvgLatencyMs(model: string): number | null {
    try {
      const row = this.db.prepare(
        `SELECT AVG(latency_ms) AS avg_latency, COUNT(latency_ms) AS n
         FROM model_calls
         WHERE model = ? AND latency_ms IS NOT NULL`
      ).get(model) as { avg_latency: number | null; n: number } | undefined;
      if (!row || !row.n || row.avg_latency == null) return null;
      return row.avg_latency;
    } catch {
      // model_calls table absent — no measured latency.
      return null;
    }
  }

  /**
   * Total real spend across the ledger, optionally filtered. Convenience
   * rollup over getRealSpendByModel().
   */
  getTotalRealSpend(opts?: {
    model?: string;
    workflow_id?: string;
    since?: number;
  }): {
    total_cost_usd: number;
    total_input_tokens: number;
    total_output_tokens: number;
    total_calls: number;
    distinct_models: number;
  } {
    const perModel = this.getRealSpendByModel(opts);
    return perModel.reduce(
      (acc, m) => ({
        total_cost_usd: acc.total_cost_usd + m.total_cost_usd,
        total_input_tokens: acc.total_input_tokens + m.total_input_tokens,
        total_output_tokens: acc.total_output_tokens + m.total_output_tokens,
        total_calls: acc.total_calls + m.call_count,
        distinct_models: acc.distinct_models + 1,
      }),
      {
        total_cost_usd: 0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_calls: 0,
        distinct_models: 0,
      }
    );
  }

  private rowToCostRecord(row: ModelCostRow): CostRecord {
    return {
      model: row.model,
      provider: row.provider,
      input_cost_per_1k: row.input_cost_per_1k,
      output_cost_per_1k: row.output_cost_per_1k,
      avg_tokens_per_request: row.avg_tokens_per_request,
      max_tokens: row.max_tokens,
      last_updated: row.last_updated
    };
  }

  close(): void {
    if (this.db) {
      this.db.close();
    }
  }
}

// Singleton instance
let costDatabaseInstance: CostDatabase | null = null;

export function getCostDatabase(): CostDatabase {
  if (!costDatabaseInstance) {
    costDatabaseInstance = new CostDatabase();
  }
  return costDatabaseInstance;
}