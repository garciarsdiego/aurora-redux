// ModelPickerModal — cascade modal for selecting models per role.
//
// 3-step state machine:
//   1. 'targets'   → pick which role to change (DECOMPOSER / TASK / REVIEWER /
//                    CONSOLIDATOR / ALL / Reset)
//   2. 'providers' → pick provider (Anthropic, OpenAI, Google, ...)
//   3. 'models'    → pick model from chosen provider; on Enter applies +
//                    returns to step 'targets' so user can chain multiple
//                    role changes without retyping `/model`.
//
// Esc semantics:
//   step 'models' → back to 'providers'
//   step 'providers' → back to 'targets'
//   step 'targets' → close modal entirely (popModal)
//
// Persistence: this modal only mutates process.env + sessionSlice. The `S` key
// to save into workspaces/<ws>/.env is a follow-up — for now the picker is
// volatile per session, which is the dogfood-first stance Example asked for.

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { SelectModal } from '../components/SelectModal.js';
import {
  loadCatalog,
  type Catalog,
  type ModelEntry,
  type ModelKind,
  type ProviderInfo,
} from '../services/modelCatalog.js';

export type ModelTarget = 'DECOMPOSER' | 'TASK' | 'REVIEWER' | 'CONSOLIDATOR' | 'ALL' | 'RESET';

// Two parallel env-var namespaces — a target can have a model override (for
// llm_call tasks via Omniroute) AND/OR an executor override (for promoting
// llm_call → cli_spawn via a specific CLI binary). They're independent: e.g.
// TASK_MODEL=cc/claude-sonnet-4-6 + TASK_EXECUTOR=cli:opencode means "run
// DAG tasks via OpenCode CLI using Claude Sonnet as its backend model" (via
// OpenCode's -m flag) — see src/executors/cli.ts cli:opencode branch.
const ENV_KEY: Readonly<Record<Exclude<ModelTarget, 'ALL' | 'RESET'>, string>> = {
  DECOMPOSER: 'DECOMPOSER_MODEL',
  TASK: 'TASK_MODEL',
  REVIEWER: 'REVIEWER_MODEL',
  CONSOLIDATOR: 'CONSOLIDATOR_MODEL',
};

const EXEC_ENV_KEY: Readonly<Record<Exclude<ModelTarget, 'ALL' | 'RESET'>, string>> = {
  DECOMPOSER: 'DECOMPOSER_EXECUTOR',
  TASK: 'TASK_EXECUTOR',
  REVIEWER: 'REVIEWER_EXECUTOR',
  CONSOLIDATOR: 'CONSOLIDATOR_EXECUTOR',
};

const TARGET_ORDER: readonly Exclude<ModelTarget, 'ALL' | 'RESET'>[] = [
  'DECOMPOSER',
  'TASK',
  'REVIEWER',
  'CONSOLIDATOR',
];

const DEFAULT_MODEL: Readonly<Record<Exclude<ModelTarget, 'ALL' | 'RESET'>, string>> = {
  DECOMPOSER: 'claude/claude-opus-4-6',
  TASK: 'claude/claude-sonnet-4-6',
  REVIEWER: 'claude/claude-sonnet-4-6',
  CONSOLIDATOR: 'claude/claude-sonnet-4-6',
};

interface TargetRow {
  readonly target: ModelTarget;
  readonly currentModel: string;
  readonly currentExec: string | null;   // null = no CLI override (llm_call path)
  readonly label: string;
}

interface ModelPickerProps {
  readonly onClose: () => void;
  readonly onAppliedNotify?: (msg: string) => void;
}

type Step =
  | { kind: 'targets' }
  | { kind: 'providers'; target: Exclude<ModelTarget, 'RESET'> }
  | { kind: 'models'; target: Exclude<ModelTarget, 'RESET'>; providerId: string };

// Tier filter cycle: all → S+ only → S+/S → S+/S/S- → A → B → C → all
type TierFilter = 'all' | 'S+' | 'S' | 'S-' | 'A' | 'B' | 'C';
const TIER_CYCLE: readonly TierFilter[] = ['all', 'S+', 'S', 'S-', 'A', 'B', 'C'];

