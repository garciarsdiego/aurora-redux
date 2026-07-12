/**
 * Sistema de Monitoramento Básico para Omniforge
 *
 * Fornece funções para coletar métricas, verificar thresholds e gerar alerts.
 */

import { initDb } from '../db/client.js';
import { getDbPath, getDecomposerMetrics } from './config.js';
import { readDaemonHeartbeat } from '../db/daemon-heartbeat.js';
import { postTelegramMessage } from './telegram-notify.js';

export interface MonitoringSummary {
  timestamp: number;
  workflows: {
    active_count: number;
    active_by_status: Record<string, number>;
    recent_success_rate: number; // última hora
    recent_cost_usd: number; // última hora
  };
  tasks: {
    parallel_active: number;
    completed_last_hour: number;
    failed_last_hour: number;
  };
  models: {
    top_5: Array<{ model: string; count: number }>;
  };
  daemon_health: {
    status: 'healthy' | 'degraded' | 'unhealthy';
    heartbeat_age_ms: number | null;
  };
}

export interface MonitoringMetrics {
  timestamp: number;
  decomposer: {
    totalObjectives: number;
    acceptedSingleTask: number;
    rejectedForCombinedTasks: number;
    rejectedForOtherReasons: number;
    acceptanceRate: number;
    rejectionRate: number;
    avgTasksPerDecomposition: number;
    rejectionReasons: Record<string, number>;
  };
  executor: {
    tasks_completed: number;
    tasks_failed: number;
    avg_duration_ms: number | null;
  };
  reviewer: {
    approved: number;
    rejected: number;
    approval_rate: number;
  };
  performance: {
    avg_task_duration_ms: number | null;
    avg_workflow_duration_ms: number | null;
  };
}

export interface AlertConfig {
  success_rate_threshold: number; // percentual
  budget_usd?: number; // orçamento horário
  consecutive_failure_threshold: number;
  telegram_bot_token?: string;
  telegram_chat_id?: string;
}

export interface AlertResult {
  triggered: boolean;
  alerts: Array<{
    type: 'success_rate' | 'budget' | 'consecutive_failures';
    message: string;
    severity: 'warning' | 'critical';
    value: number;
    threshold: number;
  }>;
}

const DEFAULT_ALERT_CONFIG: AlertConfig = {
  success_rate_threshold: 70,
  consecutive_failure_threshold: 5,
};

/**
 * Coleta resumo de monitoramento dos workflows ativos e métricas recentes
 */
export function getMonitoringSummary(): MonitoringSummary {
  const db = initDb(getDbPath());
  try {
    const now = Date.now();
    const oneHourAgo = now - 3600000;

    // Workflows ativos por status — todos os statuses NÃO-terminais de
    // WorkflowStatus (types/index.ts). Os valores antigos ('running',
    // 'retrying') eram statuses de TASK e nunca casavam com linhas de
    // workflow, então workflows em execução real ficavam fora da contagem.
    const activeWorkflows = db.prepare(`
      SELECT status, COUNT(*) as count
      FROM workflows
      WHERE status IN ('pending', 'approved', 'executing', 'paused', 'awaiting_remediation')
      GROUP BY status
    `).all() as Array<{ status: string; count: number }>;

    const activeByStatus: Record<string, number> = {};
    let activeCount = 0;
    for (const row of activeWorkflows) {
      activeByStatus[row.status] = row.count;
      activeCount += row.count;
    }

    // Taxa de sucesso recente (última hora)
    const recentWorkflows = db.prepare(`
      SELECT status, COUNT(*) as count
      FROM workflows
      WHERE completed_at >= ?
      GROUP BY status
    `).all(oneHourAgo) as Array<{ status: string; count: number }>;

    let recentCompleted = 0;
    let recentFailed = 0;
    for (const row of recentWorkflows) {
      if (row.status === 'completed') recentCompleted += row.count;
      if (row.status === 'failed') recentFailed += row.count;
    }

    const recentTotal = recentCompleted + recentFailed;
    const recentSuccessRate = recentTotal > 0 ? (recentCompleted / recentTotal) * 100 : 100;

    // Custo acumulado recente (última hora)
    const recentCost = db.prepare(`
      SELECT COALESCE(SUM(actual_cost_usd), 0) as total_cost
      FROM workflows
      WHERE completed_at >= ?
    `).get(oneHourAgo) as { total_cost: number };

    // Tasks paralelas ativas
    const parallelActive = db.prepare(`
      SELECT COUNT(*) as count
      FROM tasks
      WHERE status = 'running'
    `).get() as { count: number };

    // Tasks completadas e falhadas na última hora
    const tasksCompleted = db.prepare(`
      SELECT COUNT(*) as count
      FROM tasks
      WHERE status = 'completed' AND completed_at >= ?
    `).get(oneHourAgo) as { count: number };

    const tasksFailed = db.prepare(`
      SELECT COUNT(*) as count
      FROM tasks
      WHERE status = 'failed' AND completed_at >= ?
    `).get(oneHourAgo) as { count: number };

    // Modelos mais usados (top 5)
    const topModels = db.prepare(`
      SELECT model, COUNT(*) as count
      FROM tasks
      WHERE model IS NOT NULL AND model != ''
      GROUP BY model
      ORDER BY count DESC
      LIMIT 5
    `).all() as Array<{ model: string; count: number }>;

    // Health status do daemon
    const heartbeat = readDaemonHeartbeat(db);
    let daemonStatus: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    if (heartbeat) {
      if (heartbeat.age_ms > 30000) daemonStatus = 'unhealthy';
      else if (heartbeat.age_ms > 15000) daemonStatus = 'degraded';
    }

    return {
      timestamp: now,
      workflows: {
        active_count: activeCount,
        active_by_status: activeByStatus,
        recent_success_rate: Math.round(recentSuccessRate * 100) / 100,
        recent_cost_usd: Math.round(recentCost.total_cost * 10000) / 10000,
      },
      tasks: {
        parallel_active: parallelActive.count,
        completed_last_hour: tasksCompleted.count,
        failed_last_hour: tasksFailed.count,
      },
      models: {
        top_5: topModels,
      },
      daemon_health: {
        status: daemonStatus,
        heartbeat_age_ms: heartbeat ? heartbeat.age_ms : null,
      },
    };
  } finally {
    db.close();
  }
}

