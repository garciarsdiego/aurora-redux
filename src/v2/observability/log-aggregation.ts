/**
 * Log Aggregation Module (Sprint 0)
 *
 * Lightweight log aggregation system for development environment.
 * Uses pino for structured logging with export capabilities.
 */

import pino from 'pino';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface LogEntry {
  timestamp: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  context?: string;
  workflowId?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
}

export interface LogQuery {
  level?: LogEntry['level'];
  context?: string;
  workflowId?: string;
  taskId?: string;
  since?: number; // timestamp
  until?: number; // timestamp
  limit?: number;
  search?: string; // full-text search
}

export interface LogExportFormat {
  json: LogEntry[];
  csv: string;
  syslog: string;
}

/**
 * Configure pino logger for structured logging
 */
export function createLogger(context: string = 'omniforge') {
  const logDir = path.join(process.cwd(), 'data', 'logs');

  // Ensure log directory exists
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }

  const logFile = path.join(logDir, `${context}.log`);

  const baseConfig = {
    level: process.env.LOG_LEVEL || 'info',
    formatters: {
      level: (label: string) => {
        return { level: label };
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    base: {
      context,
    },
  };

  // Try to create logger with pino-pretty transport
  let logger: pino.Logger;
  try {
    logger = pino(baseConfig, pino.transport({
      targets: [
        {
          target: 'pino/file',
          options: {
            destination: logFile,
            mkdir: true,
          },
        },
        {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        },
      ],
    }));
  } catch (err) {
    // pino-pretty not available, fall back to file + stdout
    console.warn('pino-pretty transport not available, falling back to file + stdout');
    logger = pino(baseConfig, pino.transport({
      targets: [
        {
          target: 'pino/file',
          options: {
            destination: logFile,
            mkdir: true,
          },
        },
        {
          target: 'pino/file',
          options: {
            destination: 1, // stdout
          },
        },
      ],
    }));
  }

  return logger;
}

/**
 * Global logger instance
 */
export const logger = createLogger('omniforge');

/**
 * Log aggregation store (in-memory for development)
 */
class LogAggregator {
  private logs: LogEntry[] = [];
  private maxLogs = 10000; // Prevent memory issues
  private logFile = path.join(process.cwd(), 'data', 'logs', 'aggregated.log');

  constructor() {
    this.loadFromFile();
  }

  /**
   * Add a log entry to the aggregator
   */
  addLog(entry: LogEntry): void {
    this.logs.push(entry);
    
    // Prevent memory overflow
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs);
    }

    // Persist to file
    this.appendToFile(entry);
  }

  /**
   * Query logs with filters
   */
  queryLogs(query: LogQuery = {}): LogEntry[] {
    let filtered = [...this.logs];

    // Filter by level
    if (query.level) {
      filtered = filtered.filter(log => log.level === query.level);
    }

    // Filter by context
    if (query.context) {
      filtered = filtered.filter(log => log.context === query.context);
    }

    // Filter by workflow ID
    if (query.workflowId) {
      filtered = filtered.filter(log => log.workflowId === query.workflowId);
    }

    // Filter by task ID
    if (query.taskId) {
      filtered = filtered.filter(log => log.taskId === query.taskId);
    }

    // Filter by time range
    if (query.since) {
      filtered = filtered.filter(log => log.timestamp >= query.since!);
    }
    if (query.until) {
      filtered = filtered.filter(log => log.timestamp <= query.until!);
    }

    // Full-text search
    if (query.search) {
      const searchLower = query.search.toLowerCase();
      filtered = filtered.filter(log => 
        log.message.toLowerCase().includes(searchLower) ||
        JSON.stringify(log.metadata || {}).toLowerCase().includes(searchLower)
      );
    }

    // Sort by timestamp (newest first)
    filtered.sort((a, b) => b.timestamp - a.timestamp);

    // Apply limit
    if (query.limit) {
      filtered = filtered.slice(0, query.limit);
    }

    return filtered;
  }

  /**
   * Get log statistics
   */
  getStatistics(): {
    total: number;
    byLevel: Record<string, number>;
    byContext: Record<string, number>;
    oldestTimestamp: number | null;
    newestTimestamp: number | null;
  } {
    const byLevel: Record<string, number> = {};
    const byContext: Record<string, number> = {};
    let oldestTimestamp: number | null = null;
    let newestTimestamp: number | null = null;

    for (const log of this.logs) {
      // Count by level
      byLevel[log.level] = (byLevel[log.level] || 0) + 1;

      // Count by context
      if (log.context) {
        byContext[log.context] = (byContext[log.context] || 0) + 1;
      }

      // Track timestamps
      if (oldestTimestamp === null || log.timestamp < oldestTimestamp) {
        oldestTimestamp = log.timestamp;
      }
      if (newestTimestamp === null || log.timestamp > newestTimestamp) {
        newestTimestamp = log.timestamp;
      }
    }

    return {
      total: this.logs.length,
      byLevel,
      byContext,
      oldestTimestamp,
      newestTimestamp,
    };
  }

  /**
   * Export logs in different formats
   */
  exportLogs(query: LogQuery = {}, format: 'json' | 'csv' | 'syslog' = 'json'): string {
    const logs = this.queryLogs(query);

    switch (format) {
      case 'json':
        return JSON.stringify(logs, null, 2);

      case 'csv':
        if (logs.length === 0) return '';
        const headers = ['timestamp', 'level', 'context', 'workflowId', 'taskId', 'message', 'metadata'];
        const rows = logs.map(log => [
          log.timestamp,
          log.level,
          log.context || '',
          log.workflowId || '',
          log.taskId || '',
          `"${log.message.replace(/"/g, '""')}"`,
          `"${JSON.stringify(log.metadata || {}).replace(/"/g, '""')}"`,
        ].join(','));
        return [headers.join(','), ...rows].join('\n');

      case 'syslog':
        return logs.map(log => {
          const priority = this.levelToSyslogPriority(log.level);
          const timestamp = new Date(log.timestamp).toISOString();
          const metadata = log.metadata ? JSON.stringify(log.metadata) : '';
          return `<${priority}>${timestamp} ${log.context || 'omniforge'}: ${log.message} ${metadata}`;
        }).join('\n');

      default:
        return JSON.stringify(logs, null, 2);
    }
  }

  /**
   * Clear old logs (retention policy)
   */
  clearOldLogs(retentionMs: number = 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - retentionMs;
    const beforeCount = this.logs.length;
    this.logs = this.logs.filter(log => log.timestamp > cutoff);
    const cleared = beforeCount - this.logs.length;
    
    if (cleared > 0) {
      this.saveToFile();
    }
    
    return cleared;
  }

  private levelToSyslogPriority(level: string): number {
    // Syslog priority: facility * 8 + severity
    // We use facility 1 (user-level messages)
    const facility = 1;
    const severity = {
      debug: 7,
      info: 6,
      warn: 4,
      error: 3,
    }[level] || 6;
    return facility * 8 + severity;
  }

  private appendToFile(entry: LogEntry): void {
    try {
      const logLine = JSON.stringify(entry) + '\n';
      appendFileSync(this.logFile, logLine);
    } catch (err) {
      // Silent failure - logging shouldn't break the application
      console.error('Failed to write to log file:', err);
    }
  }

  private loadFromFile(): void {
    try {
      if (!existsSync(this.logFile)) {
        return;
      }

      const content = readFileSync(this.logFile, 'utf-8');
      const lines = content.trim().split('\n').filter(line => line.trim());

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as LogEntry;
          this.logs.push(entry);
        } catch {
          // Skip malformed lines
        }
      }

      // Respect memory limit
      if (this.logs.length > this.maxLogs) {
        this.logs = this.logs.slice(-this.maxLogs);
      }
    } catch (err) {
      console.error('Failed to load logs from file:', err);
    }
  }

  private saveToFile(): void {
    try {
      const content = this.logs.map(log => JSON.stringify(log)).join('\n') + '\n';
      writeFileSync(this.logFile, content);
    } catch (err) {
      console.error('Failed to save logs to file:', err);
    }
  }
}

