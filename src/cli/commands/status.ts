import type { Command } from 'commander';
import { initDb } from '../../db/client.js';
import { getDbPath } from '../../utils/config.js';

const STATUS_ICON: Record<string, string> = {
  completed: '✓',
  running: '▶',
  failed: '✗',
  pending: '·',
  ready: '·',
  waiting: '…',
  skipped: '-',
};

export function registerStatus(program: Command): void {
  program
    .command('status [workflow_id]')
    .description('Show workflow status (latest if no ID given)')
    .action((workflowId?: string) => {
      const db = initDb(getDbPath());
      try {
        type WfRow = { id: string; status: string; objective: string };
        const wf = workflowId
          ? (db
              .prepare('SELECT id, status, objective FROM workflows WHERE id = ?')
              .get(workflowId) as WfRow | undefined)
          : (db
              .prepare(`SELECT id, status, objective FROM workflows WHERE id != '_daemon' ORDER BY created_at DESC LIMIT 1`)
              .get() as WfRow | undefined);

        if (!wf) {
          console.log('Nenhum workflow encontrado.');
          return;
        }

        const tasks = db
          .prepare(
            'SELECT id, name, status FROM tasks WHERE workflow_id = ? ORDER BY created_at',
          )
          .all(wf.id) as { id: string; name: string; status: string }[];

        const events = db
          .prepare(
            `SELECT e.type, t.name as task_name
             FROM events e
             LEFT JOIN tasks t ON e.task_id = t.id
             WHERE e.workflow_id = ?
             ORDER BY e.id DESC LIMIT 8`,
          )
          .all(wf.id) as { type: string; task_name: string | null }[];

        console.log('');
        console.log(`Workflow: ${wf.id}`);
        console.log(`Status:   ${wf.status}`);
        console.log(`Objetivo: ${wf.objective}`);
        console.log(`Tasks (${tasks.length}):`);
        for (const t of tasks) {
          const icon = STATUS_ICON[t.status] ?? '?';
          console.log(`  [${icon}] ${t.id.slice(0, 8)}…  ${t.name}  ${t.status}`);
        }
        console.log(`Últimos events (${events.length}):`);
        for (const e of [...events].reverse()) {
          const suffix = e.task_name ? `  → ${e.task_name}` : '';
          console.log(`  ${e.type}${suffix}`);
        }
      } finally {
        db.close();
      }
    });
}
