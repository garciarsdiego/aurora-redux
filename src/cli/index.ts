#!/usr/bin/env node
import { Command } from 'commander';
import { registerRun } from './commands/run.js';
import { registerRunDag } from './commands/runDag.js';
import { registerStatus } from './commands/status.js';
import { registerList } from './commands/list.js';
import { registerInit } from './commands/init.js';
import { registerPatterns } from './commands/patterns.js';
import { registerImport } from './commands/importPattern.js';
import { registerExport } from './commands/exportPattern.js';
import { registerMcpServer } from './commands/mcp-server.js';
import { registerDaemon } from './commands/daemon.js';
import { registerRepl } from './commands/repl.js';
import { registerDoctor } from './commands/doctor.js';
import { registerHelp } from './commands/help.js';
import { registerResume } from './commands/resume.js';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Read version from dist/version.json (stamped at build) with package.json fallback.
function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const stampPath = join(here, '..', 'version.json');
    if (existsSync(stampPath)) {
      const stamp = JSON.parse(readFileSync(stampPath, 'utf8')) as {
        version: string; commit?: string;
      };
      return `${stamp.version}${stamp.commit ? ` (${stamp.commit})` : ''}`;
    }
    const pkgPath = join(here, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0-unknown';
  }
}

const program = new Command();

program
  .name('omniforge')
  .description('Omniforge — multi-agent orchestration (personal tool)')
  .version(readVersion());

registerRun(program);
registerRunDag(program);
registerStatus(program);
registerList(program);
registerInit(program);
registerPatterns(program);
registerImport(program);
registerExport(program);
registerMcpServer(program);
registerDaemon(program);
registerRepl(program);
registerDoctor(program);
registerHelp(program);
registerResume(program);

program.parse();