/**
 * Global log aggregator instance
 */
export const logAggregator = new LogAggregator();

/**
 * Convenience functions for logging with aggregation
 */
export function logDebug(message: string, metadata?: Record<string, unknown>, context?: string): void {
  const entry: LogEntry = {
    timestamp: Date.now(),
    level: 'debug',
    message,
    context,
    metadata,
  };
  logAggregator.addLog(entry);
  logger.debug(metadata || {}, message);
}

export function logInfo(message: string, metadata?: Record<string, unknown>, context?: string): void {
  const entry: LogEntry = {
    timestamp: Date.now(),
    level: 'info',
    message,
    context,
    metadata,
  };
  logAggregator.addLog(entry);
  logger.info(metadata || {}, message);
}

export function logWarn(message: string, metadata?: Record<string, unknown>, context?: string): void {
  const entry: LogEntry = {
    timestamp: Date.now(),
    level: 'warn',
    message,
    context,
    metadata,
  };
  logAggregator.addLog(entry);
  logger.warn(metadata || {}, message);
}

export function logError(message: string, metadata?: Record<string, unknown>, context?: string): void {
  const entry: LogEntry = {
    timestamp: Date.now(),
    level: 'error',
    message,
    context,
    metadata,
  };
  logAggregator.addLog(entry);
  logger.error(metadata || {}, message);
}