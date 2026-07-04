#!/usr/bin/env node

/**
 * Test Helpers for Omniforge Test Suite
 * Shared utilities for test execution, retry logic, output parsing, and metrics collection
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { execSync } = require('child_process');

/**
 * Retry configuration with exponential backoff
 */
const RETRY_CONFIG = {
  maxRetries: 3,
  baseDelayMs: 1000, // 1 second base delay
  maxDelayMs: 10000, // 10 second max delay
  backoffMultiplier: 2
};

/**
 * Execute command with retry logic and exponential backoff
 * @param {string} command - Command to execute
 * @param {Object} options - Execution options
 * @param {number} options.timeout - Timeout in milliseconds
 * @param {string} options.cwd - Working directory
 * @param {Object} options.env - Environment variables
 * @returns {Promise<Object>} Result object with output, duration, etc.
 */
export async function executeWithRetry(command, options = {}) {
  const { timeout = 120000, cwd = process.cwd(), env = process.env } = options;
  let lastError = null;
  
  for (let attempt = 0; attempt < RETRY_CONFIG.maxRetries; attempt++) {
    try {
      return await executeCommand(command, { timeout, cwd, env, attempt });
    } catch (error) {
      lastError = error;
      lastError.retryCount = attempt;
      
      // Don't retry on certain errors
      if (isNonRetryableError(error)) {
        throw error;
      }
      
      if (attempt < RETRY_CONFIG.maxRetries - 1) {
        const delay = calculateBackoffDelay(attempt);
        console.log(`   ⚠️ Retry ${attempt + 1}/${RETRY_CONFIG.maxRetries} after ${delay}ms delay`);
        await sleep(delay);
      }
    }
  }
  
  throw lastError;
}

/**
 * Execute a single command (internal) - uses execSync for simplicity
 */
