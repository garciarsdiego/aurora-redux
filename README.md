# Aurora-Redux

A personal, gateway-free engine for orchestrating multi-agent LLM workflows — decompose a goal into a DAG, run it across whatever mix of direct APIs and CLI subscriptions you have, with consensus, automatic review, and human-in-the-loop gates built in.

## What it is

Aurora-Redux (npm package `omniforge`) is a reworked, "Redux" version of a larger internal engine (codename `H2`, ~100K lines of TypeScript). The rework strips out the external gateway/router service that engine used to depend on and collapses provider selection into a single chokepoint: the **prefix of the model-id**. Everything else — the DAG scheduler, the reviewer, consensus fan-out, HITL gates, the SQLite event log — is the same machinery, just running 100% locally.

This is a single-operator tool built for one person's own workflows, not a SaaS product or a general-purpose framework. There's no multi-tenant story, no hosted dashboard, no billing. If you run it, you're the only user.

## How it routes

There is no router process. A single dispatch point in the code inspects the model-id string and picks one of three transports based on its prefix:

| Prefix | Transport | Example model-id | Notes |
|---|---|---|---|
| `kimi/` | Direct OpenAI-compatible API → `api.kimi.com/coding/v1` | `kimi/kimi-for-coding` | Key: `KIMI_API_KEY` |
| `minimax/` | Direct OpenAI-compatible API → `api.minimax.io/v1` | `minimax/MiniMax-M3` | Key: `MINIMAX_API_KEY` |
| `glm/` | Direct OpenAI-compatible API → `api.z.ai/api/coding/paas/v4` | `glm/glm-5.2` | Key: `GLM_API_KEY` |
| `claude-cli/` | Spawns `claude --print` (local CLI, prompt via stdin) | `claude-cli/` | Uses your Claude Code OAuth session, no per-token API cost |
| `codex-cli/<model>` | Spawns `codex exec` (local CLI, prompt via stdin) | `codex-cli/gpt-5.5` | Uses your Codex OAuth session |
| *(cli_spawn agent)* | Delegates to a full CLI agent in an isolated git worktree | `executor_hint: cli:claude` \| `cli:codex` \| `cli:gemini` | Agent writes files / runs commands itself; `cli:gemini` drives the Antigravity CLI (`agy`) |

Direct APIs and CLI transports both handle reasoning output (`reasoning_content` fields and inline `<think>` blocks) the same way downstream, so a task's prompt/response handling doesn't need to know which transport served it.

## Quick start

Prerequisites: Node 22+, `pnpm`, and either at least one provider API key or at least one CLI already logged in (`claude`, `codex`, and/or `agy`). `better-sqlite3` compiles a native module on install.

```bash
pnpm install
cp .env.example .env
# edit .env: fill in whichever of KIMI_API_KEY / MINIMAX_API_KEY / GLM_API_KEY you have,
# and/or make sure `claude` / `codex` / `agy` are logged in on this machine
pnpm build
node bin/omniforge run "summarize the open TODOs in this repo" -w internal --auto-approve
```

Other entry points:

```bash
node bin/omniforge run-dag examples/02-consensus-3-providers.json -w internal --auto-approve
node bin/omniforge daemon start|stop|status|restart   # HTTP MCP daemon on :20129
node bin/omniforge mcp-server                          # stdio MCP server
```

To use it as an MCP server from inside Claude Code itself:

```bash
claude mcp add aurora-redux --scope user -- node <path-to-repo>/bin/omniforge mcp-server
```

The full guide — configuration reference, DAG file format, example walkthroughs, MCP tools, troubleshooting — is in [docs/USAGE.md](docs/USAGE.md).

## What it can do

Everything below has been verified end-to-end, with the resulting workflow's evidence checkable in the SQLite event log:

- Decompose a natural-language goal into a dependency DAG (via the Claude CLI).
- Execute a DAG with a parallel scheduler that respects `depends_on` and carries upstream task outputs into downstream inputs.
- Run consensus workflows: fan out the same request as N parallel `llm_call` tasks across different providers, then consolidate the results with a separate model.
- Auto-review: any task with `acceptance_criteria` triggers an LLM-judged hard success/failure evaluation, with an automatic refine loop on failure.
- Human-in-the-loop approval gates over CLI or Telegram, auto-approvable via config.
- `cli_spawn`: delegate a task to `claude`, `codex`, or `gemini` (via `agy`) as a full agent working in its own isolated git worktree — it can write files and run commands, not just return text.
- Append-only SQLite (WAL mode) event log for every workflow run, with per-call token tracking (and USD cost accounting for the direct-API transports).
- An MCP server (stdio) exposing `omniforge_*` tools, so the engine can be driven from inside Claude Code or any other MCP-capable harness.

## Examples

See `examples/` — all of these run as-is:

- `01-decompose-and-run.txt` — a plain-language goal; run it with `node bin/omniforge run` to see decomposition + execution.
- `02-consensus-3-providers.json` — Kimi + MiniMax + GLM fan out in parallel, consolidated by GLM; run with `node bin/omniforge run-dag`.
- `03-auto-review.json` — a single task with `acceptance_criteria` that triggers the automatic reviewer; run with `node bin/omniforge run-dag`.
- `04-cli-spawn-agent.json` — a `cli_spawn` agent (Gemini via `agy`) writing a file inside an isolated worktree; run with `node bin/omniforge run-dag`.

Each example's exact command and expected output are covered step-by-step in [docs/USAGE.md](docs/USAGE.md#4-walkthrough-the-bundled-examples).

## Configuration

Four roles drive most of the behavior, set in `.env` (prefix picks the transport for each):

- `DECOMPOSER_MODEL` — turns a goal into a DAG. Default: `claude-cli/`.
- `REVIEWER_MODEL` — judges acceptance criteria. Default: `codex-cli/gpt-5.5` (strong, slow; fall back to `glm/glm-5.2` or `claude-cli/` if it bottlenecks).
- `TASK_MODEL` — default model for `llm_call` tasks. Default: `kimi/kimi-for-coding`.
- `CONSOLIDATOR_MODEL` — merges consensus/fan-out results. Default: `glm/glm-5.2`.

See `.env.example` for the full list of options (timeouts, safe mode, Telegram HITL, etc.) and `docs/USAGE.md` for the complete configuration reference.

## Status & limitations

This is a single-operator tool, not a product — there is no multi-tenant support and no hosted service. Some honest caveats:

- The direct-API providers are "for coding" plans: each is a single fixed model per subscription, not a menu of models.
- USD cost is not tracked for the subscription-based CLI transports (token counts are); only the direct-API transports have real cost accounting.
- The Codex-backed reviewer is slow — reviews can take minutes.
- Gemini is only reachable as a `cli_spawn` agent. The `agy` CLI takes its prompt as a command-line argument rather than reading stdin, so it can't be used as a "brain role" transport — a large brain-role prompt would risk exceeding Windows' argument-length limit.
- Developed and tested on Windows 11. The engine itself is cross-platform TypeScript, but CLI-spawning has specifically been hardened for Windows.

## License

MIT
