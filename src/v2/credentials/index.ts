/**
 * Credential Management System for OmniRoute
 *
 * Provides secure storage, encryption, and synchronization of credentials
 * for OmniRoute integration with support for multiple storage backends.
 *
 * @module credentials
 */

// Types
export type {
  StorageBackend,
  CredentialType,
  CredentialMetadata,
  EncryptedCredential,
  DecryptedCredential,
  CredentialStorage,
  EncryptionConfig,
  CredentialProviderConfig,
  OmniRouteSyncConfig,
  CredentialSyncStatus,
  CredentialAuditLog,
} from './types.js';

// Encryption utilities
export {
  generateSalt,
  deriveKey,
  encryptCredential,
  decryptCredential,
  encryptCredentialObject,
  decryptCredentialObject,
  generateCredentialId,
  hashCredentialValue,
  validateCredentialFormat,
} from './encryption.js';

// Storage implementations
export {
  EnvCredentialStorage,
  EncryptedFileStorage,
  createStorage,
} from './storage.js';

// Credential provider
export { CredentialProvider } from './provider.js';

// OmniRoute sync
export { OmniRouteCredentialSync } from './sync.js';

// Routing integration
export { RoutingCredentialManager } from './routing-integration.js';