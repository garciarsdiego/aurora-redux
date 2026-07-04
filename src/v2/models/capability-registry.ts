import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type ModelCapability =
  | 'streaming'
  | 'structured_output'
  | 'tool_calling'
  | 'multimodal'
  | 'embeddings'
  | 'batch'
  | 'local';

export interface ModelCapabilities {
  streaming: boolean;
  structured_output: boolean;
  tool_calling: boolean;
  multimodal: boolean;
  embeddings: boolean;
  batch: boolean;
  local: boolean;
}

export interface ModelCapabilityEntry {
  model_id: string;
  provider: string;
  use_primary: string;
  use_secondary: string;
  score_primary: number;
  score_secondary: number;
  tier: string;
  eq_ref: number;
  quality_rank: number;
  cost_rank: number;
  capabilities: ModelCapabilities;
}

export interface ModelRouteRequest {
  useCase?: string;
  provider?: string;
  requiredCapabilities?: ModelCapability[];
  strategy?: 'quality' | 'cost' | 'balanced';
}

const TIER_RANK: Record<string, number> = {
  'S+': 6,
  S: 5,
  'S-': 4,
  'A+': 4,
  A: 3,
  'B+': 2,
  B: 1,
  C: 0,
};

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === ',' && !inQuotes) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((part) => part.trim());
}

function parseScore(value: string | undefined): number {
  const n = Number((value ?? '').replace(/\/100|%/g, '').trim());
  return Number.isFinite(n) ? n : 0;
}

function providerFromModel(modelId: string): string {
  const slash = modelId.indexOf('/');
  return slash > 0 ? modelId.slice(0, slash) : 'unknown';
}

export function inferCapabilities(modelId: string): ModelCapabilities {
  const lower = modelId.toLowerCase();
  const provider = providerFromModel(modelId).toLowerCase();
  const isLocal = provider.includes('ollama') || provider.includes('local');
  const isEmbedding = lower.includes('embed');
  const isGemini = lower.includes('gemini');
  const isClaude = lower.includes('claude');
  const isGpt = lower.includes('gpt') || lower.includes('o1') || lower.includes('o3');
  const customTools = lower.includes('customtools') || lower.includes('tools');

  return {
    streaming: true,
    structured_output: !isEmbedding,
    tool_calling: customTools || isClaude || isGpt,
    multimodal: isGemini || lower.includes('vision') || lower.includes('multimodal'),
    embeddings: isEmbedding,
    batch: provider === 'openai' || provider === 'cx' || provider === 'gh',
    local: isLocal,
  };
}

export function parseProviderMatrixCsv(csvText: string): ModelCapabilityEntry[] {
  const lines = csvText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.slice(1).map((line) => {
    const [model_id = '', use_primary = '', use_secondary = '', score_primary = '', score_secondary = '', tier = '', eq_ref = ''] =
      splitCsvLine(line);
    const modelId = model_id.trim();
    const qualityRank = TIER_RANK[tier.trim()] ?? 0;
    return {
      model_id: modelId,
      provider: providerFromModel(modelId),
      use_primary: use_primary.trim(),
      use_secondary: use_secondary.trim(),
      score_primary: parseScore(score_primary),
      score_secondary: parseScore(score_secondary),
      tier: tier.trim(),
      eq_ref: parseScore(eq_ref),
      quality_rank: qualityRank,
      cost_rank: 6 - qualityRank,
      capabilities: inferCapabilities(modelId),
    };
  }).filter((entry) => entry.model_id.length > 0);
}

export function loadProviderMatrixCatalog(): ModelCapabilityEntry[] {
  const csvPath = join(process.cwd(), 'docs', '08-AI-PROVIDER-MATRIX.csv');
  return parseProviderMatrixCsv(readFileSync(csvPath, 'utf-8'));
}

function matchesUseCase(entry: ModelCapabilityEntry, useCase: string | undefined): boolean {
  if (!useCase) return true;
  const needle = useCase.toLowerCase();
  return (
    entry.use_primary.toLowerCase().includes(needle) ||
    entry.use_secondary.toLowerCase().includes(needle) ||
    entry.model_id.toLowerCase().includes(needle)
  );
}

function hasRequiredCapabilities(
  entry: ModelCapabilityEntry,
  capabilities: readonly ModelCapability[] | undefined,
): boolean {
  if (!capabilities || capabilities.length === 0) return true;
  return capabilities.every((capability) => entry.capabilities[capability]);
}

function explicitCapabilityBoost(
  entry: ModelCapabilityEntry,
  request: ModelRouteRequest,
): number {
  const required = request.requiredCapabilities ?? [];
  let boost = 0;
  if (required.includes('tool_calling') && /customtools|tools/i.test(entry.model_id)) boost += 10;
  if (required.includes('local') && entry.capabilities.local) boost += 10;
  return boost;
}

function useCaseBoost(entry: ModelCapabilityEntry, request: ModelRouteRequest): number {
  if (!request.useCase) return 0;
  const needle = request.useCase.toLowerCase();
  if (entry.use_primary.toLowerCase().includes(needle)) return 50;
  if (entry.use_secondary.toLowerCase().includes(needle)) return 10;
  return 0;
}

function scoreFor(entry: ModelCapabilityEntry, request: ModelRouteRequest): number {
  const strategy = request.strategy ?? 'quality';
  const boost = explicitCapabilityBoost(entry, request) + useCaseBoost(entry, request);
  if (strategy === 'cost') {
    return entry.cost_rank * 20 + entry.score_primary + boost;
  }
  if (strategy === 'balanced') {
    return entry.quality_rank * 70 + entry.cost_rank * 30 + entry.score_primary / 10 + boost;
  }
  return entry.quality_rank * 100 + entry.score_primary + boost;
}

export function rankModels(
  catalog: readonly ModelCapabilityEntry[],
  request: ModelRouteRequest,
): ModelCapabilityEntry[] {
  return catalog
    .filter((entry) => !request.provider || entry.provider.toLowerCase() === request.provider.toLowerCase())
    .filter((entry) => matchesUseCase(entry, request.useCase))
    .filter((entry) => hasRequiredCapabilities(entry, request.requiredCapabilities))
    .slice()
    .sort((a, b) => {
      const byScore = scoreFor(b, request) - scoreFor(a, request);
      if (byScore !== 0) return byScore;
      return a.model_id.localeCompare(b.model_id);
    });
}

export function selectModel(
  catalog: readonly ModelCapabilityEntry[],
  request: ModelRouteRequest,
): ModelCapabilityEntry | null {
  return rankModels(catalog, request)[0] ?? null;
}
