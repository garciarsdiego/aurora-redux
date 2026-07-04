# Aurora-Redux — Usage Guide

Aurora-Redux (npm package `omniforge`) is a personal, gateway-free engine for orchestrating
multi-agent LLM workflows. There is no external router/gateway process — a single dispatch
point in the code reads the **prefix of the model-id string** and picks one of three
transports. This guide covers installation, configuration, running workflows, the bundled
examples, using it as an MCP server from Claude Code, and troubleshooting.

It is a single-operator tool: no multi-tenant story, no hosted dashboard, no billing. If you
run it, you're the only user.

---

## 1. Install & build

Prerequisites:

- Node.js 22+
- `pnpm`
- At least **one** of: a direct provider API key (Kimi, MiniMax, or GLM) **or** a logged-in
  local CLI (`claude`, `codex`, and/or `agy`)
- `better-sqlite3` compiles a native module during install, so you need a working native
  toolchain (Windows: the standard `node-gyp` prerequisites — Visual Studio Build Tools with
  the "Desktop development with C++" workload, plus Python 3 — are normally already in place
  if you've built native Node modules before)

The steps below are Windows-first (PowerShell), since that's the primary development and
testing environment. The engine itself is cross-platform TypeScript; only the CLI-spawn layer
has been specifically hardened for Windows.

```powershell
# 1. Clone and enter the repo
git clone https://github.com/garciarsdiego/aurora-redux.git
cd aurora-redux

# 2. Install dependencies (compiles better-sqlite3)
pnpm install

# 3. Copy the example env file and fill in what you have
Copy-Item .env.example .env
notepad .env

# 4. Build
pnpm build

# 5. Smoke-test
node bin/omniforge run "summarize the open TODOs in this repo" -w internal --auto-approve
```

macOS / Linux — identical steps, just use your shell's equivalents:

```bash
git clone https://github.com/garciarsdiego/aurora-redux.git
cd aurora-redux
pnpm install
cp .env.example .env
$EDITOR .env
pnpm build
node bin/omniforge run "summarize the open TODOs in this repo" -w internal --auto-approve
```

`bin/omniforge` pins its own working directory to the repo root regardless of who spawns it
(relevant if a host like an MCP client spawns it from an unrelated directory), so you can
invoke it with an absolute path from anywhere once it's built.

You need **at least one** working transport for anything to actually run:

- one of `KIMI_API_KEY` / `MINIMAX_API_KEY` / `GLM_API_KEY` filled in, **or**
- `claude`, `codex`, or `agy` (Antigravity CLI) already logged in on the machine.

---

## 2. Configuration

Everything is driven by `.env` in the repo root (see `.env.example` for the canonical,
commented version). This section explains every knob in detail.

### 2.1 Bootstrap flags

| Variable | Default | Purpose |
|---|---|---|
| `OMNIFORGE_SKIP_MODEL_VALIDATION` | — | Set `true`. Lets the daemon/CLI boot without contacting an external model-catalog service. Required for the gateway-free setup described in this repo. |
| `OMNIFORGE_USE_PERSONAS` | `true` in code; `.env.example` sets `false` | Keep `false` for the direct/CLI transports documented here (the simple legacy code path). |
| `CLI_SAFE_MODE` | `false` | `cli_spawn` agents need write/exec access to do real work. Set `true` only if you want to sandbox them to read-only. |

### 2.2 The model-id prefix system (the core mechanism)

Every model-id Aurora-Redux is asked to use is a string, and the **prefix of that string**
is the single chokepoint that decides which of three transports handles the call. There is
no separate "provider" config field to keep in sync — the prefix *is* the routing decision.

| Prefix | Transport | Example model-id | Endpoint | Auth | Notes |
|---|---|---|---|---|---|
| `kimi/` | Direct OpenAI-compatible API | `kimi/kimi-for-coding` | `https://api.kimi.com/coding/v1` (override: `KIMI_BASE_URL`) | `KIMI_API_KEY` | "For coding" plan — one fixed model per subscription. |
| `minimax/` | Direct OpenAI-compatible API | `minimax/MiniMax-M3` | `https://api.minimax.io/v1` (override: `MINIMAX_BASE_URL`) | `MINIMAX_API_KEY` | Same shape as Kimi. |
| `glm/` | Direct OpenAI-compatible API | `glm/glm-5.2` | `https://api.z.ai/api/coding/paas/v4` (override: `GLM_BASE_URL`) | `GLM_API_KEY` | Same shape as Kimi/MiniMax. |
| `claude-cli/` | Local CLI subscription | `claude-cli/` | n/a — spawns `claude --print` locally | Your existing `claude` OAuth session | Prompt delivered via stdin. Marginal cost $0 per call (subscription, not metered API). |
| `codex-cli/<model>` | Local CLI subscription | `codex-cli/gpt-5.5` | n/a — spawns `codex exec` locally | Your existing `codex` OAuth session | Prompt delivered via stdin. `<model>` after the prefix is passed straight through to `codex exec`. |
| *(no model-id — `executor_hint` instead)* | `cli_spawn` agent | `executor_hint: "cli:claude"` \| `"cli:codex"` \| `"cli:gemini"` | n/a — full CLI agent in an isolated **git worktree** | Same OAuth sessions as above; `cli:gemini` drives the Antigravity CLI (`agy`, the successor to `gemini-cli`, which was retired 2026-06-18) | The agent doesn't just answer a prompt — it writes files and runs commands itself, isolated in its own worktree. |

Both direct-API and CLI transports normalize reasoning output the same way downstream
(`reasoning_content` fields and inline `<think>...</think>` blocks are both handled), so a
task's prompt/response handling never needs to know which transport actually served it.

Direct providers share one more knob:

| Variable | Default | Purpose |
|---|---|---|
| `DIRECT_PROVIDER_MAX_TOKENS` | `32000` | Reasoning models spend part of their token budget on hidden thinking before the visible answer — keep this generous or you'll truncate the real output. |

### 2.3 The four roles

Aurora-Redux assigns work to four **roles**. Each role is just an env var whose value is a
model-id — so the prefix system above is exactly how you choose that role's transport.

| Role | Env var | Default | What it does |
|---|---|---|---|
| Decomposer | `DECOMPOSER_MODEL` | `claude-cli/` | Turns a natural-language objective into a task DAG. Runs once per `run` invocation (skipped by `run-dag`, since you're supplying the DAG yourself). |
| Reviewer | `REVIEWER_MODEL` | `codex-cli/gpt-5.5` | Fires automatically on every task that has `acceptance_criteria` set. Judges hard success/failure and triggers a refine loop on failure. Strong but slow — a Codex-backed review can take minutes. |
| Task | `TASK_MODEL` | `kimi/kimi-for-coding` | The default model for `llm_call` tasks that don't set their own `model` field. |
| Consolidator | `CONSOLIDATOR_MODEL` | `glm/glm-5.2` | Used to merge/consolidate results, e.g. the final step of a consensus fan-out. Benefits from a large context window. |

**Swapping a role** just means changing the env var to a different prefixed model-id, e.g.:

```dotenv
# Use GLM instead of Kimi for the default task model
TASK_MODEL=glm/glm-5.2

# Move the reviewer off Codex onto the Claude CLI (decomposer stays at its default)
DECOMPOSER_MODEL=claude-cli/
REVIEWER_MODEL=claude-cli/
```

**Reviewer fallback in practice**: `REVIEWER_MODEL=codex-cli/gpt-5.5` is strong but the
slowest option (real-world reviews can take several minutes, since it's a full `codex exec`
process per review). If that bottlenecks your workflow, switch to one of:

```dotenv
REVIEWER_MODEL=glm/glm-5.2       # direct API, fast, no local CLI process spawn
# or
REVIEWER_MODEL=claude-cli/       # still a CLI spawn, but usually faster than codex exec
```

Also raise/lower the review timeout to match your chosen reviewer:

```dotenv
MAX_REVIEW_TIME_MS=600000   # 10 minutes — generous default for the Codex reviewer
```

Per-task overrides: any task in a DAG can set its own `"model"` field, which overrides
`TASK_MODEL` for that task only (see the DAG format in section 3).

### 2.4 Other timeouts and optional integrations

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_CLI_TIMEOUT_MS` | 180000 | Max time to wait on a single `claude --print` call. |
| `CODEX_CLI_TIMEOUT_MS` | 600000 | Max time to wait on a single `codex exec` call. |
| `OMNIROUTE_URL` / `OMNIROUTE_API_KEY` | unset | Legacy external router fallback. Left blank on purpose — Aurora-Redux does **not** require it. Only relevant if you're intentionally reintroducing a gateway. |
| `OMNIROUTE_MAX_RETRIES` | `0` | Retry count if `OMNIROUTE_URL` is set. |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | unset | Optional — routes HITL approval gates to a Telegram chat instead of (or in addition to) the CLI prompt. |

---

## 3. Running workflows

There are three ways to drive the engine: `run` (decompose + execute in one shot), `run-dag`
(execute an explicit DAG you already have), and the MCP server (drive it programmatically
from Claude Code or another MCP-capable harness).

### 3.1 `run` — decompose and execute

```bash
node bin/omniforge run "<objective in plain language>" -w internal --auto-approve
```

- `-w, --workspace <name>` (required) — logical workspace name; used for pattern storage,
  per-workspace `.env` overlays, and DB scoping. `internal` is a reasonable default for
  personal use.
- `--auto-approve` — bypass all HITL gates automatically. Omit this if you want to be
  prompted at each gate instead.
- `--no-pattern` — skip pattern matching and force a fresh DAG generation (by default, `run`
  checks if a similar objective already has a saved pattern and reuses it).

Under the hood: the objective string is sent to `DECOMPOSER_MODEL`, which returns a DAG; the
DAG is validated, persisted, and executed by the scheduler exactly like `run-dag` would.

If a workflow for the same objective/workspace is already `executing`, `run` detects it and
resumes it instead of starting a duplicate.

### 3.2 `run-dag` — execute an explicit DAG

```bash
node bin/omniforge run-dag <file.json|.yaml> -w internal --auto-approve
```

Extra flags:

- `--plan` — print a summary (task count, kinds breakdown, per-task table) and prompt Y/N
  before executing. Good for a dry-run/sanity check.
- `--edit` — open the file in `$EDITOR` (or a sane default: notepad on Windows, nano
  elsewhere) before validating and running. `--editor <cmd>` overrides the editor command.
- Combine both: `--edit --plan` to tweak, review, then confirm.

`run-dag` skips decomposition entirely — the file itself is the plan. Use it whenever you
already have (or are hand-writing / generating) a concrete task graph, or to replay one of
the bundled examples.

### 3.3 DAG file format

A DAG file is JSON or YAML with a single top-level `tasks` array. Each task is validated
against a Zod schema before anything runs. The fields you'll use in practice:

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Unique string id for this task within the DAG. |
| `name` | yes | The task's prompt/instruction (for `llm_call`, `cli_spawn`) or a human label. |
| `kind` | yes | One of: `llm_call`, `cli_spawn`, `tool_call`, `pal_call`, plus deterministic kinds (`if_else`, `switch`, `extract_json`, `print`, `loop`, `merge`, `transform`, `evaluator`). Most everyday workflows only need `llm_call` and `cli_spawn`. |
| `depends_on` | yes (can be `[]`) | Array of task `id`s that must complete before this one starts. Empty array = no dependencies, eligible to run immediately. Tasks with disjoint dependencies run in parallel. |
| `model` | no | Per-task model-id override (prefix picks the transport). If omitted, `llm_call` tasks fall back to `TASK_MODEL`. |
| `executor_hint` | no | Used by `cli_spawn` tasks: `"cli:claude"`, `"cli:codex"`, or `"cli:gemini"` — which full agent CLI executes this task in its own isolated git worktree. |
| `acceptance_criteria` | no | Free-text description of what counts as success. **Setting this field is what auto-triggers the reviewer** (`REVIEWER_MODEL`) against this task's output, with a refine loop on failure. |

A minimal, commented example (two parallel tasks feeding a third):

```json
{
  "tasks": [
    {
      "id": "t1",
      "name": "In one sentence, explain what a DAG scheduler does.",
      "kind": "llm_call",
      "depends_on": [],
      "model": "kimi/kimi-for-coding"
    },
    {
      "id": "t2",
      "name": "In one sentence, explain what a reviewer/refine loop does.",
      "kind": "llm_call",
      "depends_on": [],
      "model": "glm/glm-5.2"
    },
    {
      "id": "t3",
      "name": "Combine the two previous explanations into one short paragraph.",
      "kind": "llm_call",
      "depends_on": ["t1", "t2"],
      "model": "glm/glm-5.2"
    }
  ]
}
```

`t1` and `t2` have no dependencies, so the scheduler runs them in parallel; `t3` depends on
both and automatically receives their outputs as upstream context once they complete.

There are many more optional fields (routing constraints, HITL gates, vault I/O, cost caps,
loop/switch control flow, etc.) — see `src/types/schemas.ts` (`DagTaskSchema`) in the repo
for the full, authoritative field list if you need anything beyond the everyday subset above.

### 3.4 MCP server

See section 5 below — the same `run`/`run-dag` capabilities are exposed as MCP tools so you
can drive Aurora-Redux from inside Claude Code instead of a terminal.

---

## 4. Walkthrough: the bundled examples

All four files in `examples/` run as-is once you've built the project and have at least one
of the required providers/CLIs available.

### `01-decompose-and-run.txt`

A plain-language objective, meant to be passed to `run` (not `run-dag`) so you see the full
decompose-then-execute path:

```
Compute (387*92+1241) and print exactly 'Final value: <number>'
```

Run it:

```bash
node bin/omniforge run "$(cat examples/01-decompose-and-run.txt)" -w internal --auto-approve
```

What to expect: the decomposer (`DECOMPOSER_MODEL`, default the Claude CLI) turns this into a
small DAG (typically one or two `llm_call`/`tool_call` tasks), the scheduler executes it, and
the final output should contain the literal string `Final value: 36885` (i.e. `387*92+1241`).
This is a good first smoke test because the expected output is deterministic and easy to
eyeball.

### `02-consensus-3-providers.json`

Fan-out across three direct providers in parallel, then consolidate:

```bash
node bin/omniforge run-dag examples/02-consensus-3-providers.json -w internal --auto-approve
```

What to expect: three `llm_call` tasks (`t1` on `kimi/kimi-for-coding`, `t2` on
`minimax/MiniMax-M3`, `t3` on `glm/glm-5.2`) each evaluate a different HTTP caching strategy
in one sentence, running concurrently since none of them depend on each other. A fourth task
(`t4`, depends on all three, model `glm/glm-5.2`) consolidates the three answers into one
recommendation. Requires all three of `KIMI_API_KEY`, `MINIMAX_API_KEY`, and `GLM_API_KEY` to
be set — if one is missing, that provider's task fails fast with an error naming the env var
and the workflow stops as failed. There is no silent fallback to another provider.

### `03-auto-review.json`

A single task with `acceptance_criteria`, demonstrating the automatic reviewer:

```bash
node bin/omniforge run-dag examples/03-auto-review.json -w internal --auto-approve
```

What to expect: `t1` asks GLM to recommend one HTTP caching strategy (ETag vs. `Cache-Control
max-age` vs. stale-while-revalidate) and justify the choice. Because `acceptance_criteria` is
set ("must recommend ONE specific strategy... must not merely list all three"), the
`REVIEWER_MODEL` automatically evaluates the output against that criteria after the task
completes. If the model waffles and lists all three without choosing, the reviewer marks it a
soft/hard failure and the executor kicks off a refine loop; if it commits to one strategy with
a justification, the task is marked passed. Expect this example to take noticeably longer than
`02` if `REVIEWER_MODEL` is still the Codex default — that's the reviewer running, not a hang.

### `04-cli-spawn-agent.json`

Delegates to a full CLI coding agent in an isolated git worktree:

```bash
node bin/omniforge run-dag examples/04-cli-spawn-agent.json -w internal --auto-approve
```

What to expect: `t1` is a `kind: "cli_spawn"` task with `executor_hint: "cli:gemini"`, asking
the agent to create `hello-redux.txt` containing the line `aurora-redux works`. The Antigravity
CLI (`agy`) is spawned as a real coding agent inside its own isolated git worktree (not the
repo you're standing in) and actually writes the file there — this is the difference between
`cli_spawn` and a plain `llm_call`: the agent performs file/command side effects itself.
Requires `agy` to be logged in. Edit `executor_hint` to `"cli:claude"` or `"cli:codex"` to try
the same task with a different agent (both need their respective CLI logged in).

---

## 5. Using Aurora-Redux from Claude Code (MCP)

Aurora-Redux ships an MCP server over stdio, exposing tools prefixed `omniforge_*`. Register
it once:

```bash
claude mcp add aurora-redux --scope user -- node <path-to-repo>/bin/omniforge mcp-server
```

Replace `<path-to-repo>` with the absolute path to your clone, e.g. on Windows:

```powershell
claude mcp add aurora-redux --scope user -- node C:\path\to\aurora-redux\bin\omniforge mcp-server
```

Once registered, Claude Code can call the Aurora-Redux tools directly instead of you running
CLI commands by hand. The two you'll use most:

- **`omniforge_plan_workflow`** — decomposes an objective into a DAG and returns the plan
  *without executing it*. Use this first when you want to see (or have Claude Code show you)
  the plan before anything runs. Key inputs: `workspace` (string), `objective` (string).
  Returns a task list plus `dag_json`.
- **`omniforge_run_workflow`** — actually executes a workflow. Key inputs: `workspace`,
  `objective`, `auto_approve` (boolean), and optionally `precomputed_dag` (pass the
  `dag_json` you got back from `omniforge_plan_workflow` to skip re-decomposition). Returns
  `workflow_id`, `status`, and task count.

Other useful tools exposed the same way: `omniforge_get_workflow_status` (poll a running
workflow), `omniforge_approve_gate` (resolve a HITL gate), `omniforge_list_workflows`,
`omniforge_list_models`, `omniforge_list_patterns` / `omniforge_save_pattern`. All tool names
and their input schemas are defined in `src/mcp/server.ts` if you need the exhaustive list.

Because this is a stdio MCP server, it starts and stops with the Claude Code session that
uses it — there's no separate daemon process required for this path (see section 6 for the
optional standalone HTTP daemon instead).

---

## 6. Troubleshooting

**Daemon (`omniforge daemon start`) won't come up / immediately exits.**
Make sure `OMNIFORGE_SKIP_MODEL_VALIDATION=true` is set in `.env`. Without it, boot tries to
reach an external model-catalog service that this gateway-free setup doesn't run. This is the
single most common first-run failure.

**Reviewer is slow / workflow seems to hang for minutes on a task with `acceptance_criteria`.**
That's expected if `REVIEWER_MODEL=codex-cli/gpt-5.5` (the default) — a Codex-backed review
spawns a real `codex exec` process and can genuinely take minutes. It is not a hang. If it's
bottlenecking your workflow, switch the reviewer:

```dotenv
REVIEWER_MODEL=glm/glm-5.2
# or
REVIEWER_MODEL=claude-cli/
```

and adjust `MAX_REVIEW_TIME_MS` down if you no longer need the generous default.

**A provider key is missing.**
If a task's model-id prefix is `kimi/`, `minimax/`, or `glm/` and the matching `*_API_KEY` is
empty, the task fails fast with an error naming the exact env var (e.g. `KIMI_API_KEY not set
— required for direct provider 'kimi'`) — it does not silently fall back to another provider,
and the first failed task stops the workflow. Fix by filling in the corresponding key
in `.env`, or by pointing `TASK_MODEL`/the task's `model` field at a transport you do have
configured.

**Gemini (`cli:gemini` / `executor_hint`) tasks fail immediately.**
Gemini is only reachable as a `cli_spawn` agent via the Antigravity CLI (`agy`), the successor
to the retired `gemini-cli`. Confirm `agy` is installed and logged in on this machine —
Aurora-Redux does not manage that login for you. Note also that `agy` cannot be used as a
brain-role transport (`DECOMPOSER_MODEL` / `REVIEWER_MODEL` / etc.) because it takes its
prompt as a CLI argument rather than reading stdin, which risks exceeding Windows' command-
line length limit for large prompts — that's a deliberate scope limit, not a bug.

**CLI transports (`claude-cli/`, `codex-cli/`, `cli_spawn`) time out.**
Raise `CLAUDE_CLI_TIMEOUT_MS` / `CODEX_CLI_TIMEOUT_MS` in `.env` if your machine or the
underlying CLI is consistently slower than the defaults (180s / 600s respectively).

**Nothing happens at all / every task fails.**
Confirm you have at least one working transport: one filled-in `*_API_KEY`, or `claude` /
`codex` / `agy` logged in and reachable from a plain terminal (test each CLI directly outside
Aurora-Redux first — if `claude --print "hi"` doesn't work standalone, it won't work here
either).

**The HTTP daemon's default port (`:20129`) is already in use.**
Stop whatever else is bound to it, or check `omniforge daemon status` for the current PID
before starting a second instance — the daemon writes a PID file under `data/daemon.pid` and
refuses to double-start against the same data directory.
