# ProContract Action Fusion

2026-09-12。原生实现与 27 条 ProgramBench 开发轨迹验证已完成。Fusion 达到预先设定的开发集门槛，保留 `OPENCODE_ACTION_FUSION=1` 可选启用，默认仍关闭；尚未进行独立未见任务或全 200 题确认。

## Completed results

All 27 model runs discharged, and all 27 final evaluations passed the existing strict evaluator-validity checks. Each condition contains three repetitions on bartib, hush and cmatrix; full-score counts below are trajectories rather than distinct programs.

| Condition | Mean behavioral score | Full-score trajectories | Provider turns | Recorded model cost |
| --- | ---: | ---: | ---: | ---: |
| Existing ProContract | 84.3846% | 3/9 | 730 | $30.539668 |
| Existing Bash composition advice | 83.3636% | 1/9 | 799 | $30.302801 |
| Native Action Fusion | **85.7261%** | **3/9** | **634** | **$26.884972** |

Against the baseline, Fusion's observed mean is **+1.3415 percentage points**, provider turns are **13.15% lower**, and recorded model cost is **11.97% lower**. Its mean is 2.3626 percentage points above the Bash policy control. The complete native-delivery, evaluator-validity, activation, aggregate quality and task-mean regression gates all pass.

| Task mean over three repetitions | Baseline | Bash advice | Fusion |
| --- | ---: | ---: | ---: |
| bartib | 93.2039% | 90.9385% | 93.0652% |
| hush | 59.9500% | 59.2839% | 64.1132% |
| cmatrix | 100% | 99.8682% | 100% |

The mean gain comes mainly from hush; bartib decreases by 0.1387 percentage points versus baseline. It is not a uniformly positive result across repetitions: Fusion's three-repetition panel means are 92.3222%, 91.4342%, and 73.4220%, versus baseline 93.2289%, 92.8314%, and 67.0936%. Two repetitions are lower and the third is higher. This is a positive development-set observation, not a causal or generalization guarantee.

There are 39 actual `mutate_run` requests: 16 edit, 13 apply_patch, 7 write, and 3 rejected requests that incorrectly used Bash as the mutation tool. Of the 36 valid compositions, 32 mutations completed and 4 failed with the command skipped. The 32 command attempts produced 26 process completions and 6 failures. All error paths retain their original stage information; no automatic handoff is produced.

The corrected inference cohort used $87.727441 of recorded model usage. Including the preserved preliminary cache-placement cohort ($62.180446), the total is **$149.907887**. The corrected cohort's 2,163 admitted provider requests all have completed usage records; rejected local peer probes are counted separately. Evaluator compute and the unreturned usage limitations of the interrupted preliminary cohort remain outside an invoice claim.

Final evidence: `/home/duozhou/run-artifacts/procontract-action-fusion-prefix-20260911/FINAL.md` and `ANALYSIS.json`. Every candidate, score, input hash, phase outcome and repeated result is retained.

## Interface and behavior

Set `OPENCODE_ACTION_FUSION=1` before starting the host to install `mutate_run`. Missing or other values keep it disabled. The host captures this setting once per service graph. Ordinary Sessions do not advertise the tool; execution requires a current active ProContract binding with both filesystem-write and process-execution delegation.

The tool composes two existing canonical tools:

```json
{
  "mutation": {
    "tool": "apply_patch",
    "input": {
      "patchText": "*** Begin Patch\n*** Add File: value\n+expected\n*** End Patch"
    }
  },
  "run": {
    "command": "test \"$(cat value)\" = expected",
    "timeout": 120000
  }
}
```

`mutation.tool` also accepts `edit` and `write`, with their existing input schemas. The command uses the existing Bash schema, working-directory resolution, permissions and timeout. Choose the combined operation when the command is already known. An intermediate result that is needed to decide the command remains a reason to use separate interactions.

Outputs preserve `mutation` and `run` independently, including child call IDs, result values, structured output and managed output paths. `settled` is always false. A completed command records process exit zero; it does not certify internal assertions or broader behavioral compatibility.

- A failed mutation skips the command. Partial patch failures retain and report the changes already made.
- A failing or timed-out command retains the mutation.
- Permissions are applied by each original leaf. A wholly disabled leaf is rejected before mutation; resource-specific authorization still occurs at its original boundary.
- The original leaf identities are captured once. Replacement between stages is detected as a stale invocation.
- Each child invocation reserves its normal action. The composition wrapper does not add a third reservation. If only one action remains, the mutation may complete while the command is rejected by the original action budget.
- Mutation and Bash retain their separate native timeout rules. Remaining Contract deadline bounds each stage, and authority/lease/deadline are checked again before the second stage.
- Typed operational failures become explicit outcomes; interruption and defects remain interruptions and defects. No provider call, budget reset, handoff, attestation or automatic rollback is introduced.

This is a sequence over the current working directory, not an atomic transaction or isolated snapshot. Other concurrent tools can change the workspace. Delivery evidence continues to use the existing frozen-candidate replay and independent settlement path.

## Implementation

