# ProContract observation boundary

The subsequent [three-instance ObservationPack study](pro-contract-observation-pack-study.md)
adds an opt-in Session projection and exact recall using durable history, with a
diagnostic veto derived from the Hush trajectory. Its fixed-history measurements
do not establish live quality or cost improvements; the default tool graph remains unchanged.

This change repairs the information loop before introducing search or context
optimizations. It implements adapter-owned probe receipts, exact byte retention,
explicit reference tools and a replaceable process boundary. It adds no kernel
state, authority-changing command, automatic attestation or budget reset.

## Facts that are recorded

A replay check now binds its approved argv, optional stdin and optional exact
output predicates to the captured candidate snapshot. A predicate has an `id`,
`stream` (`stdout` or `stderr`) and expected SHA-256. These fields participate in
the existing replay-policy and Contract hashes. Older policies retain their
previous hashes and exit-only semantics.

```ts
{
  argv: ["./program"],
  stdin: "a discriminating input\n",
  timeout: 10_000,
  exit: 0,
  observations: [{
    id: "specified-output-bytes",
    stream: "stdout",
    hash: expectedOutputHash,
  }],
}
```

The expectation must come from an independently checked observation or an
issuer-approved requirement. The model cannot change it inside `contract_check`.
Naming a predicate after a behavior does not prove that behavior. Matching bytes
supports byte equality under the approved probe only.

Each invocation produces a distinct receipt, including scope, reference or
candidate identity, input, execution status, exit status, captured streams,
capture completeness and each predicate's result. `completed` means the process
and output streams completed, including nonzero exits. `timed-out` retains the
captured prefix with incomplete flags. `unavailable` has no fabricated exit or
output. `targetExecution` is always `unobserved`: this implementation has no
trusted language-level execution witness.

The Hush-style regression test launches an inner syntactically invalid probe
and an outer process that exits zero. The expected output is absent, so its
predicate fails. An independent successful check in the same replay still
records a match, and an interface-bypassing empty check still fails. The result
is repair feedback without a handoff. This does not detect a missing interface
for which the approved policy contains no distinguishing probe.

## Storage and model view

Raw bytes and receipts are content-addressed under the host data directory at
`pro-contract/observations`. Concurrent writes publish complete files with an
exclusive hard link; existing digest paths are checked, never overwritten.
The archive directory is created with mode 0700 and files with mode 0400.
Repeated output bytes share one blob; separate invocations retain separate
receipts. These are cooperative filesystem permissions, not isolation from a
process running as the same user. No automatic garbage collection deletes
Contract observation evidence.

Capture is bounded at 1 MiB per stream. A matching captured prefix cannot satisfy
a complete-output predicate. Timeout prefixes are also incomplete. Readback
validates the receipt and blob hashes and byte counts, and returns at most
16 KiB as base64 with byte offsets. Missing or corrupted authoritative evidence
fails closed. Raw bytes can contain sensitive data and belong on the trusted
side of an isolated executor.

Replay report version 2 retains the check receipts and executor identity. A
report's hash is the hash of its exact stored bytes. `contract_check` projects
overall status and counts first, followed by each check's status. The original
receipt remains in structured output and the archive. `contract_read_observation`
uses the report hash and check index, checks Contract ownership and retrieves
exact bytes. Existing version 1 replay reports remain historical artifacts;
they have no raw observation records to reconstruct.

Generic tool-output bounding now falls back to the original observation if its
preview storage write fails. It preserves interruption. This fallback applies
to presentation storage, not authoritative evidence recording: failure to record
required evidence cannot create a successful replay.

Snapshot materialization continues to create a separate writable build tree.
It does not chmod the archive to make builds work. The replay test starts with
a read-only source artifact and checks that the materialized copy can be built
without modifying the original candidate.

## Host-configured reference entry

`ReferenceTools.nodeWith(...)` is an opt-in Location tool layer. A host integration
adds it to its Location layer graph before dispatching the Contract. It is not
installed by a model proposal or loaded from a candidate-controlled config file.

