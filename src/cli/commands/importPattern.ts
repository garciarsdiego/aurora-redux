import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import type { Command } from 'commander';
import { initDb } from '../../db/client.js';
import { getDbPath } from '../../utils/config.js';
import { DagSchema } from '../../types/schemas.js';
import { insertPattern } from '../../db/persist.js';

export function registerImport(program: Command): void {
  program
    .command('import <file>')
    .description('Import a DAG JSON or YAML file as a named pattern')
    .requiredOption('-w, --workspace <name>', 'target workspace')
    .requiredOption('-n, --name <name>', 'pattern name (must be unique per workspace)')
    .option('-o, --objective <sample>', 'short objective description used for pattern matching')
    .action(async (file: string, options: { workspace: string; name: string; objective?: string }) => {
      let raw: string;
      try {
        raw = await readFile(file, 'utf-8');
      } catch {
        console.error(`Error: file not found: ${file}`);
        process.exit(1);
      }

      const ext = extname(file).toLowerCase();
      if (!['.json', '.yaml', '.yml'].includes(ext)) {
        console.error(`Error: unsupported file extension '${ext}' — use .json, .yaml, or .yml`);
        process.exit(1);
      }

      let parsed: unknown;
      try {
        parsed = ext === '.json' ? JSON.parse(raw) : yamlLoad(raw);
      } catch {
        console.error(`Error: file is not valid ${ext === '.json' ? 'JSON' : 'YAML'}`);
        process.exit(1);
      }

      const result = DagSchema.safeParse(parsed);
      if (!result.success) {
        console.error('Error: JSON does not match DAG schema');
        console.error(result.error.issues.map((i) => `  • ${i.path.join('.')}: ${i.message}`).join('\n'));
        process.exit(1);
      }

      const dag = result.data;
      const objectiveSample = options.objective ?? options.name;

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
        process.exit(1);
      }

      const taskCount = dag.tasks.length;
      const withModel = dag.tasks.filter((t) => t.model).length;
      console.log(`Imported pattern '${options.name}' into workspace '${options.workspace}'`);
      console.log(`  Tasks: ${taskCount}${withModel > 0 ? ` (${withModel} with explicit model)` : ''}`);
      console.log(`  Objective sample: ${objectiveSample}`);
    });
}
