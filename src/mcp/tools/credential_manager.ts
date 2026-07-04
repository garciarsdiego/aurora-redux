/**
 * MCP tools for credential management
 *
 * Provides CRUD operations for credentials via MCP
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type {
  CredentialProvider,
  CredentialProviderConfig,
  OmniRouteSyncConfig,
} from '../../v2/credentials/index.js';
import {
  CredentialProvider as CredentialProviderClass,
  OmniRouteCredentialSync,
  RoutingCredentialManager,
} from '../../v2/credentials/index.js';
import { optional, parsedNumber } from '../../utils/config.js';

// Global instances (singleton pattern for MCP tools)
let providerInstance: CredentialProvider | null = null;
let syncInstance: OmniRouteCredentialSync | null = null;
let routingManagerInstance: RoutingCredentialManager | null = null;

/**
 * Initialize credential management system
 */
function initializeCredentialManagement(): {
  provider: CredentialProvider;
  sync: OmniRouteCredentialSync;
  routingManager: RoutingCredentialManager;
} {
  if (providerInstance && syncInstance && routingManagerInstance) {
    return {
      provider: providerInstance,
      sync: syncInstance,
      routingManager: routingManagerInstance,
    };
  }

  // Load configuration from environment
  const backend = (optional('CREDENTIAL_STORAGE_BACKEND', 'env') as 'env' | 'encrypted-file');
  const masterKey = optional('CREDENTIAL_MASTER_KEY', 'default-master-key-change-in-production');
  const filePath = optional('CREDENTIAL_STORAGE_FILE', 'data/credentials.enc.json');
  const syncEnabled = optional('CREDENTIAL_SYNC_ENABLED', 'false') === 'true';
  const syncIntervalMs = parsedNumber('CREDENTIAL_SYNC_INTERVAL_MS', 300000); // 5 minutes
  const autoRotate = optional('CREDENTIAL_AUTO_ROTATE', 'false') === 'true';
  const rotationDays = parsedNumber('CREDENTIAL_ROTATION_DAYS', 90);

  const config: CredentialProviderConfig = {
    backend,
    masterKey,
    filePath,
    encryption: {
      algorithm: 'aes-256-gcm',
      keyDerivation: 'pbkdf2',
      iterations: 100000,
    },
  };

  const syncConfig: OmniRouteSyncConfig = {
    enabled: syncEnabled,
    syncIntervalMs,
    autoRotate,
    rotationDays,
  };

  providerInstance = new CredentialProviderClass(config, true);
  syncInstance = new OmniRouteCredentialSync(providerInstance, syncConfig);
  routingManagerInstance = new RoutingCredentialManager(providerInstance, syncInstance);

  // Start auto-sync if enabled
  if (syncEnabled) {
    syncInstance.startAutoSync();
  }

  return {
    provider: providerInstance,
    sync: syncInstance,
    routingManager: routingManagerInstance,
  };
}

/**
 * Tool: Create a new credential
 */
export const omniforge_credential_create: Tool = {
  name: 'omniforge_credential_create',
  description: 'Create a new credential with secure encryption. Supports API keys, OAuth tokens, certificates, and basic auth credentials.',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Human-readable name for the credential',
      },
      service: {
        type: 'string',
        description: 'Service name (e.g., omniroute, telegram, openai)',
      },
      type: {
        type: 'string',
        enum: ['api-key', 'oauth-token', 'certificate', 'basic-auth'],
        description: 'Type of credential',
      },
      value: {
        type: 'string',
        description: 'Credential value (will be encrypted)',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional tags for categorization',
      },
    },
    required: ['name', 'service', 'type', 'value'],
  },
};

/**
 * Tool: Get a credential by ID
 */
export const omniforge_credential_get: Tool = {
  name: 'omniforge_credential_get',
  description: 'Retrieve a credential by ID. The value will be decrypted and returned.',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Credential ID',
      },
    },
    required: ['id'],
  },
};

/**
 * Tool: Get a credential by service
 */
