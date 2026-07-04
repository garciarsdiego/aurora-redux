// Minimal fallback served when no built dashboard is found in dist/dashboard-v2.
// Production: run `pnpm build` to generate the real Aurora dashboard, then
// restart the daemon.  The Vite output in dist/dashboard-v2/ is always preferred
// by src/mcp/routes/dashboard-static.ts; these constants are only reached when
// that directory is absent (e.g. CI steps that skip `pnpm build:dashboard`).
//
// Replaces the 1811-line hand-edited legacy inline bundle (2026-05-16,
// refactor M2-B3 completion).  See docs/decisions.md D-H2.056 + D-H2.057.

export const DASHBOARD_CSS = [
  'body{font-family:system-ui,sans-serif;background:#0f0f12;color:#e2e2e5;',
  'display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}',
  '.card{background:#1a1a24;border:1px solid #2e2e40;border-radius:12px;',
  'padding:2rem 2.5rem;max-width:480px;text-align:center}',
  'h1{font-size:1.25rem;margin-bottom:.5rem}',
  'p{color:#888;font-size:.875rem;margin-bottom:1.25rem}',
  'code{background:#0f0f12;border:1px solid #2e2e40;border-radius:4px;',
  'padding:.2em .5em;font-size:.8rem}',
].join('');

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Omniforge Dashboard</title>
  <link rel="stylesheet" href="/dashboard/styles.css">
</head>
<body>
  <div class="card">
    <h1>Dashboard not built</h1>
    <p>Run <code>pnpm build</code> to generate the Aurora dashboard,<br>then restart the daemon.</p>
    <p>Omniforge H2 &middot; aurora</p>
  </div>
</body>
</html>`;

// No inline JS required for the fallback page.
export const DASHBOARD_JS = '';
