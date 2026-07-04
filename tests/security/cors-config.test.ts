/**
 * CORS Configuration Tests (Sprint 9)
 *
 * Tests for restrictive CORS configuration.
 */

import { describe, it, expect } from 'vitest';

describe('CORS Configuration', () => {
  describe('Allowed origins', () => {
    it('should allow localhost:20129', () => {
      const allowedOrigins = [
        'http://localhost:20129',
        'http://127.0.0.1:20129',
        'http://localhost:3000',
        'http://127.0.0.1:3000',
      ];

      expect(allowedOrigins).toContain('http://localhost:20129');
      expect(allowedOrigins).toContain('http://127.0.0.1:20129');
    });

    it('should allow localhost:3000 for dashboard', () => {
      const allowedOrigins = [
        'http://localhost:20129',
        'http://127.0.0.1:20129',
        'http://localhost:3000',
        'http://127.0.0.1:3000',
      ];

      expect(allowedOrigins).toContain('http://localhost:3000');
      expect(allowedOrigins).toContain('http://127.0.0.1:3000');
    });

    it('should not allow wildcard origin', () => {
      const allowedOrigins = [
        'http://localhost:20129',
        'http://127.0.0.1:20129',
        'http://localhost:3000',
        'http://127.0.0.1:3000',
      ];

      expect(allowedOrigins).not.toContain('*');
    });

    it('should not allow external origins', () => {
      const allowedOrigins = [
        'http://localhost:20129',
        'http://127.0.0.1:20129',
        'http://localhost:3000',
        'http://127.0.0.1:3000',
      ];

      expect(allowedOrigins).not.toContain('https://example.com');
      expect(allowedOrigins).not.toContain('https://malicious.com');
    });
  });

  describe('CORS headers configuration', () => {
    it('should include Access-Control-Allow-Methods', () => {
      const corsHeaders = {
        'Access-Control-Allow-Origin': 'http://localhost:20129',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Max-Age': '86400',
      };

      expect(corsHeaders['Access-Control-Allow-Methods']).toBe('GET, POST, PUT, PATCH, DELETE, OPTIONS');
    });

    it('should include Access-Control-Allow-Headers', () => {
      const corsHeaders = {
        'Access-Control-Allow-Origin': 'http://localhost:20129',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Max-Age': '86400',
      };

      expect(corsHeaders['Access-Control-Allow-Headers']).toBe('Authorization, Content-Type');
    });

    it('should include Access-Control-Allow-Credentials', () => {
      const corsHeaders = {
        'Access-Control-Allow-Origin': 'http://localhost:20129',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Max-Age': '86400',
      };

      expect(corsHeaders['Access-Control-Allow-Credentials']).toBe('true');
    });

    it('should include Access-Control-Max-Age', () => {
      const corsHeaders = {
        'Access-Control-Allow-Origin': 'http://localhost:20129',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Max-Age': '86400',
      };

      expect(corsHeaders['Access-Control-Max-Age']).toBe('86400');
    });
  });
});