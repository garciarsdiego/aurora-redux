/**
 * Rotas de Monitoramento Básico para Omniforge
 *
 * Fornece endpoints simples para monitoramento em tempo real:
 * - GET /api/monitoring/summary - Resumo das operações
 * - GET /api/monitoring/metrics - Métricas detalhadas
 * - POST /api/monitoring/check-alerts - Verificar thresholds e gerar alerts
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteContext, Router } from './types.js';
import { API_VERSION } from './_shared.js';
import {
  getMonitoringSummary,
  getMonitoringMetrics,
  checkThresholds,
  getAlertConfig,
  type AlertConfig,
} from '../../utils/monitoring.js';

/**
 * GET /api/monitoring/summary
 *
 * Retorna resumo das operações ativas do Omniforge:
 * - Workflows ativos (count e status)
 * - Taxa de sucesso recente (última hora)
 * - Custo acumulado recente (última hora)
 * - Tasks paralelas ativas
 * - Modelos mais usados (top 5)
 * - Health status do daemon
 */
function handleMonitoringSummary(res: ServerResponse): void {
  try {
    const summary = getMonitoringSummary();

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'X-Omniforge-Api-Version': String(API_VERSION),
    });
    res.end(JSON.stringify(summary, null, 2));
  } catch (err) {
    res.writeHead(500, {
      'Content-Type': 'application/json',
      'X-Omniforge-Api-Version': String(API_VERSION),
    });
    res.end(JSON.stringify({
      error: 'Failed to fetch monitoring summary',
      message: err instanceof Error ? err.message : String(err),
    }));
  }
}

/**
 * GET /api/monitoring/detailed-metrics
 *
 * Retorna métricas detalhadas do sistema:
 * - Métricas do decomposer (aceitação/rejeição)
 * - Métricas de executor (tasks completadas, falhadas)
 * - Métricas de reviewer (aprovados, rejeitados)
 * - Performance (tempos médios)
 */
function handleMonitoringMetrics(res: ServerResponse): void {
  try {
    const metrics = getMonitoringMetrics();

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'X-Omniforge-Api-Version': String(API_VERSION),
    });
    res.end(JSON.stringify(metrics, null, 2));
  } catch (err) {
    res.writeHead(500, {
      'Content-Type': 'application/json',
      'X-Omniforge-Api-Version': String(API_VERSION),
    });
    res.end(JSON.stringify({
      error: 'Failed to fetch monitoring metrics',
      message: err instanceof Error ? err.message : String(err),
    }));
  }
}

/**
 * POST /api/monitoring/check-alerts
 *
 * Verifica thresholds e gera alerts:
 * - Taxa de sucesso < 70%
 * - Custo > budget (se configurado)
 * - Tasks falhando consecutivamente > 5
 *
 * Body opcional com configuração de alerts:
 * {
 *   "success_rate_threshold": 70,
 *   "budget_usd": 1.0,
 *   "consecutive_failure_threshold": 5
 * }
 */
function handleCheckAlerts(req: IncomingMessage, res: ServerResponse): void {
  try {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        let config: Partial<AlertConfig> = {};
        if (body.trim()) {
          config = JSON.parse(body) as Partial<AlertConfig>;
        }

        const result = checkThresholds(config);

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'X-Omniforge-Api-Version': String(API_VERSION),
        });
        res.end(JSON.stringify(result, null, 2));
      } catch (err) {
        res.writeHead(400, {
          'Content-Type': 'application/json',
          'X-Omniforge-Api-Version': String(API_VERSION),
        });
        res.end(JSON.stringify({
          error: 'Invalid request body',
          message: err instanceof Error ? err.message : String(err),
        }));
      }
    });
  } catch (err) {
    res.writeHead(500, {
      'Content-Type': 'application/json',
      'X-Omniforge-Api-Version': String(API_VERSION),
    });
    res.end(JSON.stringify({
      error: 'Failed to check alerts',
      message: err instanceof Error ? err.message : String(err),
    }));
  }
}

/**
 * GET /api/monitoring/alert-config
 *
 * Retorna configuração atual de alerts (do ambiente)
 */
function handleAlertConfig(res: ServerResponse): void {
  try {
    const config = getAlertConfig();

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'X-Omniforge-Api-Version': String(API_VERSION),
    });
    res.end(JSON.stringify(config, null, 2));
  } catch (err) {
    res.writeHead(500, {
      'Content-Type': 'application/json',
      'X-Omniforge-Api-Version': String(API_VERSION),
    });
    res.end(JSON.stringify({
      error: 'Failed to fetch alert config',
      message: err instanceof Error ? err.message : String(err),
    }));
  }
}

/**
 * Router principal de monitoramento básico
 */
export const monitoringBasicRouter: Router = async (req, url, res, ctx) => {
  // GET /api/monitoring/summary
  if (req.method === 'GET' && url.pathname === '/api/monitoring/summary') {
    handleMonitoringSummary(res);
    return true;
  }

  // GET /api/monitoring/detailed-metrics
  if (req.method === 'GET' && url.pathname === '/api/monitoring/detailed-metrics') {
    handleMonitoringMetrics(res);
    return true;
  }

  // POST /api/monitoring/check-alerts
  if (req.method === 'POST' && url.pathname === '/api/monitoring/check-alerts') {
    handleCheckAlerts(req, res);
    return true;
  }

  // GET /api/monitoring/alert-config
  if (req.method === 'GET' && url.pathname === '/api/monitoring/alert-config') {
    handleAlertConfig(res);
    return true;
  }

  return false;
};