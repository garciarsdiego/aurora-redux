// Generates docs/aurora-parity/*.md from reports/aurora-parity-raw/*.json (workflow output).
// Mechanical render => high fidelity to the agent findings. Re-runnable.
import fs from 'node:fs';
import path from 'node:path';

const RAW = 'reports/aurora-parity-raw';
const OUT = 'docs/aurora-parity';
fs.mkdirSync(OUT, { recursive: true });
const read = (f) => JSON.parse(fs.readFileSync(path.join(RAW, f), 'utf8'));
const caps = read('capabilities.json');
const land = read('landscape.json');
const gaps = read('gaps.json');
const crit = read('critique.json');
const plan = read('plan.json');

const STAMP = '2026-05-30';
const head = (t) => `> Generated ${STAMP} by the \`aurora-parity-analysis\` workflow (21 agents). Source data: \`reports/aurora-parity-raw/\`.\n\n`;
const LEV = { critical: 4, high: 3, medium: 2, low: 1 };
const EFF = { S: 1, M: 2, L: 3, XL: 4 };
const bullets = (a) => (a && a.length ? a.map((x) => `- ${x}`).join('\n') : '_none_');

// ---------- 01 capability audit ----------
{
  let m = `# Omniforge H2 — Capability Audit (code-grounded)\n\n${head()}`;
  m += `Eight subsystems audited against actual source on \`fix/aurora-1.0\` (claims verified against code, not docs).\n\n`;
  m += `| Subsystem | Maturity | # capabilities |\n|---|---|---|\n`;
  for (const c of caps) m += `| ${c.subsystem.split('(')[0].trim()} | ${c.maturity} | ${c.capabilities.length} |\n`;
  m += `\n---\n\n`;
  for (const c of caps) {
    m += `## ${c.subsystem}\n\n**Maturity:** ${c.maturity}\n\n${c.summary}\n\n`;
    m += `### Capabilities\n\n| Capability | State | Evidence |\n|---|---|---|\n`;
    for (const cap of c.capabilities) m += `| **${cap.name}** — ${cap.description.replace(/\n/g, ' ')} | ${cap.state} | \`${cap.evidence}\` |\n`;
    m += `\n### Weaknesses\n\n${bullets(c.weaknesses)}\n\n`;
    if (c.doc_claims_checked && c.doc_claims_checked.length) m += `### Doc claims checked\n\n${bullets(c.doc_claims_checked)}\n\n`;
    m += `---\n\n`;
  }
  fs.writeFileSync(path.join(OUT, '01-CAPABILITY-AUDIT.md'), m);
}

// ---------- 02 competitive comparison ----------
{
  let m = `# Competitive Landscape — Parity Reference (2026)\n\n${head()}`;
  m += `Six categories benchmarked to define "parity" for single-operator use.\n\n`;
  for (const c of land) {
    m += `## ${c.category}\n\n`;
    m += `**Tools:** ${c.tools.map((t) => `${t.name} (${t.positioning})`).join('; ')}\n\n`;
    m += `### Capability checklist\n\n| Capability | Table-stakes? | Who has it |\n|---|---|---|\n`;
    for (const cap of c.capability_checklist) m += `| ${cap.capability}${cap.description ? ' — ' + cap.description.replace(/\n/g, ' ') : ''} | ${cap.is_table_stakes ? 'yes' : 'no'} | ${cap.which_tools_have_it} |\n`;
    m += `\n### Standout features worth emulating\n\n${bullets(c.standout_features)}\n\n`;
    m += `### What a solo operator values here\n\n${bullets(c.operator_value)}\n\n`;
    if (c.confidence) m += `_Confidence note: ${c.confidence}_\n\n`;
    m += `---\n\n`;
  }
  fs.writeFileSync(path.join(OUT, '02-COMPETITIVE-COMPARISON.md'), m);
}

