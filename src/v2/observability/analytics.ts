/**
 * Advanced Analytics Module (Sprint 8)
 *
 * Provides advanced analytics capabilities for:
 * - Performance trend analysis
 * - Cost optimization analytics
 * - Routing efficiency analytics
 * - Predictive insights and recommendations
 */

import type Database from 'better-sqlite3';
import { initDb } from '../../db/client.js';
import { getDbPath } from '../../utils/config.js';

export interface TimeSeriesDataPoint {
  timestamp: number;
  value: number;
  metadata?: Record<string, unknown>;
}

export interface PerformanceTrend {
  metric: string;
  period: 'hour' | 'day' | 'week' | 'month';
  data: TimeSeriesDataPoint[];
  trend: 'improving' | 'degrading' | 'stable';
  change_rate_pct: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface CostAnalytics {
  total_cost_usd: number;
  cost_by_model: Record<string, number>;
  cost_by_workflow: Array<{ workflow_id: string; cost_usd: number; task_count: number }>;
  cost_trend: TimeSeriesDataPoint[];
  avg_cost_per_task_usd: number;
  avg_cost_per_workflow_usd: number;
  cost_efficiency_score: number; // 0-100
}

export interface RoutingAnalytics {
  total_requests: number;
  requests_by_provider: Record<string, number>;
  success_rate_by_provider: Record<string, number>;
  avg_latency_by_provider: Record<string, number>;
  routing_efficiency_score: number; // 0-100
  provider_performance_trend: Record<string, PerformanceTrend>;
  optimal_routing_recommendations: Array<{
    provider: string;
    reason: string;
    expected_improvement_pct: number;
  }>;
}

export interface AnomalyDetection {
  metric: string;
  timestamp: number;
  value: number;
  expected_value: number;
  deviation_pct: number;
  severity: 'low' | 'medium' | 'high';
  description: string;
}

export interface CapacityPlanning {
  current_capacity_utilization_pct: number;
  projected_capacity_utilization_7d: number;
  projected_capacity_utilization_30d: number;
  recommended_actions: Array<{
    action: string;
    priority: 'low' | 'medium' | 'high';
    estimated_impact: string;
  }>;
}

export interface Insight {
  id: string;
  type: 'cost' | 'performance' | 'reliability' | 'capacity';
  severity: 'info' | 'warning' | 'critical';
  title: string;
  description: string;
  timestamp: number;
  recommendation: string;
  metrics: Record<string, number>;
}

export interface AnalyticsConfig {
  /** Time window for trend analysis (default: 7 days) */
  trendWindowMs: number;
  /** Number of data points for trend analysis */
  trendDataPoints: number;
  /** Anomaly detection threshold (z-score) */
  anomalyThreshold: number;
  /** Enable predictive analytics */
  enablePredictiveAnalytics: boolean;
}

const DEFAULT_CONFIG: AnalyticsConfig = {
  trendWindowMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  trendDataPoints: 100,
  anomalyThreshold: 2.5, // 2.5 standard deviations
  enablePredictiveAnalytics: true,
};

/**
 * Declarative table/SQL per supported metric, consulted by fetchTimeSeriesData.
 * Unknown metrics simply have no entry here, which fetchTimeSeriesData treats as "no data".
 */
const METRIC_QUERIES: Record<string, { table: string; sql: string }> = {
  workflow_duration: {
    table: 'workflows',
    sql: `
      SELECT completed_at as timestamp,
             (completed_at - created_at) / 1000 as value
      FROM workflows
      WHERE status = 'completed'
        AND completed_at >= ?
        AND completed_at <= ?
      ORDER BY completed_at ASC
    `,
  },
  task_latency: {
    table: 'tasks',
    sql: `
      SELECT ended_at as timestamp,
             (ended_at - started_at) as value
      FROM tasks
      WHERE status = 'completed'
        AND ended_at >= ?
        AND ended_at <= ?
      ORDER BY ended_at ASC
    `,
  },
  llm_cost: {
    table: 'events',
    sql: `
      SELECT created_at as timestamp,
             cost_usd as value
      FROM events
      WHERE type = 'llm_call'
        AND created_at >= ?
        AND created_at <= ?
      ORDER BY created_at ASC
    `,
  },
};

class AnalyticsEngine {
  private config: AnalyticsConfig;

