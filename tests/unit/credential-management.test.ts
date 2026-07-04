/**
 * Tests for credential management system
 *
 * Tests encryption, storage, provider, sync, and routing integration
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  generateSalt,
  deriveKey,
  encryptCredential,
  decryptCredential,
  encryptCredentialObject,
  decryptCredentialObject,
  generateCredentialId,
  hashCredentialValue,
  validateCredentialFormat,
} from '../../src/v2/credentials/encryption.js';
import {
  EnvCredentialStorage,
  EncryptedFileStorage,
  createStorage,
} from '../../src/v2/credentials/storage.js';
import { CredentialProvider } from '../../src/v2/credentials/provider.js';
import { OmniRouteCredentialSync } from '../../src/v2/credentials/sync.js';
import { RoutingCredentialManager } from '../../src/v2/credentials/routing-integration.js';
import type { CredentialProviderConfig } from '../../src/v2/credentials/types.js';

describe('Credential Management - Encryption', () => {
  const masterKey = 'test-master-key-12345678';
  const config = {
    algorithm: 'aes-256-gcm' as const,
    keyDerivation: 'pbkdf2' as const,
    iterations: 100000,
  };

  it('should generate a unique salt', () => {
    const salt1 = generateSalt();
    const salt2 = generateSalt();
    expect(salt1).not.toBe(salt2);
    expect(salt1.length).toBeGreaterThan(0);
  });

  it('should derive a key from master key and salt', () => {
    const salt = generateSalt();
    const key = deriveKey(masterKey, salt);
    expect(key.length).toBe(32); // 256 bits
  });

  it('should encrypt and decrypt a credential value', () => {
    const value = 'my-secret-api-key-12345';
    const salt = generateSalt();
    const { ciphertext, iv, authTag } = encryptCredential(value, masterKey, { ...config, salt });

    expect(ciphertext).toBeTruthy();
    expect(iv).toBeTruthy();
    expect(authTag).toBeTruthy();

    const decrypted = decryptCredential(ciphertext, iv, authTag, masterKey, { ...config, salt });
    expect(decrypted).toBe(value);
  });

  it('should encrypt and decrypt a full credential object', () => {
    const credential = {
      metadata: {
        id: 'test-cred-1',
        name: 'Test Credential',
        type: 'api-key' as const,
        service: 'test-service',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        tags: ['test'],
        version: 1,
      },
      value: 'secret-value-12345',
    };

    const encrypted = encryptCredentialObject(credential, masterKey, config);
    expect(encrypted.ciphertext).toBeTruthy();

    const decrypted = decryptCredentialObject(encrypted, masterKey);
    expect(decrypted.value).toBe(credential.value);
    expect(decrypted.metadata.id).toBe(credential.metadata.id);
  });

  it('should generate unique credential IDs', () => {
    const id1 = generateCredentialId();
    const id2 = generateCredentialId();
    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^cred_/);
  });

  it('should hash credential values consistently', () => {
    const value = 'test-credential-value';
    const hash1 = hashCredentialValue(value);
    const hash2 = hashCredentialValue(value);
    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(64); // SHA-256 hex
  });

  it('should validate credential formats', () => {
    const apiKeyValidation = validateCredentialFormat('api-key', 'sk-1234567890abcdef');
    expect(apiKeyValidation.valid).toBe(true);

    const shortKeyValidation = validateCredentialFormat('api-key', 'short');
    expect(shortKeyValidation.valid).toBe(false);

    const emptyValidation = validateCredentialFormat('api-key', '');
    expect(emptyValidation.valid).toBe(false);

    const basicAuthValidation = validateCredentialFormat('basic-auth', 'user:pass');
    expect(basicAuthValidation.valid).toBe(true);

    const invalidBasicAuthValidation = validateCredentialFormat('basic-auth', 'user');
    expect(invalidBasicAuthValidation.valid).toBe(false);
  });
});

describe('Credential Management - Storage', () => {
  const testDir = path.join(process.cwd(), 'data', 'test-credentials');
  const testFilePath = path.join(testDir, 'test.enc.json');

  beforeEach(async () => {
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should use env storage backend', async () => {
    const storage = new EnvCredentialStorage();
    // Env storage stores with a specific pattern (CRED_{SERVICE}_{TYPE})
    // and retrieveByService looks for common patterns like OMNIROUTE_API_KEY
    // For testing, we'll set the env var directly and verify it can be retrieved
    process.env['OMNIROUTE_API_KEY'] = 'env-test-value-12345678';

    const retrieved = await storage.retrieveByService('omniroute');
    expect(retrieved).toBeTruthy();
    expect(retrieved?.value).toBe('env-test-value-12345678');

    // Cleanup
    delete process.env['OMNIROUTE_API_KEY'];
  });

  it('should use encrypted file storage backend', async () => {
    const config: CredentialProviderConfig = {
      backend: 'encrypted-file',
      masterKey: 'test-master-key',
      filePath: testFilePath,
      encryption: {
        algorithm: 'aes-256-gcm',
        keyDerivation: 'pbkdf2',
        iterations: 100000,
      },
    };

    const storage = new EncryptedFileStorage(testFilePath, config);
    const credential = {
      metadata: {
        id: 'test-file-cred',
        name: 'Test File Credential',
        type: 'api-key' as const,
        service: 'test',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        tags: [],
        version: 1,
      },
      value: 'file-test-value-12345678', // At least 16 chars
    };

    await storage.store(credential);
    const retrieved = await storage.retrieve('test-file-cred');
    expect(retrieved).toBeTruthy();
    expect(retrieved?.value).toBe('file-test-value-12345678');

    const list = await storage.list();
    expect(list.length).toBe(1);
    expect(list[0].id).toBe('test-file-cred');

    await storage.delete('test-file-cred');
    const afterDelete = await storage.retrieve('test-file-cred');
    expect(afterDelete).toBeNull();
  });

  it('should create storage via factory', () => {
    const config: CredentialProviderConfig = {
      backend: 'env',
      masterKey: 'test-key',
      encryption: {
        algorithm: 'aes-256-gcm',
        keyDerivation: 'pbkdf2',
      },
    };

    const storage = createStorage(config);
    expect(storage).toBeInstanceOf(EnvCredentialStorage);
  });
});

describe('Credential Management - Provider', () => {
  const testDir = path.join(process.cwd(), 'data', 'test-provider-credentials');
  const testFilePath = path.join(testDir, 'test.enc.json');

  beforeEach(async () => {
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should create and retrieve credentials', async () => {
    const config: CredentialProviderConfig = {
      backend: 'encrypted-file',
      masterKey: 'test-provider-key',
      filePath: testFilePath,
      encryption: {
        algorithm: 'aes-256-gcm',
        keyDerivation: 'pbkdf2',
        iterations: 100000,
      },
    };

    const provider = new CredentialProvider(config, false);
    const credential = await provider.createCredential(
      'Test Credential',
      'test-service',
      'api-key',
      'test-api-key-value-123456', // At least 16 chars
      ['test', 'development'],
    );

    expect(credential.metadata.id).toBeTruthy();
    expect(credential.metadata.service).toBe('test-service');
    expect(credential.value).toBe('test-api-key-value-123456');

    const retrieved = await provider.getCredential(credential.metadata.id);
    expect(retrieved).toBeTruthy();
    expect(retrieved?.value).toBe('test-api-key-value-123456');
  });

  it('should list and update credentials', async () => {
    const config: CredentialProviderConfig = {
      backend: 'encrypted-file',
      masterKey: 'test-provider-key',
      filePath: testFilePath,
      encryption: {
        algorithm: 'aes-256-gcm',
        keyDerivation: 'pbkdf2',
        iterations: 100000,
      },
    };

    const provider = new CredentialProvider(config, false);
    await provider.createCredential('Cred 1', 'service1', 'api-key', 'value1-123456789012');
    await provider.createCredential('Cred 2', 'service2', 'api-key', 'value2-123456789012');

    const list = await provider.listCredentials();
    expect(list.length).toBe(2);

    const firstId = list[0].id;
    await provider.updateCredential(firstId, { value: 'updated-value-123456' });

    const updated = await provider.getCredential(firstId);
    expect(updated?.value).toBe('updated-value-123456');
  });

  it('should rotate credentials', async () => {
    const config: CredentialProviderConfig = {
      backend: 'encrypted-file',
      masterKey: 'test-provider-key',
      filePath: testFilePath,
      encryption: {
        algorithm: 'aes-256-gcm',
        keyDerivation: 'pbkdf2',
        iterations: 100000,
      },
    };

    const provider = new CredentialProvider(config, false);
    const credential = await provider.createCredential(
      'Rotatable Credential',
      'rotate-service',
      'api-key',
      'old-value-123456789012',
    );

    const oldId = credential.metadata.id;
    const rotated = await provider.rotateCredential(oldId, 'new-value-123456789012');

    expect(rotated.metadata.id).not.toBe(oldId);
    expect(rotated.value).toBe('new-value-123456789012');
    expect(rotated.metadata.version).toBe(2);

    const oldCredential = await provider.getCredential(oldId);
    expect(oldCredential).toBeNull();
  });

  it('should maintain audit log', async () => {
    const config: CredentialProviderConfig = {
      backend: 'encrypted-file',
      masterKey: 'test-provider-key',
      filePath: testFilePath,
      encryption: {
        algorithm: 'aes-256-gcm',
        keyDerivation: 'pbkdf2',
        iterations: 100000,
      },
    };

    const provider = new CredentialProvider(config, true);
    await provider.createCredential('Audit Test', 'audit-service', 'api-key', 'value-123456789012');

    const auditLog = provider.getAuditLog();
    expect(auditLog.length).toBeGreaterThan(0);
    expect(auditLog[0].action).toBe('create');
    expect(auditLog[0].success).toBe(true);
  });
});

describe('Credential Management - Sync', () => {
  it('should create sync manager', () => {
    const config: CredentialProviderConfig = {
      backend: 'env',
      masterKey: 'test-key',
      encryption: {
        algorithm: 'aes-256-gcm',
        keyDerivation: 'pbkdf2',
      },
    };

    const provider = new CredentialProvider(config, false);
    const syncConfig = {
      enabled: false,
      syncIntervalMs: 300000,
      autoRotate: false,
      rotationDays: 90,
    };

    const sync = new OmniRouteCredentialSync(provider, syncConfig);
    expect(sync).toBeInstanceOf(OmniRouteCredentialSync);
  });

  it('should not start auto-sync when disabled', () => {
    const config: CredentialProviderConfig = {
      backend: 'env',
      masterKey: 'test-key',
      encryption: {
        algorithm: 'aes-256-gcm',
        keyDerivation: 'pbkdf2',
      },
    };

    const provider = new CredentialProvider(config, false);
    const syncConfig = {
      enabled: false,
      syncIntervalMs: 300000,
      autoRotate: false,
      rotationDays: 90,
    };

    const sync = new OmniRouteCredentialSync(provider, syncConfig);
    sync.startAutoSync();
    sync.stopAutoSync();
    // Should not throw
  });
});

describe('Credential Management - Routing Integration', () => {
  it('should create routing manager', () => {
    const config: CredentialProviderConfig = {
      backend: 'env',
      masterKey: 'test-key',
      encryption: {
        algorithm: 'aes-256-gcm',
        keyDerivation: 'pbkdf2',
      },
    };

    const provider = new CredentialProvider(config, false);
    const syncConfig = {
      enabled: false,
      syncIntervalMs: 300000,
      autoRotate: false,
      rotationDays: 90,
    };

    const sync = new OmniRouteCredentialSync(provider, syncConfig);
    const routingManager = new RoutingCredentialManager(provider, sync);

    expect(routingManager).toBeInstanceOf(RoutingCredentialManager);
  });

  it('should manage credential cache', async () => {
    const config: CredentialProviderConfig = {
      backend: 'env',
      masterKey: 'test-key',
      encryption: {
        algorithm: 'aes-256-gcm',
        keyDerivation: 'pbkdf2',
      },
    };

    const provider = new CredentialProvider(config, false);
    const syncConfig = {
      enabled: false,
      syncIntervalMs: 300000,
      autoRotate: false,
      rotationDays: 90,
    };

    const sync = new OmniRouteCredentialSync(provider, syncConfig);
    const routingManager = new RoutingCredentialManager(provider, sync, 1000); // 1 second TTL

    const stats = routingManager.getCacheStats();
    expect(stats.size).toBe(0);

    routingManager.clearCache();
    // Should not throw
  });
});