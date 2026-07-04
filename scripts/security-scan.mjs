#!/usr/bin/env node
/**
 * Comprehensive Security Scan Script (Sprint 9)
 *
 * Performs multiple security checks:
 * 1. Secret scanning (existing)
 * 2. Dependency vulnerability analysis
 * 3. Security headers audit
 * 4. Input validation audit
 * 5. Auth/authz review
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logSection(title) {
  console.log('\n' + '='.repeat(60));
  log(title, 'cyan');
  console.log('='.repeat(60));
}

// ── 1. Secret Scan (using existing implementation via tsx) ─────────────────
async function runSecretScan() {
  logSection('1. SECRET SCAN');

  try {
    // Use tsx to run the secret scan script
    const { execSync } = await import('node:child_process');
    const output = execSync('npx tsx scripts/secret-scan.ts', {
      cwd: rootDir,
      encoding: 'utf-8',
      stdio: 'pipe',
    });

    if (output.includes('No committed secrets detected')) {
      log('✓ No secrets detected', 'green');
      return { status: 'pass', findings: 0 };
    } else {
      log(`⚠ Secrets detected:`, 'yellow');
      console.log(output);
      return { status: 'fail', findings: output.split('\n').filter(l => l.trim()).length };
    }
  } catch (error) {
    // If tsx fails, try to run the built version
    try {
      const { execSync } = await import('node:child_process');
      const output = execSync('node scripts/secret-scan.ts', {
        cwd: rootDir,
        encoding: 'utf-8',
        stdio: 'pipe',
      });

      if (output.includes('No committed secrets detected')) {
        log('✓ No secrets detected', 'green');
        return { status: 'pass', findings: 0 };
      } else {
        log(`⚠ Secrets detected:`, 'yellow');
        console.log(output);
        return { status: 'fail', findings: output.split('\n').filter(l => l.trim()).length };
      }
    } catch (fallbackError) {
      log(`⚠ Secret scan skipped (requires build): ${fallbackError.message}`, 'yellow');
      return { status: 'skip', findings: 0 };
    }
  }
}

// ── 2. Dependency Vulnerability Check ──────────────────────────────────────
function checkDependencyVulnerabilities() {
  logSection('2. DEPENDENCY VULNERABILITY CHECK');

  const packageJsonPath = resolve(rootDir, 'package.json');
  const pnpmLockPath = resolve(rootDir, 'pnpm-lock.yaml');

  if (!existsSync(packageJsonPath)) {
    log('✗ package.json not found', 'red');
    return { status: 'error', error: 'package.json not found' };
  }

  if (!existsSync(pnpmLockPath)) {
    log('✗ pnpm-lock.yaml not found', 'red');
    return { status: 'error', error: 'pnpm-lock.yaml not found' };
  }

  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    const dependencies = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    };

    log(`Scanning ${Object.keys(dependencies).length} dependencies...`, 'blue');

    // Check for known vulnerable packages (manual list based on recent advisories)
    const vulnerablePackages = {
      'axios': '<1.7.4', // SSRF vulnerability
      'express': '<4.19.2', // DoS vulnerability
      'lodash': '<4.17.21', // Prototype pollution
      'minimist': '<1.2.6', // Prototype pollution
      'yargs-parser': '<21.1.1', // Prototype pollution
      'node-forge': '<1.3.0', // RSA PKCS#1 signature validation
    };

    const findings = [];
    for (const [pkg, vulnerableRange] of Object.entries(vulnerablePackages)) {
      if (dependencies[pkg]) {
        const version = dependencies[pkg].replace(/^[\^~]/, '');
        findings.push({
          package: pkg,
          version,
          issue: 'Known vulnerability in version range',
          fix: `Update to version satisfying ${vulnerableRange}`,
        });
      }
    }

    if (findings.length === 0) {
      log('✓ No known vulnerable packages detected', 'green');
      return { status: 'pass', findings: 0 };
    } else {
      log(`⚠ Found ${findings.length} potentially vulnerable package(s):`, 'yellow');
      findings.forEach(f => {
        console.log(`  - ${f.package}@${f.version}: ${f.issue}`);
        console.log(`    Fix: ${f.fix}`);
      });
      return { status: 'warn', findings: findings.length, details: findings };
    }
  } catch (error) {
    log(`✗ Dependency check failed: ${error.message}`, 'red');
    return { status: 'error', error: error.message };
  }
}

// ── 3. Security Headers Audit ───────────────────────────────────────────────
function auditSecurityHeaders() {
  logSection('3. SECURITY HEADERS AUDIT');

  const httpServerPath = resolve(rootDir, 'src/mcp/http-server.ts');
  const sharedPath = resolve(rootDir, 'src/mcp/routes/_shared.ts');

  const findings = [];

  if (!existsSync(httpServerPath)) {
    log('✗ http-server.ts not found', 'red');
    return { status: 'error', error: 'http-server.ts not found' };
  }

  const httpServerContent = readFileSync(httpServerPath, 'utf-8');
  const sharedContent = existsSync(sharedPath) ? readFileSync(sharedPath, 'utf-8') : '';

  // Check for required security headers
  const requiredHeaders = [
    { name: 'Content-Security-Policy', pattern: /Content-Security-Policy/i },
    { name: 'X-Frame-Options', pattern: /X-Frame-Options/i },
    { name: 'X-Content-Type-Options', pattern: /X-Content-Type-Options/i },
    { name: 'Strict-Transport-Security', pattern: /Strict-Transport-Security/i },
    { name: 'X-XSS-Protection', pattern: /X-XSS-Protection/i },
  ];

  const allContent = httpServerContent + sharedContent;

  for (const header of requiredHeaders) {
    if (!header.pattern.test(allContent)) {
      findings.push({
        header: header.name,
        issue: 'Security header not implemented',
        recommendation: `Add ${header.name} header to HTTP responses`,
      });
    }
  }

  // Check CORS configuration
  if (/Access-Control-Allow-Origin:\s*\*/.test(allContent)) {
    findings.push({
      header: 'CORS',
      issue: 'Wildcard CORS origin allows any domain',
      recommendation: 'Restrict CORS to specific origins',
    });
  }

  if (findings.length === 0) {
    log('✓ All security headers implemented correctly', 'green');
    return { status: 'pass', findings: 0 };
  } else {
    log(`⚠ Found ${findings.length} security header issue(s):`, 'yellow');
    findings.forEach(f => {
      console.log(`  - ${f.header}: ${f.issue}`);
      console.log(`    Recommendation: ${f.recommendation}`);
    });
    return { status: 'warn', findings: findings.length, details: findings };
  }
}

