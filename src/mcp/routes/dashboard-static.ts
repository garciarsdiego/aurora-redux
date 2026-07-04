// Sprint 4.3 (D-H2.066): /dashboard, /dashboard/styles.css, /dashboard/app.js,
// /dashboard/assets/* routes.
//
// All POST-AUTH (Sprint 3.1, F-SEC-2). Built-from-source dashboard (Vite
// output) is preferred when present; legacy inline DASHBOARD_HTML/JS/CSS
// in src/mcp/dashboard-assets.ts is the fallback for dev/CI runs without
// `pnpm build:dashboard`.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerResponse } from 'node:http';
import { DASHBOARD_CSS, DASHBOARD_HTML, DASHBOARD_JS } from '../dashboard-assets.js';
import type { Router } from './types.js';
import { binaryOk, DASHBOARD_REACT_CSP, textOk } from './_shared.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// W14: dashboard-v2 is the active build target. Keep legacy `dashboard` paths
// last as fallback for older deployments.
const dashboardBuildDirs = [
  path.resolve(process.cwd(), 'dist', 'dashboard-v2'),
  path.resolve(__dirname, '..', '..', 'dashboard-v2'),
  path.resolve(process.cwd(), 'apps', 'dashboard-v2', 'dist'),
  path.resolve(process.cwd(), 'dist', 'dashboard'),
  path.resolve(__dirname, '..', '..', 'dashboard'),
  path.resolve(process.cwd(), 'apps', 'dashboard', 'dist'),
];

function contentTypeForDashboardAsset(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.js' || ext === '.mjs') return 'application/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.json' || ext === '.map') return 'application/json; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.ico') return 'image/x-icon';
  if (ext === '.woff2') return 'font/woff2';
  return 'application/octet-stream';
}

function dashboardBuiltIndex(): string | null {
  for (const dir of dashboardBuildDirs) {
    const indexPath = path.join(dir, 'index.html');
    if (existsSync(indexPath)) return readFileSync(indexPath, 'utf8');
  }
  return null;
}

function dashboardBuiltAssetPath(pathname: string): string | null {
  if (!pathname.startsWith('/dashboard/')) return null;
  let relativePath: string;
  try {
    relativePath = decodeURIComponent(pathname.slice('/dashboard/'.length));
  } catch {
    return null;
  }
  if (!relativePath || relativePath.includes('\0') || path.isAbsolute(relativePath)) return null;
  const normalized = path.normalize(relativePath);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) return null;

  for (const dir of dashboardBuildDirs) {
    const assetPath = path.resolve(dir, normalized);
    const normalizedDir = path.resolve(dir);
    if (!assetPath.startsWith(`${normalizedDir}${path.sep}`)) continue;
    if (existsSync(assetPath)) return assetPath;
  }
  return null;
}

function dashboardBuildAsset(pathname: string): { body: Buffer; contentType: string } | null {
  const assetPath = dashboardBuiltAssetPath(pathname);
  if (!assetPath) return null;
  return {
    body: readFileSync(assetPath),
    contentType: contentTypeForDashboardAsset(assetPath),
  };
}

function handleDashboardIndex(url: URL, res: ServerResponse): void {
  const queryToken = url.searchParams.get('token') ?? '';

  // Sprint 8.1 (D-H2.066, F-SEC-1): if the operator opened /dashboard?token=X,
  // set the cookie AND immediately 302-redirect to /dashboard (no query). This
  // pulls the token out of:
  //   - browser history (Ctrl+H)
  //   - URL bar (screen-share / over-shoulder leak)
  //   - Referer headers on outbound links from the dashboard
  //   - terminal scrollback when launched via `start http://...?token=...`
  // The cookie (HttpOnly + SameSite=Strict) becomes the canonical credential
  // for subsequent requests in this browser session.
  if (queryToken) {
    // W14: preserve the pathname on the redirect so deep links like
    // /dashboard/runs?token=X land on /dashboard/runs (not the raiz).
    // Stripping ?token and forwarding the same path keeps the SPA route
    // intact for React Router to hydrate.
    const pathname = url.pathname || '/dashboard';
    // Single-operator persistence: 30-day cookie so the operator does not have
    // to paste the token every time the browser session ends. SameSite=Strict
    // + HttpOnly preserve CSRF and XSS protection; the token can still be
    // rotated by deleting `data/daemon-token.txt` and restarting.
    const THIRTY_DAYS_SECONDS = 60 * 60 * 24 * 30;
    // M1 / Wave 1-E (A9): set Secure when the daemon is behind TLS. Browsers
    // only send Secure cookies over HTTPS, so flipping this on plain-HTTP
    // localhost would break the dashboard. Default is OFF (dogfood = local
    // loopback). Set OMNIFORGE_BEHIND_TLS=true behind nginx/Caddy/Cloudflare
    // so the cookie cannot leak over an HTTP downgrade.
    const secureFlag = process.env.OMNIFORGE_BEHIND_TLS === 'true' ? '; Secure' : '';
    res.writeHead(302, {
      'Location': pathname,
      'Set-Cookie': `omniforge_daemon_token=${queryToken}; Max-Age=${THIRTY_DAYS_SECONDS}; Path=/; SameSite=Strict; HttpOnly${secureFlag}`,
      'Cache-Control': 'no-store',
    });
    res.end();
    return;
  }

  const builtDashboard = dashboardBuiltIndex();
  textOk(
    res,
    builtDashboard ?? DASHBOARD_HTML,
    'text/html; charset=utf-8',
    {
      ...(builtDashboard ? { 'Content-Security-Policy': DASHBOARD_REACT_CSP } : {}),
    },
  );
}

export const dashboardStaticRouter: Router = async (req, url, res, _ctx) => {
  if (req.method !== 'GET') return false;

  if (url.pathname === '/') {
    const suffix = url.search || '';
    res.writeHead(302, {
      Location: `/dashboard${suffix}`,
      'Cache-Control': 'no-store',
    });
    res.end();
    return true;
  }
  if (url.pathname === '/dashboard') {
    handleDashboardIndex(url, res);
    return true;
  }
  if (url.pathname === '/dashboard/styles.css') {
    textOk(res, DASHBOARD_CSS, 'text/css; charset=utf-8');
    return true;
  }
  if (url.pathname === '/dashboard/app.js') {
    textOk(res, DASHBOARD_JS, 'application/javascript; charset=utf-8');
    return true;
  }
  if (url.pathname.startsWith('/dashboard/assets/')) {
    const asset = dashboardBuildAsset(url.pathname);
    if (asset) {
      binaryOk(res, asset.body, asset.contentType);
      return true;
    }
  }
  // W14 SPA fallback: any deeper path under /dashboard/ that isn't a static
  // asset must serve index.html so React Router can pick up the route on
  // the client side. Without this, /dashboard/runs and friends 404 on
  // direct-link / refresh / bookmark.
  if (url.pathname.startsWith('/dashboard/') || url.pathname === '/dashboard/') {
    handleDashboardIndex(url, res);
    return true;
  }
  return false;
};
