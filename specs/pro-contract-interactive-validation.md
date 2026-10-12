# R2 interactive preview qualification — 2026-10-12

Base: frozen R2 `78bec19263814444ab008c58d54835b59b4a1c6b`.
Branch: `r2-interactive-ready`. This is separate preview development, not a
replacement of any historical cohort or a new benchmark/policy promotion.

## Automated results

All commands ran from their package directories, with Bun 1.3.14.

| Check                                                                               | Result                          |
| ----------------------------------------------------------------------------------- | ------------------------------- |
| Core typecheck                                                                      | pass                            |
| OpenCode typecheck                                                                  | pass                            |
| TUI typecheck                                                                       | pass                            |
| Server typecheck                                                                    | pass                            |
| Client typecheck and regeneration                                                   | pass; no generated-client drift |
| Core: Contract, replay, catalog, policy, Location, native runner                    | 187 pass, 0 fail                |
| OpenCode: interactive process, private worker, HTTP/auth, registry, run, config     | 139 pass, 0 fail                |
| TUI: Contract browsing/refresh/native JSON/paging, permission sync, dialog controls | 14 pass, 0 fail                 |

The legacy JS SDK was regenerated using `packages/sdk/js/script/build.ts`.
The new profile appears in the generated configuration type; generated files
were not edited by hand.

The native-process test covers rejection and correction without admission,
exact user confirmation, configured v5 binding, dedicated native execution,
snapshot replay, native transcript retrieval, durable verification after server
restart, principal attestation, and cancellation of an already running Linux
process. The TUI renderer test exercises actual keyboard navigation, status
refresh, read-only native records, JSON scrolling, and older-message paging.

## Compiled Linux package

Linux x64, version `0.0.0-r2-interactive-preview`, channel `r2-interactive`:

```text
SHA-256 50db5b5f2d667fef37f44a12167d61ba602fc791854772248b0d222fbf489089
```

Build command from `packages/opencode`:

```bash
OPENCODE_CHANNEL=r2-interactive OPENCODE_VERSION=0.0.0-r2-interactive-preview \
  bun run build --single --skip-install --skip-embed-web-ui
```

The compiled binary passed its version smoke test, the full native-process
interactive lifecycle test, and the negative `--dangerously-skip-permissions`
formation test. The latter still rejects principal formation rather than
silently issuing a Contract.

## Real terminal control

A fresh isolated workspace and XDG/home tree, deterministic loopback provider,
and the compiled binary above were exercised through a real tmux terminal:

```text
natural-language input -> displayed exact terms -> user confirms
-> native Session -> snapshot-bound replay -> live verification list
-> native read-only transcript -> exact JSON tool record
-> independent export/check -> evidence hash entered in TUI
-> discharged -> scoped quiet
```

No `OPENCODE_SERVER_PASSWORD` was configured for this embedded TUI. Governance
used its private ephemeral worker credential. The model endpoint was a local
fixture, not a commercial provider. The exact exported `proof.txt` bytes were
independently checked against `ready\n` before entering their SHA-256 as the
principal's review evidence.

Final Contract `pct_a7079622650d6c6a503cb99e3b514576dc168f25c5fc5ca23d3e173d56701b83`
reached `discharged`; scope `6f87f98750c7c88b58c994dd957a9483ddf88664` returned
`quiet: true`, frontier 3, and no outstanding duties. Its original six-hour
deadline remained intact, with no cumulative turn/action ceilings.

Local artifacts, including terminal captures, provider requests, exact export,
specification, database, and quiet receipt:

`/home/duozhou/run-artifacts/procontract-r2-interactive-20261012/final/`

Earlier development captures and the pre-refresh binary remain in the parent
directory. They exposed the stale list and blank legacy transcript; they are
not relabeled as successful final qualification. All owned terminal/server
fixtures were explicitly stopped. No historical experiment was changed.

## Claim boundary

This qualifies the described Linux interactive mechanism and preview package.
It does not establish cross-platform release readiness, adversarial sandboxing,
live-model formation reliability, arbitrary task completion, new R2 scores, or
general superiority of the opt-in ProgramBench v5 strategy. See the
[user guide](pro-contract-interactive.md) for installation and limitations.
