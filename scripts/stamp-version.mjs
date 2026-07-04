#!/usr/bin/env node
/**
 * Build-time version stamper (D-H2.031).
 *
 * Writes dist/version.json with {version, commit, builtAt, node}.
 * Read by `omniforge --version` (and the REPL banner) so the user always
 * sees the exact build they're running, not just package.json's "0.3.0".
 *
 * If git is unavailable (e.g. shallow tarball install), commit becomes "unknown"
 * — non-fatal.
 */
import { execSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const distDir = join(root, 'dist');

if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true });

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

let commit = 'unknown';
try {
  commit = execSync('git rev-parse --short HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString().trim();
} catch {
  // not a git repo or git not on PATH — keep "unknown"
}

const stamp = {
  version: pkg.version,
  commit,
  builtAt: new Date().toISOString(),
  node: process.version,
};

writeFileSync(join(distDir, 'version.json'), JSON.stringify(stamp, null, 2) + '\n');
process.stdout.write(`[stamp-version] ${stamp.version} (${stamp.commit}) ${stamp.builtAt}\n`);
