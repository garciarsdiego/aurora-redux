export type RuntimeProtocolTier =
  | 'acp-stdio'
  | 'jsonl-headless'
  | 'app-server-jsonrpc'
  | 'text-pty-fallback';

export type RuntimeStreamFormat =
  | 'acp-jsonrpc'
  | 'claude-stream-json'
  | 'codex-jsonl'
  | 'gemini-text'
  | 'gemini-stream-json'
  | 'kimi-text'
  | 'kimi-stream-json'
  | 'opencode-json'
  | 'cursor-stream-json'
  | 'plain-text';

export type RuntimeCapabilityStatus = 'verified' | 'experimental' | 'planned' | 'disabled';

export type RuntimeExecutionProfile = 'chat' | 'review' | 'code' | 'autonomous';

export interface RuntimeProtocolCapability {
  tier: RuntimeProtocolTier;
  streamFormat: RuntimeStreamFormat;
  promptDelivery: 'stdin' | 'arg' | 'jsonrpc';
  status: RuntimeCapabilityStatus;
  supports: {
    resume: boolean;
    explicitSessionId: boolean;
    toolEvents: boolean;
    permissionRequests: boolean;
    cancellation: boolean;
    structuredOutput: boolean;
  };
  fallbackReason?: string;
}

export interface RuntimeProfileCapability {
  allowsExternalWrites: boolean;
  requiresApproval: boolean;
  args: string[];
}

export interface RuntimeExecutorCapability {
  executorId: string;
  displayName: string;
  providerPrefixes: string[];
  defaultProtocolTier: RuntimeProtocolTier;
  protocols: RuntimeProtocolCapability[];
  baseArgs: string[];
  profiles: Record<RuntimeExecutionProfile, RuntimeProfileCapability>;
}

const dangerousArgPattern = /(?:--yolo|--force|--dangerously|bypassPermissions|bypass-approvals|skip-permissions)/i;

const safeProfiles: Record<RuntimeExecutionProfile, RuntimeProfileCapability> = {
  chat: { allowsExternalWrites: false, requiresApproval: false, args: [] },
  review: { allowsExternalWrites: false, requiresApproval: false, args: [] },
  code: { allowsExternalWrites: true, requiresApproval: true, args: [] },
  autonomous: { allowsExternalWrites: true, requiresApproval: true, args: ['<unsafe-profile-explicit>'] },
};

