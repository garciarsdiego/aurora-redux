/**
 * Inline prompt prefixes injected by per-agent harnesses.
 *
 * Why constants instead of inline strings inside personas?
 *   - These prefixes are referenced by tests (the worker.described_without_writing
 *     regression check asserts the prefix is in the prompt sent to the CLI).
 *   - Centralising avoids drift when the same prefix appears in multiple
 *     personas (e.g. WORKER_LLM_NO_TOOLS_REMINDER reused across kinds).
 *   - The RFC quotes the exact text — keeping it in one file means the spec
 *     and the runtime cannot diverge.
 *
 * RULE: changes here are PERSONA-VERSION-BUMPING. If you edit a prefix, also
 * bump the persona's `version` field so the eval harness picks up the diff.
 */

/**
 * Prepended to every Worker.cli_spawn prompt for CLIs with Tools API
 * (claude-code, codex, kimi, cursor, opencode). Hardens the contract that
 * the CLI must call Write/Edit (not just describe), per the 2026-05-04
 * regression.
 *
 * NOT used for `cli:gemini` — gemini-cli in `-p` arg mode is text-only
 * (no Tools API in headless), and the EXECUTION CONTRACT verbiage made
 * the model think it was being asked to "complete a meta task" rather
 * than emit the actual content. See WORKER_GEMINI_TEXT_PREFIX below.
 */
export const WORKER_CLI_SPAWN_PREFIX = `=== EXECUTION CONTRACT — read before any tool call ===

1. Your job is to CREATE OR MODIFY FILES via the Write/Edit tool. Reading and
   describing does NOT count as completion.
2. If files matching this task exist already (e.g. from a prior attempt), treat
   them as DRAFT — read them, compare to acceptance, then OVERWRITE with the
   complete implementation.
3. Each created file must contain real, parseable source code (TSX/TS/Rust/etc),
   not pseudo-code or markdown summaries. A .tsx file MUST be valid TypeScript
   JSX with imports + exports + JSX, not a markdown narrative about what it
   would contain.
4. After writing all files, verify by reading them back and counting non-blank
   lines. Each implementation file should have >50 lines unless the spec
   explicitly says it's tiny.
5. Your final response MUST list:
   (a) Files written/modified (full paths)
   (b) Line count per file
   (c) Which acceptance criteria each file addresses (cite the criterion text)
   (d) Tool calls made (Write, Edit, Read, etc.) — these will be parsed
6. If you CANNOT complete because of an error, missing dependency, or ambiguity,
   respond with \`<BLOCKED>reason</BLOCKED>\` — NEVER silently summarize success.
7. Do NOT claim "files already exist and look correct" — either OVERWRITE with
   verified-complete implementation OR explicitly say which acceptance points
   the existing files already satisfy AND which are missing.

=== TASK ===
`;

/**
 * Worker prefix for `cli:gemini` (post-2026-05-05 fix N1).
 *
 * Why this exists: Gemini-CLI in headless `-p <prompt>` mode is purely
 * text-in/text-out — it has no Tools API, no Write/Edit/Bash. Feeding it
 * the full WORKER_CLI_SPAWN_PREFIX (with "you MUST call Write tool" rules)
 * caused the model to interpret the task as a meta-completion and reply
 * "I have completed the task" instead of producing the actual content.
 * Validated empirically in workflow `wf_d4826b15` (2m35s run, non-empty
 * but wrong-shaped output, reviewer correctly rejected).
 *
 * This prefix is short, text-output-focused, and makes no claims about
 * tools the gemini context doesn't have. Worker postHook still extracts
 * handoff sections (Summary/Actions/Artifacts/Risks/Next) when present
 * — they are encouraged but not mandated for gemini.
 */
export const WORKER_GEMINI_TEXT_PREFIX = `=== TEXT-OUTPUT WORKER ===

1. You are running in a TEXT-ONLY mode. There is no Write/Edit/Bash tool here. Produce your answer as direct stdout text.
2. Output the actual content the task asks for — DO NOT respond with "I have completed the task" or any meta-acknowledgment.
3. If the acceptance criterion specifies a format (JSON array, haiku lines, bullet list), match it exactly. No markdown fences unless the criterion explicitly requests them.
4. If the task asks for files but there is no Write tool available, explicitly respond with \`<WRONG_KIND>this task needs a file-writing CLI; gemini -p is text-only</WRONG_KIND>\` and stop.

=== TASK ===
`;

/**
 * Injected into Worker.llm_call prompts when the user prompt mentions
 * filesystem verbs. Stops the LLM from pretending it acted on the world.
 */
export const WORKER_LLM_NO_TOOLS_REMINDER = `=== REMINDER ===
You are an LLM call without tools. You CAN reason about files but CANNOT touch them.
If the request requires filesystem access, respond with <WRONG_KIND>...</WRONG_KIND> and
the executor will reroute the task. Do NOT pretend you wrote/edited files.

=== TASK ===
`;

/**
 * Banner appended after a postHook rejection when the failover classifier picks
 * `retry_with_stronger_prompt`. Concrete because vague "try harder" never works.
 */
export const RETRY_HARDER_PREFIX = `=== PRIOR ATTEMPT REJECTED ===
Your previous response was rejected for the reason below. Do NOT repeat the
same shape — read the rejection carefully and produce a DIFFERENT, contract-
compliant output.

REJECTION REASON: \${REJECTION_REASON}

=== TASK ===
`;

/** Workspace-clean banner injected by Worker.cli_spawn preHook on retry. */
export const WORKSPACE_CLEAN_BANNER = `=== WORKSPACE CLEANED ===
The workspace was cleaned of your previous attempt's outputs. Backups live at
\${BACKUP_PATHS}. Read them for reference, then OVERWRITE the originals with a
complete implementation — don't merely describe what the backup says.
`;

/**
 * Handoff schema snippet appended to worker prompts so responses can be
 * parsed by extractHandoffSections and forwarded as carry blocks.
 *
 * Mirrors prompts/snippets/workflow-handoff-schema.md — kept in sync here
 * so tests can assert without filesystem reads.
 */
export const HANDOFF_SCHEMA_SNIPPET = `
=== RESPONSE FORMAT (handoff schema) ===
When you complete your work, structure your response with these exact headings:

## Summary
Brief restatement of what was done (1-3 sentences).

## Actions
Numbered list of concrete steps taken.

## Artifacts
- file:line ranges
- command + exit codes
- URLs or output identifiers

## Risks
Issues, edge cases, things that may break.

## Next
What the next agent / step should do.

> Do not omit any section. Use "None" for empty sections.
=== END FORMAT ===
`;
