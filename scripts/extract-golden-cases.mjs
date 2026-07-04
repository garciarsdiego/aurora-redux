#!/usr/bin/env node

/**
 * Extract golden cases from historical completed workflows
 *
 * Filters:
 * - final_status='completed'
 * - Analyzes quality (DAG structure, tasks, outcomes)
 *
 * NOTE: The current database has limited historical data.
 * As workflows are completed, this script can extract real cases.
 * For now, most golden cases are synthetic (see src/v2/evals/datasets/golden-cases.ts).
 */

import Database from 'better-sqlite3';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DB_PATH = join(__dirname, '..', 'data', 'omniforge.db');

// No date filter - get all historical completed workflows
const db = new Database(DB_PATH, { readonly: true });

console.log('🔍 Extracting golden cases from all historical completed workflows...');

// Query completed workflows
const workflows = db.prepare(`
  SELECT
    id,
    workspace,
    objective,
    pattern_id,
    status,
    started_at,
    completed_at,
    created_at,
    created_by,
    estimated_cost_usd,
    actual_cost_usd,
    metadata
  FROM workflows
  WHERE status = 'completed'
  ORDER BY created_at DESC
  LIMIT 100
`).all();

console.log(`\n📊 Found ${workflows.length} completed workflows total`);

// Analyze each workflow
const goldenCandidates = [];

for (const wf of workflows) {
  const tasks = db.prepare(`
    SELECT
      id,
      name,
      kind,
      status,
      depends_on_json,
      started_at,
      completed_at,
      acceptance_criteria,
      refine_count,
      max_refine,
      model
    FROM tasks
    WHERE workflow_id = ?
    ORDER BY created_at ASC
  `).all(wf.id);

  const events = db.prepare(`
    SELECT type, payload_json, timestamp
    FROM events
    WHERE workflow_id = ?
    ORDER BY timestamp ASC
    LIMIT 20
  `).all(wf.id);

  const reviews = db.prepare(`
    SELECT score, passed, feedback
    FROM reviews
    WHERE workflow_id = ?
  `).all(wf.id);

  // Quality analysis
  const quality = analyzeWorkflowQuality(wf, tasks, events, reviews);

  if (quality.score >= 0.7) {
    goldenCandidates.push({
      workflow: wf,
      tasks,
      events,
      reviews,
      quality
    });
  }
}

console.log(`\n✨ Found ${goldenCandidates.length} high-quality golden candidates`);

// Categorize candidates
const categories = categorizeWorkflows(goldenCandidates);
console.log('\n📁 Categories:');
for (const [cat, count] of Object.entries(categories)) {
  console.log(`  ${cat}: ${count}`);
}

// Generate golden cases file
generateGoldenCasesFile(goldenCandidates);

db.close();

function analyzeWorkflowQuality(workflow, tasks, events, reviews) {
  let score = 0;
  const reasons = [];

  // 1. Task completion rate (30%)
  const completedTasks = tasks.filter(t => t.status === 'completed').length;
  const taskCompletionRate = tasks.length > 0 ? completedTasks / tasks.length : 0;
  score += taskCompletionRate * 0.3;
  reasons.push(`Task completion: ${(taskCompletionRate * 100).toFixed(0)}%`);

  // 2. DAG structure quality (25%)
  const depGraph = buildDependencyGraph(tasks);
  const hasValidDag = validateDagStructure(depGraph);
  score += hasValidDag ? 0.25 : 0;
  reasons.push(`DAG valid: ${hasValidDag ? 'yes' : 'no'}`);

  // 3. Refine efficiency (15%)
  const totalRefines = tasks.reduce((sum, t) => sum + (t.refine_count || 0), 0);
  const maxRefines = tasks.reduce((sum, t) => sum + (t.max_refine || 2), 0);
  const refineEfficiency = maxRefines > 0 ? 1 - (totalRefines / maxRefines) : 1;
  score += refineEfficiency * 0.15;
  reasons.push(`Refine efficiency: ${(refineEfficiency * 100).toFixed(0)}%`);

  // 4. Cost efficiency (15%)
  const costEfficiency = workflow.estimated_cost_usd > 0
    ? Math.min(1, workflow.estimated_cost_usd / (workflow.actual_cost_usd || 1))
    : 1;
  score += costEfficiency * 0.15;
  reasons.push(`Cost efficiency: ${(costEfficiency * 100).toFixed(0)}%`);

  // 5. Review scores (15%)
  const avgReviewScore = reviews.length > 0
    ? reviews.reduce((sum, r) => sum + r.score, 0) / reviews.length
    : 0.8;
  score += avgReviewScore * 0.15;
  reasons.push(`Avg review score: ${(avgReviewScore * 100).toFixed(0)}%`);

  return {
    score: Math.min(1, score),
    reasons,
    taskCount: tasks.length,
    completedTaskCount: completedTasks,
    totalRefines,
    avgReviewScore
  };
}

