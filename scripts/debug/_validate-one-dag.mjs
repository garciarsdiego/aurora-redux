import { readFileSync } from 'node:fs';
import { load as yamlLoad } from 'js-yaml';
import { DagSchema } from '../dist/types/schemas.js';
const path = process.argv[2];
const raw = readFileSync(path, 'utf-8');
const parsed = path.endsWith('.json') ? JSON.parse(raw) : yamlLoad(raw);
const result = DagSchema.safeParse(parsed);
if (result.success) {
  console.log(`OK ${path} → ${result.data.tasks.length} tasks`);
  // Cycle / orphan check
  const ids = new Set(result.data.tasks.map(t => t.id));
  for (const t of result.data.tasks) {
    for (const dep of t.depends_on) {
      if (!ids.has(dep)) console.log(`  WARN: task ${t.id} depends on missing id ${dep}`);
    }
  }
  process.exit(0);
}
console.log(`FAIL ${path}:`);
for (const i of result.error.issues) console.log(`  ${i.path.join('.') || '(root)'}: ${i.message}`);
process.exit(1);
