type ModelFamily = 'anthropic' | 'openai' | 'google' | 'deepseek' | 'kimi' | 'glm' | 'minimax' | 'generic';

const GUIDANCE: Record<ModelFamily, string> = {
  // Claude handles its own conventions natively — no extra guidance needed.
  anthropic: '',

  openai: [
    'MODEL EXECUTION GUIDANCE (OpenAI family):',
    '- Use structured JSON responses when output schema is declared.',
    '- Tool call arguments must be valid JSON objects matching the declared schema.',
    '- Prefer explicit type annotations in generated TypeScript/Python code.',
    '- Output complete file contents — never use ellipsis or placeholder comments.',
    '- Do not use XML tags or Anthropic-specific formatting conventions.',
    '- When acceptance_criteria specifies a measurable bound, treat it as a hard gate.',
  ].join('\n'),

  google: [
    'MODEL OPERATIONAL GUIDANCE (Google Gemini family):',
    '- Output must be plain text or valid JSON — do not wrap in markdown fences unless asked.',
    '- For code generation tasks, produce complete implementations without placeholders.',
    '- Treat acceptance_criteria as a strict binary pass/fail gate.',
    '- Do not reference Google-internal tooling, Vertex AI, or model-specific APIs.',
    '- When structured output is required, use standard JSON schema format.',
    '- Be explicit about file paths and command invocations — do not assume defaults.',
  ].join('\n'),

  deepseek: [
    'MODEL EXECUTION GUIDANCE (DeepSeek family):',
    '- Respond in English unless the objective explicitly requests another language.',
    '- For code tasks, output complete implementations with no truncation.',
    '- Do not add unsolicited explanations or caveats outside the requested output format.',
    '- When generating JSON, ensure it is valid and well-formed.',
  ].join('\n'),

  kimi: [
    'MODEL EXECUTION GUIDANCE (Kimi/Moonshot family):',
    '- Respond in English unless the objective explicitly requests another language.',
    '- For code tasks, output complete implementations — do not truncate with comments.',
    '- When outputting JSON, ensure it is strict and well-formed.',
    '- Do not add meta-commentary about your own capabilities or limitations.',
  ].join('\n'),

  glm: [
    'MODEL EXECUTION GUIDANCE (GLM/Zhipu family):',
    '- Respond in English unless the objective explicitly requests another language.',
    '- For code tasks, output complete implementations — do not truncate with comments.',
    '- When outputting JSON, ensure it is strict and well-formed.',
    '- Do not add meta-commentary about your own capabilities or limitations.',
  ].join('\n'),

  minimax: [
    'MODEL EXECUTION GUIDANCE (MiniMax family):',
    '- Respond in English unless the objective explicitly requests another language.',
    '- For code tasks, output complete implementations — do not truncate with comments.',
    '- When outputting JSON, ensure it is strict and well-formed — never wrap it in a <think> reasoning block.',
    '- Do not add meta-commentary about your own capabilities or limitations.',
  ].join('\n'),

  generic: '',
};

// Ordered: more specific prefixes first to avoid false matches.
const FAMILY_PREFIXES: Array<[string, ModelFamily]> = [
  ['deepseek', 'deepseek'],
  ['kimi', 'kimi'],
  ['moonshot', 'kimi'],
  ['minimax', 'minimax'],
  ['glm', 'glm'],
  ['claude', 'anthropic'],
  ['anthropic', 'anthropic'],
  ['gpt-', 'openai'],
  ['o1-', 'openai'],
  ['o3-', 'openai'],
  ['text-davinci', 'openai'],
  ['codex', 'openai'],
  ['gemini', 'google'],
];

export function resolveFamily(modelId: string): ModelFamily {
  const lower = modelId.toLowerCase();
  for (const [prefix, family] of FAMILY_PREFIXES) {
    if (lower.includes(prefix)) return family;
  }
  return 'generic';
}

export function getModelGuidance(modelId: string): string {
  return GUIDANCE[resolveFamily(modelId)];
}

// ---------------------------------------------------------------------------
// Per-CLI guidance: injected into the prompt built in src/executors/cli.ts
// so each CLI invocation knows its own native capabilities.
// ---------------------------------------------------------------------------

