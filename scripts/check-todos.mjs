#!/usr/bin/env node
/**
 * TODO/FIXME Checker
 * 
 * Scans the codebase for TODO, FIXME, and similar comments.
 * Helps track technical debt and pending work.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SOURCE_DIRS = ['src', 'apps', 'tests'];
const EXCLUDE_PATTERNS = ['node_modules', 'dist', '.git', 'coverage'];

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

function colorize(text, color) {
  return `${colors[color]}${text}${colors.reset}`;
}

// Patterns to search for
const PATTERNS = [
  { regex: /TODO[:\s]*(.*)/i, label: 'TODO', priority: 'medium' },
  { regex: /FIXME[:\s]*(.*)/i, label: 'FIXME', priority: 'high' },
  { regex: /HACK[:\s]*(.*)/i, label: 'HACK', priority: 'high' },
  { regex: /XXX[:\s]*(.*)/i, label: 'XXX', priority: 'medium' },
  { regex: /NOTE[:\s]*(.*)/i, label: 'NOTE', priority: 'low' },
  { regex: /WARN(?:ING)?[:\s]*(.*)/i, label: 'WARN', priority: 'medium' },
];

// File extensions to scan
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'];

function shouldExclude(path) {
  return EXCLUDE_PATTERNS.some(pattern => path.includes(pattern));
}

function getFiles(dir, baseDir = dir) {
  const files = [];
  
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relPath = relative(baseDir, fullPath);
      
      if (shouldExclude(relPath)) {
        continue;
      }
      
      if (entry.isDirectory()) {
        files.push(...getFiles(fullPath, baseDir));
      } else if (entry.isFile()) {
        const ext = entry.name.toLowerCase();
        if (EXTENSIONS.some(e => ext.endsWith(e))) {
          files.push(fullPath);
        }
      }
    }
  } catch (error) {
    // Ignore permission errors
  }
  
  return files;
}

function scanFile(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const findings = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;
    
    for (const pattern of PATTERNS) {
      const match = line.match(pattern.regex);
      if (match) {
        findings.push({
          type: pattern.label,
          priority: pattern.priority,
          line: lineNumber,
          content: match[1].trim(),
          context: line.trim(),
        });
      }
    }
  }
  
  return findings;
}

function main() {
  console.log(colorize('🔍 Scanning for TODOs, FIXMEs, and similar comments...', 'blue'));
  console.log('');
  
  const files = [];
  for (const dir of SOURCE_DIRS) {
    const fullPath = join(ROOT, dir);
    if (statSync(fullPath, { throwIfNoEntry: false })?.isDirectory()) {
      files.push(...getFiles(fullPath, ROOT));
    }
  }
  
  console.log(colorize(`Found ${files.length} files to scan`, 'gray'));
  console.log('');
  
  const allFindings = [];
  
  for (const file of files) {
    const findings = scanFile(file);
    if (findings.length > 0) {
      allFindings.push({
        file: relative(ROOT, file),
        findings,
      });
    }
  }
  
  // Group by type
  const byType = {};
  for (const fileFinding of allFindings) {
    for (const finding of fileFinding.findings) {
      if (!byType[finding.type]) {
        byType[finding.type] = [];
      }
      byType[finding.type].push({
        file: fileFinding.file,
        ...finding,
      });
    }
  }
  
  // Report summary
  const totalCount = allFindings.reduce((sum, f) => sum + f.findings.length, 0);
  console.log(colorize('📊 Summary:', 'blue'));
  console.log(`  Total findings: ${totalCount}`);
  
  for (const [type, items] of Object.entries(byType)) {
    const count = items.length;
    const color = type === 'FIXME' || type === 'HACK' ? 'red' : 'yellow';
    console.log(`  ${colorize(type, color)}: ${count}`);
  }
  console.log('');
  
  // Report by file
  if (allFindings.length > 0) {
    console.log(colorize('📝 Findings by file:', 'blue'));
    console.log('');
    
    for (const { file, findings } of allFindings.sort((a, b) => 
      a.file.localeCompare(b.file)
    )) {
      console.log(colorize(file, 'cyan'));
      
      for (const finding of findings) {
        const priorityColor = finding.priority === 'high' ? 'red' : 
                             finding.priority === 'medium' ? 'yellow' : 'gray';
        console.log(`  ${colorize(`[${finding.type}]`, priorityColor)}:${finding.line}`);
        console.log(`    ${finding.context}`);
        if (finding.content) {
          console.log(`    ${colorize(finding.content, 'gray')}`);
        }
        console.log('');
      }
    }
    
    // Exit with error if high priority items found
    const highPriorityCount = Object.values(byType)
      .flat()
      .filter(f => f.priority === 'high').length;
    
    if (highPriorityCount > 0) {
      console.log(colorize(`⚠️  Found ${highPriorityCount} high-priority items`, 'yellow'));
      process.exit(1);
    }
  } else {
    console.log(colorize('✅ No TODOs, FIXMEs, or similar comments found!', 'green'));
    process.exit(0);
  }
}

main();