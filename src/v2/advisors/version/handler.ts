// Copyright 2024 BeehiveInnovations / Omniforge Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// Ported from PAL MCP Server (Apache 2.0).
// Source: pal-mcp-server tools/version.py — class VersionTool
// © BeehiveInnovations — see ../NOTICE.md.
//
// AETHER ε.4: replaces the legacy `pal:version` stdio call. Reuses the same
// stamped `dist/version.json` lookup pattern used by mcp/http-server.ts so
// a single source of truth surfaces in CLI / HTTP /health / advisor.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import type { Advisor, AdvisorContext, AdvisorResult } from '../types.js';
import { getAdvisorMode } from '../shared/mode.js';
import { VersionInputSchema } from './schema.js';

const DESCRIPTION =
  'Return Omniforge version metadata (semver, git commit short-hash, build timestamp, node version). ' +
  'Useful for diagnostics, support tickets, and confirming a deployed daemon matches the operator\'s expectations.';

interface VersionInfo {
  version: string;
  commit?: string;
  builtAt?: string;
  node?: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function readVersion(): VersionInfo {
  // Same lookup order as src/mcp/http-server.ts readVersion(); keeps the
  // advisor and the HTTP /health route honest about a single source of truth.
  // dist/version.json is stamped by scripts/stamp-version.mjs at build time.
  const candidates = [
    path.resolve(__dirname, '..', '..', '..', 'version.json'),
    path.resolve(__dirname, '..', '..', 'version.json'),
    path.resolve(process.cwd(), 'dist', 'version.json'),
    path.resolve(process.cwd(), 'package.json'),
  ];
  for (const c of candidates) {
    try {
      const raw = readFileSync(c, 'utf8');
      const parsed = JSON.parse(raw) as VersionInfo;
      if (parsed && typeof parsed.version === 'string') {
        return parsed;
      }
    } catch {
      // try next candidate
    }
  }
  return { version: '0.0.0-unknown' };
}

function formatText(info: VersionInfo): string {
  const parts = [`omniforge ${info.version}`];
  if (info.commit) parts.push(`(${info.commit})`);
  if (info.builtAt) parts.push(`built ${info.builtAt}`);
  if (info.node) parts.push(`node ${info.node}`);
  return parts.join(' ');
}

export const versionAdvisor: Advisor = {
  name: 'version',
  description: DESCRIPTION,
  async run(ctx: AdvisorContext, args: unknown): Promise<AdvisorResult> {
    const parsed = VersionInputSchema.parse(args);
    void getAdvisorMode(ctx, args);
    const info = readVersion();

    if (parsed.format === 'text') {
      return { output: formatText(info) };
    }

    const json = JSON.stringify(info);
    return { output: json, structured: info };
  },
};