export const omniforge_credential_get_by_service: Tool = {
  name: 'omniforge_credential_get_by_service',
  description: 'Retrieve a credential by service name (e.g., omniroute, telegram).',
  inputSchema: {
    type: 'object',
    properties: {
      service: {
        type: 'string',
        description: 'Service name (e.g., omniroute, telegram)',
      },
    },
    required: ['service'],
  },
};

/**
 * Tool: List all credentials
 */
export const omniforge_credential_list: Tool = {
  name: 'omniforge_credential_list',
  description: 'List all credentials with their metadata (values are not included for security).',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

/**
 * Tool: Update a credential
 */
export const omniforge_credential_update: Tool = {
  name: 'omniforge_credential_update',
  description: 'Update an existing credential. Creates a new version.',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Credential ID',
      },
      value: {
        type: 'string',
        description: 'New credential value',
      },
      name: {
        type: 'string',
        description: 'New name for the credential',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'New tags for the credential',
      },
    },
    required: ['id'],
  },
};

/**
 * Tool: Delete a credential
 */
export const omniforge_credential_delete: Tool = {
  name: 'omniforge_credential_delete',
  description: 'Delete a credential permanently. This action cannot be undone.',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Credential ID',
      },
    },
    required: ['id'],
  },
};

/**
 * Tool: Rotate a credential
 */
export const omniforge_credential_rotate: Tool = {
  name: 'omniforge_credential_rotate',
  description: 'Rotate a credential by creating a new version with a new value. The old credential is deleted.',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Credential ID to rotate',
      },
      new_value: {
        type: 'string',
        description: 'New credential value',
      },
    },
    required: ['id', 'new_value'],
  },
};

/**
 * Tool: Sync credentials with OmniRoute
 */
export const omniforge_credential_sync: Tool = {
  name: 'omniforge_credential_sync',
  description: 'Synchronize credentials with OmniRoute. Validates credentials and updates sync status.',
  inputSchema: {
    type: 'object',
    properties: {
      credential_id: {
        type: 'string',
        description: 'Specific credential ID to sync (optional, syncs all if not provided)',
      },
    },
  },
};

/**
 * Tool: Get credential sync status
 */
export const omniforge_credential_sync_status: Tool = {
  name: 'omniforge_credential_sync_status',
  description: 'Get the sync status for credentials with OmniRoute.',
  inputSchema: {
    type: 'object',
    properties: {
      credential_id: {
        type: 'string',
        description: 'Specific credential ID to check (optional, returns all if not provided)',
      },
    },
  },
};

/**
 * Tool: Get credential audit log
 */