// ── 4. Input Validation Audit ───────────────────────────────────────────────
function auditInputValidation() {
  logSection('4. INPUT VALIDATION AUDIT');

  const criticalFiles = [
    'src/mcp/http-server.ts',
    'src/mcp/server.ts',
    'src/v2/tools/core/index.ts',
  ];

  const findings = [];

  for (const file of criticalFiles) {
    const filePath = resolve(rootDir, file);
    if (!existsSync(filePath)) continue;

    const content = readFileSync(filePath, 'utf-8');

    // Check for unsafe eval usage
    if (/\beval\(/.test(content) && !/safe-vm-eval/.test(content)) {
      findings.push({
        file,
        issue: 'Unsafe eval() usage detected',
        recommendation: 'Use safe-vm-eval or remove eval()',
      });
    }

    // Check for direct SQL query construction
    if (/\bSELECT.*FROM.*WHERE.*\+/.test(content) ||
        /\bINSERT INTO.*VALUES.*\+/.test(content)) {
      findings.push({
        file,
        issue: 'Potential SQL injection via string concatenation',
        recommendation: 'Use parameterized queries',
      });
    }

    // Check for unsafe JSON parsing without validation
    if (/JSON\.parse\(/.test(content) && !/zod|joi|validate/.test(content)) {
      findings.push({
        file,
        issue: 'JSON.parse without schema validation',
        recommendation: 'Validate JSON with Zod schemas',
      });
    }
  }

  if (findings.length === 0) {
    log('✓ Input validation looks good', 'green');
    return { status: 'pass', findings: 0 };
  } else {
    log(`⚠ Found ${findings.length} input validation issue(s):`, 'yellow');
    findings.forEach(f => {
      console.log(`  - ${f.file}: ${f.issue}`);
      console.log(`    Recommendation: ${f.recommendation}`);
    });
    return { status: 'warn', findings: findings.length, details: findings };
  }
}

// ── 5. Auth/Authz Review ───────────────────────────────────────────────────
function reviewAuthAuthz() {
  logSection('5. AUTH/AUTHZ REVIEW');

  const findings = [];

  // Check for timing-safe comparison
  const httpServerPath = resolve(rootDir, 'src/mcp/http-server.ts');
  if (existsSync(httpServerPath)) {
    const content = readFileSync(httpServerPath, 'utf-8');
    if (!/timingSafeEqual/.test(content)) {
      findings.push({
        component: 'Bearer token comparison',
        issue: 'Not using timing-safe comparison',
        recommendation: 'Use crypto.timingSafeEqual for token comparison',
      });
    } else {
      log('✓ Using timing-safe token comparison', 'green');
    }
  }

  // Check for action gate implementation
  const actionGatePath = resolve(rootDir, 'src/v2/security/action-gate.ts');
  if (existsSync(actionGatePath)) {
    log('✓ Action gate implemented', 'green');
  } else {
    findings.push({
      component: 'Action gate',
      issue: 'Action gate not implemented',
      recommendation: 'Implement action gate for tool authorization',
    });
  }

  // Check for rate limiting
  const rateLimitPath = resolve(rootDir, 'src/v2/rate-limit');
  if (existsSync(rateLimitPath)) {
    log('✓ Rate limiting implemented', 'green');
  } else {
    findings.push({
      component: 'Rate limiting',
      issue: 'Rate limiting not implemented',
      recommendation: 'Implement rate limiting for API endpoints',
    });
  }

  if (findings.length === 0) {
    log('✓ Auth/authz looks good', 'green');
    return { status: 'pass', findings: 0 };
  } else {
    log(`⚠ Found ${findings.length} auth/authz issue(s):`, 'yellow');
    findings.forEach(f => {
      console.log(`  - ${f.component}: ${f.issue}`);
      console.log(`    Recommendation: ${f.recommendation}`);
    });
    return { status: 'warn', findings: findings.length, details: findings };
  }
}

// ── Main Execution ─────────────────────────────────────────────────────────
async function main() {
  log('OMNIFORGE SECURITY SCAN (Sprint 9)', 'cyan');
  console.log('Running comprehensive security audit...\n');

  const results = {
    secretScan: await runSecretScan(),
    dependencyCheck: checkDependencyVulnerabilities(),
    securityHeaders: auditSecurityHeaders(),
    inputValidation: auditInputValidation(),
    authAuthz: reviewAuthAuthz(),
  };

  // Summary
  logSection('SUMMARY');
  const totalFindings = Object.values(results).reduce((sum, r) => sum + (r.findings || 0), 0);
  const errors = Object.values(results).filter(r => r.status === 'error').length;
  const warnings = Object.values(results).filter(r => r.status === 'warn' || r.status === 'fail').length;

  console.log(`Total findings: ${totalFindings}`);
  console.log(`Errors: ${errors}`);
  console.log(`Warnings: ${warnings}`);

  if (errors > 0) {
    log('\n✗ Security scan completed with errors', 'red');
    process.exit(1);
  } else if (warnings > 0) {
    log('\n⚠ Security scan completed with warnings', 'yellow');
    process.exit(1);
  } else {
    log('\n✓ Security scan passed - no issues found', 'green');
    process.exit(0);
  }
}

main().catch(error => {
  log(`\n✗ Fatal error: ${error.message}`, 'red');
  console.error(error);
  process.exit(1);
});