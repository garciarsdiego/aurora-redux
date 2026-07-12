import type { Command } from 'commander';
import { initDb } from '../../db/client.js';
import { getDbPath } from '../../utils/config.js';
import {
  saveWorkflowAsPattern,
  listPatterns,
  deletePattern,
} from '../../patterns/store.js';
import type { Pattern } from '../../types/index.js';

function fmtTime(epochMs: number | null): string {
  if (!epochMs) return '—';
  return new Date(epochMs).toISOString().replace('T', ' ').slice(0, 16);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

export function registerPatterns(program: Command): void {
  const cmd = program
    .command('patterns')
    .description('Manage reusable workflow patterns');

  cmd
    .command('list')
    .description('List patterns for a workspace')
    .requiredOption('-w, --workspace <name>', 'workspace to list patterns for')
    .action((options: { workspace: string }) => {
      const db = initDb(getDbPath());
      try {
        const patterns = listPatterns(db, options.workspace);
        if (patterns.length === 0) {
          console.log(`Nenhum pattern em '${options.workspace}'.`);
          return;
        }
        console.log('');
        console.log(
          'ID              name                   uses  último uso        objetivo',
        );
        console.log('-'.repeat(100));
        for (const p of patterns) {
          console.log(
            `${p.id.slice(0, 14).padEnd(16)}${p.name.padEnd(23)}${String(p.usage_count).padEnd(6)}${fmtTime(p.last_used_at).padEnd(18)}${truncate(p.objective_sample, 35)}`,
          );
        }
        console.log('');
      } finally {
        db.close();
      }
    });

  cmd
    .command('save <workflow_id> <name>')
    .description('Save a completed workflow as a named pattern')
    .action((workflowId: string, name: string) => {
      const db = initDb(getDbPath());
      try {
        const pattern: Pattern = saveWorkflowAsPattern(db, workflowId, name);
        console.log('');
        console.log('✓ Pattern salvo');
        console.log(`  ID:        ${pattern.id}`);
        console.log(`  Nome:      ${pattern.name}`);
        console.log(`  Workspace: ${pattern.workspace}`);
        console.log(`  Tasks:     ${(JSON.parse(pattern.dag_json) as { tasks: unknown[] }).tasks.length}`);
        console.log(`  Objetivo:  ${pattern.objective_sample}`);
        console.log('');
      } catch (err) {
        console.error('Erro:', err instanceof Error ? err.message : String(err));
        // exitCode (não process.exit) para deixar o finally fechar o db —
        // process.exit() aqui pularia o close e arrisca a assertion do libuv
        // no Windows (ver run.ts / run-summary.ts).
        process.exitCode = 1;
      } finally {
        db.close();
      }
    });

  cmd
    .command('delete <pattern_id>')
    .description('Delete a pattern by ID')
    .action((patternId: string) => {
      const db = initDb(getDbPath());
      try {
        const removed = deletePattern(db, patternId);
        if (removed) {
          console.log(`✓ Pattern ${patternId} removido.`);
        } else {
          console.log(`Pattern não encontrado: ${patternId}`);
          process.exitCode = 1;
        }
      } finally {
        db.close();
      }
    });
}