// Kind filter cycle: all → cli → llm → pal → all. Unknown kind (new provider
// without classification yet) is never filtered out — always visible.
type KindFilter = 'all' | 'cli' | 'llm' | 'pal';
const KIND_CYCLE: readonly KindFilter[] = ['all', 'cli', 'llm', 'pal'];

function passesTierFilter(modelTier: string | undefined, filter: TierFilter): boolean {
  if (filter === 'all') return true;
  return modelTier === filter;
}

function passesKindFilter(modelKind: ModelKind, filter: KindFilter): boolean {
  if (filter === 'all') return true;
  if (modelKind === 'unknown') return true; // never hide unclassified
  return modelKind === filter;
}

const KIND_BADGE: Readonly<Record<ModelKind, string>> = {
  cli: 'CLI',
  llm: 'LLM',
  pal: 'PAL',
  unknown: '?',
};

function readCurrentModel(target: Exclude<ModelTarget, 'ALL' | 'RESET'>): string {
  return process.env[ENV_KEY[target]] ?? DEFAULT_MODEL[target];
}

function readCurrentExec(target: Exclude<ModelTarget, 'ALL' | 'RESET'>): string | null {
  return process.env[EXEC_ENV_KEY[target]] ?? null;
}

/**
 * Apply a user's selection. Routing depends on `modelId` shape:
 *   - `cli:<slug>` → set <TARGET>_EXECUTOR env, leaving <TARGET>_MODEL alone.
 *     This tells the brain/executor to promote llm_call tasks to cli_spawn
 *     using the selected binary (see applyExecutorOverride in
 *     src/brain/executor/internal-utils.ts).
 *   - anything else → set <TARGET>_MODEL env, leaving <TARGET>_EXECUTOR alone.
 * The two env vars are independent — you can set both (e.g. cli:opencode +
 * cc/claude-sonnet-4-6) to run through OpenCode with Claude Sonnet as its
 * backend via OpenCode's `-m` flag.
 */
function applyPick(target: Exclude<ModelTarget, 'RESET'>, modelId: string): void {
  if (target === 'ALL') {
    for (const t of TARGET_ORDER) applyPick(t, modelId);
    return;
  }
  const envKey = modelId.startsWith('cli:') ? EXEC_ENV_KEY[target] : ENV_KEY[target];
  process.env[envKey] = modelId;
}

/** Clear all session overrides — models back to defaults, executor unset. */
function applyReset(): void {
  for (const t of TARGET_ORDER) {
    process.env[ENV_KEY[t]] = DEFAULT_MODEL[t];
    delete process.env[EXEC_ENV_KEY[t]];
  }
}

function buildTargetRows(): readonly TargetRow[] {
  const rows: TargetRow[] = TARGET_ORDER.map((t) => ({
    target: t as ModelTarget,
    currentModel: readCurrentModel(t),
    currentExec: readCurrentExec(t),
    label: t,
  }));
  rows.push({
    target: 'ALL',
    currentModel: '(set all 4 to same)',
    currentExec: null,
    label: 'Set ALL to same model',
  });
  rows.push({
    target: 'RESET',
    currentModel: '(restore env defaults + clear executor overrides)',
    currentExec: null,
    label: 'Reset to defaults',
  });
  return rows;
}

