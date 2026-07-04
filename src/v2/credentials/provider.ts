/**
 * Credential provider orchestration
 *
 * Provides a unified interface for credential management across different storage backends
 */

import type {
  CredentialStorage,
  DecryptedCredential,
  CredentialMetadata,
  CredentialProviderConfig,
  CredentialAuditLog,
} from './types.js';
import { createStorage } from './storage.js';
import { generateCredentialId, hashCredentialValue } from './encryption.js';

/**
 * Credential provider - main entry point for credential operations
 */
export class CredentialProvider {
  private storage: CredentialStorage;
  private auditLog: CredentialAuditLog[] = [];
  private auditEnabled: boolean;

  constructor(config: CredentialProviderConfig, auditEnabled: boolean = true) {
    this.storage = createStorage(config);
    this.auditEnabled = auditEnabled;
  }

  /**
   * Create a new credential
   */
  async createCredential(
    name: string,
    service: string,
    type: string,
    value: string,
    tags: string[] = [],
  ): Promise<DecryptedCredential> {
    const credential: DecryptedCredential = {
      metadata: {
        id: generateCredentialId(),
        name,
        type: type as any,
        service,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        tags,
        version: 1,
      },
      value,
    };

    await this.storage.store(credential);
    this.logAudit(credential.metadata.id, 'create', true);
    return credential;
  }

  /**
   * Get a credential by ID
   */
  async getCredential(id: string): Promise<DecryptedCredential | null> {
    const credential = await this.storage.retrieve(id);
    if (credential) {
      this.logAudit(id, 'read', true);
    }
    return credential;
  }

  /**
   * Get a credential by service
   */
  async getCredentialByService(service: string): Promise<DecryptedCredential | null> {
    const credential = await this.storage.retrieveByService(service);
    if (credential) {
      this.logAudit(credential.metadata.id, 'read', true);
    }
    return credential;
  }

  /**
   * List all credentials
   */
  async listCredentials(): Promise<CredentialMetadata[]> {
    return this.storage.list();
  }

  /**
   * Update a credential
   */
  async updateCredential(
    id: string,
    updates: Partial<Pick<DecryptedCredential, 'value' | 'metadata'>>,
  ): Promise<DecryptedCredential> {
    const existing = await this.storage.retrieve(id);
    if (!existing) {
      throw new Error(`Credential ${id} not found`);
    }

    const updated: DecryptedCredential = {
      ...existing,
      value: updates.value ?? existing.value,
      metadata: {
        ...existing.metadata,
        ...updates.metadata,
        id: existing.metadata.id, // Preserve ID
        created_at: existing.metadata.created_at, // Preserve creation time
        updated_at: new Date().toISOString(),
        version: existing.metadata.version + 1,
      },
    };

    await this.storage.update(updated);
    this.logAudit(id, 'update', true);
    return updated;
  }

  /**
   * Delete a credential
   */
  async deleteCredential(id: string): Promise<void> {
    await this.storage.delete(id);
    this.logAudit(id, 'delete', true);
  }

  /**
   * Rotate a credential (create new version)
   */
  async rotateCredential(id: string, newValue: string): Promise<DecryptedCredential> {
    const existing = await this.storage.retrieve(id);
    if (!existing) {
      throw new Error(`Credential ${id} not found`);
    }

    // Create a new credential with the same metadata but new value
    const rotated: DecryptedCredential = {
      metadata: {
        ...existing.metadata,
        id: generateCredentialId(),
        updated_at: new Date().toISOString(),
        version: existing.metadata.version + 1,
      },
      value: newValue,
    };

    await this.storage.store(rotated);
    await this.storage.delete(id); // Delete old credential
    this.logAudit(rotated.metadata.id, 'rotate', true);
    this.logAudit(id, 'delete', true); // Log deletion of old credential
    return rotated;
  }

  /**
   * Check if a credential exists
   */
  async credentialExists(id: string): Promise<boolean> {
    return this.storage.exists(id);
  }

  /**
   * Verify a credential value (for validation)
   */
  async verifyCredential(id: string, value: string): Promise<boolean> {
    const credential = await this.storage.retrieve(id);
    if (!credential) return false;

    const hash = hashCredentialValue(value);
    const expectedHash = hashCredentialValue(credential.value);
    return hash === expectedHash;
  }

  /**
   * Get audit log
   */
  getAuditLog(): CredentialAuditLog[] {
    return [...this.auditLog];
  }

  /**
   * Clear audit log
   */
  clearAuditLog(): void {
    this.auditLog = [];
  }

  /**
   * Log an audit event
   */
  private logAudit(
    credentialId: string,
    action: CredentialAuditLog['action'],
    success: boolean,
    error?: string,
  ): void {
    if (!this.auditEnabled) return;

    const logEntry: CredentialAuditLog = {
      id: generateCredentialId(),
      credential_id: credentialId,
      action,
      timestamp: new Date().toISOString(),
      source: 'credential-provider',
      success,
      error,
    };

    this.auditLog.push(logEntry);

    // Keep only last 1000 entries to prevent unbounded growth
    if (this.auditLog.length > 1000) {
      this.auditLog = this.auditLog.slice(-1000);
    }
  }

  /**
   * Get credential for Omniroute (convenience method)
   */
  async getOmnirouteCredential(): Promise<string | null> {
    const credential = await this.getCredentialByService('omniroute');
    return credential?.value ?? null;
  }

  /**
   * Get credential for Telegram (convenience method)
   */
  async getTelegramCredential(): Promise<{ token: string; chatId: string } | null> {
    const tokenCred = await this.getCredentialByService('telegram');
    const chatIdCred = await this.getCredentialByService('telegram-chat-id');

    if (!tokenCred || !chatIdCred) {
      return null;
    }

    return {
      token: tokenCred.value,
      chatId: chatIdCred.value,
    };
  }
}