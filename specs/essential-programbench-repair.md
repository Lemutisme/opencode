# Separate repair after the first essential ProgramBench cohort

The frozen `programbench-essential-rsi-3-20261007` cohort is closed as incomplete.
It has no valid final task scores and no policy promotion. Its source, original
deadlines, partial work, requests and failed receipts are retained unchanged.

Observed causes, not speculative hardening:

1. The task images lack `rg`; native glob/grep attempted a forbidden network
   download. The repaired profile supplies an immutable ripgrep binary on PATH.
2. A legal amber reference probe grew beyond the original 8 GiB task limit.
   `OOMPolicy=stop` terminated the instance instead of returning a tool failure.
   New scopes use `OOMPolicy=continue`, still total **8 GiB**, split into a 2 GiB
   host/native-runtime leaf and a 6 GiB tool leaf. A peer/ancestry-bound broker
   moves the shell and its synchronous admission helper before arbitrary work.
   The worker has no writable cgroup mount or API for choosing PIDs/limits.
3. Waiting for the outer Bubblewrap process did not prove the runtime exited.
   New fencing targets the recorded runtime PID/birth identity with SIGKILL,
   waits for disappearance or zombie state, and records explicit acknowledgement.
   Unacknowledged cleanup cannot clear the durable execution claim. The old
   wrapper-only receipts are not rewritten as stronger evidence.

The normative Kernel, benchmark assertions/ignore maps, seed method, model and
task-level promotion rule are unchanged. A separately frozen cohort is required;
this is not a retry with a renewed historical allowance or a post-hoc readmission
relabeled as preregistered evidence. Original task deadlines remain six hours,
with no cumulative provider/tool/request/money caps. Individual operations and
infrastructure bounds remain explicit. Before paid work, qualify real grep/glob,
bounded tool OOM with a surviving native Session, deadline/cancellation fencing,
and the exact image/official scorer path with scripted responses.
