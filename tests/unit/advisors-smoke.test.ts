/**
 * Tests for src/v2/advisors/index.ts + the loader (audit §3 gap "advisors
 * sem teste"). Smoke-level structure assertions: registry size, expected
 * advisor names, contract shape (name/description/run), stepwise vs oneshot
 * classification, registry-key vs name consistency, idempotent registration.
 *
 * Generated via Omniroute (if/deepseek-v3.2). Adapted: assertion message
 * convention (drop the `expect(x, 'msg')` second-arg form which TypeScript
 * complains about depending on the @types/vitest version) — use plain
 * messages via comments instead.
 */

// Side-effect import — populates the registry at module load.
import '../../src/v2/advisors/loader.js';
import { describe, it, expect } from 'vitest';
import { registry, getAdvisor, registerAdvisor } from '../../src/v2/advisors/index.js';

const EXPECTED_NAMES = [
  'analyze',
  'apilookup',
  'challenge',
  'chat',
  'codereview',
  'consensus',
  'debug',
  'docgen',
  'listmodels',
  'planner',
  'precommit',
  'refactor',
  'secaudit',
  'testgen',
  'thinkdeep',
  'tracer',
  'version',
] as const;

const STEPWISE_NAMES = ['codereview', 'consensus', 'debug', 'planner', 'precommit', 'thinkdeep'] as const;
const ONESHOT_NAMES = EXPECTED_NAMES.filter((n) => !(STEPWISE_NAMES as readonly string[]).includes(n));

describe('advisor registry smoke tests', () => {
  it('1. registry has exactly 17 advisors after loader import', () => {
    expect(registry.size).toBe(17);
  });

  it('2. all 17 expected advisor names are registered', () => {
    for (const name of EXPECTED_NAMES) {
      expect(getAdvisor(name)).not.toBeUndefined();
    }
  });

  it('3. every registered advisor has a stable snake_case name (≥3 chars, lowercase + underscore)', () => {
    for (const advisor of registry.values()) {
      expect(typeof advisor.name).toBe('string');
      expect(advisor.name.length).toBeGreaterThanOrEqual(3);
      expect(advisor.name).toMatch(/^[a-z][a-z0-9_]+$/);
    }
  });

  it('4. every registered advisor has a substantive description (≥40 chars, pinned to prevent rot)', () => {
    for (const advisor of registry.values()) {
      expect(typeof advisor.description).toBe('string');
      expect(advisor.description.length).toBeGreaterThanOrEqual(40);
    }
  });

  it('5. every registered advisor has a run function', () => {
    for (const advisor of registry.values()) {
      expect(typeof advisor.run).toBe('function');
    }
  });

  it('6. registry keys match each advisor name property exactly', () => {
    for (const [key, advisor] of registry.entries()) {
      expect(key).toBe(advisor.name);
    }
  });

  it('7. getAdvisor returns undefined for an unknown name', () => {
    expect(getAdvisor('__nonexistent_advisor__')).toBeUndefined();
  });

  it('8. registerAdvisor is idempotent — re-registering replaces rather than throws', () => {
    const existing = getAdvisor('chat');
    expect(existing).not.toBeUndefined();
    expect(() => registerAdvisor(existing!)).not.toThrow();
    expect(registry.size).toBe(17);
    expect(getAdvisor('chat')).toBe(existing);
  });

  it('9. stepwise advisors have isStepwise === true', () => {
    for (const name of STEPWISE_NAMES) {
      const advisor = getAdvisor(name);
      expect(advisor).not.toBeUndefined();
      expect(advisor!.isStepwise).toBe(true);
    }
  });

  it('10. oneshot advisors do not have isStepwise === true', () => {
    for (const name of ONESHOT_NAMES) {
      const advisor = getAdvisor(name);
      expect(advisor).not.toBeUndefined();
      expect(advisor!.isStepwise).not.toBe(true);
    }
  });

  it('11. advisor names are unique across the registry', () => {
    const names = Array.from(registry.values()).map((a) => a.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it('12. advisor run function has arity of 2', () => {
    for (const advisor of registry.values()) {
      expect(advisor.run.length).toBe(2);
    }
  });
});