```ts
import { ReferenceTools } from "@opencode-ai/core/tool/reference"

const referenceTools = ReferenceTools.nodeWith({
  contractID,
  executable: referenceExecutable, // AbsolutePath, outside the candidate
  directory: referenceDirectory, // AbsolutePath, fixed working directory
  hash: approvedExecutableHash, // independently frozen SHA-256
  timeout: 30_000,
})
```

The Contract must delegate `reference.run`; ordinary agent permission policy
also applies. The model receives `reference_run({ args, stdin, timeout? })` and
`reference_read({ handle, stream, offset, length })`. Tool descriptions identify
the reference and request a small first-use availability probe. A real tool call,
not tool presence alone, establishes availability. There is no automatic claim
that the model exercised a particular capability.

The executable and reference directory are resolved independently from the
candidate. Overlapping roots and symlink substitution into the candidate are
rejected. Executable bytes are checked before and after each call. This check
does not bind every shared library, interpreter, data file or transient mutation;
the host must freeze the full reference image/closure for stronger claims.
The current layer is intended for one configured Contract per Location graph.
It is not a multi-tenant reference router or a ProgramBench CLI integration.

Calls and reads spend the existing shared action budget. The per-call timeout
is the minimum of the requested timeout, host timeout and remaining Contract
deadline. Reference tools reject foreign, retired, inactive and undelegated
Sessions. A reference receipt is an observation, never a principal attestation.

## Execution boundary and next gates

Both replay and reference calls use `ProContractExecutor.Service`. A host can
replace `ProContractExecutor.node` through the existing `AppNodeBuilder` override
mechanism with an adapter that accepts only argv, cwd, stdin and timeout, and
returns individual process status plus bounded streams. The local adapter is
explicitly labelled `isolation: local` and removes model/authentication environment
variables. It still has host-user filesystem and network authority. A container
adapter, mount policy, CPU/memory enforcement and transport identity verification
are **not implemented by this change**. Do not label the local path isolated.

Before spending inference budget on performance comparisons:

1. Install and validate the reference endpoint in the actual benchmark harness.
   Add independent probes for missing interfaces and a trusted execution witness
   where byte observations are insufficient. Keep reference archives immutable
   and build copies writable. These are experimental-condition repairs.
2. Freeze a mini-style baseline and ProContract with the same model, task inputs,
   reference access, isolation, CPU, memory, command timeout, wall time and total
   provider/tool budgets. Charge observation, recovery and auxiliary inference.
3. Test Action Fusion and ObservationPack independently, then their combination.
   Fusion must retain modification and per-check results, use a whole-snapshot
   binding and preserve failed modifications. Packing must preserve statuses
   and exact readback. Measure delivery/behavior first, then cost and turns.
4. Consider reducer and proactive compaction only after these gates. Their calls
   count toward total cost and budgets; cancellation and continuation semantics
   remain unchanged. Freeze candidates before isolated holdout evaluation and
   do not feed holdout failures back into the same search. The previously used
   200 tasks are development data, not an unseen confirmation set.

No mini-swe-agent/SoL-Pi plugin was installed, no efficiency policy was enabled,
and no new model or benchmark campaign was run here. Existing trajectory counts
are candidate savings estimates, not measured savings. Archive frozen experiment
scripts and resource manifests rather than deleting reproducibility evidence.

The design follows the supplied mini-swe-agent `04d809ce` and SoL-Pi `8f8c1391`
analysis. Those mechanisms motivate the adapter boundaries; they supply neither
execution witnesses nor ProContract acceptance authority.

## Verification

From `packages/core`:

```sh
bun test test/pro-contract.test.ts test/pro-contract-replay.test.ts test/pro-contract-observation.test.ts test/tool-reference.test.ts test/tool-output-store.test.ts test/location-layer.test.ts test/session-runner.test.ts test/pro-contract-constitution.test.ts
bun typecheck
```

From `packages/schema`, run `bun test test/contract-hygiene.test.ts` and
`bun typecheck`. Regenerate Client and the legacy JavaScript SDK after the public
replay schema change. These are local mechanism and compatibility checks; they
do not establish benchmark quality retention or throughput gains.