// ---------- 03 gap register ----------
{
  let total = 0;
  const byLev = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const t of gaps) for (const g of t.gaps) { total++; byLev[g.personal_leverage]++; }
  let m = `# Gap Register — Omniforge vs the Field (single-operator filter)\n\n${head()}`;
  m += `**${total} gaps** across 4 themes (multi-tenant/billing/SSO excluded per scope).\n\n`;
  m += `Leverage distribution: **${byLev.critical} critical**, **${byLev.high} high**, ${byLev.medium} medium, ${byLev.low} low.\n\n`;
  // top gaps overview
  const flat = [];
  for (const t of gaps) for (const g of t.gaps) flat.push({ ...g, theme: t.theme });
  flat.sort((a, b) => (LEV[b.personal_leverage] - LEV[a.personal_leverage]) || (EFF[a.effort] - EFF[b.effort]));
  m += `## Top gaps (by leverage, then ascending effort)\n\n| Gap | Status | Leverage | Effort | Who has it |\n|---|---|---|---|---|\n`;
  for (const g of flat.filter((x) => LEV[x.personal_leverage] >= 3)) m += `| ${g.gap.replace(/\n/g, ' ')} | ${g.our_status} | ${g.personal_leverage} | ${g.effort} | ${g.competitors_with_it.split('(')[0].slice(0, 60)} |\n`;
  m += `\n---\n\n`;
  for (const t of gaps) {
    m += `## Theme: ${t.theme}\n\n`;
    const sorted = [...t.gaps].sort((a, b) => (LEV[b.personal_leverage] - LEV[a.personal_leverage]) || (EFF[a.effort] - EFF[b.effort]));
    for (const g of sorted) {
      m += `### [${g.personal_leverage.toUpperCase()} / ${g.effort}] ${g.gap}\n\n`;
      m += `- **Our status:** ${g.our_status}\n- **Competitors with it:** ${g.competitors_with_it}\n`;
      m += `- **Why it matters (N=1):** ${g.rationale.replace(/\n/g, ' ')}\n`;
      if (g.evidence) m += `- **Evidence / start point:** \`${g.evidence}\`\n`;
      m += `\n`;
    }
    m += `---\n\n`;
  }
  fs.writeFileSync(path.join(OUT, '03-GAP-REGISTER.md'), m);
}

// ---------- 04 execution plan ----------
{
  let m = `# Aurora Parity — Multi-Agent Execution Plan\n\n${head()}`;
  m += `**Current state grade:** ${plan.current_state_grade}\n\n`;
  m += `## North star\n\n${plan.north_star}\n\n`;
  m += `## Executive summary\n\n${plan.executive_summary}\n\n`;
  m += `## Quick wins (high-leverage, low-effort — do first)\n\n${bullets(plan.quick_wins)}\n\n`;
  m += `## Waves\n\n`;
  for (const w of plan.waves) {
    m += `### ${w.wave}\n\n`;
    m += `**Goal:** ${w.goal}\n\n`;
    if (w.rationale) m += `**Rationale:** ${w.rationale}\n\n`;
    if (w.depends_on) m += `**Depends on:** ${w.depends_on}\n\n`;
    m += `| Workstream | Effort | Leverage | Parallel | Agent role |\n|---|---|---|---|---|\n`;
    for (const ws of w.workstreams) m += `| ${ws.title} | ${ws.effort} | ${ws.leverage} | ${ws.parallelizable ? 'yes' : 'no'} | ${ws.agent_role || '-'} |\n`;
    m += `\n`;
    for (const ws of w.workstreams) {
      m += `#### ${ws.title}\n\n${ws.description}\n\n`;
      if (ws.target_files) m += `- **Target files:** \`${ws.target_files}\`\n`;
      m += `- **Effort:** ${ws.effort} · **Leverage:** ${ws.leverage} · **Parallelizable:** ${ws.parallelizable ? 'yes' : 'no'} · **Agent:** ${ws.agent_role || '-'}\n`;
      if (ws.acceptance) m += `- **Acceptance:** ${ws.acceptance}\n`;
      m += `\n`;
    }
    m += `---\n\n`;
  }
  m += `## Risks\n\n${bullets(plan.risks)}\n\n`;
  m += `## Explicitly deferred (out of scope for single-operator parity)\n\n${bullets(plan.deferred_product_gaps)}\n\n`;
  m += `---\n\n## Appendix — Adversarial critique (incorporated into this plan)\n\n`;
  m += `**Overall:** ${crit.overall_assessment}\n\n`;
  m += `**Missing gaps it caught:**\n\n${bullets(crit.missing_gaps)}\n\n`;
  m += `**Sequencing issues:**\n\n${bullets(crit.sequencing_issues)}\n\n`;
  m += `**Feasibility concerns:**\n\n${bullets(crit.feasibility_concerns)}\n\n`;
  m += `**Overscoped items trimmed:**\n\n${bullets(crit.overscoped_items)}\n\n`;
  fs.writeFileSync(path.join(OUT, '04-EXECUTION-PLAN.md'), m);
}

// counts for the console
const total = gaps.reduce((n, t) => n + t.gaps.length, 0);
const wsCount = plan.waves.reduce((n, w) => n + w.workstreams.length, 0);
console.log(`Wrote docs/aurora-parity/{01-CAPABILITY-AUDIT,02-COMPETITIVE-COMPARISON,03-GAP-REGISTER,04-EXECUTION-PLAN}.md`);
console.log(`Gaps: ${total} | Waves: ${plan.waves.length} | Workstreams: ${wsCount} | Quick wins: ${plan.quick_wins.length}`);
