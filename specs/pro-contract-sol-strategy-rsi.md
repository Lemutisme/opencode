# Sol strategy RSI: R3 → R4 → R5

This continuation changes **strategy**, not the normative Kernel, evaluator,
execution budget, tools, or task terms. It follows the three-task diagnostic in
`pro-contract-strategy-promotion.md`; that manually authored policy was not
promoted. The starting solver remains the exact R2 v5 policy. A new generator
seed is explicit: historical R2 generator continuity is not claimed.

## Executable boundary

The issuer adapter `packages/core/script/strategy-kernel.ts` calls the real
`ProContract.Service` against an isolated SQLite ledger. It does not call a model
or scheduler. Its subject is a content-addressed strategy bundle containing two
immutable artifacts: `solver_policy` and `generator_policy`.

Ordinary Contracts separate:

1. Native strategy-artifact qualification.
2. Independently recomputed, complete paired performance evidence.
3. Authorized research-only succession after a negative performance outcome.
4. Performance-backed selection, requiring discharged performance support.

Negative results escalate the performance Contract; they are never attested as
positive performance. A negative candidate may become a **research parent** to
generate a better proposal without becoming a deployment default. Ancestry is
metadata, not an evidential dependency. A selected strategy is campaign-local;
the global policy/runtime is not replaced.

Before successor generation or evaluation, the issuer checks the live Contract
standing, protocol, exact bundle, and policy bytes. Native generation receives
the parent's actual generator strategy as `executionPolicy`, exports exact
solver/generator artifacts, and records the native Contract/Session identity.
Subsequent tasks bind the generated solver policy through the existing immutable
execution binding. There is no special `spec.policy` or new normative transition.

This separates proposing a strategy from granting research/deployment standing.
The host recorder/comparator is trusted; hashes alone do not authenticate a
candidate's own claims. Withdrawal prevents **new admissions**; this adapter
does not claim distributed atomic revocation of already running jobs.

## Fixed objective

Every version has two independent executions per task. A robust full pass means
both are valid, delivered, and exactly `resolved == total`; no rounded scores.

- Preserve the comparator's already full-passing tasks.
- Compare robust full-pass count first, exact task-equal mean second, complete
  recorded cost last. Cost cannot veto higher-priority improvement.
- Compare with a contemporaneous fixed R2 baseline and, from R4, the immediate
  research parent. Missing/invalid evidence stops the batch rather than dropping
  a difficult task or granting a zero-cost retry.
- Stop for practical primary success only if both development and sealed
  confirmation comparisons prefer the candidate and at least one stage gains a
  robust full pass. A mean-only gain is not the requested primary improvement.

This is **not statistical significance**. Sequential searching, tiny panels,
globally exposed tasks, and no sham-recursion arm preclude a population-level
or generator-recursion superiority claim. The confirmation panels are disjoint
and withheld from this generator, not globally unseen benchmarks. Their details
never enter the next generation's feedback. Aggregate results on the explicitly
exposed development panel may enter subsequent research; no hidden assertions,
test names, or expected answers are passed to generators or solvers.

## Frozen batch

Root: `/home/duozhou/run-artifacts/procontract-sol-strategy-r3-20260921`.

- Model: **Sol Max**, not the separate Luna RSI experiment also on this host.
- Development: the same `cppcheck`, `ffmpeg`, and `cheat` instances from the
  prior diagnostic. The known Cppcheck reference `std.cfg` setup fault is
  disclosed, not quietly turned into target semantics or removed from the panel.
- Each task and generator has its own original six-hour deadline; cumulative
  provider-turn, action, request, and monetary caps remain absent.
- At most two comparison slots concurrently, each with three task workers.
- Frozen solver binary: retained R2, SHA-256
  `1e9bba5e8319eb6a3f00b6cdb279afb460a2b456a14be3d76615c30648b99b6d`.
- Runner checkout: `/home/duozhou/ProgramBench-sol-strategy-rsi`, branch
  `sol-strategy-rsi`, `d314c5e`. This reuses native growth/admission/scoring and
  kernel-settlement adapters, replacing mean-first selection with full-pass-first.
- Issuer checkout: `/home/duozhou/opencode-sol-strategy-rsi`, branch
  `sol-strategy-rsi`, `c814157`. Only the issuer script changes; the Kernel does not.

| Generation | Two allocation seeds | Sealed confirmation task IDs    |
| ---------- | -------------------- | ------------------------------- |
| R3         | 219300, 219301       | angle-grinder, onefetch, tinycc |
| R4         | 219310, 219311       | pier, dutree, fzf               |
| R5         | 219320, 219321       | trdsql, bat, genact             |

The confirmation queue is hash-ordered independently of historical scores; seeds
identify allocations, not deterministic provider sampling. Each generation has
one proposal, not best-of-k selection. This finite batch is not a new per-instance
count budget. If it finishes without primary improvement, a later research batch
must use separately frozen confirmation assignments; no running protocol is edited.

Cancellation is the root `CANCEL` file. The supervisor propagates cancellation
to owned execution roots; it must never interrupt another experiment. All model,
generator, rejected-policy, control, evaluator, and infrastructure-failure costs
remain attributable. Native and gateway accounting overlap and must not be added.

## Qualification before model work

- Actual native SQLite settlement, exact retry/conflict, negative evidence, and
  dependency withdrawal tests.
- Native Session/provider-wire fixture proving actual successor policy use,
  including a no-successor control. Scripted provider only, not quality evidence.
- Deadline-only configuration/admission/gateway/accounting tests, including
  continuation beyond former count limits and original-deadline termination.
- Offline wheel installation/import under both root and non-root evaluator UIDs
  for all development and R3–R5 confirmation images.
- Kernel regression and package-directory `bun typecheck` in the isolated issuer
  checkout. Existing unrelated dirty files in the main checkout remain untouched.

Qualification is not experimental success. Read `STATUS.json`, generation-specific
`development.json`/`confirmation.json`, and the ledger before reporting any gain.
An inner task's fresh-context Falsifier is still **not implemented**; the independent
boundary here is outer strategy evaluation and issuer-owned promotion. No claim of
an independent within-task reviewer or per-tool-call strategy revision is made.
