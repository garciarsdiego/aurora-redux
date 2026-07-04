/**
 * External MCP — type definitions (Mission 5, Phase 2 hardening).
 *
 * The registry persists `ExternalMcpServer` rows; the runtime layer
 * (`client.ts`) wraps `@modelcontextprotocol/sdk` `Client` instances and
 * surfaces remote tools as `ExternalMcpTool` records with the prefixed
 * name `mcp:<server-name>:<tool-name>` so the executor's tool-call
 * dispatcher can route them without colliding with the in-process tools
 * registered in `src/v2/tools/core/index.ts`.
 *
 * The Zod schemas at the bottom of the file are exported for use at
 * system boundaries (HTTP handlers, CLI commands, DB row decoding).
 */

import { z } from 'zod';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

/** Transport kinds supported by the registry. */
export type ExternalMcpTransport = 'stdio' | 'http-sse';

/**
 * Persisted external MCP server row.
 *
 * `args`/`env` are stored as JSON strings in the DB but decoded to typed
 * structures at the registry boundary.
 *
 * `bearerEnc` is the AES-256-GCM ciphertext envelope (hex-encoded) as
 * produced by `encryptBearer()` in `client.ts`. The registry never logs
 * or returns the plaintext bearer.
 */
export interface ExternalMcpServer {
  id: string;
  name: string;
  transport: ExternalMcpTransport;
  /** stdio: executable to spawn. NULL when transport='http-sse'. */
  command: string | null;
  /** stdio: argv after the executable. NULL when transport='http-sse'. */
  args: string[] | null;
  /** stdio: env overrides applied on spawn. NULL when transport='http-sse'. */
  env: Record<string, string> | null;
  /** http-sse: server SSE endpoint URL. NULL when transport='stdio'. */
  url: string | null;
  /** http-sse: AES-256-GCM ciphertext of the bearer token. NULL if no auth. */
  bearerEnc: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * A single tool advertised by a connected external MCP server.
 *
 * `prefixedName` is the canonical name the executor uses to dispatch the
 * call. It is always `mcp:<serverName>:<serverToolName>`.
 */
export interface ExternalMcpTool {
  serverName: string;
  serverToolName: string;
  prefixedName: string;
  description: string | null;
  inputSchema: Record<string, unknown>;
}

/**
 * Runtime connection state owned by `ExternalMcpManager`.
 *
 * The `client` field is the SDK `Client` instance kept open between
 * calls. Cleanup is the responsibility of the manager (`disconnect()` /
 * `disconnectAll()`).
 */
export interface ExternalMcpConnection {
  server: ExternalMcpServer;
  client: Client;
  tools: ExternalMcpTool[];
}

/**
 * Normalized result of a remote tool invocation.
 *
 * `content` is the raw payload the SDK returned (most often an array of
 * content blocks; sometimes `toolResult` for legacy servers). Callers
 * are responsible for stringifying/extracting text for LLM context.
 */
export interface ExternalMcpCallResult {
  content: unknown;
  isError: boolean;
}

// ---------------------------------------------------------------------------
// Zod schemas — used at HTTP/CLI boundaries and for raw input validation.
// ---------------------------------------------------------------------------

export const ExternalMcpTransportSchema = z.enum(['stdio', 'http-sse']);

/** Server name: starts alphanumeric, then [a-z0-9_-], 1-64 chars. */
export const ExternalMcpServerNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, {
    message:
      'name must start with a lowercase letter or digit and contain only [a-z0-9_-]',
  });

/**
 * Shape accepted by `addServer`. Cross-field validation enforces the
 * stdio/http-sse pairs — mirrors the CHECK constraint in migration 048
 * but at the application boundary so callers get clear Zod errors.
 *
 * The HTTP route layer accepts `bearer` (plaintext) for convenience; the
 * registry encrypts it before storage. Either `bearer` (plaintext) or
 * `bearerEnc` (already-encrypted) may be supplied for http-sse, but not
 * both.
 */
export const ExternalMcpServerInputSchema = z
  .object({
    name: ExternalMcpServerNameSchema,
    transport: ExternalMcpTransportSchema,
    command: z.string().min(1).nullish(),
    args: z.array(z.string()).nullish(),
    env: z.record(z.string(), z.string()).nullish(),
    url: z.string().url().nullish(),
    bearer: z.string().min(1).nullish(),
    bearerEnc: z.string().min(1).nullish(),
    active: z.boolean().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.transport === 'stdio') {
      if (!val.command) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['command'],
          message: "command is required when transport='stdio'",
        });
      }
      if (val.url != null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['url'],
          message: "url must be null when transport='stdio'",
        });
      }
      if (val.bearer != null || val.bearerEnc != null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['bearer'],
          message: "bearer/bearerEnc must be null when transport='stdio'",
        });
      }
    } else {
      if (!val.url) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['url'],
          message: "url is required when transport='http-sse'",
        });
      }
      if (val.command != null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['command'],
          message: "command must be null when transport='http-sse'",
        });
      }
      if (val.args != null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['args'],
          message: "args must be null when transport='http-sse'",
        });
      }
      if (val.env != null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['env'],
          message: "env must be null when transport='http-sse'",
        });
      }
      if (val.bearer != null && val.bearerEnc != null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['bearer'],
          message: 'pass either bearer (plaintext) or bearerEnc (encrypted), not both',
        });
      }
    }
  });

export type ExternalMcpServerInput = z.infer<typeof ExternalMcpServerInputSchema>;

/**
 * Patch shape for `updateServer`. All fields optional. Cross-field rules
 * are validated after merge with the existing row in `registry.ts`.
 */
export const ExternalMcpServerPatchSchema = z.object({
  name: ExternalMcpServerNameSchema.optional(),
  transport: ExternalMcpTransportSchema.optional(),
  command: z.string().min(1).nullish(),
  args: z.array(z.string()).nullish(),
  env: z.record(z.string(), z.string()).nullish(),
  url: z.string().url().nullish(),
  bearer: z.string().min(1).nullish(),
  bearerEnc: z.string().nullish(),
  active: z.boolean().optional(),
});

export type ExternalMcpServerPatch = z.infer<typeof ExternalMcpServerPatchSchema>;

/** Build the canonical prefixed tool name. */
export function prefixToolName(serverName: string, toolName: string): string {
  return `mcp:${serverName}:${toolName}`;
}

/**
 * Parse a prefixed tool name back into its parts. Returns null if `name`
 * is not in the `mcp:server:tool` format.
 */
export function parsePrefixedToolName(
  name: string,
): { serverName: string; toolName: string } | null {
  const match = /^mcp:([^:]+):(.+)$/.exec(name);
  if (!match) return null;
  return { serverName: match[1]!, toolName: match[2]! };
}