  constructor(config: Partial<AnalyticsConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Get performance trend analysis for a metric
   */
  getPerformanceTrend(
    db: Database.Database,
    metric: string,
    period: 'hour' | 'day' | 'week' | 'month' = 'day'
  ): PerformanceTrend {
    const now = Date.now();
    const windowStart = now - this.config.trendWindowMs;

    // Fetch time-series data from trace_spans or events
    const data = this.fetchTimeSeriesData(db, metric, windowStart, now, period);

    // Calculate trend direction
    const trend = this.calculateTrendDirection(data);
    const changeRate = this.calculateChangeRate(data);

    // Calculate percentiles
    const values = data.map(d => d.value).sort((a, b) => a - b);
    const p50 = this.percentile(values, 50);
    const p95 = this.percentile(values, 95);
    const p99 = this.percentile(values, 99);

    return {
      metric,
      period,
      data,
      trend,
      change_rate_pct: Math.round(changeRate * 100) / 100,
      p50: Math.round(p50 * 100) / 100,
      p95: Math.round(p95 * 100) / 100,
      p99: Math.round(p99 * 100) / 100,
    };
  }

  /**
   * Get cost analytics
   */
  getCostAnalytics(db: Database.Database): CostAnalytics {
    const totalCost = this.calculateTotalCost(db);
    const costByModel = this.calculateCostByModel(db);
    const costByWorkflow = this.calculateCostByWorkflow(db);
    const costTrend = this.fetchCostTrend(db);
    const avgCostPerTask = this.calculateAvgCostPerTask(db);
    const avgCostPerWorkflow = this.calculateAvgCostPerWorkflow(db);
    const efficiencyScore = this.calculateCostEfficiencyScore(db);

    return {
      total_cost_usd: totalCost,
      cost_by_model: costByModel,
      cost_by_workflow: costByWorkflow,
      cost_trend: costTrend,
      avg_cost_per_task_usd: avgCostPerTask,
      avg_cost_per_workflow_usd: avgCostPerWorkflow,
      cost_efficiency_score: efficiencyScore,
    };
  }

  /**
   * Get routing analytics
   */
  getRoutingAnalytics(db: Database.Database): RoutingAnalytics {
    const totalRequests = this.calculateTotalRequests(db);
    const requestsByProvider = this.calculateRequestsByProvider(db);
    const successRateByProvider = this.calculateSuccessRateByProvider(db);
    const avgLatencyByProvider = this.calculateAvgLatencyByProvider(db);
    const efficiencyScore = this.calculateRoutingEfficiencyScore(successRateByProvider);
    const providerPerformanceTrend = this.calculateProviderPerformanceTrends(db, Object.keys(requestsByProvider));
    const recommendations = this.generateRoutingRecommendations(
      requestsByProvider,
      successRateByProvider,
      avgLatencyByProvider
    );

    return {
      total_requests: totalRequests,
      requests_by_provider: requestsByProvider,
      success_rate_by_provider: successRateByProvider,
      avg_latency_by_provider: avgLatencyByProvider,
      routing_efficiency_score: efficiencyScore,
      provider_performance_trend: providerPerformanceTrend,
      optimal_routing_recommendations: recommendations,
    };
  }

  /**
   * Detect anomalies in metrics
   */
  detectAnomalies(db: Database.Database): AnomalyDetection[] {
    const anomalies: AnomalyDetection[] = [];
    const metrics = ['workflow_duration', 'task_latency', 'llm_cost', 'provider_latency'];

    for (const metric of metrics) {
      const trend = this.getPerformanceTrend(db, metric, 'hour');
      const anomaly = this.detectAnomalyInSeries(trend.data);
      if (anomaly) {
        anomalies.push(anomaly);
      }
    }

    return anomalies;
  }

  /**
   * Get capacity planning insights
   */
  getCapacityPlanning(db: Database.Database): CapacityPlanning {
    const currentUtilization = this.calculateCurrentCapacityUtilization(db);
    const projected7d = this.projectCapacityUtilization(db, 7);
    const projected30d = this.projectCapacityUtilization(db, 30);
    const recommendations = this.generateCapacityRecommendations(
      currentUtilization,
      projected7d,
      projected30d
    );

    return {
      current_capacity_utilization_pct: currentUtilization,
      projected_capacity_utilization_7d: projected7d,
      projected_capacity_utilization_30d: projected30d,
      recommended_actions: recommendations,
    };
  }

  /**
   * Generate insights and recommendations
   */
  generateInsights(db: Database.Database): Insight[] {
    const insights: Insight[] = [];

    // Cost insights
    const costAnalytics = this.getCostAnalytics(db);
    if (costAnalytics.cost_efficiency_score < 70) {
      insights.push({
        id: `cost-efficiency-${Date.now()}`,
        type: 'cost',
        severity: 'warning',
        title: 'Cost efficiency below target',
        description: `Current cost efficiency score is ${costAnalytics.cost_efficiency_score}/100`,
        timestamp: Date.now(),
        recommendation: 'Consider optimizing model selection or implementing caching to reduce costs',
        metrics: { cost_efficiency_score: costAnalytics.cost_efficiency_score },
      });
    }

    // Performance insights
    const workflowTrend = this.getPerformanceTrend(db, 'workflow_duration', 'day');
    if (workflowTrend.trend === 'degrading') {
      insights.push({
        id: `performance-degrading-${Date.now()}`,
        type: 'performance',
        severity: 'warning',
        title: 'Workflow performance degrading',
        description: `Workflow duration is increasing at ${Math.abs(workflowTrend.change_rate_pct)}% per period`,
        timestamp: Date.now(),
        recommendation: 'Review recent workflow executions for bottlenecks and consider optimization',
        metrics: { change_rate_pct: workflowTrend.change_rate_pct },
      });
    }

    // Reliability insights
    const routingAnalytics = this.getRoutingAnalytics(db);
    if (routingAnalytics.routing_efficiency_score < 80) {
      insights.push({
        id: `routing-efficiency-${Date.now()}`,
        type: 'reliability',
        severity: 'warning',
        title: 'Routing efficiency below target',
        description: `Current routing efficiency score is ${routingAnalytics.routing_efficiency_score}/100`,
        timestamp: Date.now(),
        recommendation: 'Review provider health and consider adjusting routing weights',
        metrics: { routing_efficiency_score: routingAnalytics.routing_efficiency_score },
      });
    }

    // Capacity insights
    const capacity = this.getCapacityPlanning(db);
    if (capacity.projected_capacity_utilization_30d > 80) {
      insights.push({
        id: `capacity-warning-${Date.now()}`,
        type: 'capacity',
        severity: 'critical',
        title: 'Capacity approaching limits',
        description: `Projected capacity utilization in 30 days: ${capacity.projected_capacity_utilization_30d}%`,
        timestamp: Date.now(),
        recommendation: 'Consider scaling infrastructure or optimizing resource usage',
        metrics: {
          current_utilization_pct: capacity.current_capacity_utilization_pct,
          projected_30d_pct: capacity.projected_capacity_utilization_30d,
        },
      });
    }

    // Anomaly insights
    const anomalies = this.detectAnomalies(db);
    for (const anomaly of anomalies) {
      if (anomaly.severity === 'high') {
        insights.push({
          id: `anomaly-${anomaly.metric}-${Date.now()}`,
          type: 'performance',
          severity: 'critical',
          title: `Anomaly detected in ${anomaly.metric}`,
          description: anomaly.description,
          timestamp: anomaly.timestamp,
          recommendation: 'Investigate the anomaly and determine if action is required',
          metrics: {
            value: anomaly.value,
            expected_value: anomaly.expected_value,
            deviation_pct: anomaly.deviation_pct,
          },
        });
      }
    }

    return insights.sort((a, b) => {
      const severityOrder = { critical: 0, warning: 1, info: 2 };
      return severityOrder[a.severity] - severityOrder[b.severity];
    });
  }

  // Private helper methods

  private fetchTimeSeriesData(
    db: Database.Database,
    metric: string,
    start: number,
    end: number,
    period: 'hour' | 'day' | 'week' | 'month'
  ): TimeSeriesDataPoint[] {
    // This is a simplified implementation
    // In production, this would query appropriate tables based on the metric
    const queryDef = METRIC_QUERIES[metric];
    if (!queryDef) return [];

    try {
      // Check if the table exists
      const tableExists = (tableName: string) => {
        try {
          db.prepare(`SELECT 1 FROM ${tableName} LIMIT 1`).get();
          return true;
        } catch {
          return false;
        }
      };

      if (!tableExists(queryDef.table)) return [];

      const params: number[] = [start, end];
      const rows = db.prepare(queryDef.sql).all(...params) as Array<{ timestamp: number; value: number }>;

      return this.aggregateByPeriod(rows, period);
    } catch (err) {
      // A SQL/query error is indistinguishable from "no data" here - return empty on error.
      return [];
    }
  }

  /**
   * Bucket time-series rows by period and average the values within each bucket.
   */
  private aggregateByPeriod(
    rows: Array<{ timestamp: number; value: number }>,
    period: 'hour' | 'day' | 'week' | 'month'
  ): TimeSeriesDataPoint[] {
    const periodMs = {
      hour: 60 * 60 * 1000,
      day: 24 * 60 * 60 * 1000,
      week: 7 * 24 * 60 * 60 * 1000,
      month: 30 * 24 * 60 * 60 * 1000,
    }[period];

    const aggregated = new Map<number, number[]>();

    for (const row of rows) {
      const bucket = Math.floor(row.timestamp / periodMs) * periodMs;
      if (!aggregated.has(bucket)) {
        aggregated.set(bucket, []);
      }
      aggregated.get(bucket)!.push(row.value);
    }

    const data: TimeSeriesDataPoint[] = [];
    for (const [timestamp, values] of aggregated.entries()) {
      const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
      data.push({ timestamp, value: avg });
    }

    return data;
  }

  private calculateTrendDirection(data: TimeSeriesDataPoint[]): 'improving' | 'degrading' | 'stable' {
    if (data.length < 2) return 'stable';

    const firstHalf = data.slice(0, Math.floor(data.length / 2));
    const secondHalf = data.slice(Math.floor(data.length / 2));

    const firstAvg = firstHalf.reduce((sum, d) => sum + d.value, 0) / firstHalf.length;
    const secondAvg = secondHalf.reduce((sum, d) => sum + d.value, 0) / secondHalf.length;

    const change = ((secondAvg - firstAvg) / firstAvg) * 100;

    if (Math.abs(change) < 5) return 'stable';
    return change < 0 ? 'improving' : 'degrading';
  }

  private calculateChangeRate(data: TimeSeriesDataPoint[]): number {
    if (data.length < 2) return 0;

    const first = data[0].value;
    const last = data[data.length - 1].value;

    return ((last - first) / first) * 100;
  }

  private percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const index = Math.ceil((p / 100) * values.length) - 1;
    return values[Math.max(0, Math.min(index, values.length - 1))];
  }

