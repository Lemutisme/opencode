# procontract-agent: a headless ProContract coding agent

`procontract-agent` runs one native V2 OpenCode session under the ProContract delivery discipline and exits. It is
built for external orchestrators (for example Dune's `cli_agent_worker`) that spawn coding agents the way they
spawn Claude Code or Codex: one process per session, a prompt in, JSON lines out.

The contract is scoped to that one run. The agent may not end the run while delivery is open: when the session
stops without a delivery, the agent is prompted to continue, up to `max_continuations`. A run ends delivered,
finished, blocked, pending (a submission the orchestrator is still running), or still open. "Delivered" means the declared preflight checks passed and the orchestrator
accepted the submission; it is never proof of correctness. The orchestrator's own verifier stays the judge. There
is no issuer, ledger, or attestation in this process.

## Command line

```
procontract-agent run    --config FILE [--prompt-file FILE] [-- PROMPT]
procontract-agent resume --config FILE --session ID [--prompt-file FILE] [-- PROMPT]
procontract-agent --version
```

- Exactly one of `--prompt-file` or a prompt after `--` is required. Use a file for prompts over 100 KiB.
- `resume` continues an earlier session of the same state directory with a new prompt. Each process invocation is
  one delivery obligation: delivery starts `open` on every `run` and `resume`.
- stdin is not read. stdout carries only the JSON lines below; diagnostics go to stderr.

## Config file

JSON, written by the orchestrator. Unknown keys are rejected.

```json
{
  "workspace": "/workspace",
  "state": "/opt/agent-home/.procontract",
  "system_prompt": "optional text appended to every prompt of this process",
  "deadline_seconds": 21600,
  "model": {
    "api": "openai-responses",
    "base_url": "http://proxy:4000/v1",
    "api_key_env": "OPENAI_API_KEY",
    "id": "gpt-5.6",
    "reasoning_effort": "high",
    "context": 272000,
    "output": 128000
  },
  "mcp": {
    "dune": {
      "url": "http://127.0.0.1:41234/mcp",
      "bearer_token_env": "DUNE_MCP_TOKEN",
      "timeout_seconds": 3300
    }
  },
  "tools": ["glob", "grep", "read", "patch", "edit", "write", "shell"],
  "delivery": {
    "submit_tools": ["dune_submit_candidate", "dune_commit_candidate"],
    "finish_tools": ["dune_finish"],
    "checks": [{ "title": "smoke test", "argv": ["bash", "-lc", "pytest -q tests/smoke"], "timeout_seconds": 600 }],
    "max_continuations": 10,
    "pending": { "status": "still_running", "id": "job_id", "wait_tools": ["dune_wait_job"] }
  }
}
```

| Key                             | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `workspace`                     | Absolute path. Session location, cwd of checks and of the `shell` tool.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `state`                         | Absolute path for the session database (`session.sqlite`), config, and `usage-<session>.json`. Reused by `resume`.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `system_prompt`                 | Optional. Appended after the delivery instructions of every prompt.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `deadline_seconds`              | Optional wall-clock limit for this process. Default: none (the orchestrator owns timeouts).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `model.api`                     | `openai-responses`, `openai-chat` (Chat Completions), or `anthropic-messages`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `model.base_url`                | The API's base URL with its version segment: requests go to `<base_url>/responses`, `/chat/completions` or `/messages`, e.g. `<proxy>/v1` or `<proxy>/anthropic/v1`.                                                                                                                                                                                                                                                                                                                                                                                                           |
| `model.api_key_env`             | Name of the environment variable holding the key. The key never appears in files.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `model.id`                      | Model name as the endpoint knows it. The only model the session can use.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `model.reasoning_effort`        | Optional. Sent as the provider's reasoning effort.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `model.context`, `model.output` | Optional token limits. Defaults: 200000 and 32000.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `mcp.<server>`                  | Optional. Remote (Streamable HTTP) MCP servers. Their tools appear as `<server>_<tool>`. `bearer_token_env` names an env var sent as `Authorization: Bearer`. `timeout_seconds` bounds one call (default 3300).                                                                                                                                                                                                                                                                                                                                                                |
| `tools`                         | Optional built-in tools to keep. Default: `glob`, `grep`, `read`, `patch`, `edit`, `write`, `shell` (OpenCode offers `patch` to GPT models and `edit`/`write` to the others). Web, subagent and Code Mode tools are never admitted.                                                                                                                                                                                                                                                                                                                                            |
| `delivery.submit_tools`         | Effective tool names whose successful call is the delivery. The checks run first; if any fails, the call is rejected before it reaches the server and the agent sees the failures. Empty: the agent delivers with `contract_delivery(action="handoff")` after the checks pass.                                                                                                                                                                                                                                                                                                 |
| `delivery.finish_tools`         | Effective tool names whose successful call ends the obligation without a delivery (`finished`), e.g. an orchestrator's "stop iterating" tool.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `delivery.checks`               | Optional public preflight checks: argv run in `workspace`, exit 0 passes. `PROCONTRACT_SUBMIT_INPUT` holds the submit call's JSON input (or `{}`).                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `delivery.max_continuations`    | Times the agent is prompted to continue after stopping with delivery open. Default 10.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `delivery.pending`              | Optional, for orchestrators whose long calls answer "still running". A submit whose JSON result has `status` equal to `pending.status` leaves delivery `pending` on that result's `pending.id` value. A wait tool (`wait_tools`) called with the same value in its `pending.id` argument completes it with a finished result, reopens it on a tool error (a later successful wait on the same id still delivers), and keeps it pending on another "still running". Waits on other ids are ignored. While pending, a resubmission is refused and an idle agent is told to wait. |

The agent also gets one tool, `contract_delivery`, with actions `status`, `check` (run the checks now), `blocked`
(with a concrete `reason`; ends the run), and `handoff` (with `summary`; only when `submit_tools` is empty).

## Output: JSON lines on stdout

| `type`         | Fields                                                                                                                                                                                                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session`      | `session_id`, `resumed`, `version`, `model`                                                                                                                                                                                                                             |
| `text`         | `text`: one finished assistant text block                                                                                                                                                                                                                               |
| `reasoning`    | `text`: one finished reasoning block                                                                                                                                                                                                                                    |
| `tool_call`    | `id`, `name`, `input`                                                                                                                                                                                                                                                   |
| `tool_result`  | `id`, `name`, `ok`, `output` (text, at most 64 KiB)                                                                                                                                                                                                                     |
| `usage`        | `source` (`step`, `title`, `compaction`), `tokens` {`input`, `output`, `reasoning`, `cache_read`, `cache_write`}, `cost_usd` (always `null`: no prices are configured; the orchestrator's model proxy knows the spend)                                                  |
| `delivery`     | `state` (`open`, `pending`, `delivered`, `finished`, `blocked`), optional `reason`, `job` (while pending), `checks` [{`title`, `passed`, `detail`}]                                                                                                                     |
| `continuation` | `count`: the agent was prompted to continue                                                                                                                                                                                                                             |
| `error`        | `message`                                                                                                                                                                                                                                                               |
| `result`       | Last line. `session_id`, `delivery` {`state`, `reason`?, `job`?}, `final_text`, `usage` {`tokens` (totals, same keys as a `usage` line), `cost_usd`}, `exit`, and `ended` (`terminated`, `interrupted`, `deadline reached`) when a signal or the deadline ended the run |

`<state>/usage-<session_id>.json` holds the same totals as `result.usage`, rewritten after every `usage` line, so
an orchestrator that kills the process still finds them. Totals cover this process (one `run` or `resume`), not the
session's earlier history. A step reports its usage when it ends, after its tool calls settle: an orchestrator that
kills the process the moment a submit tool answers may miss that last step's tokens.

## Exit status

| Code | Meaning                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------- |
| 0    | The run ended: `delivered`, `finished`, `blocked`, or `open`/`pending` after `max_continuations`. |
| 1    | Execution failed (model or runtime error).                                                        |
| 2    | Invalid command line or config.                                                                   |
| 124  | `deadline_seconds` reached.                                                                       |
| 143  | SIGTERM or SIGINT: the session was interrupted cleanly, the `result` line written.                |

On SIGTERM the session is interrupted (which releases its execution claim, so `resume` never replays the
interrupted turn) before the process exits. After a hard kill the claim survives; on start the agent interrupts every
session the host's startup recovery resumed before it prompts, which is best effort rather than a guarantee.

The delivery state is this process's view. An orchestrator that ends the process as soon as it has answered a
submission (Dune does) can leave the last `delivery`/`result` line one step behind; the orchestrator's own record of
the submission is authoritative.

## Known limitations

- Subagents are not admitted, and only one model is configured per run.
- `model.context` and `model.output` default to 200000 and 32000 tokens unless the orchestrator sets them.

## Network

The variables named by `model.api_key_env` and `mcp.*.bearer_token_env` are removed from the environment before
any command runs, so neither the `shell` tool nor the checks can read them. Only the model endpoint and the
configured MCP servers are contacted. Model catalog fetches, local model
discovery, auto-update, LSP downloads and file watching are off. `rg` must be on `PATH`. HTTP(S) proxies follow
`HTTPS_PROXY`/`NO_PROXY`. Before the first prompt the agent connects every configured MCP server and waits (up to
60 s) for its tools; a server that fails or exposes no tools ends the run with exit status 1. OpenCode keeps its
own files under `$HOME` (`~/.local/share/opencode`, `~/.cache/opencode`).

## Release artifacts

`procontract-agent-linux-x86_64` (x64 baseline, no AVX2 requirement) and `procontract-agent-linux-aarch64`,
glibc, single-file Bun executables, with `SHA256SUMS`, published as GitHub release `procontract-agent-v<version>`.
Built by `packages/sdk/script/procontract-agent-build.ts` from this commit with Bun 1.4.2.
