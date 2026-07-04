/**
 * Credential Management System for OmniRoute
 *
 * Provides secure storage, encryption, and synchronization of credentials
 * for OmniRoute integration with support for multiple storage backends.
 */

/**
 * Storage backend types
 */
export type StorageBackend = 'env' | 'encrypted-file' | 'vault';

/**
 * Credential types supported by the system
 */
export type CredentialType = 'api-key' | 'oauth-token' | 'certificate' | 'basic-auth';

/**
 * Credential metadata
 */
export interface CredentialMetadata {
  id: string;
  name: string;
  type: CredentialType;
  service: string; // e.g., 'omniroute', 'telegram', 'openai'
  created_at: string;
  updated_at: string;
  expires_at?: string;
  tags: string[];
  version: number;
}

/**
 * Encrypted credential data
 */
export interface EncryptedCredential {
  metadata: CredentialMetadata;
  ciphertext: string; // Base64-encoded encrypted data
  iv: string; // Initialization vector (Base64)
  auth_tag: string; // Authentication tag (Base64)
  algorithm: string; // Encryption algorithm used
  salt?: string; // Salt used for key derivation (Base64)
}

/**
 * Decrypted credential data
 */
export interface DecryptedCredential {
  metadata: CredentialMetadata;
  value: string; // Plaintext credential value
}

/**
 * Credential storage interface
 */
export interface CredentialStorage {
  /**
   * Store a credential
   */
  store(credential: DecryptedCredential): Promise<void>;

  /**
   * Retrieve a credential by ID
   */
  retrieve(id: string): Promise<DecryptedCredential | null>;

  /**
   * Retrieve a credential by service
   */
  retrieveByService(service: string): Promise<DecryptedCredential | null>;

  /**
   * List all credentials
   */
  list(): Promise<CredentialMetadata[]>;

  /**
   * Delete a credential
   */
  delete(id: string): Promise<void>;

  /**
   * Update a credential
   */
  update(credential: DecryptedCredential): Promise<void>;

  /**
   * Check if a credential exists
   */
  exists(id: string): Promise<boolean>;
}

/**
 * Encryption configuration
 */
export interface EncryptionConfig {
  algorithm: 'aes-256-gcm';
  keyDerivation: 'pbkdf2' | 'scrypt';
  iterations?: number; // For PBKDF2
  salt?: string; // Base64-encoded salt
}

/**
 * Credential provider configuration
 */
export interface CredentialProviderConfig {
  backend: StorageBackend;
  encryption: EncryptionConfig;
  /**
   * Master password/key for encryption
   * In production, this should come from a secure source (e.g., KMS, HSM)
   */
  masterKey: string;
  /**
   * File path for encrypted-file backend
   */
  filePath?: string;
  /**
   * Vault configuration (future)
   */
  vaultConfig?: {
    address: string;
    token: string;
    mount: string;
  };
}

/**
 * OmniRoute sync configuration
 */
export interface OmniRouteSyncConfig {
  enabled: boolean;
  syncIntervalMs: number;
  autoRotate: boolean;
  rotationDays: number;
}

/**
 * Credential sync status
 */
export interface CredentialSyncStatus {
  service: string;
  lastSync: string;
  status: 'synced' | 'pending' | 'failed';
  error?: string;
}

/**
 * Credential audit log entry
 */
export interface CredentialAuditLog {
  id: string;
  credential_id: string;
  action: 'create' | 'read' | 'update' | 'delete' | 'rotate' | 'sync';
  timestamp: string;
  user?: string;
  source: string;
  success: boolean;
  error?: string;
}