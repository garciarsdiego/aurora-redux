#!/usr/bin/env node

/**
 * Validate golden cases against TestCase interface (simple regex-based validation)
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const goldenCasesPath = join(__dirname, '..', 'src', 'v2', 'evals', 'datasets', 'golden-cases.ts');
const content = readFileSync(goldenCasesPath, 'utf-8');

console.log(`🔍 Validating golden cases...\n`);

let errors = 0;
let warnings = 0;

// Count cases by looking for id: pattern
const idMatches = content.match(/id:\s*['"]/g);
const caseCount = idMatches ? idMatches.length : 0;
console.log(`📊 Total cases found: ${caseCount}\n`);

// Required fields to check for
const requiredFields = ['id', 'workspace', 'suite', 'name', 'input', 'expected', 'tags', 'source', 'created_at'];
const validSuites = ['decomposer', 'planner', 'reviewer', 'integration', 'custom'];
const validSources = ['manual', 'synthetic', 'replay'];

// Category tracking
const categories = {
  'feature-implementation': 0,
  'refactoring': 0,
  'bug-fixing': 0,
  'documentation': 0,
  'testing': 0,
  'other': 0
};

const techStacks = new Set();

// Extract case blocks
const caseBlocks = content.split(/  \{/).filter(block => block.includes('id:'));

for (let i = 0; i < caseBlocks.length; i++) {
  const block = caseBlocks[i];
  const caseNum = i + 1;

  // Extract name
  const nameMatch = block.match(/name:\s*['"]([^'"]+)['"]/);
  const name = nameMatch ? nameMatch[1] : 'Unknown';
  console.log(`📋 Case ${caseNum}: ${name}`);

  // Check required fields
  for (const field of requiredFields) {
    const fieldPattern = new RegExp(`${field}:`);
    if (!fieldPattern.test(block)) {
      console.error(`  ❌ Missing required field: ${field}`);
      errors++;
    }
  }

  // Validate suite
  const suiteMatch = block.match(/suite:\s*['"]([^'"]+)['"]/);
  if (suiteMatch) {
    const suite = suiteMatch[1];
    if (!validSuites.includes(suite)) {
      console.error(`  ❌ Invalid suite: ${suite} (must be one of: ${validSuites.join(', ')})`);
      errors++;
    }
  }

  // Validate source
  const sourceMatch = block.match(/source:\s*['"]([^'"]+)['"]/);
  if (sourceMatch) {
    const source = sourceMatch[1];
    if (!validSources.includes(source)) {
      console.error(`  ❌ Invalid source: ${source} (must be one of: ${validSources.join(', ')})`);
      errors++;
    }
  }

  // Track categories from name
  if (name.includes('feature-implementation')) categories['feature-implementation']++;
  else if (name.includes('refactoring')) categories['refactoring']++;
  else if (name.includes('bug-fixing')) categories['bug-fixing']++;
  else if (name.includes('documentation')) categories['documentation']++;
  else if (name.includes('testing')) categories['testing']++;
  else categories['other']++;

  // Track tech stacks from tags
  const tagsMatch = block.match(/tags:\s*\[([^\]]+)\]/);
  if (tagsMatch) {
    const tagsStr = tagsMatch[1];
    const techTags = ['react', 'typescript', 'node', 'python', 'go', 'sql', 'javascript'];
    for (const tag of techTags) {
      if (tagsStr.includes(`'${tag}'`) || tagsStr.includes(`"${tag}"`)) {
        techStacks.add(tag);
      }
    }
  }

  // Check for context (optional but recommended)
  if (!block.includes('context:')) {
    console.warn(`  ⚠️  Missing context field (recommended)`);
    warnings++;
  }

  // Check for input.objective (recommended)
  if (!block.includes('input.objective') && !block.includes('objective:')) {
    console.warn(`  ⚠️  Missing input.objective (recommended)`);
    warnings++;
  }

  // Check for expected.status (recommended)
  if (!block.includes('expected.status') && !block.includes("status: 'completed'")) {
    console.warn(`  ⚠️  Missing expected.status (recommended)`);
    warnings++;
  }

  if (errors === 0 && warnings === 0) {
    console.log(`  ✅ Valid`);
  }
}

console.log('\n' + '='.repeat(60));
console.log('📊 Summary');
console.log('='.repeat(60));
console.log(`Total cases: ${caseCount}`);
console.log(`Errors: ${errors}`);
console.log(`Warnings: ${warnings}`);
console.log('\n📁 Categories:');
for (const [cat, count] of Object.entries(categories)) {
  console.log(`  ${cat}: ${count}`);
}
console.log('\n🔧 Tech stacks covered:');
console.log(`  ${Array.from(techStacks).sort().join(', ') || 'none detected'}`);

if (errors === 0) {
  console.log('\n✅ All golden cases are valid!');
  process.exit(0);
} else {
  console.log(`\n❌ Validation failed with ${errors} error(s)`);
  process.exit(1);
}