export const omniforge_credential_audit_log: Tool = {
  name: 'omniforge_credential_audit_log',
  description: 'Get the audit log for credential operations (create, read, update, delete, rotate, sync).',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

/**
 * Tool: Validate routing credentials
 */
export const omniforge_credential_validate_routing: Tool = {
  name: 'omniforge_credential_validate_routing',
  description: 'Validate all credentials required for routing (OmniRoute, Telegram, etc.).',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

/**
 * Tool handlers
 */
export async function handleCredentialCreate(args: any): Promise<any> {
  const { provider } = initializeCredentialManagement();
  const credential = await provider.createCredential(
    args.name,
    args.service,
    args.type,
    args.value,
    args.tags || [],
  );
  return {
    success: true,
    credential: {
      id: credential.metadata.id,
      name: credential.metadata.name,
      service: credential.metadata.service,
      type: credential.metadata.type,
      created_at: credential.metadata.created_at,
      tags: credential.metadata.tags,
    },
  };
}

export async function handleCredentialGet(args: any): Promise<any> {
  const { provider } = initializeCredentialManagement();
  const credential = await provider.getCredential(args.id);

  if (!credential) {
    return {
      success: false,
      error: 'Credential not found',
    };
  }

  return {
    success: true,
    credential: {
      id: credential.metadata.id,
      name: credential.metadata.name,
      service: credential.metadata.service,
      type: credential.metadata.type,
      value: credential.value, // Decrypted value
      created_at: credential.metadata.created_at,
      updated_at: credential.metadata.updated_at,
      tags: credential.metadata.tags,
      version: credential.metadata.version,
    },
  };
}

export async function handleCredentialGetByService(args: any): Promise<any> {
  const { provider } = initializeCredentialManagement();
  const credential = await provider.getCredentialByService(args.service);

  if (!credential) {
    return {
      success: false,
      error: 'Credential not found for service',
    };
  }

  return {
    success: true,
    credential: {
      id: credential.metadata.id,
      name: credential.metadata.name,
      service: credential.metadata.service,
      type: credential.metadata.type,
      value: credential.value,
      created_at: credential.metadata.created_at,
      updated_at: credential.metadata.updated_at,
      tags: credential.metadata.tags,
      version: credential.metadata.version,
    },
  };
}

export async function handleCredentialList(args: any): Promise<any> {
  const { provider } = initializeCredentialManagement();
  const credentials = await provider.listCredentials();

  return {
    success: true,
    credentials: credentials.map((c) => ({
      id: c.id,
      name: c.name,
      service: c.service,
      type: c.type,
      created_at: c.created_at,
      updated_at: c.updated_at,
      tags: c.tags,
      version: c.version,
    })),
  };
}

export async function handleCredentialUpdate(args: any): Promise<any> {
  const { provider } = initializeCredentialManagement();
  const updates: any = {};

  if (args.value !== undefined) updates.value = args.value;
  if (args.name !== undefined) updates.metadata = { name: args.name };
  if (args.tags !== undefined) updates.metadata = { ...updates.metadata, tags: args.tags };

  const credential = await provider.updateCredential(args.id, updates);

  return {
    success: true,
    credential: {
      id: credential.metadata.id,
      name: credential.metadata.name,
      service: credential.metadata.service,
      type: credential.metadata.type,
      updated_at: credential.metadata.updated_at,
      tags: credential.metadata.tags,
      version: credential.metadata.version,
    },
  };
}

export async function handleCredentialDelete(args: any): Promise<any> {
  const { provider } = initializeCredentialManagement();
  await provider.deleteCredential(args.id);

  return {
    success: true,
    message: 'Credential deleted successfully',
  };
}

export async function handleCredentialRotate(args: any): Promise<any> {
  const { provider } = initializeCredentialManagement();
  const credential = await provider.rotateCredential(args.id, args.new_value);

  return {
    success: true,
    credential: {
      id: credential.metadata.id,
      name: credential.metadata.name,
      service: credential.metadata.service,
      type: credential.metadata.type,
      created_at: credential.metadata.created_at,
      updated_at: credential.metadata.updated_at,
      tags: credential.metadata.tags,
      version: credential.metadata.version,
    },
  };
}

export async function handleCredentialSync(args: any): Promise<any> {
  const { sync } = initializeCredentialManagement();

  if (args.credential_id) {
    const status = await sync.syncCredential(args.credential_id);
    return {
      success: true,
      status,
    };
  } else {
    await sync.syncAllCredentials();
    const statuses = sync.getAllSyncStatuses();
    return {
      success: true,
      statuses,
    };
  }
}

export async function handleCredentialSyncStatus(args: any): Promise<any> {
  const { sync } = initializeCredentialManagement();

  if (args.credential_id) {
    const status = sync.getSyncStatus(args.credential_id);
    return {
      success: true,
      status,
    };
  } else {
    const statuses = sync.getAllSyncStatuses();
    return {
      success: true,
      statuses,
    };
  }
}

export async function handleCredentialAuditLog(args: any): Promise<any> {
  const { provider } = initializeCredentialManagement();
  const auditLog = provider.getAuditLog();

  return {
    success: true,
    audit_log: auditLog,
  };
}

export async function handleCredentialValidateRouting(args: any): Promise<any> {
  const { routingManager } = initializeCredentialManagement();
  const validation = await routingManager.validateRoutingCredentials();

  return {
    success: true,
    validation,
  };
}