  private calculateTotalCost(db: Database.Database): number {
    try {
      const result = db.prepare(
        "SELECT SUM(cost_usd) as total FROM events WHERE type = 'llm_call'"
      ).get() as { total: number | null };
      return result.total || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Reduce rows carrying a nullable `model` column into a Record<string, number>,
   * using 'unknown' as the fallback key. Shared by the by-model/by-provider aggregations below.
   */
  private rowsToRecordByModel<R extends { model: string }>(rows: R[], valueFn: (row: R) => number): Record<string, number> {
    return rows.reduce((acc, row) => {
      acc[row.model || 'unknown'] = valueFn(row);
      return acc;
    }, {} as Record<string, number>);
  }

  private calculateCostByModel(db: Database.Database): Record<string, number> {
    try {
      const rows = db.prepare(`
        SELECT model, SUM(cost_usd) as total
        FROM events
        WHERE type = 'llm_call'
        GROUP BY model
      `).all() as Array<{ model: string; total: number }>;

      return this.rowsToRecordByModel(rows, row => row.total);
    } catch {
      return {};
    }
  }

  private calculateCostByWorkflow(db: Database.Database): Array<{ workflow_id: string; cost_usd: number; task_count: number }> {
    try {
      const rows = db.prepare(`
        SELECT w.id as workflow_id,
               COALESCE(SUM(e.cost_usd), 0) as cost_usd,
               COUNT(DISTINCT t.id) as task_count
        FROM workflows w
        LEFT JOIN tasks t ON t.workflow_id = w.id
        LEFT JOIN events e ON e.workflow_id = w.id AND e.type = 'llm_call'
        GROUP BY w.id
        ORDER BY cost_usd DESC
        LIMIT 20
      `).all() as Array<{ workflow_id: string; cost_usd: number; task_count: number }>;

      return rows;
    } catch {
      return [];
    }
  }

  private fetchCostTrend(db: Database.Database): TimeSeriesDataPoint[] {
    return this.fetchTimeSeriesData(db, 'llm_cost', Date.now() - this.config.trendWindowMs, Date.now(), 'day');
  }

  private calculateAvgCostPerTask(db: Database.Database): number {
    try {
      const result = db.prepare(`
        SELECT AVG(e.cost_usd) as avg_cost
        FROM events e
        JOIN tasks t ON t.id = e.task_id
        WHERE e.type = 'llm_call'
      `).get() as { avg_cost: number | null };
      return result.avg_cost || 0;
    } catch {
      return 0;
    }
  }

  private calculateAvgCostPerWorkflow(db: Database.Database): number {
    try {
      const result = db.prepare(`
        SELECT AVG(cost_sum) as avg_cost
        FROM (
          SELECT SUM(cost_usd) as cost_sum
          FROM events
          WHERE type = 'llm_call' AND workflow_id IS NOT NULL
          GROUP BY workflow_id
        )
      `).get() as { avg_cost: number | null };
      return result.avg_cost || 0;
    } catch {
      return 0;
    }
  }

  private calculateCostEfficiencyScore(db: Database.Database): number {
    // Simplified efficiency score based on cache hit rate and cost per task
    try {
      const cacheHitRate = this.getCacheHitRate(db);
      const avgCostPerTask = this.calculateAvgCostPerTask(db);

      // Normalize: higher cache hit rate = better, lower cost = better
      const cacheScore = cacheHitRate;
      const costScore = Math.max(0, 100 - (avgCostPerTask * 1000)); // Arbitrary scaling

      return Math.round((cacheScore * 0.6 + costScore * 0.4) * 100) / 100;
    } catch {
      return 50; // Default score
    }
  }

  private getCacheHitRate(db: Database.Database): number {
    return calculateCacheHitRatePct(db) ?? 0;
  }

  private calculateTotalRequests(db: Database.Database): number {
    try {
      const result = db.prepare("SELECT COUNT(*) as total FROM events WHERE type = 'llm_call'").get() as { total: number };
      return result.total;
    } catch {
      return 0;
    }
  }

  private calculateRequestsByProvider(db: Database.Database): Record<string, number> {
    try {
      const rows = db.prepare(`
        SELECT model, COUNT(*) as total
        FROM events
        WHERE type = 'llm_call'
        GROUP BY model
      `).all() as Array<{ model: string; total: number }>;

      return this.rowsToRecordByModel(rows, row => row.total);
    } catch {
      return {};
    }
  }

  private calculateSuccessRateByProvider(db: Database.Database): Record<string, number> {
    try {
      const rows = db.prepare(`
        SELECT model,
               SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) as success,
               COUNT(*) as total
        FROM events
        WHERE type = 'llm_call'
        GROUP BY model
      `).all() as Array<{ model: string; success: number; total: number }>;

      return this.rowsToRecordByModel(rows, row => (row.success / row.total) * 100);
    } catch {
      return {};
    }
  }

  private calculateAvgLatencyByProvider(db: Database.Database): Record<string, number> {
    try {
      const rows = db.prepare(`
        SELECT model, AVG(duration_ms) as avg_latency
        FROM trace_spans
        WHERE kind = 'llm_call'
          AND duration_ms IS NOT NULL
        GROUP BY model
      `).all() as Array<{ model: string; avg_latency: number }>;

      return this.rowsToRecordByModel(rows, row => row.avg_latency);
    } catch {
      return {};
    }
  }

  private calculateRoutingEfficiencyScore(successRateByProvider: Record<string, number>): number {
    try {
      const successRates = Object.values(successRateByProvider);
      if (successRates.length === 0) return 50;

      const avgSuccessRate = successRates.reduce((sum, r) => sum + r, 0) / successRates.length;
      return Math.round(avgSuccessRate);
    } catch {
      return 50;
    }
  }

  private calculateProviderPerformanceTrends(db: Database.Database, providers: string[]): Record<string, PerformanceTrend> {
    const trends: Record<string, PerformanceTrend> = {};

    for (const provider of providers) {
      trends[provider] = this.getPerformanceTrend(db, `provider_latency_${provider}`, 'day');
    }

    return trends;
  }

  private generateRoutingRecommendations(
    requestsByProvider: Record<string, number>,
    successRateByProvider: Record<string, number>,
    avgLatencyByProvider: Record<string, number>
  ): Array<{ provider: string; reason: string; expected_improvement_pct: number }> {
    const recommendations: Array<{ provider: string; reason: string; expected_improvement_pct: number }> = [];

    const providers = Object.keys(requestsByProvider);

    for (const provider of providers) {
      const successRate = successRateByProvider[provider] || 0;
      const latency = avgLatencyByProvider[provider] || 0;

      if (successRate < 90) {
        recommendations.push({
          provider,
          reason: `Low success rate (${successRate.toFixed(1)}%)`,
          expected_improvement_pct: 10,
        });
      }

      if (latency > 5000) {
        recommendations.push({
          provider,
          reason: `High latency (${latency}ms)`,
          expected_improvement_pct: 15,
        });
      }
    }

    return recommendations;
  }

  private detectAnomalyInSeries(data: TimeSeriesDataPoint[]): AnomalyDetection | null {
    if (data.length < 10) return null;

    const values = data.map(d => d.value);
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
    const stdDev = Math.sqrt(variance);

    const lastPoint = data[data.length - 1];
    const zScore = Math.abs((lastPoint.value - mean) / stdDev);

    if (zScore > this.config.anomalyThreshold) {
      const deviation = ((lastPoint.value - mean) / mean) * 100;
      const severity = zScore > 4 ? 'high' : (zScore > 3 ? 'medium' : 'low');

      return {
        metric: 'unknown',
        timestamp: lastPoint.timestamp,
        value: lastPoint.value,
        expected_value: mean,
        deviation_pct: Math.round(deviation * 100) / 100,
        severity,
        description: `Value ${lastPoint.value.toFixed(2)} deviates by ${deviation.toFixed(1)}% from expected ${mean.toFixed(2)}`,
      };
    }

    return null;
  }

  private calculateCurrentCapacityUtilization(db: Database.Database): number {
    // Simplified: based on active workflows
    try {
      const active = db.prepare("SELECT COUNT(*) as count FROM workflows WHERE status = 'running'").get() as { count: number } | undefined;
      const total = db.prepare("SELECT COUNT(*) as count FROM workflows").get() as { count: number } | undefined;

      if (!total || total.count === 0) return 0;
      if (!active) return 0;
      return (active.count / total.count) * 100;
    } catch {
      return 0;
    }
  }

  private projectCapacityUtilization(db: Database.Database, days: number): number {
    const current = this.calculateCurrentCapacityUtilization(db);
    const trend = this.getPerformanceTrend(db, 'workflow_count', 'day');

    // Simple linear projection
    const growthRate = trend.change_rate_pct / 100;
    const projected = current * (1 + growthRate * days);

    return Math.min(100, Math.max(0, projected));
  }

  private generateCapacityRecommendations(
    current: number,
    projected7d: number,
    projected30d: number
  ): Array<{ action: string; priority: 'low' | 'medium' | 'high'; estimated_impact: string }> {
    const recommendations: Array<{ action: string; priority: 'low' | 'medium' | 'high'; estimated_impact: string }> = [];

    if (projected30d > 80) {
      recommendations.push({
        action: 'Scale infrastructure',
        priority: 'high',
        estimated_impact: 'Increase capacity by 20-30%',
      });
    }

    if (projected7d > 70) {
      recommendations.push({
        action: 'Optimize resource usage',
        priority: 'medium',
        estimated_impact: 'Reduce utilization by 10-15%',
      });
    }

    if (current > 50) {
      recommendations.push({
        action: 'Monitor capacity trends',
        priority: 'low',
        estimated_impact: 'Early warning system',
      });
    }

    return recommendations;
  }

  public updateConfig(config: Partial<AnalyticsConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

/**
 * Global analytics engine instance
 */
export const analyticsEngine = new AnalyticsEngine();

/**
 * Cache hit rate (0-100) computed from trace_spans rows with kind='llm_call'.
 * Returns null when there is no LLM span data to compute a rate from (missing table or zero rows).
 * Shared by AnalyticsEngine.getCacheHitRate and getLLMUsageMetrics (monitoring-dashboard.ts) so the
 * two call sites don't drift; each caller decides how to round/default the result for its own shape.
 */
export function calculateCacheHitRatePct(db: Database.Database): number | null {
  try {
    const spans = db.prepare("SELECT attributes_json FROM trace_spans WHERE kind = 'llm_call'").all() as Array<{ attributes_json: string | null }>;
    let cacheHits = 0;
    let total = 0;

    for (const span of spans) {
      if (!span.attributes_json) continue;
      try {
        const attrs = JSON.parse(span.attributes_json) as { cache_read_input_tokens?: number };
        total++;
        if (attrs.cache_read_input_tokens && attrs.cache_read_input_tokens > 0) {
          cacheHits++;
        }
      } catch {
        // Skip malformed attributes
      }
    }

    return total > 0 ? (cacheHits / total) * 100 : null;
  } catch {
    // trace_spans might not exist yet
    return null;
  }
}

/**
 * Get performance trend for a metric
 */
export function getPerformanceTrend(
  metric: string,
  period: 'hour' | 'day' | 'week' | 'month' = 'day'
): PerformanceTrend {
  const db = initDb(getDbPath());
  try {
    return analyticsEngine.getPerformanceTrend(db, metric, period);
  } finally {
    db.close();
  }
}

/**
 * Get cost analytics
 */
export function getCostAnalytics(): CostAnalytics {
  const db = initDb(getDbPath());
  try {
    return analyticsEngine.getCostAnalytics(db);
  } finally {
    db.close();
  }
}

/**
 * Get routing analytics
 */
export function getRoutingAnalytics(): RoutingAnalytics {
  const db = initDb(getDbPath());
  try {
    return analyticsEngine.getRoutingAnalytics(db);
  } finally {
    db.close();
  }
}

/**
 * Detect anomalies
 */
export function detectAnomalies(): AnomalyDetection[] {
  const db = initDb(getDbPath());
  try {
    return analyticsEngine.detectAnomalies(db);
  } finally {
    db.close();
  }
}

/**
 * Get capacity planning insights
 */
export function getCapacityPlanning(): CapacityPlanning {
  const db = initDb(getDbPath());
  try {
    return analyticsEngine.getCapacityPlanning(db);
  } finally {
    db.close();
  }
}

/**
 * Generate insights and recommendations
 */
export function generateInsights(): Insight[] {
  const db = initDb(getDbPath());
  try {
    return analyticsEngine.generateInsights(db);
  } finally {
    db.close();
  }
}

/**
 * Get comprehensive analytics report
 */
export interface AnalyticsReport {
  timestamp: number;
  performance_trends: Record<string, PerformanceTrend>;
  cost_analytics: CostAnalytics;
  routing_analytics: RoutingAnalytics;
  anomalies: AnomalyDetection[];
  capacity_planning: CapacityPlanning;
  insights: Insight[];
}

export function getAnalyticsReport(): AnalyticsReport {
  const db = initDb(getDbPath());
  try {
    return {
      timestamp: Date.now(),
      performance_trends: {
        workflow_duration: analyticsEngine.getPerformanceTrend(db, 'workflow_duration', 'day'),
        task_latency: analyticsEngine.getPerformanceTrend(db, 'task_latency', 'day'),
        llm_cost: analyticsEngine.getPerformanceTrend(db, 'llm_cost', 'day'),
      },
      cost_analytics: analyticsEngine.getCostAnalytics(db),
      routing_analytics: analyticsEngine.getRoutingAnalytics(db),
      anomalies: analyticsEngine.detectAnomalies(db),
      capacity_planning: analyticsEngine.getCapacityPlanning(db),
      insights: analyticsEngine.generateInsights(db),
    };
  } finally {
    db.close();
  }
}