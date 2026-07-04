import { writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { dump as yamlDump } from 'js-yaml';
import type { Command } from 'commander';
import { initDb } from '../../db/client.js';
import { getDbPath } from '../../utils/config.js';
import { getPatternByName } from '../../patterns/store.js';

export type Format = 'json' | 'yaml';

export function resolveFormat(
  explicit: string | undefined,
  outputPath: string | undefined,
): Format {
  if (explicit) {
    if (explicit !== 'json' && explicit !== 'yaml') {
      throw new Error(`unsupported format '${explicit}' — use json or yaml`);
    }
    return explicit;
  }
  if (outputPath) {
    const ext = extname(outputPath).toLowerCase();
    if (ext === '.yaml' || ext === '.yml') return 'yaml';
    if (ext === '.json') return 'json';
  }
  return 'json';
}

export function serialize(dag: unknown, format: Format): string {
  return format === 'yaml' ? yamlDump(dag) : `${JSON.stringify(dag, null, 2)}\n`;
}

export function registerExport(program: Command): void {
  program
    .command('export <name>')
    .description('Export a pattern as JSON or YAML (round-trips with `import`)')
    .requiredOption('-w, --workspace <name>', 'workspace where the pattern lives')
    .option('-f, --format <format>', 'output format: json or yaml')
    .option('-o, --output <file>', 'write to file (extension implies format if --format omitted)')
    .action(async (name: string, options: { workspace: string; format?: string; output?: string }) => {
      let format: Format;
      try {
        format = resolveFormat(options.format, options.output);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }

      const db = initDb(getDbPath());
      const pattern = getPatternByName(db, options.workspace, name);
      if (!pattern) {
        console.error(`Error: pattern '${name}' not found in workspace '${options.workspace}'`);
        process.exit(1);
      }

      let dag: unknown;
      try {
        dag = JSON.parse(pattern.dag_json);
      } catch {
        console.error(`Error: pattern '${name}' has corrupt dag_json`);
        process.exit(1);
      }

      const content = serialize(dag, format);

      if (options.output) {
        try {
          await writeFile(options.output, content, 'utf-8');
        } catch (err) {
          console.error(`Error: failed to write ${options.output}: ${(err as Error).message}`);
          process.exit(1);
        }
        console.log(`Exported pattern '${name}' to ${options.output} (${format})`);
        return;
      }

      process.stdout.write(content);
    });
}
