import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { ADVISOR_NAMES } from '../../src/mcp/tools/advisor_tools.js';
import { getDashboardAdvisorModes, setDashboardAdvisorModes } from '../../src/mcp/routes/dashboard-data.js';
import { codereviewAdvisor } from '../../src/v2/advisors/codereview/handler.js';

vi.mock('../../src/utils/omniroute-call.js', () => ({
  callOmniroute: vi.fn(async () => 'Review step done.\n[CONTINUE: inspect persistence next]'),
}));

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

const baseCodereviewArgs = {
  step: 'Review the backend API surface.',
  step_number: 1,
  total_steps: 2,
  next_step_required: true,
  findings: 'No findings yet.',
};

describe('advisor mode handling', () => {
  it('threads mode handling through every advisor handler', () => {
    for (const advisorName of ADVISOR_NAMES) {
      const handlerPath = join(repoRoot, 'src', 'v2', 'advisors', advisorName, 'handler.ts');
      const source = readFileSync(handlerPath, 'utf-8');

      expect(source, `${advisorName} handler should resolve advisor mode`).toMatch(
        /shouldUseStepwiseMemory|getAdvisorMode/,
      );
    }
  });

  it('preserves stepwise continuation when mode is auto', async () => {
    const result = await codereviewAdvisor.run(
      {
        workspace: 'internal',
        workflow_id: 'wf_test',
        step: {
          stepNumber: 1,
          totalSteps: 2,
          nextStepRequired: true,
          findings: [],
          conversationId: 'conv_auto_test',
        },
      },
      { ...baseCodereviewArgs, mode: 'auto' },
    );

    expect('nextStep' in result ? result.nextStep : undefined).toEqual({
      stepNumber: 2,
      request: 'inspect persistence next',
    });
  });

  it('runs a stepwise advisor as one-shot when mode is oneshot', async () => {
    const result = await codereviewAdvisor.run(
      {
        workspace: 'internal',
        workflow_id: 'wf_test',
        step: {
          stepNumber: 1,
          totalSteps: 2,
          nextStepRequired: true,
          findings: [],
          conversationId: 'conv_test',
        },
      },
      { ...baseCodereviewArgs, mode: 'oneshot' },
    );

    expect(result.output).toContain('Review step done');
    expect('nextStep' in result ? result.nextStep : undefined).toBeUndefined();
  });

  it('persists advisor mode preferences in daemon state', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE daemon_state (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);

      const saved = setDashboardAdvisorModes(db, {
        codereview: 'oneshot',
        debug: 'stepwise',
        invalid: 'oneshot',
        chat: 'bad-mode',
      });

      expect(saved).toEqual({ codereview: 'oneshot', debug: 'stepwise' });
      expect(getDashboardAdvisorModes(db)).toEqual({
        codereview: 'oneshot',
        debug: 'stepwise',
      });
    } finally {
      db.close();
    }
  });
});
