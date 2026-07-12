import type { Command } from 'commander';
import { initDb } from '../../db/client.js';
import { getDbPath } from '../../utils/config.js';

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function fmtTime(epochMs: number): string {
  return new Date(epochMs).toISOString().replace('T', ' ').slice(0, 19);
}

type WorkflowRow = {
  id: string;
  workspace: string;
  status: string;
  objective: string;
  created_at: number;
};

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

        const params: (string | number)[] = [];
        let sql = `SELECT id, workspace, status, objective, created_at FROM workflows WHERE id != '_daemon'`;
        if (options.workspace) {
          sql += ' AND workspace = ?';
          params.push(options.workspace);
        }
        sql += ' ORDER BY created_at DESC LIMIT ?';
        params.push(limit);

        const rows = db.prepare(sql).all(...params) as WorkflowRow[];

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
