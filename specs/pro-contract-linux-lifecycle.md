# ProContract Native-Linux Lifecycle

This is the Phase 3 mechanism record for `procontract-strength`. It closes one
fresh, local, network-independent Contract lifecycle with a real server process,
durable database, scheduler, dedicated Session, content-addressed Snapshot,
replay verifier, server restart, negative control, independent report,
attestation, and frontier-relative quiescence.

It is not a capability, benchmark, policy-quality, or RSI result.

## Result

```text
issue -> activate -> execute -> handoff -> replay
      -> stop server -> start new server
      -> reject wrong-subject challenge without state mutation
      -> export exact subject -> independent finite verifier
      -> principal attestation -> discharge -> quiet
```

The positive lifecycle completed. The negative control was rejected and
audited without changing authoritative Contract state.

## Environment

| Coordinate | Value |
| --- | --- |
| Date | 2026-08-18 UTC |
| Host | Linux `6.17.0-1021-gcp`, x86_64 |
| Bun | `1.3.14` |
| OpenCode binary | `0.0.0-procontract-strength-202608180634` |
| Runtime branch commits | `bd4e84c6e`, then `5d8ec4f44` |
| Server | native `opencode-linux-x64`, Basic auth enabled, loopback only |
| Executor provider | deterministic OpenAI-compatible fixture on `127.0.0.1` |
| Candidate authority | `filesystem.read` only |
| Replay/verifier network need | none |

The provider key was the literal placeholder
`non-secret-loopback-placeholder`. No API key, provider account, external
dataset, or historical `run-artifacts` directory was used or copied.

## Frozen Contract

| Field | Value |
| --- | --- |
| Contract | `pct_linux_lifecycle_20260818_run2` |
| Scope | `linux-lifecycle-20260818-run2` |
| Revision | `1` |
| `specHash` | `5e8a1f3b0cc37dcb6be8a575a6e582b0acebb29fe1dd0a46f0c62282953e94fc` |
| Goal | Prove the frozen one-file candidate satisfies its exact local criterion. |
| Claim | The exact handoff contains `lifecycle.txt` with bytes `ready\n`. |
| Protected file SHA-256 | `ed1a545bb85e55816bbf9566b028b2a0bc456b88f49f6f266c0401048824194b` |
| Replay command | `sh -c 'test "$(cat lifecycle.txt)" = ready'` |
| Model | `test/test-model` |

The candidate was a fresh Git repository containing only `lifecycle.txt` and
its Git metadata. Its initial commit was `b9912ba`. The fixture provider emitted
one `contract_report_ready` call with no uncertainty. The real scheduler
created and drained the dedicated Session.

Execution binding at handoff:

| Field | Value |
| --- | --- |
| Session | `ses_fec66f2f2ffeVP2NEf5osJu4C5` |
| Prompt | `msg_013990d0d002ChkortNHP4b2gP` |
| Semantic attempts | `1` |
| Provider turns | `1` |
| Counted tool actions | `0` |
| Dispatched | `true` |

The reporting tool is a governance transition and did not consume delegated
candidate tool authority.

## Handoff and replay

The active executor petition captured:

| Coordinate | Value |
| --- | --- |
| `subjectHash` | `f7ddd02611840c873fa168a4bba5e0a559277670` |
| replay `policyHash` | `95d20f58dc04e3d0c223a7fc0963e0858d791058c0a6d977dfa0f229d47ecdf0` |
| replay `evidenceHash` | `3d43138e0b2fb50ed068be29bc05b9b3cac691c006b4c7b5a420c1eaa128a121` |
| replay decision | passed |

The replay ran in a materialized temporary Snapshot, observed exit 0, matched
the protected hash, found the required artifact, and produced empty stdout and
stderr hashes. The same credential-free JSON value is committed below.

Before restart and attestation, scoped state was:

| Field | Value |
| --- | --- |
| quiet | `false` |
| frontier | `2` |
| ledger hash | `275fc03901a3f2b439f1d3f45e829933ebbb0528d035eddf075a1584b20e8028` |
| state hash | `0c5d926cd7877dbba298da8e6929e99a330bc5e67c66046c3c192876bda97249` |
| outstanding | `pct_linux_lifecycle_20260818_run2` |

The first successful server process was stopped after this observation. A new
native server process started against the same XDG data directory and returned
the same Contract in `verification` before any principal mutation.

## Negative control

After restart, the principal challenge route received revision 1 with
`subjectHash=wrong-subject-negative-control`.

The response was HTTP 409:

```json
{"_tag":"ConflictError","message":"challenge subject does not match"}
```

The complete Contract JSON before and after was identical. The scoped proof
was:

| Check | Before | After | Result |
| --- | --- | --- | --- |
| status | `verification` | `verification` | unchanged |
| state hash | `0c5d926c...7249` | `0c5d926c...7249` | unchanged |
| outstanding IDs | one lifecycle Contract | one lifecycle Contract | unchanged |
| frontier | `2` | `3` | rejection recorded |
| ledger hash | `275fc039...e8028` | `3d985900...1db08` | rejection recorded |