export const RUNTIME_EXECUTOR_CAPABILITIES: RuntimeExecutorCapability[] = [
  {
    executorId: 'cli:claude-code',
    displayName: 'Claude Code',
    providerPrefixes: ['cc', 'claude'],
    defaultProtocolTier: 'jsonl-headless',
    baseArgs: ['--print', '--output-format', 'stream-json', '--verbose'],
    profiles: safeProfiles,
    protocols: [
      {
        tier: 'jsonl-headless',
        streamFormat: 'claude-stream-json',
        promptDelivery: 'stdin',
        status: 'verified',
        // Verified by live two-turn resume harness 2026-05-10:
        // _artifacts/runtime-resume-harness/claude-2026-05-10T02-26-46-208Z.md
        // Turn 1 stored "47", turn 2 retrieved it via --resume <sessionId>.
        // Claude Code v2.1.131. Flags: --print --verbose --output-format stream-json --session-id <uuid> ; --resume <id>.
        supports: {
          resume: true,
          explicitSessionId: true,
          toolEvents: true,
          permissionRequests: true,
          cancellation: true,
          structuredOutput: true,
        },
      },
    ],
  },
  {
    executorId: 'cli:codex',
    displayName: 'Codex CLI',
    providerPrefixes: ['cx', 'codex'],
    defaultProtocolTier: 'jsonl-headless',
    baseArgs: ['exec'],
    profiles: safeProfiles,
    protocols: [
      {
        tier: 'jsonl-headless',
        streamFormat: 'codex-jsonl',
        promptDelivery: 'stdin',
        status: 'verified',
        // W3 — verified by live two-turn resume harness 2026-05-11:
        //   _artifacts/runtime-resume-harness/codex-2026-05-11T23-47-08-775Z.md
        // Turn 1 stored "47" with `codex exec --json --skip-git-repo-check`
        // (sessionId 019e196f...); turn 2 retrieved "47" via
        // `codex exec resume <id> --json --skip-git-repo-check`. codex-cli
        // 0.130.0. NOTE: `--ephemeral` MUST NOT be on turn 1 because
        // `exec resume` is a separate process that reads the on-disk rollout
        // under ~/.codex/sessions/; `--ephemeral` deletes it and resume
        // fails with "no rollout found for thread id ... (code -32600)".
        supports: {
          resume: true,
          explicitSessionId: true,
          toolEvents: true,
          permissionRequests: true,
          cancellation: true,
          structuredOutput: true,
        },
      },
      {
        tier: 'text-pty-fallback',
        streamFormat: 'plain-text',
        promptDelivery: 'stdin',
        status: 'verified',
        supports: {
          resume: false,
          explicitSessionId: false,
          toolEvents: false,
          permissionRequests: false,
          cancellation: true,
          structuredOutput: false,
        },
        fallbackReason: 'default Codex execution currently uses plain exec output',
      },
      {
        tier: 'app-server-jsonrpc',
        streamFormat: 'codex-jsonl',
        promptDelivery: 'jsonrpc',
        status: 'experimental',
        supports: {
          resume: true,
          explicitSessionId: true,
          toolEvents: true,
          permissionRequests: true,
          cancellation: true,
          structuredOutput: true,
        },
        fallbackReason: 'app-server requires live probe before production routing',
      },
    ],
  },
  {
    executorId: 'cli:gemini',
    displayName: 'Gemini CLI',
    providerPrefixes: ['gemini-cli', 'gemini'],
    defaultProtocolTier: 'text-pty-fallback',
    baseArgs: ['-p'],
    profiles: safeProfiles,
    protocols: [
      {
        tier: 'text-pty-fallback',
        streamFormat: 'gemini-text',
        promptDelivery: 'arg',
        status: 'verified',
        supports: {
          resume: false,
          explicitSessionId: false,
          toolEvents: false,
          permissionRequests: false,
          cancellation: true,
          structuredOutput: false,
        },
        fallbackReason: 'ACP support must be probed before marking structured',
      },
      {
        // Wave 2 Agent H — opt-in stream-json + resume tier. Status stays
        // experimental until Wave 3 verification. Capabilities reflect what
        // the captured sample at _artifacts/runtime-resume-harness/
        // gemini-stream-json-sample.txt confirms (gemini 0.41.2):
        //   resume:             VERIFIED via --resume <uuid>
        //   explicitSessionId:  VERIFIED via --session-id <uuid>
        //   toolEvents:         VERIFIED via type=tool_use NDJSON events
        //   permissionRequests: NOT exposed in stream-json (gemini handles
        //                       them via interactive flow; --yolo bypasses)
        //   cancellation:       SIGTERM works; tree-kill semantics same as
        //                       text-pty-fallback path
        //   structuredOutput:   VERIFIED — events have well-typed shapes
        //
        // Live two-turn proof recorded 2026-05-10 in worktree
        // agent-a883601ffabedf285: turn 1 stored "ARCANE-TURTLE-7" via
        // --output-format stream-json --session-id <uuid>; turn 2 recalled
        // via --resume <uuid>. defaultProtocolTier intentionally stays
        // text-pty-fallback — this tier flips on only when callers opt in
        // via opts.runtime.streamJson in src/executors/cli.ts.
        tier: 'jsonl-headless',
        streamFormat: 'gemini-stream-json',
        promptDelivery: 'arg',
        status: 'experimental',
        supports: {
          resume: true,
          explicitSessionId: true,
          toolEvents: true,
          permissionRequests: false,
          cancellation: true,
          structuredOutput: true,
        },
        fallbackReason: 'two-turn resume harness is opt-in; defaultProtocolTier stays text-pty-fallback until Wave 3 verifies in production',
      },
      {
        tier: 'acp-stdio',
        streamFormat: 'acp-jsonrpc',
        promptDelivery: 'jsonrpc',
        status: 'planned',
        supports: {
          resume: false,
          explicitSessionId: false,
          toolEvents: true,
          permissionRequests: true,
          cancellation: true,
          structuredOutput: true,
        },
      },
    ],
  },
  {
    executorId: 'cli:kimi',
    displayName: 'Kimi CLI',
    providerPrefixes: ['kimi', 'kmc', 'kmca', 'kimi-coding'],
    // defaultProtocolTier stays text-pty-fallback so existing callers keep
    // their behaviour. The new jsonl-headless tier below is opt-in via
    // opts.runtime.streamJson === true OR opts.runtime.nativeSessionId.
    defaultProtocolTier: 'text-pty-fallback',
    baseArgs: ['--print'],
    profiles: safeProfiles,
    protocols: [
      {
        tier: 'text-pty-fallback',
        streamFormat: 'kimi-text',
        promptDelivery: 'stdin',
        status: 'verified',
        supports: {
          resume: false,
          explicitSessionId: false,
          toolEvents: false,
          permissionRequests: false,
          cancellation: true,
          structuredOutput: false,
        },
        fallbackReason: 'jsonl-headless tier covers resume/structured output (opt-in)',
      },
      {
        // W3 — verified by live two-turn resume harness 2026-05-11:
        //   _artifacts/runtime-resume-harness/kimi-2026-05-11T23-56-34-837Z.md
        // Turn 1 stored "47" with
        //   kimi --print --input-format text --output-format stream-json
        //        -r <uuid> -w <cwd>
        // and turn 2 retrieved "47" via the same args (resume of the same
        // -r <uuid>). kimi-cli 1.34.0. Workspace boundary check: 0 files
        // created in cwd or REPO_ROOT/src — clean. The harness confirmed
        // stream-json events were parsed for both turns (`saw stream-json
        // events: yes`) and the assistant content shape is structured JSON
        // ({role, content[{type: 'think' | 'text', ...}]}).
        // NOTE: kimi `--print` mode implicitly enables --yolo server-side
        // per `kimi -h`; we never pass --yolo explicitly and rely on the
        // workspace boundary check inside cli.ts to catch out-of-scope writes.
        tier: 'jsonl-headless',
        streamFormat: 'kimi-stream-json',
        promptDelivery: 'stdin',
        status: 'verified',
        supports: {
          resume: true,
          explicitSessionId: true,
          toolEvents: true,
          permissionRequests: false,
          cancellation: true,
          structuredOutput: true,
        },
        fallbackReason: 'opt-in via opts.runtime.streamJson === true or opts.runtime.nativeSessionId',
      },
      {
        tier: 'acp-stdio',
        streamFormat: 'acp-jsonrpc',
        promptDelivery: 'jsonrpc',
        status: 'planned',
        supports: {
          resume: false,
          explicitSessionId: false,
          toolEvents: true,
          permissionRequests: true,
          cancellation: true,
          structuredOutput: true,
        },
      },
    ],
  },
  {
    executorId: 'cli:opencode',
    displayName: 'OpenCode',
    providerPrefixes: ['opencode', 'opencode-zen', 'kimi-for-coding', 'zai', 'deepseek', 'xiaomi'],
    defaultProtocolTier: 'text-pty-fallback',
    baseArgs: ['run'],
    profiles: safeProfiles,
    protocols: [
      {
        tier: 'text-pty-fallback',
        streamFormat: 'plain-text',
        promptDelivery: 'arg',
        status: 'verified',
        supports: {
          resume: false,
          explicitSessionId: false,
          toolEvents: false,
          permissionRequests: false,
          cancellation: true,
          structuredOutput: false,
        },
        fallbackReason: 'native ACP/server mode must be probed before production routing',
      },
      {
        // Phase 8 Wave E — opencode ACP stdio VERIFIED live 2026-05-10:
        //   _artifacts/runtime-resume-harness/opencode-acp-2026-05-10T05-46-40-054Z.md (probe)
        //   _artifacts/runtime-resume-harness/opencode-acp-smoke-2026-05-10T06-49-49-768Z.md (end-to-end smoke)
        //   verdict=PASS sessionId=ses_1ef5... 19 notifications + 4 responses
        // OpenCode v1.14.46. Lifecycle: initialize -> session/new -> session/prompt
        // -> session/update.* notifications -> session/close. Cancel via session/cancel
        // notification. Server-to-client `session/request_permission` bridged via
        // AcpAdapter.permissionHandler (default: cancelled-after-timeout).
        // session/end is WRONG name — opencode returns -32601; use session/close
        // (per agentCapabilities.sessionCapabilities.close).
        tier: 'acp-stdio',
        streamFormat: 'acp-jsonrpc',
        promptDelivery: 'jsonrpc',
        status: 'verified',
        supports: {
          resume: true,
          explicitSessionId: true,
          toolEvents: true,
          permissionRequests: true,
          cancellation: true,
          structuredOutput: true,
        },
      },
    ],
  },
  {
    executorId: 'cli:cursor',
    displayName: 'Cursor Agent',
    providerPrefixes: ['cursor'],
    defaultProtocolTier: 'jsonl-headless',
    baseArgs: ['-p', '--output-format', 'stream-json'],
    profiles: safeProfiles,
    protocols: [
      {
        // W3 round 3 — Example correction round 2 (2026-05-11): cursor-agent
        // supports flag-based resume with the `=` form (`--resume=<uuid>`,
        // single arg). The original W3 probe FAILED because it tried the
        // space-separated form (`--resume <uuid>`, two args). The `=` form
        // pins to a specific session, and stream-json emits the captured
        // session_id on every event (system.init lands within ~200ms).
        //
        // Live two-turn resume harness 2026-05-11 PASS (stream-json path):
        //   _artifacts/runtime-resume-harness/cursor-2026-05-11T-PASS.md
        //   cursor-agent 2026.05.05-84a231c. Turn 1 captured
        //   session_id=968a0371-... from system.init event. Turn 2 with
        //   `--resume=<sid>` returned "47" AND emitted the same session_id
        //   across all turn-2 events. Total wall-clock: 25s.
        //
        // This is full parity with Claude Code's headless mode:
        //   • structuredOutput (system/user/assistant/result events)
        //   • explicit session_id pin (no "latest chat" race)
        //   • toolEvents available via stream-json shape
        tier: 'jsonl-headless',
        streamFormat: 'cursor-stream-json',
        promptDelivery: 'arg',
        status: 'verified',
        supports: {
          resume: true,
          explicitSessionId: true,
          toolEvents: true,
          permissionRequests: true,
          cancellation: true,
          structuredOutput: true,
        },
      },
      {
        // Text-pty-fallback is kept as a backup for environments where
        // stream-json is undesirable (e.g. log noise). Resume still works
        // (cursor honours --resume=<uuid> regardless of output format) but
        // without structured events the executor has to scrape plain text.
        tier: 'text-pty-fallback',
        streamFormat: 'plain-text',
        promptDelivery: 'arg',
        status: 'verified',
        supports: {
          resume: true,
          explicitSessionId: true,
          toolEvents: false,
          permissionRequests: false,
          cancellation: true,
          structuredOutput: false,
        },
        fallbackReason: 'backup for stream-json-incompatible environments; jsonl-headless above is the primary',
      },
    ],
  },
];

