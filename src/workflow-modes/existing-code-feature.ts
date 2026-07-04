import type Database from 'better-sqlite3';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import type { Dag, DagTask } from '../types/index.js';
import { recordContextDecision } from '../context/store.js';

export type WorkflowMode = 'standard' | 'existing_code_feature';

export interface ArchitectureContract {
  runId: string;
  projectRoot: string;
  appType: 'react' | 'node' | 'unknown';
  existingStateStores: string[];
  existingUiSurfaces: string[];
  allowedFiles: string[];
  forbiddenPatterns: string[];
  requiredIntegrationPoints: string[];
  testSelectors: string[];
}

/**
 * Human-readable English directives, not regex/substring matchers. Each
 * directive must have a corresponding detector helper in
 * `src/quality/architecture-reviewer.ts` (gated on the directive's presence
 * in `contract.forbiddenPatterns`).
 */
export const EXISTING_CODE_FORBIDDEN_PATTERNS = [
  'Mounting a separate DOM island outside the existing app shell.',
  'Creating a duplicate store when an existing store owns the domain.',
  'Adding a feature only to a demo/mock/sidebar surface when the objective targets the product workflow.',
  'Passing only with build output and no browser/product evidence for UI work.',
  'Creating a .task-modules-root or similar sidecar root unless explicitly requested.',
  'Calling createRoot(...) or ReactDOM.render(...) on a freshly created element when the app already mounts a single root.',
  'Instantiating a parallel Redux/Zustand/Pinia/Vuex store (createStore, configureStore, createSlice, defineStore, create((set,get) => ...)) when an equivalent domain store already exists in the contract.existingStateStores list.',
  'Creating a parallel React Context (createContext) for state that the existing existingStateStores already owns.',
  'Bootstrapping a second framework instance (new Vue(...), createApp(...), bootstrapApplication(...), angular.module(...)) when the project already has one app entry.',
  'Adding a hard-coded sidecar marker (id="sidecar", id="standalone", id="task-modules-root", data-omniforge-sidecar, .sidecar-root) to the DOM.',
  'Spawning a parallel routing tree (BrowserRouter/Router/createRouter/createBrowserRouter) when the existing app already declares routes.',
  'Re-mounting a parallel QueryClient/SWRConfig/ApolloProvider when the contract.existingUiSurfaces already provide one upstream.',
  'Mounting an additional <html>, <body>, or top-level layout shell instead of integrating into the existing layout component.',
] as const;

const ARCHITECTURE_SCOUT_NAME = 'Explore existing product architecture and integration points';
const ARCHITECTURE_CONTRACT_NAME = 'Write existing-code architecture integration contract';

/**
 * Fallback selectors used by `buildArchitectureContractFromProjectRoot` when
 * the architecture-scout has not yet provided codebase-derived selectors.
 * Implementation tasks should prefer scout-derived selectors and treat these
 * as a last resort.
 */
const DEFAULT_FALLBACK_TEST_SELECTORS = [
  '[data-testid]',
  '#root',
  '.app',
  '.task-card',
  '.task-list',
] as const;

function taskIdSet(tasks: DagTask[]): Set<string> {
  return new Set(tasks.map((task) => task.id));
}

