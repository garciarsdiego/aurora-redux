#!/usr/bin/env node
// Read-only inspector for the reflection_store table (Week 4 deliverable).
// Usage:
//   node scripts/inspect-reflections.mjs [--db <path>] [--limit N]
//
// Prints two views:
//   1) Top N reflections by relevance (FTS5 rank if a query given, else by score/weight column if present, else most-cited)
//   2) Top N reflections by age (newest first)
//
// Strictly read-only. Opens the DB with `readonly: true`.

import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  return args[i + 1];
}

const DB_PATH = path.resolve(flag('--db', 'data/omniforge.db'));
const LIMIT = Number(flag('--limit', '20'));

if (!fs.existsSync(DB_PATH)) {
  console.error(`[inspect-reflections] DB not found at ${DB_PATH}`);
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

// Confirm the table exists
const tableRow = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='reflection_store'")
  .get();
if (!tableRow) {
  console.error('[inspect-reflections] reflection_store table not present. Has migration 055 run?');
  process.exit(2);
}

// Discover columns so we adapt to schema drift
const cols = db.prepare("PRAGMA table_info(reflection_store)").all().map((r) => r.name);
const has = (c) => cols.includes(c);

const idCol = has('id') ? 'id' : (cols[0] || 'rowid');
const createdCol = has('created_at') ? 'created_at' : has('inserted_at') ? 'inserted_at' : has('ts') ? 'ts' : null;
const workflowCol = has('workflow_id') ? 'workflow_id' : null;
const lessonCol = has('lesson') ? 'lesson' : has('content') ? 'content' : has('text') ? 'text' : null;
const tagsCol = has('tags') ? 'tags' : null;
const scoreCol = has('relevance') ? 'relevance' : has('score') ? 'score' : has('weight') ? 'weight' : null;

const total = db.prepare('SELECT COUNT(*) AS n FROM reflection_store').get().n;
console.log(`reflection_store: ${total} rows (db=${DB_PATH})`);
console.log('columns:', cols.join(', '));
console.log('');

function truncate(s, n = 140) {
  if (!s) return '';
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function fmtRow(r, i) {
  const id = r[idCol];
  const wf = workflowCol ? r[workflowCol] : '';
  const created = createdCol ? r[createdCol] : '';
  const score = scoreCol ? r[scoreCol] : '';
  const tags = tagsCol ? r[tagsCol] : '';
  const lesson = lessonCol ? truncate(r[lessonCol]) : '';
  return `${String(i + 1).padStart(2)}. [${id}] ${created || ''} ${wf ? `wf=${wf}` : ''} ${score !== '' ? `score=${score}` : ''} ${tags ? `tags=${tags}` : ''}\n     ${lesson}`;
}

// --- Top N by relevance ---
console.log(`=== Top ${LIMIT} by relevance ===`);
let relSql;
if (scoreCol) {
  relSql = `SELECT * FROM reflection_store ORDER BY ${scoreCol} DESC, ${createdCol || idCol} DESC LIMIT ?`;
} else if (createdCol) {
  // No explicit score: surface the most recent (proxy for "freshly relevant")
  relSql = `SELECT * FROM reflection_store ORDER BY ${createdCol} DESC LIMIT ?`;
} else {
  relSql = `SELECT * FROM reflection_store LIMIT ?`;
}
const byRelevance = db.prepare(relSql).all(LIMIT);
if (byRelevance.length === 0) {
  console.log('(no rows)');
} else {
  byRelevance.forEach((r, i) => console.log(fmtRow(r, i)));
}
console.log('');

// --- Top N by age (newest first) ---
console.log(`=== Top ${LIMIT} by age (newest first) ===`);
let ageSql;
if (createdCol) {
  ageSql = `SELECT * FROM reflection_store ORDER BY ${createdCol} DESC LIMIT ?`;
} else {
  ageSql = `SELECT * FROM reflection_store ORDER BY ${idCol} DESC LIMIT ?`;
}
const byAge = db.prepare(ageSql).all(LIMIT);
if (byAge.length === 0) {
  console.log('(no rows)');
} else {
  byAge.forEach((r, i) => console.log(fmtRow(r, i)));
}

db.close();
