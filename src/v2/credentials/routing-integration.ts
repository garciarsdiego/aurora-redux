/**
 * Routing engine integration for credential management
 *
 * Integrates credential management with the routing engine for seamless credential usage
 */

import type { CredentialProvider } from './provider.js';
import type { OmniRouteCredentialSync } from './sync.js';

/**
 * Routing engine credential manager
 */
export class RoutingCredentialManager {
  private provider: CredentialProvider;
  private sync: OmniRouteCredentialSync;
  private credentialCache: Map<string, { value: string; expiresAt: number }> = new Map();
  private cacheTtlMs: number;

  constructor(
    provider: CredentialProvider,
    sync: OmniRouteCredentialSync,
    cacheTtlMs: number = 5 * 60 * 1000, // 5 minutes default
  ) {
    this.provider = provider;
    this.sync = sync;
    this.cacheTtlMs = cacheTtlMs;
  }

  /**
   * Get credential for routing with caching
   */
  async getRoutingCredential(service: string): Promise<string | null> {
    // Check cache first
    const cached = this.credentialCache.get(service);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    // Fetch from provider
    const credential = await this.provider.getCredentialByService(service);
    if (!credential) {
      return null;
    }

    // Cache the credential
    this.credentialCache.set(service, {
      value: credential.value,
      expiresAt: Date.now() + this.cacheTtlMs,
    });

    return credential.value;
  }

  /**
   * Get OmniRoute API key for routing
   */
  async getOmnirouteApiKey(): Promise<string | null> {
    return this.getRoutingCredential('omniroute');
  }

  /**
   * Get Telegram credentials for routing
   */
  async getTelegramCredentials(): Promise<{ token: string; chatId: string } | null> {
    const token = await this.getRoutingCredential('telegram');
    const chatId = await this.getRoutingCredential('telegram-chat-id');

    if (!token || !chatId) {
      return null;
    }

    return { token, chatId };
  }

  /**
   * Clear credential cache
   */
  clearCache(): void {
    this.credentialCache.clear();
  }

  /**
   * Invalidate specific credential in cache
   */
  invalidateCache(service: string): void {
    this.credentialCache.delete(service);
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; entries: Array<{ service: string; expiresAt: number }> } {
    return {
      size: this.credentialCache.size,
      entries: Array.from(this.credentialCache.entries()).map(([service, data]) => ({
        service,
        expiresAt: data.expiresAt,
      })),
    };
  }

  /**
   * Sync credentials before routing
   */
  async syncBeforeRouting(): Promise<void> {
    await this.sync.syncAllCredentials();
  }

  /**
   * Validate routing credentials
   */
  async validateRoutingCredentials(): Promise<{
    omniroute: boolean;
    telegram: boolean;
    overall: boolean;
  }> {
    const omnirouteKey = await this.getOmnirouteApiKey();
    const telegramCreds = await this.getTelegramCredentials();

    const omnirouteValid = omnirouteKey !== null && omnirouteKey.length > 0;
    const telegramValid = telegramCreds !== null && telegramCreds.token.length > 0;

    return {
      omniroute: omnirouteValid,
      telegram: telegramValid,
      overall: omnirouteValid, // OmniRoute is critical for routing
    };
  }

  /**
   * Get credential with automatic sync on failure
   */
  async getCredentialWithAutoSync(service: string): Promise<string | null> {
    let credential = await this.getRoutingCredential(service);

    // If credential is null, try syncing first
    if (credential === null) {
      await this.sync.syncAllCredentials();
      credential = await this.getRoutingCredential(service);
    }

    return credential;
  }
}