function buildDependencyGraph(tasks) {
  const graph = {};
  for (const task of tasks) {
    const deps = task.depends_on_json ? JSON.parse(task.depends_on_json) : [];
    graph[task.id] = deps;
  }
  return graph;
}

function validateDagStructure(graph) {
  // Check for cycles (simple DFS)
  const visited = new Set();
  const recursionStack = new Set();

  function hasCycle(node) {
    if (recursionStack.has(node)) return true;
    if (visited.has(node)) return false;

    visited.add(node);
    recursionStack.add(node);

    const deps = graph[node] || [];
    for (const dep of deps) {
      if (hasCycle(dep)) return true;
    }

    recursionStack.delete(node);
    return false;
  }

  for (const node of Object.keys(graph)) {
    if (hasCycle(node)) return false;
  }

  return true;
}

function categorizeWorkflows(candidates) {
  const categories = {
    'feature-implementation': 0,
    'refactoring': 0,
    'bug-fixing': 0,
    'documentation': 0,
    'testing': 0,
    'analysis': 0,
    'other': 0
  };

  for (const candidate of candidates) {
    const objective = candidate.workflow.objective.toLowerCase();
    const tasks = candidate.tasks;

    // Analyze task kinds and objective
    const hasCliSpawn = tasks.some(t => t.kind === 'cli_spawn');
    const hasToolCall = tasks.some(t => t.kind === 'tool_call');
    const hasLlmCall = tasks.some(t => t.kind === 'llm_call');

    if (objective.includes('add') || objective.includes('implement') || objective.includes('create') || objective.includes('build')) {
      categories['feature-implementation']++;
    } else if (objective.includes('refactor') || objective.includes('extract') || objective.includes('rename') || objective.includes('optimize')) {
      categories['refactoring']++;
    } else if (objective.includes('fix') || objective.includes('bug') || objective.includes('error') || objective.includes('debug')) {
      categories['bug-fixing']++;
    } else if (objective.includes('document') || objective.includes('doc') || objective.includes('readme') || objective.includes('guide')) {
      categories['documentation']++;
    } else if (objective.includes('test') || objective.includes('spec') || objective.includes('coverage')) {
      categories['testing']++;
    } else if (objective.includes('analyze') || objective.includes('review') || objective.includes('audit') || objective.includes('investigate')) {
      categories['analysis']++;
    } else {
      categories['other']++;
    }
  }

  return categories;
}

