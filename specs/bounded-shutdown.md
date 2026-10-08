# Bounded shutdown for ProContract RSI

This repair follows the separately frozen `8f2a09b` nine-instance diagnostic.
It does not revise that cohort, its deadlines, its missing scores, its public
inputs, or its official grader. The normative Kernel and public Protocol are
unchanged. It is not evidence of a better learned policy.

## Failure and ownership

The gateway's signal handler acquired the same non-reentrant lock used for
accounting. A signal delivered while that lock was held, or a reentrant signal,
could prevent exit. The native host then awaited gateway exit without a bound,
after clearing its work timer. The old cohort controller waited indefinitely
for cancelled children. The observed gateway was sleeping on a futex; no Python
stack was captured, so the exact production lock interleaving is not proven.
The old source's lock failure is reproduced deterministically by the tests.

Shutdown now closes each ownership boundary:

- Gateway stop does not acquire business locks. Process exit closes sockets;
  admitted requests without a completion record remain unknown, not free.
- Native startup and worker waits observe stop. Wrapper, runtime PID/birth,
  and gateway are fenced independently. Gateway TERM escalates to KILL after
  one second. Cleanup has a five-second monotonic bound and cannot renew the
  original work deadline. A request to kill is never an exit acknowledgement.
- The operator controller records one cancellation time, stops admissions, and
  bounds graceful and forced cleanup. A unique cohort token, durable admission,
  systemd InvocationID and ControlGroup bind any scope signal. Unknown ownership
  is reported, never guessed. Unrelated scopes are not targeted.

Real subprocess tests cover ignored TERM, wrapper/runtime separation, missing
runtime identity, cancellation during setup, and settled-promise cancellation
races. Real systemd qualification additionally checks an unrelated live scope.

## Separately frozen endpoint containment

The new controller may continue other fixed assignments after an isolated
invalid official score only when host-owned provenance identifies the terminal
original-task grade and cleanup is positively acknowledged. Candidate-panel
grades are not original endpoints. Local runtime-safety verifications must also
remain supported; successful RSI proposals must not become controller faults.

The endpoint classifier checks admission identity, immutable task/profile
references, native fences, terminal checkpoint/execution linkage, official
subject/configuration identity, grader operation completion and cleanup.
Malformed, stale, mismatched, timed-out, cancelled, or unacknowledged evidence
cannot qualify as an isolated invalid score. Invalid official evidence remains
unknown; it is neither a zero nor an instruction to retry or continue solving.

`executionComplete` means all 18 fixed assignments safely settled;
`scoresComplete` (and the compatibility `complete` field) requires 18 valid
scores. Unknown repeats prevent complete task means and promotion. Historical
results are never pooled with this new cohort to fill gaps.

## Restart conditions

Before paid admission, commit and freeze the new source, requalify the native
execution chain and endpoint/controller integration, verify unchanged benchmark
suppliers, and retain every qualification attempt. Preserve Luna / max, the
same nine instances and two repeats, three concurrent originals, and six hours
per original including grading. Provider/tool/request/money caps remain null.
Do not lower the 64 GiB storage reserve to force admission.

The historical non-ProgramBench local verifier and official ProgramBench bridge
retain their grading semantics. Outer controller bounds do not fabricate their
cleanup acknowledgement. A remaining unknown cleanup stops the cohort and is
reported as such.