const CLI_GUIDANCE: Record<string, string> = {
  'cli:claude-code': [
    'CLI RUNTIME GUIDANCE (Claude Code):',
    'Native capabilities available:',
    '- Agent tool for dispatching subagents in parallel within this session.',
    '  Use when the task has multiple independent facets that benefit from',
    '  specialist perspectives. Available subagent_type values include:',
    '  general-purpose, code-reviewer, typescript-pro, frontend-developer,',
    '  architect, architect-reviewer, security-auditor, refactoring-specialist,',
    '  debugger, Explore (fast codebase search), Plan (implementation planning),',
    '  test-automator, database-optimizer.',
    '  Pattern: dispatch all subagents in one turn (parallel), wait for all,',
    '  then synthesize.',
    '- Read / Write / Edit / Glob / Grep for file ops (no external tooling needed).',
    '- Bash tool for shell commands.',
    '- TodoWrite for multi-step task tracking.',
    'If the task prompt says "dispatch N subagents" — use the Agent tool.',
    'If the task prompt has OUTPUT_DIR, write files there directly.',
  ].join('\n'),

  'cli:codex': [
    'CLI RUNTIME GUIDANCE (Codex):',
    'Native capabilities: sandboxed file edits via your internal apply_patch',
    'equivalent. You DO NOT have a generic Agent-style subagent dispatch;',
    'handle delegation by sequential reasoning. If the task asks for',
    '"parallel subagents", treat it as a hint to structure the work into',
    'distinct phases rather than attempting concurrent dispatch.',
    'Strong at: deterministic code generation, bounded file edits, refactors.',
    'Weak at: open-ended reasoning, research across many files (delegate',
    'those back to Omniforge DAG parallelism instead of trying in one call).',
  ].join('\n'),

  'cli:gemini': [
    'CLI RUNTIME GUIDANCE (Gemini CLI):',
    'Native capabilities: Google-grounded search built-in (use for tasks',
    'needing current information). MCP tool support for external',
    'integrations. No parallel subagent dispatch — use your strengths',
    '(grounding, long context, multimodal) rather than trying to emulate',
    "Claude Code's Agent tool.",
    'Strong at: research with up-to-date sources, long-document analysis,',
    'multimodal tasks.',
    '',
    'IMPORTANT — file encoding on Windows: when writing text files, use',
    "UTF-8 encoding WITHOUT BOM. If invoking PowerShell's Set-Content or",
    'Out-File, pass `-Encoding utf8` (PowerShell 5.1) or `-Encoding utf8NoBOM`',
    '(PowerShell 7+) explicitly. Windows PowerShell 5.1 defaults to UTF-16 LE',
    'with BOM, which downstream readers interpret as garbled bytes. Example',
    'smoke test 2026-05-01 — gemini.txt landed as 14 bytes for 4 characters',
    'with FF FE prefix because of this default. Use UTF-8 always.',
  ].join('\n'),

  'cli:kimi': [
    'CLI RUNTIME GUIDANCE (Kimi):',
    'Native capabilities: long context window (excels at large-document',
    'reasoning), strong Chinese + English. No native parallel subagent',
    'dispatch. Treat as a capable single agent; avoid emulating Agent tool',
    'patterns.',
  ].join('\n'),

  'cli:cursor': [
    'CLI RUNTIME GUIDANCE (Cursor agent, headless):',
    'Running under `agent -p --force` — non-interactive, auto-approves edits.',
    'Native capabilities: file read/write/edit within the current directory,',
    'shell command execution, codebase indexing. No parallel subagent dispatch',
    "equivalent to Claude Code's Agent tool — handle delegation sequentially.",
    'Strong at: IDE-style refactors, multi-file coordinated edits, tight',
    'diff-review loops. Weak at: open-ended research without file anchor.',
    'When OUTPUT_DIR is set, write artifacts there directly.',
  ].join('\n'),

  'cli:kilo': [
    'CLI RUNTIME GUIDANCE (Kilo Code, headless):',
    'Running under `kilo run --auto` — fully autonomous, skips permission',
    'prompts. No machine-readable output format documented (text only), so',
    'the reviewer will see your final synthesis verbatim — be concise and',
    'avoid streaming-chat conventions. No parallel subagent dispatch.',
    'Strong at: autonomous test-fix loops, CI-style workflows. Weak at:',
    'exploratory tasks where partial output visibility matters.',
    'When OUTPUT_DIR is set, write artifacts there directly.',
  ].join('\n'),

  'cli:opencode': [
    'CLI RUNTIME GUIDANCE (OpenCode, headless):',
    'Running under `opencode run --dangerously-skip-permissions`. The backend',
    "model may have been selected via `-m provider/model` — respect the model's",
    'native conventions (if the flag was set, your underlying model is shown',
    'in the session banner). No parallel subagent dispatch.',
    'Native capabilities: file read/write/edit, shell exec, session state',
    'persistence, plugin system (via opencode plugins). Treat as a capable',
    'single-agent executor.',
    'When OUTPUT_DIR is set, write artifacts there directly.',
  ].join('\n'),
};

export function getCliGuidance(executorHint: string | null | undefined): string {
  if (!executorHint) return '';
  const lower = executorHint.toLowerCase().trim();

  // 1. Exact canonical key match (e.g. "cli:claude-code").
  if (Object.prototype.hasOwnProperty.call(CLI_GUIDANCE, lower)) {
    return CLI_GUIDANCE[lower] as string;
  }

  // 2. Partial match against CLI names (strips the "cli:" prefix for comparison).
  for (const [key, guidance] of Object.entries(CLI_GUIDANCE)) {
    const cliName = key.replace(/^cli:/, '');
    if (lower.includes(cliName)) return guidance;
  }

  return '';
}