/**
 * Coleta métricas detalhadas do decomposer, executor e reviewer
 */
export function getMonitoringMetrics(): MonitoringMetrics {
  const db = initDb(getDbPath());
  try {
    // Importar métricas do decomposer do config
    const decomposerMetrics = getDecomposerMetrics();

    // Métricas do executor
    const tasksCompleted = db.prepare(`
      SELECT COUNT(*) as count
      FROM tasks
      WHERE status = 'completed'
    `).get() as { count: number };

    const tasksFailed = db.prepare(`
      SELECT COUNT(*) as count
      FROM tasks
      WHERE status = 'failed'
    `).get() as { count: number };

    const avgTaskDuration = db.prepare(`
      SELECT AVG(completed_at - started_at) as avg_duration
      FROM tasks
      WHERE status = 'completed' AND started_at IS NOT NULL AND completed_at IS NOT NULL
    `).get() as { avg_duration: number | null };

    const avgWorkflowDuration = db.prepare(`
      SELECT AVG(completed_at - started_at) as avg_duration
      FROM workflows
      WHERE status = 'completed' AND started_at IS NOT NULL AND completed_at IS NOT NULL
    `).get() as { avg_duration: number | null };

    // Métricas do reviewer (baseado em quality_reviews)
    let approved = 0;
    let rejected = 0;
    try {
      const reviews = db.prepare(`
        SELECT decision, COUNT(*) as count
        FROM quality_reviews
        GROUP BY decision
      `).all() as Array<{ decision: string; count: number }>;

      for (const review of reviews) {
        if (review.decision === 'approved') approved += review.count;
        if (review.decision === 'rejected') rejected += review.count;
      }
    } catch {
      // Tabela quality_reviews pode não existir em versões antigas
    }

    const totalReviews = approved + rejected;
    const approvalRate = totalReviews > 0 ? (approved / totalReviews) * 100 : 100;

    // Check explícito por null: um avg legítimo de 0ms não deve virar null.
    const avgTaskDurationMs =
      avgTaskDuration.avg_duration != null ? Math.round(avgTaskDuration.avg_duration) : null;
    const avgWorkflowDurationMs =
      avgWorkflowDuration.avg_duration != null ? Math.round(avgWorkflowDuration.avg_duration) : null;

    return {
      timestamp: Date.now(),
      decomposer: decomposerMetrics,
      executor: {
        tasks_completed: tasksCompleted.count,
        tasks_failed: tasksFailed.count,
        avg_duration_ms: avgTaskDurationMs,
      },
      reviewer: {
        approved,
        rejected,
        approval_rate: Math.round(approvalRate * 100) / 100,
      },
      performance: {
        avg_task_duration_ms: avgTaskDurationMs,
        avg_workflow_duration_ms: avgWorkflowDurationMs,
      },
    };
  } finally {
    db.close();
  }
}

