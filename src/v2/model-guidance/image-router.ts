import { z } from 'zod';

export const ImageRoutingInputSchema = z.object({
  taskDescription: z.string().min(1),
  hasImages: z.boolean(),
  preferredProvider: z
    .enum(['anthropic', 'openai', 'google', 'any'])
    .default('any'),
  costTier: z.enum(['cheap', 'balanced', 'quality']).default('balanced'),
});

export type ImageRoutingInput = z.infer<typeof ImageRoutingInputSchema>;

export interface ModelCandidate {
  model_id: string;
  provider: string;
  has_vision: boolean;
  cost_tier: 'cheap' | 'balanced' | 'quality';
  context_window: number;
}

export interface ImageRoutingOutput {
  selected: ModelCandidate;
  rationale: string;
  alternatives: ModelCandidate[];
}

type ProviderPreference = ImageRoutingInput['preferredProvider'];
type CostTier = ImageRoutingInput['costTier'];

function filterByProvider(
  catalog: ModelCandidate[],
  provider: ProviderPreference,
): ModelCandidate[] {
  if (provider === 'any') {
    return catalog;
  }

  return catalog.filter((candidate) => candidate.provider === provider);
}

function filterByCostTier(
  catalog: ModelCandidate[],
  costTier: CostTier,
): ModelCandidate[] {
  return catalog.filter((candidate) => candidate.cost_tier === costTier);
}

function pickCandidates(
  catalog: ModelCandidate[],
  provider: ProviderPreference,
  costTier: CostTier,
): ModelCandidate[] {
  const exactProvider = filterByProvider(catalog, provider);
  const exactProviderAndCost = filterByCostTier(exactProvider, costTier);
  if (exactProviderAndCost.length > 0) {
    return exactProviderAndCost;
  }

  if (exactProvider.length > 0) {
    return exactProvider;
  }

  if (provider !== 'any') {
    const anyProviderAndCost = filterByCostTier(catalog, costTier);
    if (anyProviderAndCost.length > 0) {
      return anyProviderAndCost;
    }

    return catalog;
  }

  return [];
}

export function routeImageTask(
  input: ImageRoutingInput,
  catalog: ModelCandidate[],
): ImageRoutingOutput {
  const parsed = ImageRoutingInputSchema.parse(input);

  const baseCatalog = parsed.hasImages
    ? catalog.filter((candidate) => candidate.has_vision)
    : catalog;

  if (parsed.hasImages && baseCatalog.length === 0) {
    throw new Error(
      'Image routing failed: hasImages=true but zero vision-capable models exist in the catalog.',
    );
  }

  const candidates = pickCandidates(
    baseCatalog,
    parsed.preferredProvider,
    parsed.costTier,
  );

  if (candidates.length === 0) {
    throw new Error(
      `Image routing failed: no model candidates available for hasImages=${parsed.hasImages}, costTier=${parsed.costTier}, provider=${parsed.preferredProvider}.`,
    );
  }

  const [selected, ...rest] = candidates;
  const rationale = `Selected ${selected.model_id} because hasImages=${parsed.hasImages}, vision=${selected.has_vision}, costTier=${parsed.costTier}, provider=${parsed.preferredProvider}.`;

  return {
    selected,
    rationale,
    alternatives: rest.slice(0, 3),
  };
}