function generateGoldenCasesFile(candidates) {
  const goldenCases = [];

  for (const candidate of candidates.slice(0, 30)) { // Max 30 cases
    const wf = candidate.workflow;
    const objective = wf.objective;

    // Determine category
    const category = determineCategory(objective, candidate.tasks);

    // Extract tech stack from tasks
    const techStack = extractTechStack(candidate.tasks);

    // Generate tags
    const tags = [
      category,
      techStack,
      `tasks:${candidate.tasks.length}`,
      `quality:${(candidate.quality.score * 100).toFixed(0)}%`,
      'golden',
      'historical'
    ];

    // Build input (simplified objective)
    const input = {
      objective,
      workspace: wf.workspace,
      context: {
        created_by: wf.created_by,
        pattern_id: wf.pattern_id
      }
    };

    // Build expected (successful completion with tasks)
    const expected = {
      status: 'completed',
      task_count: candidate.tasks.length,
      completed_tasks: candidate.quality.completedTaskCount,
      has_valid_dag: true,
      cost_usd: wf.actual_cost_usd,
      duration_ms: wf.completed_at ? wf.completed_at - wf.started_at : null
    };

    const goldenCase = {
      id: `gc-${wf.id.slice(0, 8)}`,
      workspace: wf.workspace,
      suite: 'integration', // Historical workflows are integration tests
      name: `${category}: ${objective.slice(0, 50)}${objective.length > 50 ? '...' : ''}`,
      input,
      expected,
      context: {
        workflow_id: wf.id,
        created_at: wf.created_at,
        completed_at: wf.completed_at,
        quality_score: candidate.quality.score,
        quality_reasons: candidate.quality.reasons,
        task_kinds: [...new Set(candidate.tasks.map(t => t.kind))],
        tech_stack: techStack
      },
      tags,
      source: 'manual',
      created_at: Math.floor(Date.now() / 1000)
    };

    goldenCases.push(goldenCase);
  }

  // Write to file
  const outputPath = join(__dirname, '..', 'src', 'v2', 'evals', 'datasets', 'golden-cases.ts');
  const fileContent = `/**
 * Golden cases extracted from historical completed workflows
 *
 * Source: data/omniforge.db
 * Filter: status='completed' (all time)
 * Quality threshold: score >= 0.7
 * Generated: ${new Date().toISOString()}
 *
 * Total cases: ${goldenCases.length}
 */

import type { TestCase } from '../types.js';

export const GOLDEN_CASES: TestCase[] = [
${goldenCases.map(c => `  ${JSON.stringify(c, null, 2).split('\n').join('\n  ')}`).join(',\n\n')}
];

export default GOLDEN_CASES;
`;

  // Ensure directory exists
  const dir = dirname(outputPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(outputPath, fileContent, 'utf-8');
  console.log(`\n✅ Generated ${goldenCases.length} golden cases in: ${outputPath}`);
}

function determineCategory(objective, tasks) {
  const obj = objective.toLowerCase();

  if (obj.includes('add') || obj.includes('implement') || obj.includes('create') || obj.includes('build')) {
    return 'feature-implementation';
  } else if (obj.includes('refactor') || obj.includes('extract') || obj.includes('rename') || obj.includes('optimize')) {
    return 'refactoring';
  } else if (obj.includes('fix') || obj.includes('bug') || obj.includes('error') || obj.includes('debug')) {
    return 'bug-fixing';
  } else if (obj.includes('document') || obj.includes('doc') || obj.includes('readme') || obj.includes('guide')) {
    return 'documentation';
  } else if (obj.includes('test') || obj.includes('spec') || obj.includes('coverage')) {
    return 'testing';
  } else if (obj.includes('analyze') || obj.includes('review') || obj.includes('audit') || obj.includes('investigate')) {
    return 'analysis';
  }

  return 'other';
}

function extractTechStack(tasks) {
  const kinds = new Set(tasks.map(t => t.kind));

  if (kinds.has('cli_spawn')) {
    // Check task names for tech hints
    const names = tasks.map(t => t.name.toLowerCase()).join(' ');
    if (names.includes('react') || names.includes('jsx')) return 'react';
    if (names.includes('python') || names.includes('py')) return 'python';
    if (names.includes('go') || names.includes('golang')) return 'go';
    if (names.includes('node') || names.includes('typescript') || names.includes('ts')) return 'typescript';
    if (names.includes('rust')) return 'rust';
    return 'multi-language';
  }

  if (kinds.has('llm_call')) return 'llm-analysis';
  if (kinds.has('tool_call')) return 'tool-automation';

  return 'general';
}