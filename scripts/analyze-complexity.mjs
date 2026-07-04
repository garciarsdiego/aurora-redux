#!/usr/bin/env node
/**
 * Code Complexity Analyzer
 * 
 * Analyzes TypeScript/JavaScript files for complexity metrics:
 * - Lines of code (LOC)
 * - Cyclomatic complexity
 * - Function length
 * - Nesting depth
 * - Parameter count
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SOURCE_DIR = join(ROOT, 'src');
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

// Thresholds
const THRESHOLDS = {
  maxFileLoc: 500,
  maxFunctionLoc: 50,
  maxComplexity: 10,
  maxNestingDepth: 4,
  maxParameters: 5,
};

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
      } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
        files.push(fullPath);
      }
    }
  } catch (error) {
    // Ignore permission errors
  }
  
  return files;
}

function analyzeFile(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  
  // Calculate LOC (excluding empty lines and comments)
  let loc = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')) {
      loc++;
    }
  }
  
  // Find functions and analyze them
  const functions = [];
  const functionRegex = /(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:function|\([^)]*\)\s*=>)|(?:async\s+)?(\w+)\s*\([^)]*\)\s*{)/g;
  let match;
  
  while ((match = functionRegex.exec(content)) !== null) {
    const funcName = match[1] || match[2] || match[3] || 'anonymous';
    const startPos = match.index;
    
    // Find function body
    let braceCount = 0;
    let inFunction = false;
    let endPos = startPos;
    
    for (let i = startPos; i < content.length; i++) {
      if (content[i] === '{') {
        braceCount++;
        inFunction = true;
      } else if (content[i] === '}') {
        braceCount--;
        if (inFunction && braceCount === 0) {
          endPos = i;
          break;
        }
      }
    }
    
    const functionContent = content.substring(startPos, endPos + 1);
    const functionLines = functionContent.split('\n');
    const functionLoc = functionLines.filter(l => l.trim() && !l.trim().startsWith('//')).length;
    
    // Calculate cyclomatic complexity (simplified)
    const complexity = (functionContent.match(/\b(if|else|for|while|case|catch|&&|\|\|)\b/g) || []).length + 1;
    
    // Calculate nesting depth
    let maxDepth = 0;
    let currentDepth = 0;
    for (const char of functionContent) {
      if (char === '{') {
        currentDepth++;
        maxDepth = Math.max(maxDepth, currentDepth);
      } else if (char === '}') {
        currentDepth--;
      }
    }
    
    // Count parameters
    const paramMatch = functionContent.match(/\(([^)]*)\)/);
    const paramCount = paramMatch ? paramMatch[1].split(',').filter(p => p.trim()).length : 0;
    
    functions.push({
      name: funcName,
      loc: functionLoc,
      complexity,
      nestingDepth: maxDepth,
      parameterCount: paramCount,
      line: content.substring(0, startPos).split('\n').length,
    });
  }
  
  return {
    filePath: relative(ROOT, filePath),
    loc,
    functions,
  };
}

function checkThresholds(value, threshold, type) {
  if (value > threshold) {
    return { exceeds: true, ratio: value / threshold };
  }
  return { exceeds: false };
}

function main() {
  console.log(colorize('🔍 Analyzing code complexity...', 'blue'));
  console.log('');
  
  const files = getFiles(SOURCE_DIR, ROOT);
  console.log(colorize(`Found ${files.length} files to analyze`, 'gray'));
  console.log('');
  
  const analyses = [];
  const issues = [];
  
  for (const file of files) {
    const analysis = analyzeFile(file);
    analyses.push(analysis);
    
    // Check file LOC
    const fileLocCheck = checkThresholds(analysis.loc, THRESHOLDS.maxFileLoc, 'file');
    if (fileLocCheck.exceeds) {
      issues.push({
        type: 'file_loc',
        file: analysis.filePath,
        value: analysis.loc,
        threshold: THRESHOLDS.maxFileLoc,
        ratio: fileLocCheck.ratio,
      });
    }
    
    // Check functions
    for (const func of analysis.functions) {
      const funcLocCheck = checkThresholds(func.loc, THRESHOLDS.maxFunctionLoc, 'function');
      if (funcLocCheck.exceeds) {
        issues.push({
          type: 'function_loc',
          file: analysis.filePath,
          function: func.name,
          line: func.line,
          value: func.loc,
          threshold: THRESHOLDS.maxFunctionLoc,
          ratio: funcLocCheck.ratio,
        });
      }
      
      const complexityCheck = checkThresholds(func.complexity, THRESHOLDS.maxComplexity, 'complexity');
      if (complexityCheck.exceeds) {
        issues.push({
          type: 'complexity',
          file: analysis.filePath,
          function: func.name,
          line: func.line,
          value: func.complexity,
          threshold: THRESHOLDS.maxComplexity,
          ratio: complexityCheck.ratio,
        });
      }
      
      const nestingCheck = checkThresholds(func.nestingDepth, THRESHOLDS.maxNestingDepth, 'nesting');
      if (nestingCheck.exceeds) {
        issues.push({
          type: 'nesting',
          file: analysis.filePath,
          function: func.name,
          line: func.line,
          value: func.nestingDepth,
          threshold: THRESHOLDS.maxNestingDepth,
          ratio: nestingCheck.ratio,
        });
      }
      
      const paramCheck = checkThresholds(func.parameterCount, THRESHOLDS.maxParameters, 'parameters');
      if (paramCheck.exceeds) {
        issues.push({
          type: 'parameters',
          file: analysis.filePath,
          function: func.name,
          line: func.line,
          value: func.parameterCount,
          threshold: THRESHOLDS.maxParameters,
          ratio: paramCheck.ratio,
        });
      }
    }
  }
  
  // Calculate statistics
  const totalLoc = analyses.reduce((sum, a) => sum + a.loc, 0);
  const totalFunctions = analyses.reduce((sum, a) => sum + a.functions.length, 0);
  const avgFileLoc = totalLoc / analyses.length;
  const avgFunctionLoc = analyses.reduce((sum, a) => 
    sum + a.functions.reduce((s, f) => s + f.loc, 0), 0) / totalFunctions;
  
  console.log(colorize('📊 Statistics:', 'blue'));
  console.log(`  Total files: ${analyses.length}`);
  console.log(`  Total LOC: ${totalLoc}`);
  console.log(`  Total functions: ${totalFunctions}`);
  console.log(`  Average file LOC: ${avgFileLoc.toFixed(1)}`);
  console.log(`  Average function LOC: ${avgFunctionLoc.toFixed(1)}`);
  console.log('');
  
  // Report issues
  if (issues.length > 0) {
    console.log(colorize(`⚠️  Found ${issues.length} complexity issues`, 'yellow'));
    console.log('');
    
    // Group by type
    const byType = {};
    for (const issue of issues) {
      if (!byType[issue.type]) {
        byType[issue.type] = [];
      }
      byType[issue.type].push(issue);
    }
    
    for (const [type, typeIssues] of Object.entries(byType)) {
      console.log(colorize(`\n${type.toUpperCase()}:`, 'cyan'));
      
      for (const issue of typeIssues) {
        const ratioColor = issue.ratio > 2 ? 'red' : 'yellow';
        console.log(`  ${colorize(issue.file, 'gray')}${issue.function ? `:${issue.function}` : ''}${issue.line ? `:${issue.line}` : ''}`);
        console.log(`    ${issue.value} / ${issue.threshold} (${colorize(`${issue.ratio.toFixed(1)}x`, ratioColor)})`);
      }
    }
    
    console.log('');
    console.log(colorize('💡 Suggestions:', 'blue'));
    console.log('  - Split large files into smaller modules');
    console.log('  - Extract complex functions into smaller ones');
    console.log('  - Reduce nesting depth using early returns');
    console.log('  - Use objects for functions with many parameters');
    console.log('');
    
    process.exit(1);
  } else {
    console.log(colorize('✅ No complexity issues found!', 'green'));
    process.exit(0);
  }
}

main();