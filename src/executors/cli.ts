// =============================================================================
// cli.ts — facade re-export. The implementation now lives in ./cli/.
//
// Historically this file was a 2400+ LOC god-module that mixed bin resolution,
// per-CLI argv adapters, Windows .cmd shim handling, stream-json parsers,
// OpenCode ACP transport, and the runCliTask orchestrator. Refactor M2-A1
// split it into a domain-organised tree under `./cli/`:
//
//   cli/
//     index.ts              ← runCliTask orchestrator
//     types.ts              ← CliSpec, RunCliOpts, parsed-output shapes
//     permission-context.ts ← withCliPermissionMode + isCliSafeMode
//     bin-resolver.ts       ← claudeBin/codexBin/... memoized lookup
//     spawn-common.ts       ← buildCliSpawnOptions + resolveSpawnTarget
//     cli-inference.ts      ← model↔cli compatibility + inferCliIdFromTask
//     resolve-spec.ts       ← resolveCliSpec dispatcher
//     adapters/             ← per-CLI argv builders (one file per CLI)
//     prompt-builder.ts     ← buildPrompt (sections layered for the LLM)
//     jsonl-parser.ts       ← Claude + Gemini stream-json parsers
//     runtime-injection.ts  ← opt-in argv mutations (gemini resume etc.)
//     opencode-acp.ts       ← Wave D OpenCode ACP transport
//
// Every external consumer (`brain/validator.ts`, `mcp/tools/run_workflow.ts`,
// the entire test suite, …) imports via `'../../executors/cli.js'` — this
// facade keeps that contract intact. Don't add new logic here; add it under
// `./cli/` and re-export from `./cli/index.ts`.
// =============================================================================

export * from './cli/index.js';
