import type { ContextEngine } from './types.js';
import { DefaultContextEngine } from './default-engine.js';

const registry = new Map<string, ContextEngine>();

export function registerContextEngine(engine: ContextEngine): void {
  registry.set(engine.info.id, engine);
}

export function resolveContextEngine(id: string = 'default'): ContextEngine {
  const engine = registry.get(id);
  if (!engine) throw new Error(`ContextEngine not found: ${id}`);
  return engine;
}

registerContextEngine(new DefaultContextEngine());
