#!/usr/bin/env tsx
import { resolve } from 'node:path';
import { formatSecretFindings, scanDirectory } from '../src/v2/security/secret-scan.js';

const root = resolve(process.argv[2] ?? process.cwd());
const findings = scanDirectory(root);

if (findings.length > 0) {
  process.stderr.write(`Secret scan failed with ${findings.length} finding(s):\n`);
  process.stderr.write(`${formatSecretFindings(findings)}\n`);
  process.exit(1);
}

process.stdout.write(`${formatSecretFindings(findings)}\n`);
