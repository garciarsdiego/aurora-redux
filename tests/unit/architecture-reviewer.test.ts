import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

import { initDb } from '../../src/db/client.js';
import { insertTask, insertWorkflow, newTaskId, newWorkflowId } from '../../src/db/persist.js';
import { reviewArchitectureIntegration } from '../../src/quality/architecture-reviewer.js';
import { buildFinalProductEvidenceBundle, runStaticWebProductHarness } from '../../src/quality/final-evidence.js';
import { recordArchitectureContract } from '../../src/workflow-modes/existing-code-feature.js';
import type { ArchitectureContract } from '../../src/workflow-modes/existing-code-feature.js';
import type { Task, Workflow } from '../../src/types/index.js';

function makeWorkflow(id = newWorkflowId()): Workflow {
  const now = Date.now();
  return {
    id,
    workspace: 'internal',
    objective: 'Add task modules to existing React product',
    pattern_id: null,
    status: 'executing',
    started_at: now,
    completed_at: null,
    created_at: now,
    created_by: null,
    estimated_cost_usd: null,
    actual_cost_usd: null,
    max_total_cost_usd: null,
    max_duration_seconds: null,
    metadata: null,
  };
}

function makeTask(workflowId: string, root: string): Task {
  const now = Date.now();
  return {
    id: newTaskId(),
    workflow_id: workflowId,
    name: 'Implement task modules',
    kind: 'cli_spawn',
    input_json: JSON.stringify({ execution_context: { worktree_root: root } }),
    output_json: 'Implemented task modules.',
    status: 'completed',
    depends_on: [],
    executor_hint: 'cli:codex',
    timeout_seconds: 300,
    max_retries: 0,
    retry_count: 0,
    retry_policy: 'none',
    started_at: now,
    completed_at: now,
    created_at: now,
    acceptance_criteria: 'Task modules integrate into the existing React app.',
    refine_count: 0,
    max_refine: 0,
    refine_feedback: null,
    model: 'cx/gpt-5.4',
    hitl: false,
    execution_mode: 'ephemeral',
  };
}

function contractFor(workflowId: string, root: string): ArchitectureContract {
  return {
    runId: workflowId,
    projectRoot: root,
    appType: 'react',
    existingStateStores: ['src/state/AppState.ts'],
    existingUiSurfaces: ['src/App.tsx', 'src/screens/Tasks.tsx'],
    allowedFiles: ['src/**'],
    forbiddenPatterns: ['Mounting a separate DOM island outside the existing app shell.'],
    requiredIntegrationPoints: ['src/App.tsx', 'src/state/AppState.ts'],
    testSelectors: ['#root', '[data-testid="task-list"]'],
  };
}