`packages/core/src/tool/action-fusion.ts` registers one normal `Tool.make` value. It invokes the original mutation and Bash through `ToolRegistry.Materialization.settle`, preserving leaf authorization and the sole generic output-retention boundary. It does not define another executable representation or registry-owned executor.

An internal `Tool.withSubactions` marker associates child accounting with the canonical tool value. A different tool registered under the same name receives ordinary action accounting. The registry's existing binding reservations continue to own action limits.

`BuiltInTools` installs the configured node; the Session runner advertises the composite only within the applicable Contract delegation. Public Protocol and Server HttpApi types are unchanged.

## Validation

The 17 focused tests use real filesystem mutations, the canonical registry, real Bash and real Contract accounting. They cover all three mutation tools, complete and partial multi-file patches, invalid patches, nonzero exit, timeout, long commands, missing authority, denied tools, a one-action budget, disabled configuration, stale placement, cancellation and tool-identity-based accounting.

The long-command check runs an actual 61-second command under a 65-second Bash timeout, establishing that it is not cut off by the mutation tool's one-minute limit. Cancellation checks preserve the mutation while terminating the running process.

The 139 relevant existing registry, mutation, Session and observation-policy checks also pass, as do Core/OpenCode typechecks and 21 ProgramBench transport/reference boundary checks. Detailed logs and source fingerprints are retained in:

```text
/home/duozhou/run-artifacts/procontract-action-fusion-20260911/
```

## ProgramBench experiment

The experiment uses bartib, hush and cmatrix, with three repetitions in each of three conditions:

1. Existing ProContract execution with ObservationPack enabled.
2. The same tools, with a fixed instruction recommending known sequences in existing Bash.
3. The same base plus the production Fusion tool and its description.

All use GPT-5.6 Sol xhigh, the same offline reference harness, immutable task/evaluator inputs, 1,000 native turns, the existing offline adapter's 1,000,000-action sentinel, and six hours per task. Nine three-task campaigns each have the same $20 recorded-usage circuit breaker. Selection seeds 42–44 balance ordering within repetitions and do not set model sampling seeds.

The benchmark runtime is a dedicated copy at `/home/duozhou/opencode-fusion-bench`, retaining the tested offline transport/reference adapter. Its Fusion, canonical Tool and registry modules are identical to the implementation in this working tree. The runner and built-ins retain the adapter's existing integrations while adding the same Fusion wiring. The shell-control hint exists only in this experimental runtime.

The corrected runner lives at `/home/duozhou/ProgramBench-fusion-prefix`. Existing campaigns and worktrees are not inputs that can be modified by the new candidates. The actual request gateway checks model, effort, reference/recall availability and the expected condition-specific tool/hint before interpretation of results.

The first launch was stopped in every arm after the shell control showed about 3–4% cache reuse versus about 97–98% in the other conditions. Its fixed instruction had been appended after history. All requests, partial candidates and $62.180446 of recorded usage are preserved in the original experiment directory; these interrupted trajectories are not selected as validation results.

The same instruction was moved into the stable system-prefix array in the benchmark-only overlay, and all three binaries were rebuilt from that common overlay. The production Fusion implementation did not change. The full 27-trajectory cohort restarted in `/home/duozhou/run-artifacts/procontract-action-fusion-prefix-20260911/`; `CACHE-QUALIFICATION.json` records recovered cache reuse. The combined recorded-usage target for both cohorts remains $180, with possible in-flight/unreturned usage explicitly tracked.

After all model runs completed, the last evaluation stalled in a PTY test's `waitpid`. A nonblocking Python stack inspection and a small test in the actual grader reproduced a separate timer bug: a pytest rerun reused its protocol wrapper after the original signal timer expired, while `safe_reporting` discarded the saved timer. The original failed to return within a 4-second watchdog; restoring the configured timer on each affected retry correctly failed both 0.2-second test attempts and emitted a report in 0.70 seconds.

The fix is isolated in `/home/duozhou/ProgramBench-fusion-eval/src/programbench/eval/safe_reporting.py`. All 27 frozen submissions were uniformly reevaluated using that fix, preserving the test assertions, configured timeout values, retry count, base-image digests and scoring metadata. No model inference or candidate modification was repeated. Existing available canonical scores did not change. `evaluator-repair/FROZEN.json`, `timer-reproduction.json`, and `SCORE-CHANGES.json` retain the repair evidence. The final evaluator-validity label uses the existing harness checks; this harness did not additionally supply an expected executable hash to the validator.

`PLAN.md` freezes the design before inference. `FROZEN.json`, build receipts and source archives bind the inputs. `SUMMARY.json` and `REPORT.md` report every selected trajectory, including unavailable scores. Full-score counts refer to repeated trajectories, not distinct programs. Native discharge remains separate from external behavioral quality. These previously inspected tasks are development evidence.

The user prioritizes performance, so cost reduction is not a selection requirement. Fusion must show actual activation, valid complete delivery and no lower mean than either control, with no task-mean regression above two percentage points, before meeting this experiment's development gate. Passing that gate does not establish whole-benchmark generalization.
