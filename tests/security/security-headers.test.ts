/**
 * Security Headers Tests (Sprint 9)
 *
 * Tests for security headers implementation across HTTP responses.
 */

import { describe, it, expect } from 'vitest';
import {
  SECURITY_HEADERS,
  textOk,
  jsonOk,
  binaryOk,
  unauthorized,
  notFound,
  badRequest,
} from '../../src/mcp/routes/_shared.js';

describe('Security Headers', () => {
  describe('SECURITY_HEADERS constant', () => {
    it('should include X-Frame-Options set to DENY', () => {
      expect(SECURITY_HEADERS['X-Frame-Options']).toBe('DENY');
    });

    it('should include X-Content-Type-Options set to nosniff', () => {
      expect(SECURITY_HEADERS['X-Content-Type-Options']).toBe('nosniff');
    });

    it('should include Strict-Transport-Security with max-age', () => {
      expect(SECURITY_HEADERS['Strict-Transport-Security']).toContain('max-age=31536000');
      expect(SECURITY_HEADERS['Strict-Transport-Security']).toContain('includeSubDomains');
    });

    it('should include X-XSS-Protection', () => {
      expect(SECURITY_HEADERS['X-XSS-Protection']).toBe('1; mode=block');
    });

    it('should include Referrer-Policy', () => {
      expect(SECURITY_HEADERS['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    });

    it('should include Permissions-Policy', () => {
      expect(SECURITY_HEADERS['Permissions-Policy']).toContain('geolocation=()');
      expect(SECURITY_HEADERS['Permissions-Policy']).toContain('microphone=()');
      expect(SECURITY_HEADERS['Permissions-Policy']).toContain('camera=()');
    });
  });

  describe('Response helpers include security headers', () => {
    it('jsonOk should include security headers', () => {
      const mockRes = {
        headersSent: false,
        headers: {},
        writeHead: function (status: number, headers: Record<string, string>) {
          this.headers = headers;
          this.headersSent = true;
        },
        end: function () {},
      } as any;

      jsonOk(mockRes, { test: 'data' });

      expect(mockRes.headers['X-Frame-Options']).toBe('DENY');
      expect(mockRes.headers['X-Content-Type-Options']).toBe('nosniff');
      expect(mockRes.headers['Strict-Transport-Security']).toBeDefined();
    });

    it('textOk should include security headers', () => {
      const mockRes = {
        headersSent: false,
        headers: {},
        writeHead: function (status: number, headers: Record<string, string>) {
          this.headers = headers;
          this.headersSent = true;
        },
        end: function () {},
      } as any;

      textOk(mockRes, 'test', 'text/plain');

      expect(mockRes.headers['X-Frame-Options']).toBe('DENY');
      expect(mockRes.headers['X-Content-Type-Options']).toBe('nosniff');
    });

    it('binaryOk should include security headers', () => {
      const mockRes = {
        headersSent: false,
        headers: {},
        writeHead: function (status: number, headers: Record<string, string>) {
          this.headers = headers;
          this.headersSent = true;
        },
        end: function () {},
      } as any;

      binaryOk(mockRes, Buffer.from('test'), 'application/octet-stream');

      expect(mockRes.headers['X-Frame-Options']).toBe('DENY');
      expect(mockRes.headers['X-Content-Type-Options']).toBe('nosniff');
    });

    it('unauthorized should include security headers', () => {
      const mockRes = {
        headersSent: false,
        headers: {},
        writeHead: function (status: number, headers: Record<string, string>) {
          this.headers = headers;
          this.headersSent = true;
        },
        end: function () {},
      } as any;

      unauthorized(mockRes);

      expect(mockRes.headers['X-Frame-Options']).toBe('DENY');
      expect(mockRes.headers['X-Content-Type-Options']).toBe('nosniff');
    });

    it('notFound should include security headers', () => {
      const mockRes = {
        headersSent: false,
        headers: {},
        writeHead: function (status: number, headers: Record<string, string>) {
          this.headers = headers;
          this.headersSent = true;
        },
        end: function () {},
      } as any;

      notFound(mockRes);

      expect(mockRes.headers['X-Frame-Options']).toBe('DENY');
      expect(mockRes.headers['X-Content-Type-Options']).toBe('nosniff');
    });

    it('badRequest should include security headers', () => {
      const mockRes = {
        headersSent: false,
        headers: {},
        writeHead: function (status: number, headers: Record<string, string>) {
          this.headers = headers;
          this.headersSent = true;
        },
        end: function () {},
      } as any;

      badRequest(mockRes, 'Invalid input');

      expect(mockRes.headers['X-Frame-Options']).toBe('DENY');
      expect(mockRes.headers['X-Content-Type-Options']).toBe('nosniff');
    });
  });
});