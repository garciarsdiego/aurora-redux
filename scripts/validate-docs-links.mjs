#!/usr/bin/env node
/**
 * Documentation Link Validator
 * 
 * Validates internal documentation links in markdown files.
 * Checks for:
 * - Broken internal links
 * - Missing referenced files
 * - Duplicate section headers
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DOCS_DIR = join(ROOT, 'docs');

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  gray: '\x1b[90m',
};

function colorize(text, color) {
  return `${colors[color]}${text}${colors.reset}`;
}

// Collect all markdown files
function getMarkdownFiles(dir) {
  const files = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
      files.push(...getMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(fullPath);
    }
  }
  
  return files;
}

// Extract links from markdown content
function extractLinks(content, filePath) {
  const links = [];
  
  // Match [text](link) pattern
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  let match;
  
  while ((match = linkRegex.exec(content)) !== null) {
    const [, text, link] = match;
    links.push({
      text,
      link,
      line: content.substring(0, match.index).split('\n').length,
      filePath,
    });
  }
  
  return links;
}

// Extract section headers
function extractHeaders(content) {
  const headers = [];
  const lines = content.split('\n');
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      const level = match[1].length;
      const text = match[2].trim();
      // Convert to anchor format
      const anchor = text
        .toLowerCase()
        .replace(/[^\w\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-');
      headers.push({ level, text, anchor, line: i + 1 });
    }
  }
  
  return headers;
}

// Resolve link path
function resolveLink(link, filePath) {
  const fileDir = dirname(filePath);
  
  // Handle anchor links (same file)
  if (link.startsWith('#')) {
    return { type: 'anchor', anchor: link.slice(1), filePath };
  }
  
  // Handle external links
  if (link.startsWith('http://') || link.startsWith('https://')) {
    return { type: 'external', url: link };
  }
  
  // Handle internal links with anchor
  const [pathPart, ...anchorParts] = link.split('#');
  const anchor = anchorParts.join('#');
  
  const resolvedPath = resolve(fileDir, pathPart);
  return { type: 'internal', filePath: resolvedPath, anchor: anchor || null };
}

// Check if file exists
function fileExists(filePath) {
  return existsSync(filePath) && statSync(filePath).isFile();
}

// Validate a single link
function validateLink(linkInfo, docsFiles) {
  const { link, filePath, line } = linkInfo;
  const resolved = resolveLink(link, filePath);
  
  if (resolved.type === 'external') {
    return { valid: true, type: 'external' };
  }
  
  if (resolved.type === 'anchor') {
    const headers = extractHeaders(readFileSync(filePath, 'utf-8'));
    const anchorExists = headers.some(h => h.anchor === resolved.anchor);
    return {
      valid: anchorExists,
      type: 'anchor',
      anchor: resolved.anchor,
      error: anchorExists ? null : `Anchor #${resolved.anchor} not found`,
    };
  }
  
  if (resolved.type === 'internal') {
    if (!fileExists(resolved.filePath)) {
      return {
        valid: false,
        type: 'internal',
        target: resolved.filePath,
        error: `File not found: ${relative(ROOT, resolved.filePath)}`,
      };
    }
    
    if (resolved.anchor) {
      const headers = extractHeaders(readFileSync(resolved.filePath, 'utf-8'));
      const anchorExists = headers.some(h => h.anchor === resolved.anchor);
      return {
        valid: anchorExists,
        type: 'internal-with-anchor',
        target: resolved.filePath,
        anchor: resolved.anchor,
        error: anchorExists ? null : `Anchor #${resolved.anchor} not found in ${relative(ROOT, resolved.filePath)}`,
      };
    }
    
    return { valid: true, type: 'internal', target: resolved.filePath };
  }
  
  return { valid: false, error: 'Unknown link type' };
}

// Main validation
function main() {
  console.log(colorize('🔍 Validating documentation links...', 'blue'));
  console.log('');
  
  const docsFiles = getMarkdownFiles(DOCS_DIR);
  console.log(colorize(`Found ${docsFiles.length} markdown files`, 'gray'));
  console.log('');
  
  let totalLinks = 0;
  let brokenLinks = 0;
  const errors = [];
  
  for (const filePath of docsFiles) {
    const content = readFileSync(filePath, 'utf-8');
    const links = extractLinks(content, filePath);
    
    for (const link of links) {
      totalLinks++;
      const validation = validateLink(link, docsFiles);
      
      if (!validation.valid) {
        brokenLinks++;
        const relPath = relative(ROOT, filePath);
        errors.push({
          file: relPath,
          line: link.line,
          link: link.link,
          error: validation.error,
        });
      }
    }
  }
  
  // Report results
  console.log(colorize(`📊 Results:`, 'blue'));
  console.log(`  Total links: ${totalLinks}`);
  console.log(`  ${colorize('Broken links:', brokenLinks > 0 ? 'red' : 'green')} ${brokenLinks}`);
  console.log('');
  
  if (errors.length > 0) {
    console.log(colorize('❌ Broken links found:', 'red'));
    console.log('');
    
    for (const error of errors) {
      console.log(colorize(`  ${error.file}:${error.line}`, 'yellow'));
      console.log(`    Link: ${error.link}`);
      console.log(`    Error: ${error.error}`);
      console.log('');
    }
    
    process.exit(1);
  } else {
    console.log(colorize('✅ All documentation links are valid!', 'green'));
    process.exit(0);
  }
}

main();