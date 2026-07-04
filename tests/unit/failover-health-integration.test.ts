/**
 * Unit tests for failover classifier health integration
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  isProviderHealthy,
  extractProviderFromModel,
} from '../../src/v2/failover/classifier.js';

// Mock health cache
vi.mock('../../src/v2/omniroute-bridge/health-cache.js', () => ({
  getHealthStatus: vi.fn(),
}));

describe('Failover Classifier Health Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isProviderHealthy', () => {
    it('should return true when provider is healthy', async () => {
      const { getHealthStatus } = await import('../../src/v2/omniroute-bridge/health-cache.js');
      vi.mocked(getHealthStatus).mockResolvedValue({
        ok: true,
        data: {
          status: 'ok',
          timestamp: new Date().toISOString(),
          providers: {
            claude: {
              status: 'healthy',
              latency_ms: 500,
              last_check: new Date().toISOString(),
            },
          },
          rate_limits: {},
        },
      });

      const result = await isProviderHealthy('claude');
      expect(result).toBe(true);
    });

    it('should return false when provider is unhealthy', async () => {
      const { getHealthStatus } = await import('../../src/v2/omniroute-bridge/health-cache.js');
      vi.mocked(getHealthStatus).mockResolvedValue({
        ok: true,
        data: {
          status: 'ok',
          timestamp: new Date().toISOString(),
          providers: {
            claude: {
              status: 'unhealthy',
              latency_ms: 5000,
              last_check: new Date().toISOString(),
            },
          },
          rate_limits: {},
        },
      });

      const result = await isProviderHealthy('claude');
      expect(result).toBe(false);
    });

    it('should return false when provider is degraded', async () => {
      const { getHealthStatus } = await import('../../src/v2/omniroute-bridge/health-cache.js');
      vi.mocked(getHealthStatus).mockResolvedValue({
        ok: true,
        data: {
          status: 'ok',
          timestamp: new Date().toISOString(),
          providers: {
            claude: {
              status: 'degraded',
              latency_ms: 2000,
              last_check: new Date().toISOString(),
            },
          },
          rate_limits: {},
        },
      });

      const result = await isProviderHealthy('claude');
      expect(result).toBe(false);
    });

    it('should return true when provider not found in health data', async () => {
      const { getHealthStatus } = await import('../../src/v2/omniroute-bridge/health-cache.js');
      vi.mocked(getHealthStatus).mockResolvedValue({
        ok: true,
        data: {
          status: 'ok',
          timestamp: new Date().toISOString(),
          providers: {
            openai: {
              status: 'healthy',
              latency_ms: 800,
              last_check: new Date().toISOString(),
            },
          },
          rate_limits: {},
        },
      });

      const result = await isProviderHealthy('claude');
      expect(result).toBe(true); // Assume healthy for unknown providers
    });

    it('should return true when health check fails', async () => {
      const { getHealthStatus } = await import('../../src/v2/omniroute-bridge/health-cache.js');
      vi.mocked(getHealthStatus).mockResolvedValue({
        ok: false,
        error: 'API error',
      });

      const result = await isProviderHealthy('claude');
      expect(result).toBe(true); // Assume healthy to avoid false positives
    });

    it('should return true when health status is unavailable', async () => {
      const { getHealthStatus } = await import('../../src/v2/omniroute-bridge/health-cache.js');
      vi.mocked(getHealthStatus).mockResolvedValue({
        ok: true,
        data: undefined,
      });

      const result = await isProviderHealthy('claude');
      expect(result).toBe(true);
    });

    it('should handle exceptions gracefully', async () => {
      const { getHealthStatus } = await import('../../src/v2/omniroute-bridge/health-cache.js');
      vi.mocked(getHealthStatus).mockRejectedValue(new Error('Network error'));

      const result = await isProviderHealthy('claude');
      expect(result).toBe(true); // Assume healthy on error
    });

    it('should be case-insensitive for provider names', async () => {
      const { getHealthStatus } = await import('../../src/v2/omniroute-bridge/health-cache.js');
      vi.mocked(getHealthStatus).mockResolvedValue({
        ok: true,
        data: {
          status: 'ok',
          timestamp: new Date().toISOString(),
          providers: {
            Claude: {
              status: 'healthy',
              latency_ms: 500,
              last_check: new Date().toISOString(),
            },
          },
          rate_limits: {},
        },
      });

      const result = await isProviderHealthy('claude');
      expect(result).toBe(true); // Should handle case mismatch gracefully
    });
  });

  describe('extractProviderFromModel', () => {
    it('should extract provider from model with slash', () => {
      expect(extractProviderFromModel('cc/claude-sonnet-4-6')).toBe('cc');
      expect(extractProviderFromModel('openai/gpt-4o')).toBe('openai');
      expect(extractProviderFromModel('google/gemini-pro')).toBe('google');
    });

    it('should extract provider from claude model IDs', () => {
      expect(extractProviderFromModel('claude-sonnet-4-6')).toBe('claude');
      expect(extractProviderFromModel('claude-3-5-haiku')).toBe('claude');
      expect(extractProviderFromModel('cc/claude-opus-4-6')).toBe('cc');
    });

    it('should extract provider from openai model IDs', () => {
      expect(extractProviderFromModel('gpt-4o')).toBe('openai');
      expect(extractProviderFromModel('gpt-4-turbo')).toBe('openai');
      expect(extractProviderFromModel('openai/gpt-3.5-turbo')).toBe('openai');
    });

    it('should extract provider from google model IDs', () => {
      expect(extractProviderFromModel('gemini-pro')).toBe('google');
      expect(extractProviderFromModel('gemini-1.5-pro')).toBe('google');
    });

    it('should return null for unknown bare model patterns', () => {
      // No slash + unknown shape = null
      expect(extractProviderFromModel('unknown-model')).toBeNull();
      expect(extractProviderFromModel('')).toBeNull();
      // With a slash we extract the raw prefix verbatim (upstream maps it)
      expect(extractProviderFromModel('x/custom-model')).toBe('x');
    });

    it('should handle null input', () => {
      expect(extractProviderFromModel(null as any)).toBeNull();
      expect(extractProviderFromModel(undefined as any)).toBeNull();
    });

    it('should handle edge cases', () => {
      expect(extractProviderFromModel('/model-without-provider')).toBe('');
      expect(extractProviderFromModel('provider/')).toBe('provider');
      expect(extractProviderFromModel('multiple/slashes/model')).toBe('multiple');
    });
  });

  describe('Integration Scenarios', () => {
    it('should check provider health for common models', async () => {
      const { getHealthStatus } = await import('../../src/v2/omniroute-bridge/health-cache.js');
      vi.mocked(getHealthStatus).mockResolvedValue({
        ok: true,
        data: {
          status: 'ok',
          timestamp: new Date().toISOString(),
          providers: {
            claude: {
              status: 'healthy',
              latency_ms: 500,
              last_check: new Date().toISOString(),
            },
            openai: {
              status: 'healthy',
              latency_ms: 800,
              last_check: new Date().toISOString(),
            },
          },
          rate_limits: {},
        },
      });

      const claudeHealthy = await isProviderHealthy('claude');
      const openaiHealthy = await isProviderHealthy('openai');
      
      expect(claudeHealthy).toBe(true);
      expect(openaiHealthy).toBe(true);
    });

    it('should handle mixed provider health states', async () => {
      const { getHealthStatus } = await import('../../src/v2/omniroute-bridge/health-cache.js');
      vi.mocked(getHealthStatus).mockResolvedValue({
        ok: true,
        data: {
          status: 'ok',
          timestamp: new Date().toISOString(),
          providers: {
            claude: {
              status: 'healthy',
              latency_ms: 500,
              last_check: new Date().toISOString(),
            },
            openai: {
              status: 'unhealthy',
              latency_ms: 5000,
              last_check: new Date().toISOString(),
            },
          },
          rate_limits: {},
        },
      });

      const claudeHealthy = await isProviderHealthy('claude');
      const openaiHealthy = await isProviderHealthy('openai');
      
      expect(claudeHealthy).toBe(true);
      expect(openaiHealthy).toBe(false);
    });
  });
});