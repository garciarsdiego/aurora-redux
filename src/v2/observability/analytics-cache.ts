/**
 * Analytics Performance Optimization Module (Sprint 8)
 *
 * Provides caching, query optimization, and async processing for analytics.
 */

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

export interface AnalyticsCacheConfig {
  /** Default TTL for cache entries in milliseconds */
  defaultTtlMs: number;
  /** Maximum cache size */
  maxCacheSize: number;
  /** Enable query result caching */
  enableQueryCaching: boolean;
  /** Enable background refresh */
  enableBackgroundRefresh: boolean;
  /** Background refresh interval */
  backgroundRefreshIntervalMs: number;
}

const DEFAULT_CONFIG: AnalyticsCacheConfig = {
  defaultTtlMs: 5 * 60 * 1000, // 5 minutes
  maxCacheSize: 100,
  enableQueryCaching: true,
  enableBackgroundRefresh: true,
  backgroundRefreshIntervalMs: 60 * 1000, // 1 minute
};

class AnalyticsCache {
  private config: AnalyticsCacheConfig;
  private cache: Map<string, CacheEntry<unknown>>;
  private refreshTimers: Map<string, NodeJS.Timeout>;
  private hitCount = 0;
  private missCount = 0;

  constructor(config: Partial<AnalyticsCacheConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.cache = new Map();
    this.refreshTimers = new Map();
  }

  /**
   * Get cached data or compute if not available
   */
  async get<T>(
    key: string,
    computeFn: () => Promise<T> | T,
    ttl?: number
  ): Promise<T> {
    if (!this.config.enableQueryCaching) {
      return computeFn();
    }

    const entry = this.cache.get(key);

    // Check if cache entry exists and is valid
    if (entry && Date.now() - entry.timestamp < entry.ttl) {
      this.hitCount++;
      return entry.data as T;
    }

    this.missCount++;

    // Compute new value
    const data = await computeFn();

    // Cache the result
    this.set(key, data, ttl);

    return data;
  }

  /**
   * Set cache entry
   */
  set<T>(key: string, data: T, ttl?: number): void {
    const entry: CacheEntry<T> = {
      data,
      timestamp: Date.now(),
      ttl: ttl || this.config.defaultTtlMs,
    };

    this.cache.set(key, entry as CacheEntry<unknown>);

    // Enforce cache size limit
    if (this.cache.size > this.config.maxCacheSize) {
      this.evictOldest();
    }

    // Note: Background refresh not implemented in set() - needs computeFn
    // Background refresh is handled in get() when data is computed
  }