export function ModelPickerModal({
  onClose,
  onAppliedNotify,
}: ModelPickerProps): React.ReactElement {
  const [step, setStep] = useState<Step>({ kind: 'targets' });
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [tick, setTick] = useState(0); // bumps after apply to refresh target rows
  const [tierFilter, setTierFilter] = useState<TierFilter>('all');
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');

  const cycleTier = (): void => {
    const idx = TIER_CYCLE.indexOf(tierFilter);
    const next = TIER_CYCLE[(idx + 1) % TIER_CYCLE.length] ?? 'all';
    setTierFilter(next);
  };

  const cycleKind = (): void => {
    const idx = KIND_CYCLE.indexOf(kindFilter);
    const next = KIND_CYCLE[(idx + 1) % KIND_CYCLE.length] ?? 'all';
    setKindFilter(next);
  };

  // Composite filter predicate used at model + provider stages.
  const modelPasses = (m: ModelEntry): boolean =>
    passesTierFilter(m.tier, tierFilter) && passesKindFilter(m.kind, kindFilter);

  const tierLabel = tierFilter === 'all' ? undefined : `tier:${tierFilter}`;
  const kindLabel = kindFilter === 'all' ? undefined : `kind:${kindFilter}`;

  // Load catalog once on mount (cached internally for 5min).
  useEffect(() => {
    let cancelled = false;
    loadCatalog().then(
      (cat) => { if (!cancelled) setCatalog(cat); },
      (err: unknown) => {
        if (!cancelled) setCatalogError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => { cancelled = true; };
  }, []);

  // Step 'targets' uses `tick` to recompute current values after a successful apply.
  const targetRows = useMemo<readonly TargetRow[]>(() => buildTargetRows(), [tick]);

  // Catastrophic catalog failure — render an error frame with Esc to close.
  useInput((_input, key) => {
    if (catalogError && key.escape) onClose();
  });

  if (catalogError && !catalog) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1}>
        <Text color="red" bold>Cannot load model catalog</Text>
        <Text>{catalogError}</Text>
        <Text dimColor>Esc to close</Text>
      </Box>
    );
  }

  if (catalog === null) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text dimColor>Loading model catalog…</Text>
      </Box>
    );
  }

  // Step 1 — TARGETS
  if (step.kind === 'targets') {
    return (
      <SelectModal<TargetRow>
        title={`Models · current configuration${catalog.liveError ? ' · (CSV only — live API unavailable)' : ` · source:${catalog.source}`}`}
        items={targetRows}
        searchableText={(row) => `${row.label} ${row.currentModel} ${row.currentExec ?? ''}`}
        onSelect={(row) => {
          if (row.target === 'RESET') {
            applyReset();
            onAppliedNotify?.('All 4 targets reset (models to defaults + executor overrides cleared)');
            setTick((t) => t + 1);
            return;
          }
          if (row.target === 'ALL') {
            setStep({ kind: 'providers', target: 'ALL' });
            return;
          }
          setStep({ kind: 'providers', target: row.target as Exclude<ModelTarget, 'ALL' | 'RESET'> });
        }}
        onCancel={onClose}
        renderItem={(row, isSelected) => (
          <Box>
            <Text color={isSelected ? 'cyan' : undefined} bold={isSelected}>
              {row.label.padEnd(13)}
            </Text>
            <Text> </Text>
            <Text dimColor>{row.currentModel}</Text>
            {row.currentExec ? (
              <Text color="magenta">{`  ▸ exec=${row.currentExec}`}</Text>
            ) : null}
          </Box>
        )}
        footer="↑↓ navigate · Enter change · Esc close · pick a cli:* model to set *_EXECUTOR override"
      />
    );
  }

  // Step 2 — PROVIDERS (filter by tier+kind: only providers with at least 1 matching model)
  if (step.kind === 'providers') {
    const targetLabel = step.target === 'ALL' ? 'ALL targets' : step.target;
    // Apply composite filter at provider level: a provider is shown iff it has
    // at least one model matching BOTH tier and kind filters. modelCount recomputed.
    const providersFiltered: readonly ProviderInfo[] = catalog.providers
      .map((prov) => {
        const matchingCount = catalog.models.filter(
          (m) => m.provider === prov.id && modelPasses(m),
        ).length;
        return { ...prov, modelCount: matchingCount };
      })
      .filter((prov) => prov.modelCount > 0);

    return (
      <SelectModal<ProviderInfo>
        title={`Pick provider for ${targetLabel}`}
        items={providersFiltered}
        toggleBindings={[
          ...(tierLabel ? [{ char: 't', onCycle: cycleTier, label: tierLabel }] : [{ char: 't', onCycle: cycleTier }]),
          ...(kindLabel ? [{ char: 'k', onCycle: cycleKind, label: kindLabel }] : [{ char: 'k', onCycle: cycleKind }]),
        ]}
        searchableText={(prov) => `${prov.displayName} ${prov.id}`}
        onSelect={(prov) => setStep({ kind: 'models', target: step.target, providerId: prov.id })}
        onCancel={() => setStep({ kind: 'targets' })}
        renderItem={(prov, isSelected) => (
          <Box>
            <Text color={isSelected ? 'cyan' : undefined} bold={isSelected}>
              {prov.displayName}
            </Text>
            <Text dimColor>{`  ${prov.modelCount} model${prov.modelCount === 1 ? '' : 's'}`}</Text>
          </Box>
        )}
      />
    );
  }

  // Step 3 — MODELS for selected provider
  const modelsForProvider: readonly ModelEntry[] = catalog.models.filter(
    (m) => m.provider === step.providerId,
  );
  // "Current" highlight marker: for the llm case, compare against <TARGET>_MODEL.
  // For a cli:* selection, compare against <TARGET>_EXECUTOR — both lanes shown
  // with the ◄ current marker in their respective rows.
  const currentModelForTarget =
    step.target === 'ALL' ? '' : readCurrentModel(step.target);
  const currentExecForTarget =
    step.target === 'ALL' ? '' : (readCurrentExec(step.target) ?? '');
  const targetLabel = step.target === 'ALL' ? 'ALL targets' : step.target;

  return (
    <SelectModal<ModelEntry>
      title={`Pick model for ${targetLabel}`}
      items={modelsForProvider}
      externalFilter={modelPasses}
      toggleBindings={[
        ...(tierLabel ? [{ char: 't', onCycle: cycleTier, label: tierLabel }] : [{ char: 't', onCycle: cycleTier }]),
        ...(kindLabel ? [{ char: 'k', onCycle: cycleKind, label: kindLabel }] : [{ char: 'k', onCycle: cycleKind }]),
      ]}
      searchableText={(model) =>
        `${model.model_id} ${model.kind} ${model.tier ?? ''} ${model.use_primary ?? ''} ${model.use_secondary ?? ''}`
      }
      onSelect={(model) => {
        applyPick(step.target, model.model_id);
        const targetSummary = step.target === 'ALL' ? 'all 4 targets' : step.target;
        const isCli = model.model_id.startsWith('cli:');
        const lane = isCli ? 'executor override' : 'model';
        onAppliedNotify?.(
          `${targetSummary} ${lane} → ${model.model_id} [${KIND_BADGE[model.kind]}] (this session)`,
        );
        setStep({ kind: 'targets' });
        setTick((t) => t + 1);
      }}
      onCancel={() => setStep({ kind: 'providers', target: step.target })}
      renderItem={(model, isSelected) => {
        // Highlight whichever lane this entry belongs to — cli:* entries
        // compare against <TARGET>_EXECUTOR; everything else compares against
        // <TARGET>_MODEL. Both lanes render ◄ current independently.
        const isCli = model.model_id.startsWith('cli:');
        const isCurrent = isCli
          ? model.model_id === currentExecForTarget
          : model.model_id === currentModelForTarget;
        const kindColor: string | undefined =
          model.kind === 'cli' ? 'magenta' :
          model.kind === 'pal' ? 'yellow' :
          model.kind === 'llm' ? 'cyan' :
          undefined;
        return (
          <Box>
            <Text color={isSelected ? 'cyan' : undefined} bold={isSelected}>
              {model.model_id.padEnd(45)}
            </Text>
            <Text color={kindColor} dimColor>{` [${KIND_BADGE[model.kind]}]`}</Text>
            <Text dimColor>
              {(model.tier ? ` ${model.tier}` : '').padEnd(5)}
              {model.use_primary ? ` · ${model.use_primary}` : ''}
            </Text>
            {isCurrent ? <Text color="green">{' ◄ current'}</Text> : null}
          </Box>
        );
      }}
      emptyMessage={`No models for '${step.providerId}' matching active filters`}
    />
  );
}
