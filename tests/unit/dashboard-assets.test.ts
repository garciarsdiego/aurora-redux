import { describe, it, expect } from 'vitest';
import { DASHBOARD_CSS, DASHBOARD_HTML, DASHBOARD_JS } from '../../src/mcp/dashboard-assets.js';

describe('dashboard static assets (minimal fallback)', () => {
  it('DASHBOARD_HTML is a non-empty string containing a valid HTML skeleton', () => {
    expect(typeof DASHBOARD_HTML).toBe('string');
    expect(DASHBOARD_HTML.length).toBeGreaterThan(0);
    expect(DASHBOARD_HTML).toContain('<!doctype html>');
    expect(DASHBOARD_HTML).toContain('<html');
    expect(DASHBOARD_HTML).toContain('</html>');
  });

  it('DASHBOARD_HTML communicates that a build step is required', () => {
    expect(DASHBOARD_HTML.toLowerCase()).toContain('pnpm build');
    expect(DASHBOARD_HTML.toLowerCase()).toMatch(/not built|dashboard not built/i);
  });

  it('DASHBOARD_HTML references the stylesheet correctly', () => {
    expect(DASHBOARD_HTML).toContain('/dashboard/styles.css');
  });

  it('DASHBOARD_CSS is a non-empty string', () => {
    expect(typeof DASHBOARD_CSS).toBe('string');
    expect(DASHBOARD_CSS.length).toBeGreaterThan(0);
  });

  it('DASHBOARD_JS is a string (may be empty for the fallback page)', () => {
    expect(typeof DASHBOARD_JS).toBe('string');
  });
});
