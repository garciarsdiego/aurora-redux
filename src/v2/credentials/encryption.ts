/**
 * Encryption utilities for credential management
 *
 * Uses AES-256-GCM for authenticated encryption with PBKDF2 for key derivation
 */

import crypto from 'node:crypto';
import type {
  EncryptionConfig,
  EncryptedCredential,
  DecryptedCredential,
} from './types.js';

const DEFAULT_ITERATIONS = 100000;
const SALT_LENGTH = 32;
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32; // 256 bits for AES-256

/**
 * Generate a random salt for key derivation
 */
export function generateSalt(): string {
  const salt = crypto.randomBytes(SALT_LENGTH);
  return salt.toString('base64');
}

/**
 * Derive a cryptographic key from the master password using PBKDF2
 */
export function deriveKey(
  masterKey: string,
  salt: string,
  iterations: number = DEFAULT_ITERATIONS,
): Buffer {
  const saltBuffer = Buffer.from(salt, 'base64');
  return crypto.pbkdf2Sync(masterKey, saltBuffer, iterations, KEY_LENGTH, 'sha256');
}

/**
 * Encrypt a credential value using AES-256-GCM
 */
export function encryptCredential(
  value: string,
  masterKey: string,
  config: EncryptionConfig,
): { ciphertext: string; iv: string; authTag: string } {
  if (config.algorithm !== 'aes-256-gcm') {
    throw new Error(`Unsupported algorithm: ${config.algorithm}`);
  }

  const salt = config.salt || generateSalt();
  const key = deriveKey(masterKey, salt, config.iterations);
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let ciphertext = cipher.update(value, 'utf8');
  ciphertext = Buffer.concat([ciphertext, cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

/**
 * Decrypt a credential value using AES-256-GCM
 */
export function decryptCredential(
  ciphertext: string,
  iv: string,
  authTag: string,
  masterKey: string,
  config: EncryptionConfig,
): string {
  if (config.algorithm !== 'aes-256-gcm') {
    throw new Error(`Unsupported algorithm: ${config.algorithm}`);
  }

  if (!config.salt) {
    throw new Error('Salt is required for decryption');
  }

  const key = deriveKey(masterKey, config.salt, config.iterations);
  const ivBuffer = Buffer.from(iv, 'base64');
  const authTagBuffer = Buffer.from(authTag, 'base64');
  const ciphertextBuffer = Buffer.from(ciphertext, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, ivBuffer);
  decipher.setAuthTag(authTagBuffer);

  let plaintext = decipher.update(ciphertextBuffer);
  plaintext = Buffer.concat([plaintext, decipher.final()]);

  return plaintext.toString('utf8');
}

/**
 * Encrypt a full credential object
 */
export function encryptCredentialObject(
  credential: DecryptedCredential,
  masterKey: string,
  config: EncryptionConfig,
): EncryptedCredential {
  const salt = config.salt || generateSalt();
  const { ciphertext, iv, authTag } = encryptCredential(
    credential.value,
    masterKey,
    { ...config, salt },
  );

  return {
    metadata: credential.metadata,
    ciphertext,
    iv,
    auth_tag: authTag,
    algorithm: config.algorithm,
    salt, // Store salt for decryption
  };
}

/**
 * Decrypt a full credential object
 */
export function decryptCredentialObject(
  encrypted: EncryptedCredential,
  masterKey: string,
): DecryptedCredential {
  const config: EncryptionConfig = {
    algorithm: 'aes-256-gcm',
    keyDerivation: 'pbkdf2',
    iterations: DEFAULT_ITERATIONS,
    salt: encrypted.salt || encrypted.iv, // Use stored salt, fallback to IV
  };

  const value = decryptCredential(
    encrypted.ciphertext,
    encrypted.iv,
    encrypted.auth_tag,
    masterKey,
    config,
  );

  return {
    metadata: encrypted.metadata,
    value,
  };
}

/**
 * Generate a unique credential ID
 */
export function generateCredentialId(): string {
  return `cred_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * Hash a credential value for comparison (one-way)
 */
export function hashCredentialValue(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Validate credential format (basic validation)
 */
export function validateCredentialFormat(
  type: string,
  value: string,
): { valid: boolean; error?: string } {
  if (!value || value.trim().length === 0) {
    return { valid: false, error: 'Credential value cannot be empty' };
  }

  switch (type) {
    case 'api-key':
      if (value.length < 16) {
        return { valid: false, error: 'API key must be at least 16 characters' };
      }
      break;
    case 'oauth-token':
      if (!value.includes('.') && value.length < 20) {
        return { valid: false, error: 'OAuth token appears invalid' };
      }
      break;
    case 'basic-auth':
      if (!value.includes(':')) {
        return { valid: false, error: 'Basic auth must be in format username:password' };
      }
      break;
    default:
      // Accept any format for unknown types
      break;
  }

  return { valid: true };
}