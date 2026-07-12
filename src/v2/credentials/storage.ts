/**
 * Credential storage implementations
 *
 * Supports multiple storage backends: environment variables, encrypted file, and vault (future)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  CredentialStorage,
  DecryptedCredential,
  CredentialMetadata,
  CredentialProviderConfig,
  CredentialType,
  EncryptedCredential,
} from './types.js';
import {
  encryptCredentialObject,
  decryptCredentialObject,
  generateCredentialId,
  validateCredentialFormat,
} from './encryption.js';

/**
 * Environment variable storage backend
 * Reads credentials from environment variables (legacy support)
 */
export class EnvCredentialStorage implements CredentialStorage {
  private prefix: string;

  constructor(prefix: string = 'CRED_') {
    this.prefix = prefix;
  }

  async store(credential: DecryptedCredential): Promise<void> {
    const envKey = `${this.prefix}${credential.metadata.service.toUpperCase()}_${credential.metadata.type.toUpperCase()}`;
    process.env[envKey] = credential.value;
  }

  async retrieve(id: string): Promise<DecryptedCredential | null> {
    // Env storage doesn't support ID-based retrieval
    // This is a limitation of the env backend
    return null;
  }

  async retrieveByService(service: string): Promise<DecryptedCredential | null> {
    // Try common env variable patterns
    const patterns = [
      `${service.toUpperCase()}_API_KEY`,
      `${service.toUpperCase()}_TOKEN`,
      `${this.prefix}${service.toUpperCase()}_API_KEY`,
    ];
    if (service === 'omniroute') {
      patterns.push(`OMNIROUTE_API_KEY`); // Special case for Omniroute
    }

    for (const pattern of patterns) {
      const value = process.env[pattern];
      if (value) {
        return {
          metadata: {
            id: generateCredentialId(),
            name: `${service} credential`,
            type: 'api-key',
            service,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            tags: ['env'],
            version: 1,
          },
          value,
        };
      }
    }

    return null;
  }

  async list(): Promise<CredentialMetadata[]> {
    // List all env vars matching the prefix
    const credentials: CredentialMetadata[] = [];
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith(this.prefix) && value) {
        const parts = key.substring(this.prefix.length).split('_');
        if (parts.length >= 2) {
          const service = parts[0].toLowerCase();
          const type = parts[1].toLowerCase();
          credentials.push({
            id: generateCredentialId(),
            name: `${service} credential`,
            type: type as CredentialType,
            service,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            tags: ['env'],
            version: 1,
          });
        }
      }
    }
    return credentials;
  }

  async delete(id: string): Promise<void> {
    // Not supported for env storage
    throw new Error('Delete not supported for environment variable storage');
  }

  async update(credential: DecryptedCredential): Promise<void> {
    await this.store(credential);
  }

  async exists(id: string): Promise<boolean> {
    // Env storage doesn't support ID-based retrieval (see retrieve above),
    // so existence checks by ID always report false. Use retrieveByService instead.
    return false;
  }
}

/**
 * Encrypted file storage backend
 * Stores credentials in an encrypted JSON file
 */
export class EncryptedFileStorage implements CredentialStorage {
  private filePath: string;
  private config: CredentialProviderConfig;
  private credentials: Map<string, EncryptedCredential> = new Map();
  private loaded = false;

  constructor(filePath: string, config: CredentialProviderConfig) {
    this.filePath = path.resolve(filePath);
    this.config = config;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;

    try {
      const data = await fs.readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(data) as Record<string, EncryptedCredential>;
      this.credentials = new Map(Object.entries(parsed));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      // File doesn't exist yet, start with empty map
      this.credentials = new Map();
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    const data = JSON.stringify(Object.fromEntries(this.credentials), null, 2);
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, data, { mode: 0o600 }); // Owner read/write only
  }

  async store(credential: DecryptedCredential): Promise<void> {
    await this.ensureLoaded();

    const validation = validateCredentialFormat(credential.metadata.type, credential.value);
    if (!validation.valid) {
      throw new Error(`Invalid credential format: ${validation.error}`);
    }

    const encrypted = encryptCredentialObject(credential, this.config.masterKey, this.config.encryption);
    this.credentials.set(credential.metadata.id, encrypted);
    await this.save();
  }

  /**
   * Decrypt a stored credential, treating failures as "not found".
   * Note: a wrong master key surfaces as a logged error + null, not a throw —
   * callers see the credential as missing.
   */
  private tryDecrypt(id: string, encrypted: EncryptedCredential): DecryptedCredential | null {
    try {
      return decryptCredentialObject(encrypted, this.config.masterKey);
    } catch (error) {
      console.error(`Failed to decrypt credential ${id}:`, error);
      return null;
    }
  }

  async retrieve(id: string): Promise<DecryptedCredential | null> {
    await this.ensureLoaded();

    const encrypted = this.credentials.get(id);
    if (!encrypted) return null;

    return this.tryDecrypt(id, encrypted);
  }

  async retrieveByService(service: string): Promise<DecryptedCredential | null> {
    await this.ensureLoaded();

    for (const [id, encrypted] of this.credentials.entries()) {
      if (encrypted.metadata.service === service) {
        const decrypted = this.tryDecrypt(id, encrypted);
        if (decrypted) return decrypted;
      }
    }

    return null;
  }

  async list(): Promise<CredentialMetadata[]> {
    await this.ensureLoaded();

    return Array.from(this.credentials.values()).map((c) => c.metadata);
  }

  async delete(id: string): Promise<void> {
    await this.ensureLoaded();

    if (!this.credentials.has(id)) {
      throw new Error(`Credential ${id} not found`);
    }

    this.credentials.delete(id);
    await this.save();
  }

  async update(credential: DecryptedCredential): Promise<void> {
    await this.ensureLoaded();

    if (!this.credentials.has(credential.metadata.id)) {
      throw new Error(`Credential ${credential.metadata.id} not found`);
    }

    credential.metadata.updated_at = new Date().toISOString();
    credential.metadata.version += 1;

    const encrypted = encryptCredentialObject(credential, this.config.masterKey, this.config.encryption);
    this.credentials.set(credential.metadata.id, encrypted);
    await this.save();
  }

  async exists(id: string): Promise<boolean> {
    await this.ensureLoaded();
    return this.credentials.has(id);
  }
}

/**
 * Factory function to create the appropriate storage backend
 */
export function createStorage(config: CredentialProviderConfig): CredentialStorage {
  switch (config.backend) {
    case 'env':
      return new EnvCredentialStorage();
    case 'encrypted-file':
      if (!config.filePath) {
        throw new Error('filePath is required for encrypted-file backend');
      }
      return new EncryptedFileStorage(config.filePath, config);
    case 'vault':
      throw new Error('Vault backend not yet implemented');
    default:
      throw new Error(`Unknown storage backend: ${config.backend}`);
  }
}