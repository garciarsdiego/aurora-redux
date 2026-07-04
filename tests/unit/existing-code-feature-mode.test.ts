import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

import {
  applyExistingCodeFeatureModeToDag,
  buildArchitectureContractFromProjectRoot,
  EXISTING_CODE_FORBIDDEN_PATTERNS,
} from '../../src/workflow-modes/existing-code-feature.js';
import type { Dag } from '../../src/types/index.js';

describe('existing-code feature workflow mode', () => {
  it('adds architecture scout and contract tasks before implementation tasks', () => {
    const dag: Dag = {
      tasks: [
        {
          id: 't0',
          name: 'Review execution plan',
          kind: 'llm_call',
          depends_on: [],
          hitl: true,
          acceptance_criteria: 'Plan lists subsequent tasks with kinds and deliverables',
        },
        {
          id: 't1',
          name: 'Implement task creation UI',
          kind: 'cli_spawn',
          depends_on: ['t0'],
          executor_hint: 'cli:codex',
          model: 'cx/gpt-5.4',
          acceptance_criteria: 'src/App.tsx imports the feature and build exits 0',
        },
      ],
    };

    const rewritten = applyExistingCodeFeatureModeToDag(dag);
    const scout = rewritten.tasks.find((task) => task.id === 'architecture_scout');
    const contract = rewritten.tasks.find((task) => task.id === 'architecture_contract');
    const implementation = rewritten.tasks.find((task) => task.id === 't1');

    expect(scout?.depends_on).toEqual(['t0']);
    expect(contract?.depends_on).toEqual(['architecture_scout']);
    expect(implementation?.depends_on).toContain('architecture_contract');
  });

  it('builds an architecture contract from the existing React project structure', () => {
    const root = mkdtempSync(join(tmpdir(), 'omniforge-existing-code-'));
    try {
      mkdirSync(join(root, 'src', 'state'), { recursive: true });
      mkdirSync(join(root, 'src', 'components'), { recursive: true });
      writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { react: '^19.0.0' } }));
      writeFileSync(join(root, 'src', 'main.tsx'), 'import { createRoot } from "react-dom/client";');
      writeFileSync(join(root, 'src', 'state', 'task-store.ts'), 'export const useTaskStore = create(() => ({}));');
      writeFileSync(join(root, 'src', 'components', 'TaskList.tsx'), 'export function TaskList() { return null; }');

      const contract = buildArchitectureContractFromProjectRoot({
        runId: 'wf_existing_code',
        projectRoot: root,
      });

      expect(contract.appType).toBe('react');
      expect(contract.existingStateStores).toContain('src/state/task-store.ts');
      expect(contract.existingUiSurfaces).toEqual(expect.arrayContaining([
        'src/main.tsx',
        'src/components/TaskList.tsx',
      ]));
      expect(contract.requiredIntegrationPoints).toContain('src/state/task-store.ts');
      expect(contract.forbiddenPatterns.join('\n')).toMatch(/DOM island|sidecar/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('EXISTING_CODE_FORBIDDEN_PATTERNS retains all original 5 entries', () => {
    const original = [
      'Mounting a separate DOM island outside the existing app shell.',
      'Creating a duplicate store when an existing store owns the domain.',
      'Adding a feature only to a demo/mock/sidebar surface when the objective targets the product workflow.',
      'Passing only with build output and no browser/product evidence for UI work.',
      'Creating a .task-modules-root or similar sidecar root unless explicitly requested.',
    ];
    for (const directive of original) {
      expect(EXISTING_CODE_FORBIDDEN_PATTERNS).toContain(directive);
    }
  });

  it('EXISTING_CODE_FORBIDDEN_PATTERNS includes sidecar React mount directive', () => {
    const joined = EXISTING_CODE_FORBIDDEN_PATTERNS.join('\n');
    expect(joined).toMatch(/createRoot\(\.\.\.\)/);
    expect(joined).toMatch(/ReactDOM\.render\(\.\.\.\)/);
  });

  it('EXISTING_CODE_FORBIDDEN_PATTERNS includes parallel state-store directive', () => {
    const joined = EXISTING_CODE_FORBIDDEN_PATTERNS.join('\n');
    expect(joined).toMatch(/Redux\/Zustand\/Pinia\/Vuex/);
    expect(joined).toMatch(/contract\.existingStateStores/);
  });

  it('EXISTING_CODE_FORBIDDEN_PATTERNS includes parallel React Context and second framework bootstrap directives', () => {
    const joined = EXISTING_CODE_FORBIDDEN_PATTERNS.join('\n');
    expect(joined).toMatch(/parallel React Context \(createContext\)/);
    expect(joined).toMatch(/Bootstrapping a second framework instance/);
    expect(joined).toMatch(/createApp\(\.\.\.\)/);
  });

  it('EXISTING_CODE_FORBIDDEN_PATTERNS includes hard-coded sidecar marker directive', () => {
    const joined = EXISTING_CODE_FORBIDDEN_PATTERNS.join('\n');
    expect(joined).toMatch(/hard-coded sidecar marker/);
    expect(joined).toMatch(/data-omniforge-sidecar/);
  });

  it('EXISTING_CODE_FORBIDDEN_PATTERNS includes parallel router and parallel data-layer provider directives', () => {
    const joined = EXISTING_CODE_FORBIDDEN_PATTERNS.join('\n');
    expect(joined).toMatch(/parallel routing tree/);
    expect(joined).toMatch(/BrowserRouter\/Router\/createRouter\/createBrowserRouter/);
    expect(joined).toMatch(/QueryClient\/SWRConfig\/ApolloProvider/);
  });

  it('EXISTING_CODE_FORBIDDEN_PATTERNS includes parallel layout shell directive', () => {
    const joined = EXISTING_CODE_FORBIDDEN_PATTERNS.join('\n');
    expect(joined).toMatch(/<html>, <body>, or top-level layout shell/);
  });

  it('EXISTING_CODE_FORBIDDEN_PATTERNS has at least 13 entries', () => {
    expect(EXISTING_CODE_FORBIDDEN_PATTERNS.length).toBeGreaterThanOrEqual(13);
  });

  it('architecture_scout acceptance criteria mentions testSelectors extraction', () => {
    const dag: Dag = {
      tasks: [
        {
          id: 't0',
          name: 'Review execution plan',
          kind: 'llm_call',
          depends_on: [],
          hitl: true,
          acceptance_criteria: 'Plan lists subsequent tasks with kinds and deliverables',
        },
      ],
    };
    const rewritten = applyExistingCodeFeatureModeToDag(dag);
    const scout = rewritten.tasks.find((task) => task.id === 'architecture_scout');
    expect(scout?.acceptance_criteria).toContain('testSelectors');
    expect(scout?.acceptance_criteria).toContain('aria-label');
  });

  it('architecture_contract acceptance criteria forbids verbatim copying of fallback testSelectors', () => {
    const dag: Dag = {
      tasks: [
        {
          id: 't0',
          name: 'Review execution plan',
          kind: 'llm_call',
          depends_on: [],
          hitl: true,
          acceptance_criteria: 'Plan lists subsequent tasks with kinds and deliverables',
        },
      ],
    };
    const rewritten = applyExistingCodeFeatureModeToDag(dag);
    const contract = rewritten.tasks.find((task) => task.id === 'architecture_contract');
    expect(contract?.acceptance_criteria).toContain('never copy the buildArchitectureContractFromProjectRoot fallbacks verbatim');
  });

  it('architecture_scout acceptance criteria mentions feature-noun integration points', () => {
    const dag: Dag = {
      tasks: [
        {
          id: 't0',
          name: 'Review execution plan',
          kind: 'llm_call',
          depends_on: [],
          hitl: true,
          acceptance_criteria: 'Plan lists subsequent tasks with kinds and deliverables',
        },
      ],
    };
    const rewritten = applyExistingCodeFeatureModeToDag(dag);
    const scout = rewritten.tasks.find((task) => task.id === 'architecture_scout');
    expect(scout?.acceptance_criteria).toContain('requiredIntegrationPoints');
    expect(scout?.acceptance_criteria).toContain('feature noun');
  });

  it('architecture_contract acceptance criteria requires non-empty requiredIntegrationPoints', () => {
    const dag: Dag = {
      tasks: [
        {
          id: 't0',
          name: 'Review execution plan',
          kind: 'llm_call',
          depends_on: [],
          hitl: true,
          acceptance_criteria: 'Plan lists subsequent tasks with kinds and deliverables',
        },
      ],
    };
    const rewritten = applyExistingCodeFeatureModeToDag(dag);
    const contract = rewritten.tasks.find((task) => task.id === 'architecture_contract');
    expect(contract?.acceptance_criteria).toContain('requiredIntegrationPoints');
    expect(contract?.acceptance_criteria).toContain('Never emit an empty array');
  });

  it('DEFAULT_FALLBACK_TEST_SELECTORS contains the 5 original selectors', () => {
    const root = mkdtempSync(join(tmpdir(), 'omniforge-existing-code-fallback-'));
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: {} }));
      const contract = buildArchitectureContractFromProjectRoot({
        runId: 'wf_fallback',
        projectRoot: root,
      });
      expect(contract.testSelectors).toEqual([
        '[data-testid]',
        '#root',
        '.app',
        '.task-card',
        '.task-list',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('applyExistingCodeFeatureModeToDag remains a no-op when an architecture task already exists', () => {
    const dag: Dag = {
      tasks: [
        {
          id: 't0',
          name: 'Explore existing product architecture and integration points',
          kind: 'cli_spawn',
          depends_on: [],
          executor_hint: 'cli:codex',
          model: 'cx/gpt-5.4',
          acceptance_criteria: 'Already-present scout task',
        },
        {
          id: 't1',
          name: 'Implement task creation UI',
          kind: 'cli_spawn',
          depends_on: ['t0'],
          executor_hint: 'cli:codex',
          model: 'cx/gpt-5.4',
          acceptance_criteria: 'src/App.tsx imports the feature and build exits 0',
        },
      ],
    };
    const rewritten = applyExistingCodeFeatureModeToDag(dag);
    expect(rewritten).toEqual(dag);
    expect(rewritten.tasks).toHaveLength(2);
  });
});
