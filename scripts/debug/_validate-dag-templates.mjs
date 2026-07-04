// One-shot validator: reads 3 template files, parses them, runs DagSchema.
// Kept under scripts/ so it can resolve node_modules via package.json.
import { readFileSync } from 'node:fs';
import { load as yamlLoad } from 'js-yaml';
import { DagSchema } from '../dist/types/schemas.js';

const cases = [
  { path: 'docs/examples/pattern-dag-template.yaml', fmt: 'yaml' },
  { path: 'docs/examples/pattern-dag-template.json', fmt: 'json' },
  { path: 'docs/examples/pattern-dag-minimal.yaml', fmt: 'yaml' },
];

let fail = 0;
for (const { path, fmt } of cases) {
  const raw = readFileSync(path, 'utf-8');
  const parsed = fmt === 'yaml' ? yamlLoad(raw) : JSON.parse(raw);
  const result = DagSchema.safeParse(parsed);
  if (result.success) {
    console.log(`OK   ${path} → ${result.data.tasks.length} tasks`);
  } else {
    fail++;
    console.log(`FAIL ${path}:`);
    for (const issue of result.error.issues) {
      console.log(`       ${issue.path.join('.') || '(root)'}: ${issue.message}`);
    }
  }
}
process.exit(fail);
