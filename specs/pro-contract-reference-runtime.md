# Reference tools: production-path repair

The 2026-09-22 audit found that H1's `reference_contrast` was not advertised in
any of its 16 first provider requests and was never called. H2 changed two tool
strings but compiled to the same binary as H1. Those score observations remain
valid historical measurements, not evidence that the proposed tool caused a gain.

The operator explicitly paused the pending H1 handoff. Its original authority
directory has `CANCEL` and `PAUSE-AUTHORIZATION.json`; no new authority was booted.
The historical frozen cohort, its runner, artifacts and admission rules are not
modified by this repair. This is an **operator repair**, not an autonomous Sol
improvement or a performance-promoted successor.

## Production composition

`ReferenceTools.configuredNode` now participates in `BuiltInTools.node`. Its
process-scoped setting parses the existing issuer-owned
`OPENCODE_REFERENCE_BINDING` once. No setting means no registration; malformed
settings fail closed. Registration is restricted to the binding's exact candidate
Location. The tools still require the current Contract/Session/revision/lease,
`reference.run` delegation and ordinary leaf permission checks. Non-Contract
Sessions do not acquire reference tool visibility or execution authority.

The runner already supplies this binding and grants the corresponding authority;
no new runner flag, credential, public protocol or normative Kernel modification
is required. `reference_contrast` composes two ordinary canonical `reference_run`
actions, retaining their individual observations and accounting.

## Execute-only reference identity

The production oracle is root-owned and execute-only. Do not change its mode or
read its bytes from the worker to hash it. The existing trusted runner measures
the image/runtime reference and publishes a read-only attestation on its protected
provider channel. The tool checks the configured digest and exact immutable file
identity before and after each invocation.

Attestations are bounded regular files opened without following symlinks. Their
owner must differ from the non-root worker and their write bits must be clear.
The reference must remain a root-owned, nonwritable regular file with the attested
device/inode/mode/size/mtime. Candidate-local attestation paths and executable
substitution are rejected. These checks rely on the existing external mount,
non-root and capability isolation; they do not give mutable H promotion authority.
The directly installed cooperative test node retains its original readable-file
hash check, but production environment bindings require the host attestation.

## Validation

Run tests and type checking from `packages/core`, inside the isolated qualification
container when importing candidate code:

```sh
bun typecheck
bun test test/tool-reference.test.ts test/tool-reference-binding.test.ts \
  test/session-runner.test.ts test/session-observation-pack.test.ts
```

`script/ota-reference-e2e.ts` drives the unchanged official ProgramBench adapter
and actual compiled OpenCode binary with a local scripted provider. It checks the
real advertised catalog, canonical tool results, durable calls, original deadline,
unreadable oracle and unwritable attestation. Its modes are:

- `control`: old H1 does not advertise the tool; a forced call returns unknown tool.
- `repaired`: the new binary advertises the reference tools and executes distinct
  and identical input contrasts successfully.
- `tampered`: an operator-controlled bad attestation makes the first contrast
  incomplete with an identity failure; restoring it permits a fresh successful
  contrast, without accepting a stale success.

Artifacts are under
`/home/duozhou/run-artifacts/procontract-reference-repair-20260922`.
The provider is scripted and makes **zero paid/real model calls**. Dummy program
delivery and official grading exercise infrastructure, not solution quality.
The repaired binary requires new paired performance evidence before promotion;
neither H1's old scores nor these smoke checks can establish that improvement.
