/**
 * Internal helpers shared across the provider-discovery module.
 * Not part of the public API.
 */

/** Extract the provider prefix from a model id (e.g. "openai/gpt-4" -> "openai"). */
export function providerOf(model: string): string {
  return model.split('/')[0];
}

/** Group items into a record keyed by the given key function. */
export function groupBy<T>(items: T[], keyOf: (item: T) => string): Record<string, T[]> {
  const grouped: Record<string, T[]> = {};

  for (const item of items) {
    const key = keyOf(item);
    if (!grouped[key]) {
      grouped[key] = [];
    }
    grouped[key].push(item);
  }

  return grouped;
}