describe('architecture reviewer', () => {
  it('rejects sidecar React roots for existing-code product features', () => {
    const root = mkdtempSync(join(tmpdir(), 'omniforge-sidecar-review-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      const file = join(root, 'src', 'task-modules.tsx');
      writeFileSync(
        file,
        [
          'import { createRoot } from "react-dom/client";',
          'const mount = document.createElement("div");',
          'mount.className = "task-modules-root";',
          'document.body.appendChild(mount);',
          'createRoot(mount).render(<TaskModules />);',
        ].join('\n'),
      );

      const issues = reviewArchitectureIntegration({ files: [file] });
      expect(issues.map((issue) => issue.code)).toContain('sidecar_dom_island');
      expect(issues[0]?.severity).toBe('blocking');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('adds sidecar findings to the final static product harness', () => {
    const root = mkdtempSync(join(tmpdir(), 'omniforge-sidecar-harness-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(
        join(root, 'src', 'main.tsx'),
        [
          'import { createRoot } from "react-dom/client";',
          'const sidecar = document.createElement("div");',
          'sidecar.dataset.omniforgeSidecar = "task-modules";',
          'document.body.appendChild(sidecar);',
          'createRoot(sidecar).render(<TaskModules />);',
        ].join('\n'),
      );

      const result = runStaticWebProductHarness([
        {
          id: 'tk_sidecar',
          name: 'Implement task modules',
          kind: 'cli_spawn',
          status: 'completed',
          model: 'cx/gpt-5.4',
          executor_hint: 'cli:codex',
          input_json: JSON.stringify({ execution_context: { worktree_root: root } }),
          output_json: 'Implemented sidecar.',
          acceptance_criteria: 'Task modules are visible.',
        },
      ]);

      expect(result.status).toBe('failed');
      expect(result.issues.map((issue) => issue.code)).toContain('sidecar_dom_island');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('loads the workflow architecture contract into final product evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'omniforge-sidecar-contract-'));
    const db = initDb(':memory:');
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(
        join(root, 'src', 'main.tsx'),
        [
          'import { createRoot } from "react-dom/client";',
          'const sidecar = document.createElement("div");',
          'sidecar.dataset.omniforgeSidecar = "task-modules";',
          'document.body.appendChild(sidecar);',
          'createRoot(sidecar).render(<TaskModules />);',
        ].join('\n'),
      );
      const workflow = makeWorkflow();
      insertWorkflow(db, workflow);
      insertTask(db, makeTask(workflow.id, root));
      recordArchitectureContract(db, {
        runId: workflow.id,
        contract: contractFor(workflow.id, root),
      });

      const bundle = buildFinalProductEvidenceBundle(db, workflow.id);
      const sidecar = bundle.productHarness.issues.find((issue) => issue.code === 'sidecar_dom_island');
      expect(bundle.productHarness.status).toBe('failed');
      expect(bundle.productHarness.notes).toContain(
        'Static product harness applied the workflow architecture integration contract.',
      );
      expect(sidecar?.safeContext).toMatchObject({
        contract: {
          appType: 'react',
          requiredIntegrationPoints: ['src/App.tsx', 'src/state/AppState.ts'],
        },
      });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // F1-10: deterministic detectors added by F1-7
  // ---------------------------------------------------------------------------

  describe('detectsParallelDomRoot', () => {
    it('flags a new createRoot file when existingUiSurfaces is set', () => {
      const root = mkdtempSync(join(tmpdir(), 'omniforge-arch-pdom-1-'));
      try {
        mkdirSync(join(root, 'src'), { recursive: true });
        const file = join(root, 'src', 'task-panel.tsx');
        writeFileSync(
          file,
          [
            'import { createRoot } from "react-dom/client";',
            'const el = document.getElementById("task-panel-root")!;',
            'createRoot(el).render(<TaskPanel />);',
          ].join('\n'),
        );

        const issues = reviewArchitectureIntegration({
          files: [file],
          changedFiles: [file],
          contract: {
            ...contractFor('wf', root),
            forbiddenPatterns: [],
          },
          objective: 'Add a task panel',
        });

        expect(issues.map((i) => i.code)).toContain('arch.parallel_dom_root');
        const issue = issues.find((i) => i.code === 'arch.parallel_dom_root')!;
        expect(issue.severity).toBe('blocking');
        expect(issue.safeContext).toMatchObject({ pattern: 'createRoot(', appType: 'react' });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('does not flag the existing UI surface re-rendering itself', () => {
      const root = mkdtempSync(join(tmpdir(), 'omniforge-arch-pdom-2-'));
      try {
        mkdirSync(join(root, 'src'), { recursive: true });
        const existing = join(root, 'src', 'App.tsx');
        writeFileSync(
          existing,
          [
            'import { createRoot } from "react-dom/client";',
            'createRoot(document.getElementById("root")!).render(<App />);',
          ].join('\n'),
        );

        const issues = reviewArchitectureIntegration({
          files: [existing],
          changedFiles: [existing],
          contract: {
            ...contractFor('wf', root),
            forbiddenPatterns: [],
          },
          objective: 'Update App component',
        });

        expect(issues.map((i) => i.code)).not.toContain('arch.parallel_dom_root');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('flags ReactDOM.render in a new file', () => {
      const root = mkdtempSync(join(tmpdir(), 'omniforge-arch-pdom-3-'));
      try {
        mkdirSync(join(root, 'src'), { recursive: true });
        const file = join(root, 'src', 'legacy-mount.tsx');
        writeFileSync(
          file,
          [
            'import ReactDOM from "react-dom";',
            'ReactDOM.render(<Legacy />, document.getElementById("legacy"));',
          ].join('\n'),
        );

        const issues = reviewArchitectureIntegration({
          files: [file],
          changedFiles: [file],
          contract: {
            ...contractFor('wf', root),
            forbiddenPatterns: [],
          },
          objective: 'Add legacy widget',
        });

        const matched = issues.find((i) => i.code === 'arch.parallel_dom_root');
        expect(matched).toBeDefined();
        expect(matched?.safeContext).toMatchObject({ pattern: 'ReactDOM.render(' });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('flags hydrateRoot in a new file', () => {
      const root = mkdtempSync(join(tmpdir(), 'omniforge-arch-pdom-4-'));
      try {
        mkdirSync(join(root, 'src'), { recursive: true });
        const file = join(root, 'src', 'ssr-hydrate.tsx');
        writeFileSync(
          file,
          [
            'import { hydrateRoot } from "react-dom/client";',
            'hydrateRoot(document.getElementById("ssr-root")!, <App />);',
          ].join('\n'),
        );

        const issues = reviewArchitectureIntegration({
          files: [file],
          changedFiles: [file],
          contract: {
            ...contractFor('wf', root),
            forbiddenPatterns: [],
          },
          objective: 'Add SSR hydration',
        });

        const matched = issues.find((i) => i.code === 'arch.parallel_dom_root');
        expect(matched).toBeDefined();
        expect(matched?.safeContext).toMatchObject({ pattern: 'hydrateRoot(' });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('skips parallel-DOM detection when existingUiSurfaces is empty', () => {
      const root = mkdtempSync(join(tmpdir(), 'omniforge-arch-pdom-5-'));
      try {
        mkdirSync(join(root, 'src'), { recursive: true });
        const file = join(root, 'src', 'mount.tsx');
        writeFileSync(
          file,
          [
            'import { createRoot } from "react-dom/client";',
            'createRoot(document.getElementById("root")!).render(<App />);',
          ].join('\n'),
        );

        const issues = reviewArchitectureIntegration({
          files: [file],
          changedFiles: [file],
          contract: {
            ...contractFor('wf', root),
            existingUiSurfaces: [],
            forbiddenPatterns: [],
          },
          objective: 'Bootstrap app',
        });

        expect(issues.map((i) => i.code)).not.toContain('arch.parallel_dom_root');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('opts out of parallel-DOM detection when objective contains "standalone"', () => {
      const root = mkdtempSync(join(tmpdir(), 'omniforge-arch-pdom-6-'));
      try {
        mkdirSync(join(root, 'src'), { recursive: true });
        const file = join(root, 'src', 'standalone-widget.tsx');
        writeFileSync(
          file,
          [
            'import { createRoot } from "react-dom/client";',
            'createRoot(document.getElementById("widget")!).render(<Widget />);',
          ].join('\n'),
        );

        const issues = reviewArchitectureIntegration({
          files: [file],
          changedFiles: [file],
          contract: {
            ...contractFor('wf', root),
            forbiddenPatterns: [],
          },
          objective: 'Build a standalone widget for embedding',
        });

        expect(issues.map((i) => i.code)).not.toContain('arch.parallel_dom_root');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('keeps blocking when forbiddenPatterns explicitly forbid sidecar even if objective opts in', () => {
      const root = mkdtempSync(join(tmpdir(), 'omniforge-arch-pdom-7-'));
      try {
        mkdirSync(join(root, 'src'), { recursive: true });
        const file = join(root, 'src', 'standalone-widget.tsx');
        writeFileSync(
          file,
          [
            'import { createRoot } from "react-dom/client";',
            'createRoot(document.getElementById("widget")!).render(<Widget />);',
          ].join('\n'),
        );

        const issues = reviewArchitectureIntegration({
          files: [file],
          changedFiles: [file],
          contract: {
            ...contractFor('wf', root),
            forbiddenPatterns: ['No sidecar widgets allowed in this product'],
          },
          objective: 'Build a standalone widget',
        });

        expect(issues.map((i) => i.code)).toContain('arch.parallel_dom_root');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('normalizes Windows backslash paths when matching existing surfaces', () => {
      const root = mkdtempSync(join(tmpdir(), 'omniforge-arch-pdom-8-'));
      try {
        mkdirSync(join(root, 'src'), { recursive: true });
        const existing = join(root, 'src', 'App.tsx');
        writeFileSync(
          existing,
          [
            'import { createRoot } from "react-dom/client";',
            'createRoot(document.getElementById("root")!).render(<App />);',
          ].join('\n'),
        );
        // Force a backslash-style path on the input regardless of platform.
        const backslashPath = existing.replace(/\//g, '\\');

        const issues = reviewArchitectureIntegration({
          files: [existing],
          changedFiles: [backslashPath],
          contract: {
            ...contractFor('wf', root),
            forbiddenPatterns: [],
          },
          objective: 'Update App',
        });

        // Existing surface ends with src/App.tsx — must NOT trigger parallel root.
        expect(issues.map((i) => i.code)).not.toContain('arch.parallel_dom_root');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('detectsParallelStateStore', () => {
    it('flags a new createSlice (redux-toolkit) file when existingStateStores is set', () => {
      const root = mkdtempSync(join(tmpdir(), 'omniforge-arch-pstore-1-'));
      try {
        mkdirSync(join(root, 'src'), { recursive: true });
        const file = join(root, 'src', 'taskSlice.ts');
        writeFileSync(
          file,
          [
            'import { createSlice } from "@reduxjs/toolkit";',
            'export const taskSlice = createSlice({ name: "tasks", initialState: [], reducers: {} });',
          ].join('\n'),
        );

        const issues = reviewArchitectureIntegration({
          files: [file],
          changedFiles: [file],
          contract: {
            ...contractFor('wf', root),
            forbiddenPatterns: [],
          },
          objective: 'Add task slice',
        });

        const matched = issues.find((i) => i.code === 'arch.parallel_state_store');
        expect(matched).toBeDefined();
        expect(matched?.severity).toBe('blocking');
        expect(matched?.safeContext).toMatchObject({ detectedLibrary: 'redux-toolkit' });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('flags a new defineStore (pinia) file', () => {
      const root = mkdtempSync(join(tmpdir(), 'omniforge-arch-pstore-2-'));
      try {
        mkdirSync(join(root, 'src'), { recursive: true });
        const file = join(root, 'src', 'taskStore.ts');
        writeFileSync(
          file,
          [
            'import { defineStore } from "pinia";',
            'export const useTasks = defineStore("tasks", { state: () => ({ items: [] }) });',
          ].join('\n'),
        );

        const issues = reviewArchitectureIntegration({
          files: [file],
          changedFiles: [file],
          contract: {
            ...contractFor('wf', root),
            forbiddenPatterns: [],
          },
          objective: 'Add Pinia store',
        });

        const matched = issues.find((i) => i.code === 'arch.parallel_state_store');
        expect(matched).toBeDefined();
        expect(matched?.safeContext).toMatchObject({ detectedLibrary: 'pinia' });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('flags a new zustand factory `create((set) => ...)`', () => {
      const root = mkdtempSync(join(tmpdir(), 'omniforge-arch-pstore-3-'));
      try {
        mkdirSync(join(root, 'src'), { recursive: true });
        const file = join(root, 'src', 'useTasks.ts');
        writeFileSync(
          file,
          [
            'import { create } from "zustand";',
            'export const useTasks = create((set) => ({ tasks: [], add: (t) => set((s) => ({ tasks: [...s.tasks, t] })) }));',
          ].join('\n'),
        );

        const issues = reviewArchitectureIntegration({
          files: [file],
          changedFiles: [file],
          contract: {
            ...contractFor('wf', root),
            forbiddenPatterns: [],
          },
          objective: 'Add zustand store',
        });

        const matched = issues.find((i) => i.code === 'arch.parallel_state_store');
        expect(matched).toBeDefined();
        expect(matched?.safeContext).toMatchObject({ detectedLibrary: 'zustand' });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('does not flag an existing store file even when content matches', () => {
      const root = mkdtempSync(join(tmpdir(), 'omniforge-arch-pstore-4-'));
      try {
        mkdirSync(join(root, 'src', 'state'), { recursive: true });
        const existing = join(root, 'src', 'state', 'AppState.ts');
        writeFileSync(
          existing,
          [
            'import { createSlice } from "@reduxjs/toolkit";',
            'export const appSlice = createSlice({ name: "app", initialState: {}, reducers: {} });',
          ].join('\n'),
        );

        const issues = reviewArchitectureIntegration({
          files: [existing],
          changedFiles: [existing],
          contract: {
            ...contractFor('wf', root),
            forbiddenPatterns: [],
          },
          objective: 'Update AppState',
        });

        expect(issues.map((i) => i.code)).not.toContain('arch.parallel_state_store');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('skips parallel-store detection when existingStateStores is empty', () => {
      const root = mkdtempSync(join(tmpdir(), 'omniforge-arch-pstore-5-'));
      try {
        mkdirSync(join(root, 'src'), { recursive: true });
        const file = join(root, 'src', 'newStore.ts');
        writeFileSync(
          file,
          [
            'import { createSlice } from "@reduxjs/toolkit";',
            'export const x = createSlice({ name: "x", initialState: {}, reducers: {} });',
          ].join('\n'),
        );

        const issues = reviewArchitectureIntegration({
          files: [file],
          changedFiles: [file],
          contract: {
            ...contractFor('wf', root),
            existingStateStores: [],
            forbiddenPatterns: [],
          },
          objective: 'Bootstrap state',
        });

        expect(issues.map((i) => i.code)).not.toContain('arch.parallel_state_store');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('validatesAllowedFiles', () => {
    it('flags a file outside src/** when allowedFiles=["src/**"]', () => {
      const root = mkdtempSync(join(tmpdir(), 'omniforge-arch-allow-1-'));
      try {
        mkdirSync(join(root, 'scripts'), { recursive: true });
        const file = join(root, 'scripts', 'build.ts');
        writeFileSync(file, 'export {};');

        const issues = reviewArchitectureIntegration({
          files: [file],
          changedFiles: ['scripts/build.ts'],
          contract: {
            ...contractFor('wf', root),
            forbiddenPatterns: [],
          },
          objective: 'Add build script',
        });

        const matched = issues.find((i) => i.code === 'arch.changed_files_outside_contract');
        expect(matched).toBeDefined();
        expect(matched?.severity).toBe('blocking');
        expect(matched?.safeContext).toMatchObject({ file: 'scripts/build.ts' });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('does not flag tests outside src/** thanks to the built-in tests allowlist', () => {
      const root = mkdtempSync(join(tmpdir(), 'omniforge-arch-allow-2-'));
      try {
        const issues = reviewArchitectureIntegration({
          files: [],
          changedFiles: [
            'tests/unit/foo.test.ts',
            'test/setup.ts',
            '__tests__/legacy.spec.tsx',
            'src/utils/x.test.ts',
          ],
          contract: {
            ...contractFor('wf', root),
            forbiddenPatterns: [],
          },
          objective: 'Add tests',
        });

        expect(issues.map((i) => i.code)).not.toContain('arch.changed_files_outside_contract');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('does not flag files inside the allowed glob', () => {
      const root = mkdtempSync(join(tmpdir(), 'omniforge-arch-allow-3-'));
      try {
        const issues = reviewArchitectureIntegration({
          files: [],
          changedFiles: ['src/components/Button.tsx', 'src/state/AppState.ts'],
          contract: {
            ...contractFor('wf', root),
            forbiddenPatterns: [],
          },
          objective: 'Update components',
        });

        expect(issues.map((i) => i.code)).not.toContain('arch.changed_files_outside_contract');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('flags multiple offenders independently', () => {
      const root = mkdtempSync(join(tmpdir(), 'omniforge-arch-allow-4-'));
      try {
        const issues = reviewArchitectureIntegration({
          files: [],
          changedFiles: ['scripts/build.ts', 'docs/notes.md', 'config/release.yaml'],
          contract: {
            ...contractFor('wf', root),
            forbiddenPatterns: [],
          },
          objective: 'Touch unrelated paths',
        });

        const offenders = issues.filter((i) => i.code === 'arch.changed_files_outside_contract');
        expect(offenders).toHaveLength(3);
        const labels = offenders.map((i) => (i.safeContext as { file: string }).file).sort();
        expect(labels).toEqual(['config/release.yaml', 'docs/notes.md', 'scripts/build.ts']);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('is a no-op when allowedFiles is empty', () => {
      const root = mkdtempSync(join(tmpdir(), 'omniforge-arch-allow-5-'));
      try {
        const issues = reviewArchitectureIntegration({
          files: [],
          changedFiles: ['anywhere/at/all.ts', 'whatever.md'],
          contract: {
            ...contractFor('wf', root),
            allowedFiles: [],
            forbiddenPatterns: [],
          },
          objective: 'No scope',
        });

        expect(issues.map((i) => i.code)).not.toContain('arch.changed_files_outside_contract');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('normalizes Windows backslashes before glob match', () => {
      const root = mkdtempSync(join(tmpdir(), 'omniforge-arch-allow-6-'));
      try {
        const issues = reviewArchitectureIntegration({
          files: [],
          changedFiles: ['src\\components\\Button.tsx', 'src\\state\\AppState.ts'],
          contract: {
            ...contractFor('wf', root),
            forbiddenPatterns: [],
          },
          objective: 'Update with Windows paths',
        });

        expect(issues.map((i) => i.code)).not.toContain('arch.changed_files_outside_contract');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('cross-cutting behaviour', () => {
    it('returns no contract-derived issues and does not throw when contract is null', () => {
      const root = mkdtempSync(join(tmpdir(), 'omniforge-arch-cross-1-'));
      try {
        mkdirSync(join(root, 'src'), { recursive: true });
        const file = join(root, 'src', 'plain.ts');
        writeFileSync(file, 'export const x = 1;');

        const issues = reviewArchitectureIntegration({
          files: [file],
          changedFiles: [file],
          contract: null,
          objective: 'Whatever',
        });

        // Without a contract, none of the contract-gated detectors should fire.
        const codes = issues.map((i) => i.code);
        expect(codes).not.toContain('arch.parallel_dom_root');
        expect(codes).not.toContain('arch.parallel_state_store');
        expect(codes).not.toContain('arch.changed_files_outside_contract');
        expect(codes).not.toContain('arch.changed_files_overflow');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('caps changedFiles at 500 and emits arch.changed_files_overflow warning', () => {
      const root = mkdtempSync(join(tmpdir(), 'omniforge-arch-cross-2-'));
      try {
        const changed = Array.from({ length: 600 }, (_, i) => `src/feature/file_${i}.ts`);

        const issues = reviewArchitectureIntegration({
          files: [],
          changedFiles: changed,
          contract: {
            ...contractFor('wf', root),
            forbiddenPatterns: [],
          },
          objective: 'Bulk touch',
        });

        const overflow = issues.find((i) => i.code === 'arch.changed_files_overflow');
        expect(overflow).toBeDefined();
        expect(overflow?.severity).toBe('warning');
        expect(overflow?.safeContext).toMatchObject({ totalFiles: 600, capped: 500 });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
