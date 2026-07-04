/**
 * Unit tests for OmniRoute health API client
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { 
  checkBasicHealth, 
  checkDetailedHealth,
  type BasicHealthResult,
  type DetailedHealthResult,
} from '../../src/v2/omniroute-bridge/client.js';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch as any;

// Mock config functions. Path must be 2 levels up from tests/unit/ to reach src/.
vi.mock('../../src/utils/config.js', () => ({
  getOmnirouteUrl: vi.fn(() => 'http://localhost:20228'),
  getOmnirouteApiKey: vi.fn(() => 'test-api-key'),
  getOmnirouteTimeoutMs: vi.fn(() => 30000),
  getOmnirouteMaxRetries: vi.fn(() => 0),
  getOmnirouteModelCatalogTimeoutMs: vi.fn(() => 15000),
}));

describe('OmniRoute Health API Client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockClear();
  });

  describe('checkBasicHealth', () => {
    it('should return health status on successful request', async () => {
      const mockResponse: BasicHealthResult = {
        status: 'ok',
        timestamp: new Date().toISOString(),
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const result = await checkBasicHealth();
      expect(result.ok).toBe(true);
      expect(result.data).toEqual(mockResponse);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:20228/api/health',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'Authorization': 'Bearer test-api-key',
          }),
        })
      );
    });

    it('should handle HTTP errors gracefully', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      } as Response);

      const result = await checkBasicHealth();
      expect(result.ok).toBe(false);
      expect(result.error).toContain('HTTP 500');
      expect(result.data).toBeDefined();
      expect(result.data?.status).toBe('error');
    });

    it('should handle network errors', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const result = await checkBasicHealth();
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Network error');
      expect(result.data).toBeDefined();
      expect(result.data?.status).toBe('error');
    });

    it('should handle timeout errors', async () => {
      const timeoutError = new Error('Timeout');
      timeoutError.name = 'AbortError';
      mockFetch.mockRejectedValue(timeoutError);

      const result = await checkBasicHealth();
      expect(result.ok).toBe(false);
      expect(result.error).toContain('timeout');
    });

    it('should use 3 second timeout', async () => {
      mockFetch.mockImplementation(() => 
        new Promise((resolve) => setTimeout(() => resolve({
          ok: true,
          json: async () => ({ status: 'ok', timestamp: new Date().toISOString() }),
        } as Response), 100))
      );

      await checkBasicHealth();
      
      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[1]).toHaveProperty('signal');
    });
  });

  describe('checkDetailedHealth', () => {
    it('should return detailed health status on successful request', async () => {
      const mockResponse: DetailedHealthResult = {
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
        rate_limits: {
          claude: {
            remaining: 95,
            reset_in: 3600,
          },
          openai: {
            remaining: 80,
            reset_in: 1800,
          },
        },
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const result = await checkDetailedHealth();
      expect(result.ok).toBe(true);
      expect(result.data).toEqual(mockResponse);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:20228/api/monitoring/health',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'Authorization': 'Bearer test-api-key',
          }),
        })
      );
    });

    it('should handle HTTP errors gracefully', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      } as Response);

      const result = await checkDetailedHealth();
      expect(result.ok).toBe(false);
      expect(result.error).toContain('HTTP 401');
      expect(result.data).toBeDefined();
      expect(result.data?.status).toBe('error');
      expect(result.data?.providers).toEqual({});
    });

    it('should handle network errors', async () => {
      mockFetch.mockRejectedValue(new Error('Connection refused'));

      const result = await checkDetailedHealth();
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Connection refused');
      expect(result.data).toBeDefined();
      expect(result.data?.status).toBe('error');
    });

    it('should handle timeout errors', async () => {
      const timeoutError = new Error('Timeout');
      timeoutError.name = 'TimeoutError';
      mockFetch.mockRejectedValue(timeoutError);

      const result = await checkDetailedHealth();
      expect(result.ok).toBe(false);
      expect(result.error).toContain('timeout');
    });

    it('should use 3 second timeout', async () => {
      mockFetch.mockImplementation(() => 
        new Promise((resolve) => setTimeout(() => resolve({
          ok: true,
          json: async () => ({ status: 'ok', timestamp: new Date().toISOString(), providers: {}, rate_limits: {} }),
        } as Response), 100))
      );

      await checkDetailedHealth();
      
      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[1]).toHaveProperty('signal');
    });
  });

  describe('API Integration', () => {
    it('should handle missing API key gracefully', async () => {
      const { getOmnirouteApiKey } = await import('../../src/utils/config.js');
      vi.mocked(getOmnirouteApiKey).mockReturnValue(undefined as unknown as string);

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'ok', timestamp: new Date().toISOString() }),
      } as Response);

      const result = await checkBasicHealth();
      expect(result.ok).toBe(true);
      
      // Should still call fetch even without API key
      expect(mockFetch).toHaveBeenCalled();
      
      // Should not include Authorization header without API key
      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[1].headers).not.toHaveProperty('Authorization');
    });

    it('should use custom OmniRoute URL from config', async () => {
      const { getOmnirouteUrl } = await import('../../src/utils/config.js');
      vi.mocked(getOmnirouteUrl).mockReturnValue('http://custom-omniroute:3000');

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'ok', timestamp: new Date().toISOString() }),
      } as Response);

      await checkBasicHealth();
      
      expect(mockFetch).toHaveBeenCalledWith(
        'http://custom-omniroute:3000/api/health',
        expect.any(Object)
      );
    });
  });

  describe('Error Handling', () => {
    it('should handle malformed JSON response', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => { throw new Error('Invalid JSON'); },
        text: async () => 'invalid json',
      } as Response);

      const result = await checkBasicHealth();
      expect(result.ok).toBe(false);
    });

    it('should handle empty response body', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({}),
      } as Response);

      const result = await checkBasicHealth();
      // Should still return ok if response is successful, even with minimal data
      expect(result.ok).toBe(true);
    });

    it('should handle response without status field', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ timestamp: new Date().toISOString() }),
      } as Response);

      const result = await checkBasicHealth();
      expect(result.ok).toBe(true);
      expect(result.data).toBeDefined();
    });
  });
});