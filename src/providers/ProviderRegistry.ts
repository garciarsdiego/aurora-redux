import { EventEmitter } from 'events';
import type { ProviderConfig } from './types.js';

export class ProviderRegistry extends EventEmitter {
  private providers: Map<string, ProviderConfig> = new Map();

  /**
   * Register a new provider
   */
  register(provider: ProviderConfig): void {
    this.providers.set(provider.name, provider);
    this.emit('providerRegistered', provider);
  }

  /**
   * Unregister a provider
   */
  unregister(name: string): void {
    const provider = this.providers.get(name);
    if (provider) {
      this.providers.delete(name);
      this.emit('providerUnregistered', provider);
    }
  }

  /**
   * Get a specific provider
   */
  get(name: string): ProviderConfig | undefined {
    return this.providers.get(name);
  }

  /**
   * Get all registered providers
   */
  getAll(): ProviderConfig[] {
    return Array.from(this.providers.values());
  }

  /**
   * Get enabled providers only
   */
  getEnabled(): ProviderConfig[] {
    return this.getAll().filter(p => p.enabled);
  }

  /**
   * Get providers sorted by priority
   */
  getByPriority(): ProviderConfig[] {
    return this.getAll()
      .sort((a, b) => b.priority - a.priority);
  }

  /**
   * Get providers that support a specific feature
   */
  getByFeature(feature: string): ProviderConfig[] {
    return this.getAll().filter(p => 
      p.enabled && p.features.includes(feature)
    );
  }

  /**
   * Get the best provider for a specific model
   */
  getBestForModel(model: string): ProviderConfig | undefined {
    const candidates = this.getProvidersForModel(model);

    if (candidates.length === 0) {
      return undefined;
    }

    // Return highest priority provider
    return candidates.reduce((best, current) => 
      current.priority > best.priority ? current : best
    );
  }

  /**
   * Get providers that can handle a specific model
   */
  getProvidersForModel(model: string): ProviderConfig[] {
    return this.getAll().filter(p => 
      p.enabled && p.models.includes(model)
    );
  }

  /**
   * Check if a provider is enabled
   */
  isEnabled(name: string): boolean {
    const provider = this.providers.get(name);
    return provider ? provider.enabled : false;
  }

  /**
   * Enable or disable a provider
   */
  setEnabled(name: string, enabled: boolean): void {
    const provider = this.providers.get(name);
    if (provider) {
      provider.enabled = enabled;
      this.emit('providerToggled', provider);
    }
  }

  /**
   * Update provider configuration
   */
  update(name: string, updates: Partial<ProviderConfig>): void {
    const provider = this.providers.get(name);
    if (provider) {
      Object.assign(provider, updates);
      this.emit('providerUpdated', provider);
    }
  }
}

// Singleton instance
let providerRegistryInstance: ProviderRegistry | null = null;

export function getProviderRegistry(): ProviderRegistry {
  if (!providerRegistryInstance) {
    providerRegistryInstance = new ProviderRegistry();
    // Register default Omniroute provider
    providerRegistryInstance.register({
      name: 'omniroute',
      type: 'omniroute',
      endpoint: 'http://localhost:20228',
      models: [
        'cc/claude-sonnet-4-6',
        'cc/claude-opus-4-6',
        'cc/claude-haiku-4-5-20251001',
        'gh/gpt-4o',
        'gh/gpt-4o-mini'
      ],
      features: ['routing', 'cost-optimization', 'multi-provider'],
      priority: 10,
      enabled: true
    });
  }
  return providerRegistryInstance;
}