/**
 * OmniRoute credential synchronization
 *
 * Synchronizes credentials with OmniRoute for seamless integration
 */

import type { CredentialProvider } from './provider.js';
import type {
  OmniRouteSyncConfig,
  CredentialSyncStatus,
  DecryptedCredential,
} from './types.js';
import { getOmnirouteUrl, getOmnirouteApiKey } from '../../utils/config.js';

/**
 * OmniRoute credential sync manager
 */
export class OmniRouteCredentialSync {
  private provider: CredentialProvider;
  private config: OmniRouteSyncConfig;
  private syncStatuses: Map<string, CredentialSyncStatus> = new Map();
  private syncInterval?: NodeJS.Timeout;

  constructor(provider: CredentialProvider, config: OmniRouteSyncConfig) {
    this.provider = provider;
    this.config = config;
  }

  /**
   * Start automatic sync
   */
  startAutoSync(): void {
    if (!this.config.enabled) {
      console.log('[credential-sync] Auto-sync disabled');
      return;
    }

    if (this.syncInterval) {
      console.log('[credential-sync] Auto-sync already running');
      return;
    }

    console.log(`[credential-sync] Starting auto-sync (interval: ${this.config.syncIntervalMs}ms)`);
    this.syncInterval = setInterval(() => {
      this.syncAllCredentials().catch((err) => {
        console.error('[credential-sync] Auto-sync failed:', err);
      });
    }, this.config.syncIntervalMs);

    // Initial sync
    this.syncAllCredentials().catch((err) => {
      console.error('[credential-sync] Initial sync failed:', err);
    });
  }

  /**
   * Stop automatic sync
   */
  stopAutoSync(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = undefined;
      console.log('[credential-sync] Auto-sync stopped');
    }
  }

  /**
   * Sync all credentials to OmniRoute
   */
  async syncAllCredentials(): Promise<void> {
    const credentials = await this.provider.listCredentials();

    for (const metadata of credentials) {
      if (metadata.service === 'omniroute') {
        await this.syncCredential(metadata.id);
      }
    }
  }

  /**
   * Sync a specific credential to OmniRoute
   */
  async syncCredential(credentialId: string): Promise<CredentialSyncStatus> {
    const credential = await this.provider.getCredential(credentialId);

    if (!credential) {
      const status: CredentialSyncStatus = {
        service: 'omniroute',
        lastSync: new Date().toISOString(),
        status: 'failed',
        error: 'Credential not found',
      };
      this.syncStatuses.set(credentialId, status);
      return status;
    }

    try {
      // For OmniRoute, we validate the credential by making a test request
      const isValid = await this.validateOmnirouteCredential(credential.value);

      const status: CredentialSyncStatus = {
        service: 'omniroute',
        lastSync: new Date().toISOString(),
        status: isValid ? 'synced' : 'failed',
        error: isValid ? undefined : 'Credential validation failed',
      };

      this.syncStatuses.set(credentialId, status);
      return status;
    } catch (error) {
      const status: CredentialSyncStatus = {
        service: 'omniroute',
        lastSync: new Date().toISOString(),
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
      this.syncStatuses.set(credentialId, status);
      return status;
    }
  }

  /**
   * Validate an OmniRoute credential by making a test request
   */
  private async validateOmnirouteCredential(apiKey: string): Promise<boolean> {
    try {
      const url = getOmnirouteUrl();
      const response = await fetch(`${url}/health`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(5000),
      });

      return response.ok;
    } catch (error) {
      console.error('[credential-sync] Validation failed:', error);
      return false;
    }
  }

  /**
   * Get sync status for a credential
   */
  getSyncStatus(credentialId: string): CredentialSyncStatus | undefined {
    return this.syncStatuses.get(credentialId);
  }

  /**
   * Get all sync statuses
   */
  getAllSyncStatuses(): CredentialSyncStatus[] {
    return Array.from(this.syncStatuses.values());
  }

  /**
   * Rotate credential if auto-rotate is enabled
   */
  async maybeRotateCredential(credentialId: string): Promise<boolean> {
    if (!this.config.autoRotate) {
      return false;
    }

    const credential = await this.provider.getCredential(credentialId);
    if (!credential) {
      return false;
    }

    // Check if credential is old enough to rotate
    const createdAt = new Date(credential.metadata.created_at);
    const now = new Date();
    const daysSinceCreation = (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24);

    if (daysSinceCreation >= this.config.rotationDays) {
      console.log(`[credential-sync] Rotating credential ${credentialId} (${daysSinceCreation.toFixed(1)} days old)`);
      // Note: Actual rotation would require fetching a new credential from the source
      // This is a placeholder for the rotation logic
      return true;
    }

    return false;
  }

  /**
   * Sync credential from OmniRoute (pull changes)
   */
  async syncFromOmniRoute(credentialId: string): Promise<DecryptedCredential | null> {
    // This would pull credential updates from OmniRoute
    // For now, we just validate the existing credential
    const credential = await this.provider.getCredential(credentialId);
    if (!credential) {
      return null;
    }

    const isValid = await this.validateOmnirouteCredential(credential.value);
    if (!isValid) {
      console.warn(`[credential-sync] Credential ${credentialId} is invalid`);
    }

    return credential;
  }
}