This exercises the kernel rejection boundary. It is stronger than an adapter
that silently skips a stale result because the invalid command is durably
visible while the authoritative state remains unchanged.

## Independent verifier and attestation

After the negative control, `opencode contract export` materialized the exact
handoff subject in a new directory. A separate shell invocation checked the
bytes and recomputed the protected-file SHA-256.

The finite verifier manifest hash is:

```text
3ae6b539dae70574b3976b9a67b4e8fbb4961458e7c9327e2c7b2f4ed1971429
```

Its report re-bound the current Contract ID, revision, `specHash`,
`subjectHash`, replay policy/evidence, manifest, observation, and deterministic
decision. Immediately before attestation, the adapter refetched the Contract
and verified all of those coordinates. The report evidence hash is:

```text
fd2e3f48c601bd82a903df9446346b0026dce48c6b1f7e827c52084448e3c45b
```

That hash is distinct from replay evidence. Principal attestation returned:

| Field | Value |
| --- | --- |
| HTTP status | `200` |
| frontier | `4` |
| ledger hash | `78fae161e35b1d6c54e7c497ed90b7bdc9030daeddb1ddd6cfa00902977ae288` |
| attestation ID | `pca_0139c2dbc0018x1Xjc0kS8iySe` |
| Contract status | `discharged` |

Final scoped quiescence was:

| Field | Value |
| --- | --- |
| quiet | `true` |
| frontier | `4` |
| ledger hash | `78fae161e35b1d6c54e7c497ed90b7bdc9030daeddb1ddd6cfa00902977ae288` |
| state hash | `388e2a6c7789e414548d657ea57ed4842fa676f041dc533880ea199bf6689f28` |
| outstanding | none |

## Committed artifacts

Artifact SHA-256 values below cover the exact Git file bytes. Replay
`evidenceHash` is different by design: the runtime hashes compact
`JSON.stringify(report)` and then stores the value as pretty JSON. Re-encoding
the committed replay JSON compactly recomputes
`3d43138e0b2fb50ed068be29bc05b9b3cac691c006b4c7b5a420c1eaa128a121`.

| Artifact | SHA-256 | Purpose |
| --- | --- | --- |
| [`pro-contract-linux-lifecycle-fake-provider.ts`](./artifacts/pro-contract-linux-lifecycle-fake-provider.ts) | `93c3c9db0f1a354154e5a1c874f2facbc8ca918bfdeb2a05cbe4dcf7f90b616e` | Deterministic loopback executor fixture |
| [`pro-contract-linux-lifecycle-replay-report.json`](./artifacts/pro-contract-linux-lifecycle-replay-report.json) | `fd07a5e4d69bd24af7499ee84c6f7624031c1379d52ecafd3f115c138760bf8c` | Git representation of the institution-owned replay observation |
| [`pro-contract-linux-lifecycle-verifier-manifest.json`](./artifacts/pro-contract-linux-lifecycle-verifier-manifest.json) | `3ae6b539dae70574b3976b9a67b4e8fbb4961458e7c9327e2c7b2f4ed1971429` | External finite verifier definition |
| [`pro-contract-linux-lifecycle-verifier-report.json`](./artifacts/pro-contract-linux-lifecycle-verifier-report.json) | `fd2e3f48c601bd82a903df9446346b0026dce48c6b1f7e827c52084448e3c45b` | Independent principal evidence |

The SQLite database, Snapshot object store, and temporary exported tree remain
outside Git. They contain no needed capability result; the committed finite
reports and coordinates are sufficient to audit this mechanism claim. Exact
database replay would additionally require a separately transferred,
credential-scrubbed XDG data directory.

## Excluded attempt

An earlier isolated state tree issued one Contract but failed before a provider
turn with `SessionRunnerModel.ModelUnavailableError`. The custom provider had
no active integration because its public config declared `env: []`. No handoff,
replay result, attestation, or recognized success occurred. The successful run
used a fresh data directory and an env-backed placeholder integration.

This failure is not part of the positive evidence. It is retained here because
the institution failed closed and because silently omitting infrastructure
failures would overstate lifecycle reliability.

## Claim boundary

This run proves that, on this native Linux host:

- the production scheduler and dedicated Session can reach a frozen handoff;
- replay checks the exact captured subject and produces finite evidence;
- Contract state survives a server process restart before attestation;
- a wrong-subject principal command is rejected and audited without state
  mutation;
- a distinct, content-addressed report can support exact discharge; and
- final scoped quiescence is frontier-relative and reproducible from the
  recorded coordinates.

It does not prove task capability, policy quality, replay completeness,
adversarial OS isolation, credential isolation, verifier authenticity,
general liveness, autonomous RSI, or recursive metaproductivity.