function executeCommand(command, options) {
  const startTime = Date.now();
  
  try {
    const stdout = execSync(command, {
      cwd: options.cwd,
      env: options.env,
      encoding: 'utf-8',
      timeout: options.timeout,
      stdio: 'pipe'
    });
    
    const duration = Date.now() - startTime;
    
    return {
      stdout,
      stderr: '',
      exitCode: 0,
      duration,
      success: true,
      retryCount: options.attempt || 0
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorObj = new Error(error.message);
    errorObj.stdout = error.stdout;
    errorObj.stderr = error.stderr;
    errorObj.exitCode = error.status;
    errorObj.duration = duration;
    errorObj.retryCount = options.attempt || 0;
    throw errorObj;
  }
}

/**
 * Calculate exponential backoff delay
 */
function calculateBackoffDelay(attempt) {
  const delay = RETRY_CONFIG.baseDelayMs * Math.pow(RETRY_CONFIG.backoffMultiplier, attempt);
  return Math.min(delay, RETRY_CONFIG.maxDelayMs);
}

/**
 * Check if error is non-retryable
 */
function isNonRetryableError(error) {
  const nonRetryablePatterns = [
    /ENOENT/,
    /EACCES/,
    /invalid/i,
    /syntax/i,
    /authentication/i
  ];
  
  return nonRetryablePatterns.some(pattern => 
    pattern.test(error.message) || pattern.test(error.stderr || '')
  );
}

/**
 * Sleep utility
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Parse Omniforge output to extract structured information
 * @param {string} output - Raw output from Omniforge
 * @returns {Object} Parsed information
 */
export function parseOmniforgeOutput(output) {
  const result = {
    workflow_id: null,
    tasks_executed: null,
    duration_ms: null,
    model: null,
    provider: null,
    cost_usd: null,
    tokens_used: null,
    dag_structure: null,
    status: null,
    error: null
  };
  
  if (!output) return result;
  
  // Extract workflow ID (multiple patterns)
  const workflowPatterns = [
    /workflow[_\s-]?id[:\s]+['"]?(wf_[a-f0-9-]{36})['"]?/i,
    /ID:\s+(wf_[a-f0-9-]{36})/,
    /workflow[_\s-]?id[:\s]+['"]?([a-f0-9-]{8}-[a-f0-9-]{4}-[a-f0-9-]{4}-[a-f0-9-]{4}-[a-f0-9-]{12})['"]?/i,
    /ID:\s+([a-f0-9-]{8}-[a-f0-9-]{4}-[a-f0-9-]{4}-[a-f0-9-]{4}-[a-f0-9-]{12})/
  ];
  
  for (const pattern of workflowPatterns) {
    const match = output.match(pattern);
    if (match) {
      result.workflow_id = match[1];
      break;
    }
  }
  
  // Extract tasks count
  const tasksMatch = output.match(/tasks?:\s*(\d+)/i);
  if (tasksMatch) {
    result.tasks_executed = parseInt(tasksMatch[1]);
  }
  
  // Extract duration
  const durationPatterns = [
    /dura[cç][ãa]o?:\s*(\d+)ms/i,
    /duration:\s*(\d+)ms/i,
    /completed in\s*(\d+)ms/i
  ];
  
  for (const pattern of durationPatterns) {
    const match = output.match(pattern);
    if (match) {
      result.duration_ms = parseInt(match[1]);
      break;
    }
  }
  
  // Extract model/provider
  const modelMatch = output.match(/model[:\s]+([^\s\n]+)/i);
  if (modelMatch) {
    result.model = modelMatch[1].trim();
    const parts = result.model.split('/');
    if (parts.length > 1) {
      result.provider = parts[0];
    }
  }
  
  // Extract cost
  const costMatch = output.match(/cost[:\s]*\$?([\d.]+)/i);
  if (costMatch) {
    result.cost_usd = parseFloat(costMatch[1]);
  }
  
  // Extract tokens
  const tokensMatch = output.match(/tokens?:\s*(\d+)/i);
  if (tokensMatch) {
    result.tokens_used = parseInt(tokensMatch[1]);
  }
  
  // Extract DAG structure
  const dagMatch = output.match(/dag[:\s]+(\{.*\})/is);
  if (dagMatch) {
    try {
      result.dag_structure = JSON.parse(dagMatch[1]);
    } catch (e) {
      // Ignore parse errors
    }
  }
  
  // Detect status
  if (output.toLowerCase().includes('completed') || output.toLowerCase().includes('success')) {
    result.status = 'completed';
  } else if (output.toLowerCase().includes('failed') || output.toLowerCase().includes('error')) {
    result.status = 'failed';
  }
  
  // Extract error message
  const errorPatterns = [
    /error[:\s]+(.+?)(?:\n|$)/i,
    /failed[:\s]+(.+?)(?:\n|$)/i
  ];
  
  for (const pattern of errorPatterns) {
    const match = output.match(pattern);
    if (match) {
      result.error = match[1].trim();
      break;
    }
  }
  
  return result;
}

/**
 * Validate structured output
 * @param {Object} parsedOutput - Parsed output from parseOmniforgeOutput
 * @param {Object} requirements - Validation requirements
 * @returns {Object} Validation result
 */
export function validateStructuredOutput(parsedOutput, requirements = {}) {
  const {
    requireWorkflowId = true,
    requireTasksExecuted = false,
    requireDuration = false,
    requireModel = false
  } = requirements;
  
  const validation = {
    valid: true,
    errors: [],
    warnings: []
  };
  
  if (requireWorkflowId && !parsedOutput.workflow_id) {
    validation.valid = false;
    validation.errors.push('Workflow ID not found in output');
  }
  
  if (requireTasksExecuted && parsedOutput.tasks_executed === null) {
    validation.warnings.push('Tasks executed count not found');
  }
  
  if (requireDuration && parsedOutput.duration_ms === null) {
    validation.warnings.push('Duration not found in output');
  }
  
  if (requireModel && !parsedOutput.model) {
    validation.warnings.push('Model information not found');
  }
  
  return validation;
}

/**
 * Advanced metrics collector
 */
export class MetricsCollector {
  constructor() {
    this.metrics = {
      performance_by_task_type: {},
      cost_analysis: {},
      execution_time_distribution: {
        p50: null,
        p75: null,
        p90: null,
        p95: null,
        p99: null
      },
      success_rate_by_model: {},
      success_rate_by_provider: {},
      retry_statistics: {
        total_retries: 0,
        retries_by_test: {},
        successful_retries: 0,
        failed_retries: 0
      }
    };
  }
  
  /**
   * Record test execution
   */
  recordTestExecution(test, result) {
    const taskType = test.expected_type || 'unknown';
    const model = test.model || result.model || 'unknown';
    const provider = model.split('/')[0] || 'unknown';
    
    // Performance by task type
    if (!this.metrics.performance_by_task_type[taskType]) {
      this.metrics.performance_by_task_type[taskType] = {
        total_tests: 0,
        total_duration_ms: 0,
        avg_duration_ms: 0,
        success_count: 0,
        failure_count: 0
      };
    }
    
    const taskMetrics = this.metrics.performance_by_task_type[taskType];
    taskMetrics.total_tests++;
    taskMetrics.total_duration_ms += result.duration_ms || 0;
    taskMetrics.avg_duration_ms = taskMetrics.total_duration_ms / taskMetrics.total_tests;
    
    if (result.status === 'passed') {
      taskMetrics.success_count++;
    } else {
      taskMetrics.failure_count++;
    }
    
    // Cost analysis
    if (result.cost_usd !== null) {
      if (!this.metrics.cost_analysis[taskType]) {
        this.metrics.cost_analysis[taskType] = {
          total_cost_usd: 0,
          avg_cost_usd: 0,
          test_count: 0
        };
      }
      
      const costMetrics = this.metrics.cost_analysis[taskType];
      costMetrics.total_cost_usd += result.cost_usd;
      costMetrics.test_count++;
      costMetrics.avg_cost_usd = costMetrics.total_cost_usd / costMetrics.test_count;
    }
    
    // Success rate by model
    if (!this.metrics.success_rate_by_model[model]) {
      this.metrics.success_rate_by_model[model] = {
        total: 0,
        success: 0,
        failure: 0,
        success_rate: 0
      };
    }
    
    const modelMetrics = this.metrics.success_rate_by_model[model];
    modelMetrics.total++;
    if (result.status === 'passed') {
      modelMetrics.success++;
    } else {
      modelMetrics.failure++;
    }
    modelMetrics.success_rate = (modelMetrics.success / modelMetrics.total) * 100;
    
    // Success rate by provider
    if (!this.metrics.success_rate_by_provider[provider]) {
      this.metrics.success_rate_by_provider[provider] = {
        total: 0,
        success: 0,
        failure: 0,
        success_rate: 0
      };
    }
    
    const providerMetrics = this.metrics.success_rate_by_provider[provider];
    providerMetrics.total++;
    if (result.status === 'passed') {
      providerMetrics.success++;
    } else {
      providerMetrics.failure++;
    }
    providerMetrics.success_rate = (providerMetrics.success / providerMetrics.total) * 100;
    
    // Retry statistics
    if (result.retry_count > 0) {
      this.metrics.retry_statistics.total_retries += result.retry_count;
      this.metrics.retry_statistics.retries_by_test[test.id] = result.retry_count;
      
      if (result.status === 'passed') {
        this.metrics.retry_statistics.successful_retries++;
      } else {
        this.metrics.retry_statistics.failed_retries++;
      }
    }
  }
  
  /**
   * Calculate execution time percentiles
   */
  calculateTimePercentiles(durations) {
    if (durations.length === 0) return;
    
    const sorted = [...durations].sort((a, b) => a - b);
    
    const percentile = (p) => {
      const index = Math.ceil((p / 100) * sorted.length) - 1;
      return sorted[Math.max(0, index)];
    };
    
    this.metrics.execution_time_distribution.p50 = percentile(50);
    this.metrics.execution_time_distribution.p75 = percentile(75);
    this.metrics.execution_time_distribution.p90 = percentile(90);
    this.metrics.execution_time_distribution.p95 = percentile(95);
    this.metrics.execution_time_distribution.p99 = percentile(99);
  }
  
  /**
   * Get metrics summary
   */
  getSummary() {
    return {
      performance_by_task_type: this.metrics.performance_by_task_type,
      cost_analysis: this.metrics.cost_analysis,
      execution_time_distribution: this.metrics.execution_time_distribution,
      success_rate_by_model: this.metrics.success_rate_by_model,
      success_rate_by_provider: this.metrics.success_rate_by_provider,
      retry_statistics: this.metrics.retry_statistics
    };
  }
}

/**
 * Async test executor for long-running workflows
 */
export class AsyncTestExecutor {
  constructor(options = {}) {
    this.pollInterval = options.pollInterval || 5000; // 5 seconds
    this.maxPollTime = options.maxPollTime || 3600000; // 1 hour
    this.runningTests = new Map();
  }
  
  /**
   * Start async test
   */
  async startAsyncTest(command, options = {}) {
    const { cwd = process.cwd(), timeout = this.maxPollTime } = options;
    
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const testId = `async-${Date.now()}`;
      
      const child = spawn(command, {
        shell: true,
        cwd,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      
      // Store child process for monitoring
      this.runningTests.set(testId, {
        child,
        startTime,
        stdout: '',
        stderr: ''
      });
      
      child.stdout.on('data', (data) => {
        const testInfo = this.runningTests.get(testId);
        if (testInfo) {
          testInfo.stdout += data.toString();
        }
      });
      
      child.stderr.on('data', (data) => {
        const testInfo = this.runningTests.get(testId);
        if (testInfo) {
          testInfo.stderr += data.toString();
        }
      });
      
      child.on('exit', (code) => {
        const testInfo = this.runningTests.get(testId);
        if (testInfo) {
          this.runningTests.delete(testId);
          
          const duration = Date.now() - startTime;
          if (code === 0) {
            resolve({
              stdout: testInfo.stdout,
              stderr: testInfo.stderr,
              exitCode: code,
              duration,
              success: true
            });
          } else {
            reject(new Error(`Async test failed with exit code ${code}`));
          }
        }
      });
      
      child.on('error', (error) => {
        this.runningTests.delete(testId);
        reject(error);
      });
      
      // Unref to allow parent to exit
      child.unref();
      
      // Return test ID for monitoring
      resolve({ testId, pid: child.pid });
    });
  }
  
  /**
   * Poll async test status
   */
  async pollTestStatus(testId) {
    const testInfo = this.runningTests.get(testId);
    if (!testInfo) {
      return { status: 'not_found' };
    }
    
    const elapsed = Date.now() - testInfo.startTime;
    const parsed = parseOmniforgeOutput(testInfo.stdout);
    
    return {
      status: 'running',
      elapsed_ms: elapsed,
      parsed_output: parsed,
      has_output: testInfo.stdout.length > 0
    };
  }
  
  /**
   * Cancel running test
   */
  cancelTest(testId) {
    const testInfo = this.runningTests.get(testId);
    if (testInfo) {
      testInfo.child.kill('SIGTERM');
      this.runningTests.delete(testId);
      return true;
    }
    return false;
  }
  
  /**
   * Get all running tests
   */
  getRunningTests() {
    return Array.from(this.runningTests.entries()).map(([id, info]) => ({
      id,
      pid: info.child.pid,
      elapsed_ms: Date.now() - info.startTime
    }));
  }
}

/**
 * Truncate output to max length
 */
export function truncateOutput(output, maxLength = 2000) {
  if (!output) return null;
  if (output.length <= maxLength) return output;
  return output.substring(0, maxLength) + '...[truncated]';
}

/**
 * Get adaptive timeout based on complexity
 */
export function getAdaptiveTimeout(complexity, retryCount = 0) {
  const baseTimeout = 300000; // 5 minutes base
  const complexityMultiplier = {
    'baixa': 1,
    'media': 2,
    'alta': 4,
    'muito_alta': 8,
    'extrema': 12
  };
  
  const multiplier = complexityMultiplier[complexity] || 1;
  const retryMultiplier = 1 + (retryCount * 0.5);
  
  return baseTimeout * multiplier * retryMultiplier;
}

/**
 * Save results to file
 */
export function saveResults(results, resultsDir, filename) {
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }
  
  const filepath = path.join(resultsDir, filename);
  fs.writeFileSync(filepath, JSON.stringify(results, null, 2));
  return filepath;
}

/**
 * Generate timestamp for filenames
 */
export function generateTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}