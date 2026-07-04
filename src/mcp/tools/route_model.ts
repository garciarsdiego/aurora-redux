import { z } from 'zod';
import {
  loadProviderMatrixCatalog,
  rankModels,
  selectModel,
} from '../../v2/models/capability-registry.js';

export const RouteModelSchema = z.object({
  use_case: z.string().optional(),
  provider: z.string().optional(),
  strategy: z.enum(['quality', 'cost', 'balanced']).optional().default('quality'),
  required_capabilities: z.array(z.enum([
    'streaming',
    'structured_output',
    'tool_calling',
    'multimodal',
    'embeddings',
    'batch',
    'local',
  ])).optional().default([]),
  limit: z.number().int().min(1).max(25).optional().default(5),
});

export async function routeModelTool(raw: unknown): Promise<string> {
  const input = RouteModelSchema.parse(raw);
  const catalog = loadProviderMatrixCatalog();
  const request = {
    useCase: input.use_case,
    provider: input.provider,
    requiredCapabilities: input.required_capabilities,
    strategy: input.strategy,
  };
  const selected = selectModel(catalog, request);
  const candidates = rankModels(catalog, request).slice(0, input.limit);
  return JSON.stringify({ selected, candidates });
}
