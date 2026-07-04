// src/v2/advisors/index.ts
// Advisor registry — in-process replacement for PAL MCP stdio calls.

import type { Advisor } from './types.js';

export const registry = new Map<string, Advisor>();

export function registerAdvisor(a: Advisor): void {
  registry.set(a.name, a);
}

export function getAdvisor(name: string): Advisor | undefined {
  return registry.get(name);
}
