import type { Command } from 'commander';
import { initDb } from '../../db/client.js';
import { getDbPath } from '../../utils/config.js';

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function fmtTime(epochMs: number): string {
  return new Date(epochMs).toISOString().replace('T', ' ').slice(0, 19);
}

export function registerList(program: Command): void {
  program
    .command('list')
    .description('List recent workflows')
    .option('-w, --workspace <name>', 'filter by workspace')
    .option('-n, --limit <n>', 'max results', '10')
    .action((options: { workspace?: string; limit: string }) => {
      const db = initDb(getDbPath());
      try {
        const limit = parseInt(options.limit, 10) || 10;

        const rows = options.workspace
          ? (db
              .prepare(
                `SELECT id, workspace, status, objective, created_at FROM workflows WHERE id != '_daemon' AND workspace = ? ORDER BY created_at DESC LIMIT ?`,
              )
              .all(options.workspace, limit) as {
              id: string;
              workspace: string;
              status: string;
              objective: string;
              created_at: number;
            }[])
          : (db
              .prepare(
                `SELECT id, workspace, status, objective, created_at FROM workflows WHERE id != '_daemon' ORDER BY created_at DESC LIMIT ?`,
              )
              .all(limit) as {
              id: string;
              workspace: string;
              status: string;
              objective: string;
              created_at: number;
            }[]);

        if (rows.length === 0) {
          console.log('Nenhum workflow encontrado.');
          return;
        }

        console.log('');
        console.log(
          'ID                                    workspace   status     criado_em            objetivo',
        );
        console.log('-'.repeat(110));
        for (const r of rows) {
          console.log(
            `${r.id.padEnd(38)}  ${r.workspace.padEnd(10)}  ${r.status.padEnd(9)}  ${fmtTime(r.created_at)}  ${truncate(r.objective, 40)}`,
          );
        }
      } finally {
        db.close();
      }
    });
}
