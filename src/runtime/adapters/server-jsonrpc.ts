import type { RuntimeAdapterStructuredError } from './acp.js';

export interface ServerJsonRpcProbeInput {
  executorId: string;
  endpoint?: string | null;
  statusBeforeProbe: 'verified' | 'experimental' | 'planned' | 'disabled';
}

export interface ServerJsonRpcProbeDecision {
  canUse: boolean;
  structuredError?: RuntimeAdapterStructuredError;
}

export function decideServerJsonRpcProbe(input: ServerJsonRpcProbeInput): ServerJsonRpcProbeDecision {
  if (input.statusBeforeProbe !== 'verified') {
    return {
      canUse: false,
      structuredError: {
        code: 'runtime_server_jsonrpc_unverified',
        origin: `runtime.adapter.server-jsonrpc:${input.executorId}`,
        message: `Server JSON-RPC adapter for ${input.executorId} is ${input.statusBeforeProbe}, not verified.`,
        suggestedAction:
          'Run an isolated live probe that proves startup, initialize, prompt turn, cancellation, and shutdown before routing workflows through server JSON-RPC.',
        safeContext: {
          executorId: input.executorId,
          protocol: 'server-jsonrpc',
          statusBeforeProbe: input.statusBeforeProbe,
          endpointConfigured: Boolean(input.endpoint),
        },
      },
    };
  }
  if (!input.endpoint?.trim()) {
    return {
      canUse: false,
      structuredError: {
        code: 'runtime_server_jsonrpc_missing_endpoint',
        origin: `runtime.adapter.server-jsonrpc:${input.executorId}`,
        message: 'Server JSON-RPC adapter is verified but no endpoint was provided.',
        suggestedAction: 'Start the server transport in an isolated process and pass its local endpoint to the runtime adapter.',
        safeContext: {
          executorId: input.executorId,
          protocol: 'server-jsonrpc',
        },
      },
    };
  }
  return { canUse: true };
}
