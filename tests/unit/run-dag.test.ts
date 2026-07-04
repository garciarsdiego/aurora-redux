// Tests for run-dag command's pure helpers (file IO + plan formatting).
// The interactive prompt and execute path are integration concerns covered
// by manual smoke; here we test the parsing + summary logic in isolation.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readAndValidateDag, formatPlan, buildEditorCommand } from '../../src/cli/commands/runDag.js';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'omniforge-rundag-test-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const validYaml = `
tasks:
  - id: t0
    name: "First task"
    kind: llm_call
    depends_on: []
    model: cc/claude-sonnet-4-6
    acceptance_criteria: "Does the thing."
    timeout_seconds: 300
  - id: t1
    name: "Second task with HITL gate"
    kind: cli_spawn
    depends_on: [t0]
    executor_hint: cli:claude-code
    acceptance_criteria: "Writes file."
    hitl: true
    timeout_seconds: 600
`;

const validJson = JSON.stringify({
  tasks: [
    {
      id: 't0',
      name: 'Only task',
      kind: 'tool_call',
      depends_on: [],
      tool_name: 'http-request',
      acceptance_criteria: 'Returns status.',
    },
  ],
});

describe('readAndValidateDag', () => {
  it('reads + parses + validates a valid YAML file', () => {
    const path = join(tmp, 'good.yaml');
    writeFileSync(path, validYaml, 'utf-8');
    const dag = readAndValidateDag(path);
    expect(dag.tasks).toHaveLength(2);
    expect(dag.tasks[0]!.id).toBe('t0');
    expect(dag.tasks[1]!.hitl).toBe(true);
  });

  it('reads + parses + validates a valid JSON file', () => {
    const path = join(tmp, 'good.json');
    writeFileSync(path, validJson, 'utf-8');
    const dag = readAndValidateDag(path);
    expect(dag.tasks).toHaveLength(1);
    expect(dag.tasks[0]!.kind).toBe('tool_call');
  });

  it('throws on missing file', () => {
    expect(() => readAndValidateDag(join(tmp, 'nope.yaml')))
      .toThrow(/file not found/);
  });

  it('throws on unsupported extension', () => {
    const path = join(tmp, 'bad.txt');
    writeFileSync(path, 'whatever', 'utf-8');
    expect(() => readAndValidateDag(path))
      .toThrow(/unsupported extension/);
  });

  it('throws on malformed YAML', () => {
    const path = join(tmp, 'bad.yaml');
    writeFileSync(path, 'tasks: [: invalid }', 'utf-8');
    expect(() => readAndValidateDag(path)).toThrow(/failed to parse/);
  });

  it('throws on malformed JSON', () => {
    const path = join(tmp, 'bad.json');
    writeFileSync(path, '{ tasks: missing-quote }', 'utf-8');
    expect(() => readAndValidateDag(path)).toThrow(/failed to parse/);
  });

  it('throws on schema violation with precise issue path', () => {
    const path = join(tmp, 'bad-schema.yaml');
    writeFileSync(path, `
tasks:
  - id: t0
    name: "Bad task"
    kind: not_a_real_kind
    depends_on: []
`, 'utf-8');
    expect(() => readAndValidateDag(path))
      .toThrow(/DAG schema validation failed/);
  });

  it('throws on empty tasks array', () => {
    const path = join(tmp, 'empty.yaml');
    writeFileSync(path, 'tasks: []', 'utf-8');
    expect(() => readAndValidateDag(path))
      .toThrow(/DAG schema validation failed/);
  });
});

describe('formatPlan', () => {
  it('produces summary with counts, kinds, models, HITL gates', () => {
    const path = join(tmp, 'plan-test.yaml');
    writeFileSync(path, validYaml, 'utf-8');
    const dag = readAndValidateDag(path);
    const plan = formatPlan(dag, path, { workspace: 'internal' });

    expect(plan).toContain('DAG Plan:');
    expect(plan).toContain('Workspace:  internal');
    expect(plan).toContain('Tasks:      2');
    expect(plan).toContain('llm_call (1)');
    expect(plan).toContain('cli_spawn (1)');
    expect(plan).toContain('cc/claude-sonnet-4-6');
    expect(plan).toContain('cli:claude-code');
    expect(plan).toContain('HITL gates: 1 at [t1]');
  });

  it('flags auto-approve in HITL line when option set', () => {
    const path = join(tmp, 'plan-test.yaml');
    writeFileSync(path, validYaml, 'utf-8');
    const dag = readAndValidateDag(path);
    const plan = formatPlan(dag, path, { workspace: 'internal', autoApprove: true });
    expect(plan).toContain('AUTO-APPROVED');
  });

  it('omits HITL detail when no gates in DAG', () => {
    const path = join(tmp, 'no-hitl.yaml');
    writeFileSync(path, `
tasks:
  - id: t0
    name: "No HITL task"
    kind: llm_call
    depends_on: []
`, 'utf-8');
    const dag = readAndValidateDag(path);
    const plan = formatPlan(dag, path, { workspace: 'internal' });
    expect(plan).toContain('HITL gates: 0');
    expect(plan).not.toContain(' at [');
  });

  it('shows tool_call tools section', () => {
    const path = join(tmp, 'tool.json');
    writeFileSync(path, validJson, 'utf-8');
    const dag = readAndValidateDag(path);
    const plan = formatPlan(dag, path, { workspace: 'internal' });
    expect(plan).toContain('Tools:');
    expect(plan).toContain('http-request');
  });

  it('shows per-task table with id, kind, name, deps, HITL marker', () => {
    const path = join(tmp, 'plan-test.yaml');
    writeFileSync(path, validYaml, 'utf-8');
    const dag = readAndValidateDag(path);
    const plan = formatPlan(dag, path, { workspace: 'internal' });
    // Per-task lines
    expect(plan).toMatch(/t0\s+\[llm_call\s*\]/);
    expect(plan).toMatch(/t1\s+\[cli_spawn\s*\].*\[HITL\]/);
    expect(plan).toContain('(root)');
    expect(plan).toContain('← [t0]');
  });

  it('truncates long task names with ellipsis', () => {
    const longName = 'x'.repeat(80);
    const path = join(tmp, 'long.yaml');
    writeFileSync(path, `
tasks:
  - id: t0
    name: "${longName}"
    kind: llm_call
    depends_on: []
`, 'utf-8');
    const dag = readAndValidateDag(path);
    const plan = formatPlan(dag, path, { workspace: 'internal' });
    expect(plan).toContain('xxx...');
    expect(plan).not.toContain(longName); // full name not present
  });
});

describe('buildEditorCommand', () => {
  it('splits editor command into executable and args without shell wrapping', () => {
    const cmd = buildEditorCommand('C:/tmp/plan.yaml', 'code --wait');
    expect(cmd.command).toBe('code');
    expect(cmd.args).toEqual(['--wait', 'C:/tmp/plan.yaml']);
    expect(cmd.shell).toBe(false);
  });

  it('rejects shell metacharacters in editor override', () => {
    expect(() => buildEditorCommand('plan.yaml', 'code --wait && whoami'))
      .toThrow(/metacharacters/i);
  });
});