export function listRuntimeExecutorCapabilities(): RuntimeExecutorCapability[] {
  return RUNTIME_EXECUTOR_CAPABILITIES.map((capability) => ({
    ...capability,
    protocols: capability.protocols.map((protocol) => ({ ...protocol, supports: { ...protocol.supports } })),
    profiles: {
      chat: { ...capability.profiles.chat, args: [...capability.profiles.chat.args] },
      review: { ...capability.profiles.review, args: [...capability.profiles.review.args] },
      code: { ...capability.profiles.code, args: [...capability.profiles.code.args] },
      autonomous: { ...capability.profiles.autonomous, args: [...capability.profiles.autonomous.args] },
    },
    baseArgs: [...capability.baseArgs],
    providerPrefixes: [...capability.providerPrefixes],
  }));
}

export function getRuntimeExecutorCapability(executorId: string): RuntimeExecutorCapability | undefined {
  return listRuntimeExecutorCapabilities().find((capability) => capability.executorId === executorId);
}

export function runtimeExecutorForModel(model: string | null | undefined): string | null {
  if (!model?.trim() || !model.includes('/')) return null;
  const provider = model.split('/')[0]?.toLowerCase();
  const capability = RUNTIME_EXECUTOR_CAPABILITIES.find((item) =>
    item.providerPrefixes.some((prefix) => prefix.toLowerCase() === provider),
  );
  return capability?.executorId ?? null;
}

export function dangerousArgsInBaseCapabilities(): Array<{ executorId: string; arg: string }> {
  const findings: Array<{ executorId: string; arg: string }> = [];
  for (const capability of RUNTIME_EXECUTOR_CAPABILITIES) {
    for (const arg of capability.baseArgs) {
      if (dangerousArgPattern.test(arg)) findings.push({ executorId: capability.executorId, arg });
    }
  }
  return findings;
}
