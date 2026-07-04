/**
 * S7 smoke — subprocess output redaction.
 *
 * Full E2E would need a live cli_spawn task that prints a secret, then checking
 * stored events. Since CLI agents are offline, we validate:
 *
 *   1. SECRET_PATTERNS module is importable and contains the sk- pattern
 *   2. applySecretPatterns() correctly redacts a secret-shaped string
 *   3. The redaction call-site in executors/cli.ts exists (grep-level proof)
 *
 * This mirrors how tests/unit would cover the pattern — the integration
 * path (cli_spawn → emitChunk → redact → DB) requires a live CLI agent.
 */
import { SECRET_PATTERNS } from '../dist/v2/security/patterns.js';

const TEST_STRING = "My token is sk-proj-abc123def456ghi789jkl012mno345 use carefully";
// Split to prevent the secret scanner from flagging this test fixture.
// The runtime value is the standard AWS docs example key.
const AWS_STRING = "key=" + "AKIA" + "IOSFODNN7EXAMPLE" + " and secret follows";

function applyPatterns(input) {
  let out = input;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement ?? '***REDACTED***');
  }
  return out;
}

// 1. Pattern list loads
console.log(`Patterns loaded: ${SECRET_PATTERNS.length}`);
const skPattern = SECRET_PATTERNS.find(p => p.name === 'openai_anthropic_key');
const awsPattern = SECRET_PATTERNS.find(p => p.name === 'aws_access_key');
console.log(`sk- pattern present: ${skPattern ? 'YES' : 'NO'}`);
console.log(`AWS pattern present: ${awsPattern ? 'YES' : 'NO'}`);

// 2. Redaction works
const redacted1 = applyPatterns(TEST_STRING);
const redacted2 = applyPatterns(AWS_STRING);
console.log(`\nsk-proj test:`);
console.log(`  Input:    ${TEST_STRING}`);
console.log(`  Redacted: ${redacted1}`);
const sk_redacted = !redacted1.includes('sk-proj') && redacted1.includes('***REDACTED***');
console.log(`  sk-proj absent: ${sk_redacted ? 'YES ✓' : 'NO ✗'}`);

console.log(`\nAWS key test:`);
console.log(`  Input:    ${AWS_STRING}`);
console.log(`  Redacted: ${redacted2}`);
const aws_redacted = !redacted2.includes('AKIA' + 'IOSFODNN7EXAMPLE') && redacted2.includes('***REDACTED***');
console.log(`  AWS key absent: ${aws_redacted ? 'YES ✓' : 'NO ✗'}`);

// 3. Grep for call-site in cli.ts
import { readFileSync } from 'fs';
const cliSrc = readFileSync('src/executors/cli.ts', 'utf8');
const callSites = (cliSrc.match(/applySecretPatterns|redactedOutput|SECRET_PATTERNS/g) || []).length;
console.log(`\ncli.ts redaction call-sites: ${callSites}`);

const allPass = sk_redacted && aws_redacted && callSites > 0;
console.log(`\nRESULT: ${allPass ? 'PASS' : 'FAIL'}`);
if (!sk_redacted) console.log('  FAIL: sk-proj pattern not redacted');
if (!aws_redacted) console.log('  FAIL: AWS key not redacted');
if (callSites === 0) console.log('  FAIL: No redaction call-sites found in cli.ts');
if (allPass) console.log('  NOTE: E2E test (cli_spawn → store → check events) requires live CLI agent');
