# Sol Max: full-harness OTA research campaign

Root: `/home/duozhou/run-artifacts/procontract-sol-ota-rsi-20260921`.
Read `QUALIFICATION.json`, `profile.json`, `STATUS.json` and the live `ota.sqlite`
before reporting progress. Launch/first-request evidence is recorded separately;
configuration or an offline bridge test is **not** a real-model launch.

This is a new experiment, not a relabeling or modification of the frozen R3–R5
strategy-only run. The external ProContract Kernel remains unchanged. The new
ProgramBench checkout is `/home/duozhou/ProgramBench-ota-rsi`; its official test
and scoring semantics are unchanged. The additional bridge binds exact full
source/binary/policy identities and an externally admitted original deadline.

## Frozen objective and assignments

- Model: `openai/gpt-5.6-sol`, variant/effort `max`.
- Research seed S0 role-dispatches the R3 generation/solver policies, with explicit
  current-Contract output precedence. It is **not** the byte-identical previously
  evaluated R3 policy and is not claimed as a performance-promoted seed.
- H0 is the previously qualified full source-built Linux OpenCode release.
- Development: cppcheck, ffmpeg, cheat (the original difficult panel).
- Confirmation: xplr, hyperfine, code-minimap, plus cmatrix/ngrrram retention.
  The three new tasks are SHA-ordered independently of historical scores after
  excluding the prior R3–R5 confirmation assignments. This is not a globally unseen
  benchmark or a statistical-significance claim.
- Two executions per task/version, allocation seeds `219910` and `219911`.
  Seeds are allocation identities, not deterministic provider samples.
- Preserve established robust full passes. Cmatrix and ngrrram are also explicit
  required candidate full-pass floors; they are not invented seed attestations.
- Added full passes take priority; otherwise require at least +2 pp task-equal
  mean in both panels (an already entirely full panel may tie). Mean-only gains
  permit OTA switching but are not the primary objective being achieved.
- Stop for primary success only after a _novel_ robust full pass beyond known
  floors is accepted and the selected release demonstrates runtime health.
  Regaining a noisy control's previously established full pass is not a new gain.

The Cppcheck `std.cfg` reference limitation is disclosed as an observation, not
treated as intended semantics or silently removed. Development feedback contains
per-task/replicate counts and comparison counts, never hidden expected outputs or
confirmation scores. Fixed-panel repeated selection still exposes a selection
signal and can overfit; full-200/generalization claims need separate evaluation.

## Execution and authority

At most six external evaluation allocations run concurrently, interleaving paired
controls and candidates. Every allocation receives its own original six-hour
deadline before setup. The same deadline reaches native Contract admission,
Session execution, the credential gateway and the host watchdog. This new
cohort's outer allocation includes setup and scoring; neither renews the clock.
There are no cumulative turn/action/request/money ceilings or finite sentinels.

Independent ProgramBench scoring revalidates campaign, runtime, policy, assignment,
submission, evaluator and test-map identities. Undelivered results count as zero;
missing/invalid evidence stops rather than dropping a task or taking a free retry.
Source reconstruction uses exact Git blobs with filters/hooks disabled and safe
in-tree links. No candidate code executes on the host. Binary probes, inference,
builds and scoring use their isolated existing boundaries.

Inference/scoring owners, gateway processes and evaluator cgroups/containers are
fenced on cancellation. The supervisor drains aborted allocations before another
admission or promotion. Only this cohort's ownership is touched.

Use `ROOT/CANCEL` for explicit cancellation. The external launcher publishes
durable status without manufacturing agent progress heartbeats. Known native cost
estimates and independent gateway usage overlap; they are not added together.
Since H may change its own cost reporting, monetary accounting remains explicitly
incomplete until independent reconciliation; unknown is never silently zero.

`qualification/BRIDGE.json` is a scripted-provider test through the real official
scorer (zero paid model requests), not evidence that Sol improved. Image checks
verify offline dependencies under both evaluator UIDs. The production profile
may launch only after all frozen qualifications and input hashes are verified.