/**
 * Verifica thresholds e gera alerts
 */
export function checkThresholds(config: Partial<AlertConfig> = {}): AlertResult {
  const fullConfig: AlertConfig = { ...DEFAULT_ALERT_CONFIG, ...config };
  const summary = getMonitoringSummary();
  const alerts: AlertResult['alerts'] = [];

  // Verificar taxa de sucesso
  if (summary.workflows.recent_success_rate < fullConfig.success_rate_threshold) {
    alerts.push({
      type: 'success_rate',
      message: `Taxa de sucesso abaixo do threshold: ${summary.workflows.recent_success_rate.toFixed(1)}% < ${fullConfig.success_rate_threshold}%`,
      severity: 'warning',
      value: summary.workflows.recent_success_rate,
      threshold: fullConfig.success_rate_threshold,
    });
  }

  // Verificar budget horário
  if (fullConfig.budget_usd && summary.workflows.recent_cost_usd > fullConfig.budget_usd) {
    alerts.push({
      type: 'budget',
      message: `Custo horário acima do budget: $${summary.workflows.recent_cost_usd.toFixed(4)} > $${fullConfig.budget_usd.toFixed(4)}`,
      severity: 'critical',
      value: summary.workflows.recent_cost_usd,
      threshold: fullConfig.budget_usd,
    });
  }

  // Verificar falhas consecutivas
  if (summary.tasks.failed_last_hour >= fullConfig.consecutive_failure_threshold) {
    alerts.push({
      type: 'consecutive_failures',
      message: `Muitas falhas consecutivas na última hora: ${summary.tasks.failed_last_hour} >= ${fullConfig.consecutive_failure_threshold}`,
      severity: 'critical',
      value: summary.tasks.failed_last_hour,
      threshold: fullConfig.consecutive_failure_threshold,
    });
  }

  // Log warnings
  for (const alert of alerts) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [MONITORING ALERT] [${alert.severity.toUpperCase()}] ${alert.message}`;
    
    if (alert.severity === 'critical') {
      console.error(logMessage);
    } else {
      console.warn(logMessage);
    }
  }

  // Opcional: enviar notificação via Telegram
  if (alerts.length > 0 && fullConfig.telegram_bot_token && fullConfig.telegram_chat_id) {
    sendTelegramAlert(fullConfig.telegram_bot_token, fullConfig.telegram_chat_id, alerts).catch((err) => {
      console.error('[MONITORING] Failed to send Telegram alert:', err);
    });
  }

  return {
    triggered: alerts.length > 0,
    alerts,
  };
}

/**
 * Envia alert via Telegram (opcional)
 */
async function sendTelegramAlert(
  botToken: string,
  chatId: string,
  alerts: AlertResult['alerts']
): Promise<void> {
  const criticalAlerts = alerts.filter((a) => a.severity === 'critical');
  const warningAlerts = alerts.filter((a) => a.severity === 'warning');

  let message = '🚨 *Omniforge Monitoring Alerts*\n\n';

  if (criticalAlerts.length > 0) {
    message += '*CRITICAL:*\n';
    for (const alert of criticalAlerts) {
      message += `• ${alert.message}\n`;
    }
    message += '\n';
  }

  if (warningAlerts.length > 0) {
    message += '*WARNING:*\n';
    for (const alert of warningAlerts) {
      message += `• ${alert.message}\n`;
    }
  }

  message += `\nTimestamp: ${new Date().toISOString()}`;

  const response = await postTelegramMessage(botToken, chatId, message, 'Markdown');
  if (!response.ok) {
    throw new Error(`Telegram API error: ${response.statusText}`);
  }
}

/**
 * Obtém configuração de alerts do ambiente
 */
export function getAlertConfig(): AlertConfig {
  return {
    success_rate_threshold: Number(process.env.MONITORING_SUCCESS_RATE_THRESHOLD) || DEFAULT_ALERT_CONFIG.success_rate_threshold,
    budget_usd: process.env.MONITORING_BUDGET_USD ? Number(process.env.MONITORING_BUDGET_USD) : undefined,
    consecutive_failure_threshold: Number(process.env.MONITORING_CONSECUTIVE_FAILURE_THRESHOLD) || DEFAULT_ALERT_CONFIG.consecutive_failure_threshold,
    telegram_bot_token: process.env.MONITORING_TELEGRAM_BOT_TOKEN,
    telegram_chat_id: process.env.MONITORING_TELEGRAM_CHAT_ID,
  };
}