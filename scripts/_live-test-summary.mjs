// One-off: aggregate stats across the live Omniroute test workflows.
import Database from 'better-sqlite3';
const db = new Database('data/omniforge.db', { readonly: true });
const internalWfs = db
  .prepare(`SELECT id, objective, status, started_at, completed_at, created_by
              FROM workflows
             WHERE workspace='internal' AND created_at > 1779489000000
             ORDER BY started_at ASC`)
  .all();
const real = internalWfs.filter((w) =>
  !['sprint0_test', 'atomicity_test', 'auto_capture_test', 'integration_test', 'traces_test', 'variant_test'].includes(w.created_by ?? ''),
);
console.log('Live test workflows:', real.length);
let totalDur = 0, totalIn = 0, totalOut = 0, ok = 0;
for (const w of real) {
  const dur = w.completed_at && w.started_at ? Math.round((w.completed_at - w.started_at) / 1000) : 0;
  totalDur += dur;
  if (w.status === 'completed') ok++;
  const tasks = db.prepare('SELECT input_tokens, output_tokens FROM tasks WHERE workflow_id = ?').all(w.id);
  let tin = 0, tout = 0;
  for (const t of tasks) { tin += t.input_tokens || 0; tout += t.output_tokens || 0; }
  totalIn += tin;
  totalOut += tout;
  console.log('  ' + w.status.padEnd(10) + ' | ' + (dur + 's').padStart(6) + ' | in=' + String(tin).padStart(7) + ' out=' + String(tout).padStart(7) + ' | ' + w.objective.slice(0, 75));
}
console.log('---');
console.log('Total duration:', Math.round(totalDur / 60) + 'm', (totalDur % 60) + 's');
console.log('Total tokens: in=' + totalIn + ' out=' + totalOut);
console.log('Success rate: ' + ok + '/' + real.length + ' (' + Math.round((ok/real.length)*100) + '%)');
// Estimated cost (rough): Sonnet ~$3/M in, $15/M out; Haiku $1/$5; GPT-5.5 $5/$15; etc.
// Use Sonnet-like blend for estimate.
const blendIn = 0.000003;
const blendOut = 0.000015;
console.log('Estimated cost (Sonnet-blend): $' + ((totalIn * blendIn) + (totalOut * blendOut)).toFixed(4));
db.close();
