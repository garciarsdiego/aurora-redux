/**
 * Public surface of the agent framework.
 *
 * Internal modules (validators/*, prompts/*) are imported directly when needed
 * — only what callers outside the agents tree should reach for is re-exported
 * here. Keeps the import graph easy to audit.
 */

export type {
  AgentContext,
  AgentEventEmitter,
  AgentId,
  AgentPersona,
  AmbiguityRule,
  FailureMode,
  PostHookResult,
  PreHookResult,
  RemediationStrategy,
  ToolName,
  UniversalRuleId,
} from './types.js';
export {
  AGENT_IDS,
  AgentInputError,
  AgentOutputError,
  AgentRejectedError,
  UNIVERSAL_HARD_RULES,
} from './types.js';

export { renderSystemPrompt } from './prompts/system_prompt_template.js';
export {
  RETRY_HARDER_PREFIX,
  WORKER_CLI_SPAWN_PREFIX,
  WORKER_LLM_NO_TOOLS_REMINDER,
  WORKSPACE_CLEAN_BANNER,
} from './prompts/prefixes.js';

export { runAgent, createInMemoryContext } from './runner.js';
export type { AgentInvokeArgs, AgentInvoker, RunAgentOptions } from './runner.js';

export type { PermissionAction, PermissionMap, PersonaPermissions } from './permissions.js';
export { PermissionDeniedError, resolveToolPermission, enforcePersonaToolPermissions } from './permissions.js';

export {
  DECOMPOSER_PERSONA,
  DecomposerInputSchema,
  DecomposerOutputSchema,
  ModelEntrySchema,
  KNOWN_CLIS,
  hasCycle,
  pickAlternativeModel,
} from './personas/decomposer.js';
export type { DecomposerInput, DecomposerOutput, ModelEntry, KnownCli } from './personas/decomposer.js';

export {
  WORKER_CLI_SPAWN_PERSONA,
  WorkerCliSpawnInputSchema,
  WorkerCliSpawnOutputSchema,
} from './personas/worker_cli_spawn.js';
export type { WorkerCliSpawnInput, WorkerCliSpawnOutput } from './personas/worker_cli_spawn.js';

// Onda 2 — remaining 7 personas (full RFC implementation)

export {
  REFINER_PERSONA,
  RefinerInputSchema,
  RefinerOutputSchema,
} from './personas/refiner.js';
export type { RefinerInput, RefinerOutput } from './personas/refiner.js';

export {
  WORKER_LLM_CALL_PERSONA,
  WorkerLlmCallInputSchema,
  WorkerLlmCallOutputSchema,
} from './personas/worker_llm_call.js';
export type { WorkerLlmCallInput, WorkerLlmCallOutput } from './personas/worker_llm_call.js';

export {
  WORKER_TOOL_CALL_PERSONA,
  WorkerToolCallInputSchema,
  WorkerToolCallOutputSchema,
  ToolNameSchema,
  classifyDangerousBashCommand,
} from './personas/worker_tool_call.js';
export type { WorkerToolCallInput, WorkerToolCallOutput, ToolKind } from './personas/worker_tool_call.js';

export {
  WORKER_ADVISOR_CALL_PERSONA,
  WorkerAdvisorCallInputSchema,
  WorkerAdvisorCallOutputSchema,
  ADVISOR_NAMES,
  ADVISOR_MODES,
  modeIsSupported,
  defaultModeFor,
} from './personas/worker_advisor_call.js';
export type {
  WorkerAdvisorCallInput,
  WorkerAdvisorCallOutput,
  AdvisorName,
  AdvisorMode,
} from './personas/worker_advisor_call.js';

export {
  REVIEWER_PERSONA,
  ReviewerInputSchema,
  ReviewerOutputSchema,
  countCriteria,
} from './personas/reviewer.js';
export type { ReviewerInput, ReviewerOutput } from './personas/reviewer.js';

export {
  FAILOVER_CLASSIFIER_PERSONA,
  FailoverClassifierInputSchema,
  FailoverClassifierOutputSchema,
  matchKnownFailurePattern,
} from './personas/failover_classifier.js';
export type { FailoverClassifierInput, FailoverClassifierOutput } from './personas/failover_classifier.js';

export {
  CONSOLIDATOR_PERSONA,
  ConsolidatorInputSchema,
  ConsolidatorOutputSchema,
} from './personas/consolidator.js';
export type { ConsolidatorInput, ConsolidatorOutput } from './personas/consolidator.js';

// Onda 3 — AI Builder conversational persona

export {
  BUILDER_CONVERSATIONAL_PERSONA,
  BuilderConversationalInputSchema,
  BuilderConversationalOutputSchema,
  BuilderActionSchema,
  ConversationTurnSchema,
} from './personas/builder_conversational.js';
export type {
  BuilderConversationalInput,
  BuilderConversationalOutput,
  BuilderAction,
  ConversationTurn,
} from './personas/builder_conversational.js';

export {
  SUSPICION_PATTERNS,
  SUSPICION_AUTO_FAIL_THRESHOLD,
  calculateSuspicion,
} from './validators/suspicion.js';
export type { SuspicionPattern, SuspicionScore } from './validators/suspicion.js';

export {
  hasWriteTool,
  isWriteTool,
  listToolNames,
  requiresWrite,
  extractFilePathsFromAcceptance,
} from './validators/tool_trace.js';
export type { ToolCallTraceEntry } from './validators/tool_trace.js';

export { verifyAcceptanceArtifacts, verifyFile } from './validators/filesystem.js';
export type { AcceptanceVerification, FileVerification } from './validators/filesystem.js';

export { backupFileForRetry, backupFilesForRetry } from './validators/workspace.js';
export type { BackupOptions, BackupResult } from './validators/workspace.js';