function uniqueTaskId(tasks: DagTask[], base: string): string {
  const existing = taskIdSet(tasks);
  if (!existing.has(base)) return base;
  for (let index = 2; index < 100; index++) {
    const candidate = `${base}_${index}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error(`Could not allocate unique DAG task id for ${base}`);
}

function planGateId(tasks: DagTask[]): string | null {
  return tasks.find((task) => task.id === 't0')?.id
    ?? tasks.find((task) => task.hitl && task.kind === 'llm_call')?.id
    ?? null;
}

function hasArchitectureTask(tasks: DagTask[]): boolean {
  return tasks.some((task) =>
    /architecture|integration contract|entry points|codebase structure/i.test(task.name),
  );
}

export function applyExistingCodeFeatureModeToDag(dag: Dag): Dag {
  if (hasArchitectureTask(dag.tasks)) return dag;

  const tasks = dag.tasks.map((task) => ({ ...task, depends_on: [...task.depends_on] }));
  const gateId = planGateId(tasks);
  const scoutId = uniqueTaskId(tasks, 'architecture_scout');
  const contractId = uniqueTaskId([...tasks, { id: scoutId } as DagTask], 'architecture_contract');

  const scoutTask: DagTask = {
    id: scoutId,
    name: ARCHITECTURE_SCOUT_NAME,
    kind: 'cli_spawn',
    depends_on: gateId ? [gateId] : [],
    executor_hint: 'cli:codex',
    model: 'cx/gpt-5.4',
    acceptance_criteria:
      'Writes architecture-contract-input.md with app entry points, state/store files, UI surfaces, integration points, and any forbidden sidecar patterns observed. '
      + 'Additionally enumerates testSelectors[]: an array of selectors usable by Playwright/RTL to locate the existing feature surfaces — extract from the codebase: (a) every aria-label="..." literal, (b) every data-testid="..." literal, (c) heading text inside <h1>-<h3> on the screens being extended, (d) primary button labels (text inside <button> elements). Write each as a Playwright selector (\'[aria-label="X"]\', \'[data-testid="Y"]\', \'role=heading[name="Z"]\', \'role=button[name="W"]\') in the architecture-contract-input.md. Cap at 30 selectors. If none can be extracted (no UI yet), return an empty array — never the hard-coded defaults. '
      + 'For requiredIntegrationPoints[]: parse the user objective to identify the existing feature noun(s) being extended (e.g. "Settings", "Task form", "Inbox"). For each noun, locate and list (a) the screen/page component file (e.g. src/settings/SettingsPage.tsx), (b) the state slice / context / hook that owns the data (e.g. src/settings/SettingsContext.tsx, src/settings/useSettings.ts), (c) the public re-export barrel if present (e.g. src/settings/index.ts), (d) the route/registration site (e.g. src/router.tsx line where /settings is mounted). Output as relative POSIX paths. Minimum 1 entry, maximum 12 entries. If no existing feature is being extended (greenfield-in-existing-app), output the app entry file (src/App.tsx or src/main.tsx) so downstream tasks at least know where to graft.',
    timeout_seconds: 600,
  };

  const contractTask: DagTask = {
    id: contractId,
    name: ARCHITECTURE_CONTRACT_NAME,
    kind: 'llm_call',
    depends_on: [scoutId],
    model: 'cx/gpt-5.4',
    acceptance_criteria:
      'Outputs a concrete ArchitectureContract covering projectRoot, appType, existingStateStores, existingUiSurfaces, allowedFiles, forbiddenPatterns, requiredIntegrationPoints, and testSelectors. '
      + 'testSelectors must be derived from the architecture-scout output and never copy the buildArchitectureContractFromProjectRoot fallbacks verbatim. If the scout returned an empty array, propagate the empty array (callers will fall back to defaults). '
      + 'requiredIntegrationPoints must reflect the scout-extracted entry points for the feature noun being extended. Never emit an empty array; if scout returned empty, fall back to the contract.existingUiSurfaces App/main entry. Each entry must be a path that actually exists in the project (paths the implementation tasks must import from or modify).',
    timeout_seconds: 600,
  };

  const rewritten = tasks.map((task) => {
    if (task.id === gateId) return task;
    const depends = new Set(task.depends_on.filter((id) => id !== contractId));
    depends.add(contractId);
    return { ...task, depends_on: [...depends] };
  });

  return {
    ...dag,
    tasks: [
      ...rewritten,
      scoutTask,
      contractTask,
    ],
  };
}

function safeReadJson(path: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function walkProjectFiles(root: string, maxFiles = 300): string[] {
  const out: string[] = [];
  const ignored = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);
  const walk = (dir: string, depth: number): void => {
    if (out.length >= maxFiles || depth > 5) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) break;
      if (ignored.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!/\.(ts|tsx|js|jsx|css|json)$/.test(entry.name)) continue;
      try {
        if (statSync(full).size <= 400_000) out.push(full);
      } catch {
        // Ignore unreadable files.
      }
    }
  };
  walk(root, 0);
  return out;
}

function rel(root: string, file: string): string {
  return relative(root, file).replace(/\\/g, '/');
}

function detectAppType(root: string, files: string[]): ArchitectureContract['appType'] {
  const pkg = safeReadJson(join(root, 'package.json'));
  const deps = {
    ...(pkg['dependencies'] && typeof pkg['dependencies'] === 'object' ? pkg['dependencies'] as Record<string, unknown> : {}),
    ...(pkg['devDependencies'] && typeof pkg['devDependencies'] === 'object' ? pkg['devDependencies'] as Record<string, unknown> : {}),
  };
  if ('react' in deps || files.some((file) => /(^|[\\/])(main|App)\.tsx?$/.test(file))) return 'react';
  if (existsSync(join(root, 'package.json'))) return 'node';
  return 'unknown';
}

function detectStateStores(root: string, files: string[]): string[] {
  const stores = new Set<string>();
  for (const file of files) {
    const relativePath = rel(root, file);
    const lower = relativePath.toLowerCase();
    let content = '';
    try {
      content = readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    if (
      lower.includes('/store') ||
      lower.includes('/state') ||
      /\bzustand\b|\bcreateStore\b|\buse[A-Z][A-Za-z0-9]+Store\b/.test(content)
    ) {
      stores.add(relativePath);
    }
  }
  return [...stores].sort();
}

function detectUiSurfaces(root: string, files: string[]): string[] {
  return files
    .map((file) => rel(root, file))
    .filter((file) =>
      /(^|\/)(main|App)\.(tsx|jsx|ts|js)$/.test(file) ||
      /(^|\/)(screens|components|overlays|chrome)\//.test(file),
    )
    .slice(0, 80)
    .sort();
}

export function buildArchitectureContractFromProjectRoot(input: {
  runId: string;
  projectRoot: string;
  objective?: string;
}): ArchitectureContract {
  const root = resolve(input.projectRoot);
  const files = existsSync(root) ? walkProjectFiles(root) : [];
  const existingStateStores = detectStateStores(root, files);
  const existingUiSurfaces = detectUiSurfaces(root, files);
  const appType = detectAppType(root, files);
  const requiredIntegrationPoints = [
    ...existingStateStores.slice(0, 12),
    ...existingUiSurfaces.filter((file) => /(^|\/)(main|App)\.(tsx|jsx|ts|js)$/.test(file)).slice(0, 8),
  ];

  return {
    runId: input.runId,
    projectRoot: root,
    appType,
    existingStateStores,
    existingUiSurfaces,
    allowedFiles: [
      'src/**',
      'app/**',
      'components/**',
      'package.json',
      'vite.config.*',
      'tsconfig*.json',
      'tests/**',
    ],
    forbiddenPatterns: [...EXISTING_CODE_FORBIDDEN_PATTERNS],
    requiredIntegrationPoints: requiredIntegrationPoints.length > 0
      ? requiredIntegrationPoints
      : existingUiSurfaces.slice(0, 12),
    testSelectors: [...DEFAULT_FALLBACK_TEST_SELECTORS],
  };
}

export function recordArchitectureContract(
  db: Database.Database,
  input: {
    runId: string;
    contract: ArchitectureContract;
  },
): void {
  recordContextDecision(db, {
    runId: input.runId,
    kind: 'note',
    status: 'recorded',
    rationale: 'Existing-code feature architecture contract recorded before implementation tasks.',
    metadata: {
      decision_type: 'architecture_contract',
      architecture_contract: input.contract,
    },
  });
}

export function existingCodePlanningInstruction(objective: string): string {
  return [
    objective,
    '',
    '---',
    'OMNIFORGE WORKFLOW MODE: existing_code_feature',
    'This workflow modifies an existing product. Decompose accordingly:',
    '- Add architecture/codebase scout work before feature implementation.',
    '- Add an explicit architecture integration contract before implementation.',
    '- Implementation tasks must integrate into existing app/state/UI surfaces.',
    '- Do not mount a separate DOM island, duplicate app shell, or sidecar feature UI unless the objective explicitly requests it.',
    '- Acceptance criteria must name real integration points, files, selectors, and product evidence.',
  ].join('\n');
}