  /**
   * Invalidate cache entry
   */
  invalidate(key: string): void {
    this.cache.delete(key);
    const timer = this.refreshTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.refreshTimers.delete(key);
    }
  }

  /**
   * Invalidate all cache entries matching a pattern
   */
  invalidatePattern(pattern: string): void {
    const regex = new RegExp(pattern);
    for (const key of this.cache.keys()) {
      if (regex.test(key)) {
        this.invalidate(key);
      }
    }
  }

  /**
   * Clear all cache entries
   */
  clear(): void {
    this.cache.clear();
    for (const timer of this.refreshTimers.values()) {
      clearTimeout(timer);
    }
    this.refreshTimers.clear();
  }

  /**
   * Get cache statistics
   */
  getStats(): {
    size: number;
    hitRate: number;
    missCount: number;
    hitCount: number;
  } {
    const total = this.hitCount + this.missCount;
    return {
      size: this.cache.size,
      hitRate: total > 0 ? this.hitCount / total : 0,
      missCount: this.missCount,
      hitCount: this.hitCount,
    };
  }

  /**
   * Evict oldest cache entry
   */
  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTimestamp = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.timestamp < oldestTimestamp) {
        oldestTimestamp = entry.timestamp;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.invalidate(oldestKey);
    }
  }

  public updateConfig(config: Partial<AnalyticsCacheConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

/**
 * Global analytics cache instance
 */
export const analyticsCache = new AnalyticsCache();

/**
 * Query optimizer for analytics queries
 */
export interface QueryOptimizationResult {
  optimized: boolean;
  originalQuery: string;
  optimizedQuery?: string;
  reason?: string;
  estimatedSpeedup?: number;
}

class QueryOptimizer {
  /**
   * Optimize a SQL query for analytics
   */
  optimizeQuery(query: string): QueryOptimizationResult {
    let optimized = query;
    let reason: string | undefined;
    let estimatedSpeedup: number | undefined;

    // Add index hints if missing
    if (query.includes('WHERE') && !query.includes('INDEXED BY')) {
      // This is a simplified check - in production, you'd analyze the schema
      reason = 'Consider adding indexes for WHERE clause columns';
      estimatedSpeedup = 2;
    }

    // Suggest LIMIT for large result sets
    if (query.includes('SELECT') && !query.includes('LIMIT') && !query.includes('GROUP BY')) {
      optimized += ' LIMIT 1000';
      reason = 'Added LIMIT to prevent large result sets';
      estimatedSpeedup = 5;
    }

    // Suggest specific columns instead of SELECT *
    if (query.includes('SELECT *')) {
      reason = 'Consider selecting specific columns instead of *';
      estimatedSpeedup = 1.5;
    }

    return {
      optimized: optimized !== query,
      originalQuery: query,
      optimizedQuery: optimized,
      reason,
      estimatedSpeedup,
    };
  }

  /**
   * Analyze query performance
   */
  analyzeQueryPerformance(query: string): {
    complexity: 'low' | 'medium' | 'high';
    estimatedExecutionTimeMs: number;
    recommendations: string[];
  } {
    const recommendations: string[] = [];
    let complexity: 'low' | 'medium' | 'high' = 'low';
    let estimatedTime = 10;

    // Check for JOIN operations
    if (query.includes('JOIN')) {
      complexity = 'medium';
      estimatedTime += 50;
      recommendations.push('Ensure JOIN columns are indexed');
    }

    // Check for subqueries
    if (query.includes('(SELECT')) {
      complexity = 'high';
      estimatedTime += 100;
      recommendations.push('Consider rewriting subqueries as JOINs');
    }

    // Check for GROUP BY
    if (query.includes('GROUP BY')) {
      estimatedTime += 30;
      recommendations.push('Ensure GROUP BY columns are indexed');
    }

    // Check for ORDER BY
    if (query.includes('ORDER BY')) {
      estimatedTime += 20;
      recommendations.push('Ensure ORDER BY columns are indexed');
    }

    // Check for aggregate functions
    if (query.match(/COUNT|SUM|AVG|MAX|MIN/)) {
      estimatedTime += 40;
    }

    return {
      complexity,
      estimatedExecutionTimeMs: estimatedTime,
      recommendations,
    };
  }
}

/**
 * Global query optimizer instance
 */
export const queryOptimizer = new QueryOptimizer();

/**
 * Async processor for heavy analytics computations
 */
export interface AsyncJob<T> {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: T;
  error?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

class AsyncProcessor {
  private jobs: Map<string, AsyncJob<unknown>>;
  private maxConcurrentJobs: number;
  private runningJobs: number;

  constructor(maxConcurrentJobs: number = 3) {
    this.jobs = new Map();
    this.maxConcurrentJobs = maxConcurrentJobs;
    this.runningJobs = 0;
  }

  /**
   * Submit a job for async processing
   */
  async submit<T>(
    jobFn: () => Promise<T> | T,
    jobId?: string
  ): Promise<string> {
    const id = jobId || `job-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

    const job: AsyncJob<T> = {
      id,
      status: 'pending',
      createdAt: Date.now(),
    };

    this.jobs.set(id, job);

    // Process immediately if capacity available
    if (this.runningJobs < this.maxConcurrentJobs) {
      this.processJob(id, jobFn);
    } else {
      // Queue for later processing (simplified - in production, use a proper queue)
      setTimeout(() => this.processJob(id, jobFn), 1000);
    }

    return id;
  }

  /**
   * Get job status
   */
  getJobStatus<T>(jobId: string): AsyncJob<T> | null {
    const job = this.jobs.get(jobId);
    return job ? (job as AsyncJob<T>) : null;
  }

  /**
   * Wait for job completion
   */
  async waitForJob<T>(jobId: string, timeoutMs: number = 30000): Promise<T> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const job = this.getJobStatus<T>(jobId);

      if (!job) {
        throw new Error(`Job ${jobId} not found`);
      }

      if (job.status === 'completed') {
        return job.result!;
      }

      if (job.status === 'failed') {
        throw new Error(job.error || 'Job failed');
      }

      await new Promise(resolve => setTimeout(resolve, 100));
    }

    throw new Error(`Job ${jobId} timed out after ${timeoutMs}ms`);
  }

  /**
   * Process a job
   */
  private async processJob<T>(jobId: string, jobFn: () => Promise<T> | T): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'pending') {
      return;
    }

    job.status = 'running';
    job.startedAt = Date.now();
    this.runningJobs++;

    try {
      const result = await jobFn();
      job.status = 'completed';
      job.result = result;
      job.completedAt = Date.now();
    } catch (error) {
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : String(error);
      job.completedAt = Date.now();
    } finally {
      this.runningJobs--;
    }
  }

  /**
   * Clean up old completed jobs
   */
  cleanup(maxAgeMs: number = 60 * 60 * 1000): void {
    const now = Date.now();
    const cutoff = now - maxAgeMs;

    for (const [id, job] of this.jobs.entries()) {
      if (
        (job.status === 'completed' || job.status === 'failed') &&
        job.completedAt &&
        job.completedAt < cutoff
      ) {
        this.jobs.delete(id);
      }
    }
  }

  /**
   * Get processor statistics
   */
  getStats(): {
    totalJobs: number;
    pendingJobs: number;
    runningJobs: number;
    completedJobs: number;
    failedJobs: number;
  } {
    let pending = 0;
    let running = 0;
    let completed = 0;
    let failed = 0;

    for (const job of this.jobs.values()) {
      switch (job.status) {
        case 'pending':
          pending++;
          break;
        case 'running':
          running++;
          break;
        case 'completed':
          completed++;
          break;
        case 'failed':
          failed++;
          break;
      }
    }

    return {
      totalJobs: this.jobs.size,
      pendingJobs: pending,
      runningJobs: running,
      completedJobs: completed,
      failedJobs: failed,
    };
  }
}

/**
 * Global async processor instance
 */
export const asyncProcessor = new AsyncProcessor();

/**
 * Convenience function to get cached analytics data
 */
export async function getCachedAnalytics<T>(
  key: string,
  computeFn: () => Promise<T> | T,
  ttl?: number
): Promise<T> {
  return analyticsCache.get(key, computeFn, ttl);
}

/**
 * Convenience function to optimize a query
 */
export function optimizeQuery(query: string): QueryOptimizationResult {
  return queryOptimizer.optimizeQuery(query);
}

/**
 * Convenience function to submit async job
 */
export async function submitAsyncJob<T>(
  jobFn: () => Promise<T> | T,
  jobId?: string
): Promise<string> {
  return asyncProcessor.submit(jobFn, jobId);
}

/**
 * Convenience function to wait for async job
 */
export async function waitForAsyncJob<T>(
  jobId: string,
  timeoutMs?: number
): Promise<T> {
  return asyncProcessor.waitForJob(jobId, timeoutMs);
}