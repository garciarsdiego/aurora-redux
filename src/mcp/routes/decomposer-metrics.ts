/**
 * OTIMIZAÇÃO 10: Router para métricas do decomposer
 * Expõe endpoint GET /api/decomposer-metrics com métricas de aceitação/rejeição
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteContext, Router } from './types.js';
import { getDecomposerMetrics } from '../../utils/config.js';

export function createDecomposerMetricsRouter(): Router {
  return async (req: IncomingMessage, url: URL, res: ServerResponse, ctx: RouteContext) => {
    if (req.method !== 'GET' || url.pathname !== '/api/decomposer-metrics') {
      return false;
    }

    try {
      const metrics = getDecomposerMetrics();
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(metrics, null, 2));
      
      return true;
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to fetch decomposer metrics' }, null, 2));
      return true;
    }
  };
}