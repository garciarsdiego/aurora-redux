import type { Command } from 'commander';
import { initDb } from '../../db/client.js';
import { getDbPath } from '../../utils/config.js';
import { insertPattern } from '../../db/persist.js';
import { readAndValidateDag } from './runDag.js';
import type { Dag } from '../../types/index.js';

export function registerImport(program: Command): void {
  program
    .command('import <file>')
    .description('Import a DAG JSON or YAML file as a named pattern')
    .requiredOption('-w, --workspace <name>', 'target workspace')
    .requiredOption('-n, --name <name>', 'pattern name (must be unique per workspace)')
    .option('-o, --objective <sample>', 'short objective description used for pattern matching')
    .action(async (file: string, options: { workspace: string; name: string; objective?: string }) => {
      // Read + parse + Zod-validate shared with `run-dag` (readAndValidateDag)
      // instead of a near-identical inline copy.
      let dag: Dag;
      try {
        dag = readAndValidateDag(file);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exitCode = 1;
        return;
      }

      const objectiveSample = options.objective ?? options.name;

      // exitCode (not process.exit) + finally db.close(): same rationale as
      // run.ts — process.exit() with a better-sqlite3 handle mid-close hits a
      // libuv assertion on Windows.
      const db = initDb(getDbPath());
      try {
        insertPattern(db, {
          id: `pt_${crypto.randomUUID()}`,
          workspace: options.workspace,
          name: options.name,
          source: 'imported',
          objective_sample: objectiveSample,
          dag_json: JSON.stringify(dag),
          usage_count: 0,
          success_count: 0,
          avg_duration_ms: null,
          last_used_at: null,
          created_at: Date.now(),
        });
      } catch (err) {
        const msg = (err as Error).message ?? '';
        if (msg.includes('UNIQUE constraint failed')) {
          console.error(`Error: pattern '${options.name}' already exists in workspace '${options.workspace}'`);
        } else {
          console.error(`Error: ${msg}`);
        }
        process.exitCode = 1;
        return;
      } finally {
        db.close();
      }

      const taskCount = dag.tasks.length;
      const withModel = dag.tasks.filter((t) => t.model).length;
      console.log(`Imported pattern '${options.name}' into workspace '${options.workspace}'`);
      console.log(`  Tasks: ${taskCount}${withModel > 0 ? ` (${withModel} with explicit model)` : ''}`);
      console.log(`  Objective sample: ${objectiveSample}`);
    });
}
