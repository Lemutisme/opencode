# Extended delivery evaluation

Engineering qualification after `64a96dda0e`, performed on 2026-10-05 in the
isolated `contract-delivery` worktree. This is not a paid model benchmark,
capability-improvement result, or change to any frozen research cohort.

## Findings and corrections

1. **Embedded host database ownership.** The default Database node captured its
   filename when its module was imported. A later independent embedded host
   could reopen an earlier host's deleted temporary database. Resolve the layer
   at host acquisition instead. Real HTTP and SQLite regressions verify that
   overlapping hosts keep separate databases, including when the first request
   occurs after another host changes configuration.
2. **Test environment isolation.** The OpenCode preload cleared OpenAI keys but
   inherited `OPENAI_BASE_URL`. This redirected the Cloudflare gateway fixtures
   away from their expected provider identity. Scrub the endpoint in the test
   process, not in production. The file-permission test assumes Unix umask 022;
   use that explicit test environment rather than altering runtime file modes.
3. **HTTP exerciser correctness.** Protected handler scenarios must send valid
   principal credentials, not disable authentication. Missing-Contract probes
   now provide valid attestation/challenge coordinates. Auth probes use an
   isolated directory rather than writing a configuration file into the
   checkout. Cached HTTP applications must close before their scenario's
   shared runtime scope, even when preserving the database across scenarios.
   Otherwise later fake-provider requests inherit a disposed runtime.

The original failures and follow-up results remain under
`tmp/contract-delivery-eval/`. No assertions were relaxed and no skips were
added to produce a passing result.

## Additional adversarial and upgrade coverage

- Seven new actual-Service/process tests cover attestation-coordinate rejection,
  durable rejection history, strategy state across fresh process restarts,
  conflicting and exact settlement retries after withdrawal/rollback, retained
  full-pass protection, and two independent SQLite writers racing promotion.
  Three repetitions passed: 21 test executions, not 21 independent capability
  measurements.
- A historical SQL fixture was produced by unmodified Core/Schema services at
  `5b79856fd4`, using synthetic Contracts only. Four upgrade regressions verify
  byte-preserved historical state and ledger, preserved explicit ceilings and
  usage, new deadline-only and policy persistence, migration idempotency, and
  atomic DDL/journal rollback after a real SQLite failure.
- The original `64a96dda0e` archive was extracted outside the checkout. Binary,
  catalog, source-tree, lockfile and included-log hashes matched its manifest;
  the same four native process scenarios passed from that extracted binary.
  This does not qualify a later binary without rebuilding and retesting it.

## Expanded checks

| Check                      | Result                                                          |
| -------------------------- | --------------------------------------------------------------- |
| Core full suite            | 1,376 passed, zero failed, 172 files                            |
| LLM full suite             | 305 passed, 30 existing skips, zero failed                      |
| TUI full suite             | 195 passed, one existing skip, zero failed                      |
| SDK Next full suite        | 6 passed, zero failed                                           |
| Protocol full suite        | 2 passed, zero failed                                           |
| HTTP route coverage        | 218 scenarios; no missing or extra routes                       |
| HTTP authorization         | 218 passed; zero failed, skipped, missing or extra              |
| Full OpenCode suite        | 3,691 passed, 22 existing skips, one existing todo, zero failed |
| Full HTTP effect scenarios | 218 passed; zero failed, skipped, missing or extra              |

Provider recording stayed disabled and LLM replay filters were cleared. Its 30
skips are existing missing-cassette cases; live-provider fixtures were not re-recorded. Existing
OpenCode skips/todo cover known legacy-projection, UI/teardown, response-shape,
Unicode, platform-specific, credential/cassette and remote-instruction cases.
Skipped tests are not passes.

The normalized OpenCode run covered 3,714 tests across 264 files and 50 snapshots
in 603.63 seconds. The initial inherited-environment run had five failures
(one umask expectation and four gateway endpoint cases); its original log is
retained separately. The endpoint cases were reproduced with and without the
inherited URL, and the unchanged permission test was reproduced under each
umask before the full corrected run. No result was selected from model trials.

An independent negative control retained one actual HTTP handler across three
projects, creating all Sessions through HTTP instead of sharing fixture runtime
layers. Sync, async, then sync prompts all completed with their distinct scripted
responses and no assistant error; exactly three localhost provider requests
were observed. This distinguishes the exerciser lifetime defect from a
persistent multi-project server failure.

Run package tests from their package directories. The full OpenCode command is:

```sh
cd packages/opencode
(umask 022; RECORD=false bun test --timeout 30000 --only-failures)
```

The HTTP exerciser additionally runs `coverage`, `auth` and `effect` modes with
`--fail-on-missing --fail-on-skip`. All effect-mode model work uses the local
scripted provider. The exact final binary identity and release qualification
commands belong in the distribution's `RELEASE.json`.

## Publication boundary

Local pre-push inspection covered all 24 then-unpublished commits: 337 new
blobs, approximately 10.2 MB, no new binary blobs or live databases. Candidate
credential matches were fixture placeholders; this bounded local scan is not a
proof of secret absence. Subsequent QA changes require the same path/content
check before publication.

The subsequent 14-file QA delta was also inspected locally: all 177,924 bytes
were regular text, with no new binary, live database, auth file or recognizable
real credential. The historical fixture contains synthetic records only.

Push only `origin/contract-delivery`, not all branches or research refs. Build
archives and their logs are ignored distribution artifacts and are not included
by a source-branch push. The original workspace and historical cohorts remain
unchanged.
