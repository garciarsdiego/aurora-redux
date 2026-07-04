#!/usr/bin/env node
// Auto-generates docs/MCP-TOOLS-REFERENCE.md from the live Omniforge MCP daemon.
//
// Usage:
//   OMNIFORGE_TOKEN=<token> node scripts/generate-mcp-docs.mjs           # writes file
//   OMNIFORGE_TOKEN=<token> node scripts/generate-mcp-docs.mjs --dry-run # prints to stdout
//
// Generated via Omniroute (cx/gpt-5.5-medium). Strategy is parse-free:
// fetch the daemon's tool list (already JSON-Schema'd) and format as Markdown.

import { writeFile } from 'node:fs/promises';
import { argv, env, exit } from 'node:process';

const BASE_URL = env.OMNIFORGE_DAEMON_URL ?? 'http://127.0.0.1:20129';
const TOKEN = env.OMNIFORGE_TOKEN ?? '';
const DRY_RUN = argv.includes('--dry-run');
const OUT_PATH = 'docs/MCP-TOOLS-REFERENCE.md';

if (!TOKEN) {
  console.error('❌  OMNIFORGE_TOKEN is not set. Export it and retry:\n   export OMNIFORGE_TOKEN=<your-token>');
  exit(1);
}

// ── Fetch tool list ──────────────────────────────────────────────────────────
let tools;
try {
  const res = await fetch(`${BASE_URL}/mcp/tools/list`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) {
    console.error(`❌  Daemon returned HTTP ${res.status} ${res.statusText}`);
    exit(1);
  }
  const body = await res.json();
  // Accept { tools: [...] } or a bare array (or JSON-RPC-style { result: { tools } })
  tools = Array.isArray(body) ? body : (body.tools ?? body.result?.tools);
  if (!Array.isArray(tools)) {
    throw new Error('Unexpected response shape: ' + JSON.stringify(body).slice(0, 200));
  }
} catch (err) {
  if (err.cause?.code === 'ECONNREFUSED' || /fetch failed/i.test(err.message ?? '')) {
    console.error(`❌  Cannot reach daemon at ${BASE_URL}. Is omniforge-daemon running?`);
  } else {
    console.error('❌  Failed to fetch tool list:', err.message);
  }
  exit(1);
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function typeLabel(schema) {
  if (!schema) return 'any';
  if (schema.type) return schema.type;
  if (schema.anyOf) return schema.anyOf.map((s) => s.type ?? 'any').join(' | ');
  if (schema.oneOf) return schema.oneOf.map((s) => s.type ?? 'any').join(' | ');
  if (schema.$ref) return schema.$ref.split('/').pop();
  return 'any';
}

function renderTable(inputSchema) {
  const props = inputSchema?.properties;
  if (!props || Object.keys(props).length === 0) return '_No input parameters._\n';
  const required = new Set(inputSchema.required ?? []);
  const rows = Object.entries(props).map(([field, schema]) => {
    const type = typeLabel(schema);
    const req = required.has(field) ? '✅' : '';
    const desc = (schema.description ?? schema.title ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    return `| \`${field}\` | \`${type}\` | ${req} | ${desc} |`;
  });
  return ['| Field | Type | Required | Description |', '|---|---|:-:|---|', ...rows].join('\n') + '\n';
}

function renderTool(tool) {
  const name = tool.name ?? '(unnamed)';
  const desc = (tool.description ?? '').trim() || '_No description provided._';
  const schema = tool.inputSchema ?? tool.input_schema ?? {};
  return [
    `### \`${name}\``,
    '',
    desc,
    '',
    '**Input:**',
    '',
    renderTable(schema),
  ].join('\n');
}

// ── Build Markdown ───────────────────────────────────────────────────────────
const sorted = [...tools].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
const date = new Date().toISOString().slice(0, 10);

const sections = sorted.map(renderTool).join('\n---\n\n');

const markdown = `# Omniforge MCP Tools Reference

> **Auto-generated** on ${date} — do not edit by hand. Re-run via:
> \`OMNIFORGE_TOKEN=<token> node scripts/generate-mcp-docs.mjs\`
>
> Source: \`${BASE_URL}/mcp/tools/list\`
> Total tools: **${sorted.length}**

---

${sections}

---

_See also: [Codex handoff: Omniroute](./notes/2026-05-05-codex-handoff-omniroute.md), [Codex handoff: agents + advisors](./notes/2026-05-05-codex-handoff-agents-advisors.md)_
`;

// ── Output ───────────────────────────────────────────────────────────────────
if (DRY_RUN) {
  process.stdout.write(markdown);
} else {
  await writeFile(OUT_PATH, markdown, 'utf8');
  console.log(`✅  Wrote ${sorted.length} tools → ${OUT_PATH}`);
}
