import { ADVISOR_MODES, type AdvisorContext, type AdvisorMode } from '../types.js';

const ADVISOR_MODE_SET = new Set<string>(ADVISOR_MODES);

export function isAdvisorMode(value: unknown): value is AdvisorMode {
  return typeof value === 'string' && ADVISOR_MODE_SET.has(value);
}

export function getAdvisorMode(ctx: AdvisorContext, args: unknown): AdvisorMode {
  if (typeof args === 'object' && args !== null && isAdvisorMode((args as { mode?: unknown }).mode)) {
    return (args as { mode: AdvisorMode }).mode;
  }
  return ctx.mode ?? 'auto';
}

export function shouldUseStepwiseMemory(ctx: AdvisorContext, args: unknown): boolean {
  return getAdvisorMode(ctx, args) !== 'oneshot';
}
