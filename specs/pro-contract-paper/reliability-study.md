# ProContract 可靠性与信任边界实验研究

状态：实验设计与代码审计，不是已完成结论。审计日期：2026-09-04。代码坐标：`contract-policy-split`；当前 runtime 与 `910d9f2856323ad5493ee52f8cb2c315d2172e10` 相同。

本文服从 `specs/pro-contract-paper.md` 的 claim gate。默认威胁模型是 cooperative trusted-caller：除非实验建立进程、凭证、数据库和证据存储隔离，否则不得声称 adversarial non-bypass。

方向修订：本方向现为论文主实验，而非投影实验的可靠性补充。首个工作包是同产物、
不同授权/支持历史的判别，并加入强 workflow、逐项语义消融、false quiet 和有效交付
控制。优先级以 [实验总计划](experiment-plan.md) 为准；本报告的审计假设不等于新实验结果。

## 1. 核心结论

当前 ProContract 最强且最窄的可靠性结果，是**权威状态转换的坐标完整性**：

- `ProContractKernel.transition` 对 revision、`specHash`、`subjectHash`、replay policy、dependency revision 和 actor label 做确定性检查。
- `ProContract.Service` 把一次 transition 的 Contract 状态、attestation、event 和 ledger head 放在一个 SQLite immediate transaction 中。
- `ProContractOpenCode` 用持久 binding、lease、attempt key 和事务内 counter 协调本地执行。
- `ProContractReplay.Service.verify` 在独立 materialized tree 上执行冻结的有限检查。
- principal HTTP mutation routes 在配置 Basic auth 时验证同一组用户名/密码，未配置密码时 fail closed。

这些机制没有自行建立以下更强事实：

- `evidenceHash` 所指证据存在、来自指定 verifier、且语义上足以支持 claim。
- `subjectHash` 覆盖任务成功所依赖的全部外部状态。
- executor 无法获得 principal credential、直接调用 Core service、修改 SQLite 或证据文件。
- `process.execute` 被 filesystem、network、process namespace 或剩余 deadline 隔离。
- scheduler 在任意故障下最终交付，或 authorized discharge 等于用户成功收到有用产物。
- ledger hash chain 在 trusted database rewrite 后会被外部 witness 检测。
- `requires` 表示 generation lineage；它实际表示 current live support dependence。

论文应报告 conditional safety and measured availability，而不是 unconditional safety、semantic correctness 或 general liveness。

## 2. 实际执行边界

### 2.1 Kernel

`packages/core/src/pro-contract/kernel.ts` 的 `ProContractKernel.transition` 是只依赖 Schema 和 `Hash` 的纯 reducer。

它实际 enforce：

- `issue` 要求 `actor === draft.issuer`、issuer/executor 不同、重算 `specHash` 一致；requirement 必须已存在、同 issuer、精确 revision 且未 released。
- exact duplicate issue retry 是 accepted no-op；同 ID 冲突内容被拒绝。
- `institutionCommands` 只接受 actor `"institution"`；petition 只接受 executor label；revision decision、release、resume、challenge 只接受 issuer label。
- revision 可改 spec，但 `spec.requires` 的 JSON 表示必须不变。
- `report-ready` 要求 active/current revision/无 pending revision；replay result 必须匹配 policy/subject，失败 replay 回到 dormant。
- `discharge` 要求 verification、handoff、current revision/spec/subject、新 attestation ID，以及 matching passed replay（若配置）。
- Schema 将 principal evidence hash 声明为 `NonEmptyString`；reducer 本身只在配置 replay 时要求它不同于 replay hash，不检查证据内容。command actor 与 `verifierID` 必须等于 issuer label；不能把 Schema 约束当成任意直接 Core 调用都经过解码的证明。
- challenge 绑定 current revision/subject，清除 source support，并沿 `spec.requires` 使 live dependents escalated、清除 support。
- `quiet` 只把 discharged/released 视为 settled；escalated 不会静默消失。

actor 是数据字段，不是 credential。若 untrusted caller 能构造 `Command` 或调用固定 actor 的 Service wrapper，kernel 不知道调用者是谁。

### 2.2 Store 与 ledger

`packages/core/src/pro-contract.ts` 内部 `execute` 在 immediate transaction 中读取 Contract state、运行 reducer、写 accepted state/attestation、追加 accepted 或 rejected event、更新 global ledger head，再返回 receipt。

可主张的是 returned receipt 所对应事务的原子性，前提是 SQLite/Drizzle/Bun 事务语义成立。不能主张“每个发起过的命令都可审计”：进程可在 commit 前被 kill，此时没有 event。

hash chain 使用未签名的 `Hash.sha256(JSON.stringify(...))`。当前没有 startup revalidation、外部 checkpoint、append-only storage 或 remote witness，因此不支持对有 DB 写权限攻击者的 tamper-evidence 声明。

`ProContractOpenCode.issue` 先执行 `contracts.issue`，再独立执行 `create`。中间 crash 会留下无 binding 的 durable Contract；`ProContractScheduler.runOnce` 将其 escalated，偏向 safety 但产生 availability/false-blocking 代价。

`settleEvaluation` 的 activate、report-ready、discharge 是多个事务。中间状态大多可重试推进，但 discharge 已成功而 response 丢失时，再试返回 already settled 冲突，不是 idempotent success receipt。

### 2.3 Binding、lease、retry 与 budget

`packages/core/src/pro-contract/open-code.ts` 的 process-local `owner` 是随机 UUID；binding 持久化 revision、Session/Prompt、attempts、turn/action counters、lease 和 `attemptKey`。

`claim` 只接受 active、无 pending revision 的 Contract；unexpired lease 不重复分配；revision、visible challenge 或 blocked context 变化形成新 semantic attempt；有 work 的 expired lease 旋转 Session/Prompt但不额外消费 attempt；zero-work lease 可原 Session reclaim。

`reserveTurn`/`reserveAction` 要求 current process owner、未过期 lease、current revision、active status、无 pending revision，并在 immediate transaction 内检查 deadline/limit 和增加 counter。

这只界定“成功 reservation 的数量”，不界定全部真实消耗：

- provider request 在 reservation 后失败仍计一次，属于保守计费。
- unknown/stale non-control tool call 在 lookup 前 reservation，也会计 action。
- control tools 不计 action。
- direct Core service、plugin side effect、host process 或其他未媒介通道不计。
- action 在 deadline 前启动后可越过 deadline继续运行。
- `bash` timeout 最长 10 分钟，未裁剪为 Contract remaining time。

旧 Session 的正常 runner 会被 `SessionExecutionLocal` 和 `SessionRunner` lease checks fence。但 `ContractControlTools` 仅用 `bindings.forSession` 找 binding，leaf function 未再次要求 `dispatched`、current owner、lease unexpired 或 current Session ID；control tools 又免 action reservation。因此“旧 Session 绝不能触发 control transition”尚未建立，必须做高优先级 negative control。

### 2.4 Replay 与 artifact identity

`contract_report_ready` 从 Session 查 binding/Contract，由 `Snapshot.Service.capture` 捕获 subject；模型不能提交 hash。配置 replay 时，`ProContractReplay.Service.verify` materialize 精确 Snapshot 到 fresh tree，限制 replay cwd/inspected path，顺序运行冻结 argv，记录 exit 与 output hashes，检查 protected files/artifacts，hash report 并写入 data directory。

artifact identity 不等于 semantic truth：

- Git tree 只覆盖 Snapshot 实际 capture 的 Location state。
- 默认忽略和大于 2 MiB 的 untracked file 可能不在 tree；声明 artifact 才 force include。
- external services、environment、network、credentials、clock、toolchain/image identity 不在 subject。
- replay child process 使用 `extendEnv: true`，没有 network/credential sandbox。
- executable identity 未冻结；相同 argv 不表示 verifier bytes 相同。
- kernel 不读取 replay report 文件，也不由 evidenceHash 重算 report。
- trusted in-process caller 可构造字段匹配且 `passed: true` 的 `ReplayResult`。
- replay pass 是有限 preflight，principal evidence 仍是 opaque hash。

live workspace 在 capture 后变化不会改变 handoff subject。因此必须分别记录“被授权的 frozen release”和“consumer 最终收到的 bytes”，不能用 current worktree 代表 settled artifact。

### 2.5 Permission 与 resource boundary

`SessionRunner` 为 Contract Session 追加 deny-all，再按 `spec.authority` 开放：

- `filesystem.read` -> `read`、`glob`、`grep`。
- `filesystem.write` -> shared `edit` action，覆盖 edit/write/apply_patch。
- `process.execute` -> `bash`。
- control tools 和 `todowrite` 固定开放。
- adapter 不认识的 capability 不产生执行权限。

leaf tools 再调用 `PermissionV2.assert`，形成有价值的双层 mediation。但 capability 不等于 OS capability：read/edit 的 external path 经 `LocationMutation` 和 `external_directory` permission；`bash` 则明确拥有 host-user filesystem、process、network authority，command 参数中的 external path 只有 advisory warning。resource experiment 必须观察真实 side effect，不能只看 tool catalog。

### 2.6 Auth 与 principal identity

`packages/protocol/src/groups/pro-contract.ts` 给 issue、attest、challenge、decideRevision、release、resume 加 `PrincipalAuthorization`。`packages/server/src/middleware/authorization.ts` 在未配置 password 时对这些 routes 一律 401，配置后接受一组 Basic credential。

该边界不区分 issuer、verifier、operator 或 Contract；credential possession 即拥有全部 principal route authority。Core `ProContract.Service` 不认证 caller，并固定使用 `local-owner` 或 `institution`。

`contract_propose`/`contract_propose_revision` 经 `PermissionV2.assert` 后调用内部 Service；permission reply endpoint 只受 server-wide `Authorization`，普通 Authorization 在无密码时放行。现有“principal routes fail closed”测试不等于“所有可到达的 principal mutation paths fail closed”。必须端到端测试无密码 server 上的 Session/tool/permission-reply issue/revision 路径。

## 3. 威胁模型与外部假设

每个结果标注层级：

- T0：纯 reducer；actor provenance 由 harness 保证，command 内容可恶意。
- T1：同进程 trusted service graph；executor 只能走正常 Session/tool path。
- T2：Basic-auth local server；executor 不知道 credential，不能读 DB/data directory。
- T3：隔离 worker；principal/verifier process、credential、DB、evidence store 分离。
- T4：host-adversarial；当前设计不支持。

当前实现可直接支持 T0/T1 和 T2 的部分 route-auth 实验；无隔离 artifact 前不得提升到 T3。

外部假设必须冻结：SQLite durability；SHA-256 collision resistance但不假设 hash 内容真实；Snapshot capture correctness；clock model；唯一 tool-settlement入口；principal evidence producer identity/report/pass rule；evaluator/replay executable与environment；executor 无 DB/credential/evidence-write 权限；`requires` 只表示 live support，lineage 留在实验 manifest。

## 4. 正常运行与故障矩阵

正常 operation 与 injected faults 分表报告，不混合平均。

### 4.1 Fault-free controls

| ID  | 场景                                           | Oracle                                                            |
| --- | ---------------------------------------------- | ----------------------------------------------------------------- |
| N1  | issue -> execute -> replay -> attest -> export | exact frozen artifact 被授权且可导出；current worktree 差异单列   |
| N2  | exact issue retry                              | 一项 duty、一份 binding、不重复执行                               |
| N3  | visible challenge -> remediation -> re-attest  | 新 Session、旧 Session fenced、累计预算保留                       |
| N4  | sealed challenge                               | executor 不见 sealed evidence/subject；principal 可恢复或 release |
| N5  | upstream support withdrawal                    | 只升级 live-support descendants；lineage-only candidate 不受影响  |
| N6  | valid revision accept                          | old revision 停止执行；new revision 不继承旧 handoff/attestation  |
| N7  | deadline/attempt exhaustion                    | obligation escalated 且不 quiet；authorized release 单列          |

### 4.2 Discriminating perturbations

| 故障                            | 精确注入点                                 | Oracle 与风险                                                 |
| ------------------------------- | ------------------------------------------ | ------------------------------------------------------------- |
| pre-commit crash                | `ProContract.execute` kernel 后、commit 前 | 无 state/event/receipt；当前只有 DB 假设，无 kill test        |
| issue-binding gap crash         | `ProContractOpenCode.issue` 两调用间       | duty 存在、binding 缺失；测 escalation、false block、恢复时间 |
| post-claim crash                | scheduler claim 后、Session create 前      | lease durable、无 turn；expiry 后 reclaim，不永久 orphan      |
| post-create crash               | Session create 后、prompt admit 前         | empty Session 可恢复，不重复 semantic attempt                 |
| post-admit crash                | 两次 `sessions.prompt` 之间                | durable input 不重复、不遗漏 wake                             |
| post-turn-reserve crash         | reserve 后、stream 前                      | counter +1、无 output；不超预算但计 availability 损失         |
| mid-tool crash                  | leaf side effect 后、result 前             | 允许 duplicate risk；不得声称 exactly-once side effect        |
| post-handoff crash              | `reportReady` commit 后                    | verification/subject durable；live mutation 不替换 subject    |
| response loss after discharge   | commit 后、client receive 前               | 不二次 attestation；记录 retry 是否 idempotent success        |
| exact/conflicting issue retry   | 同 ID 同/不同坐标                          | exact no-op；conflict不覆盖 Contract/binding                  |
| stale owner before expiry       | restart后立即 claim                        | 等待 expiry；计 availability，不计 false acceptance           |
| stale owner after takeover      | old process reschedule/reserve             | old owner不得覆盖新 binding                                   |
| retired Session control call    | old Session 直接 settle control tool       | 若 accepted，停止 non-bypass claim                            |
| stale revision ready/attest     | revision accept 后提交旧结果               | rejection、state unchanged、event audited                     |
| substituted live candidate      | capture后改 worktree                       | settlement只对 old subject；delivery用 export bytes           |
| wrong-subject replay            | matching policy、different subject         | report-ready/discharge拒绝                                    |
| fabricated replay result        | direct trusted-service call                | 当前可能接受；证明 caller isolation 是必要假设                |
| replay report delete/tamper     | write后、discharge前                       | 当前不 refetch；不得主张 evidence-store integrity             |
| late positive evaluation        | support已撤回                              | 不得恢复旧 support                                            |
| late negative evaluation        | 已有新 handoff                             | old subject challenge拒绝，current handoff不变                |
| root support withdrawal         | challenge discharged upstream              | transitive live dependents失去 current support                |
| lineage-only withdrawal         | ancestor只生成 candidate                   | 无 `requires` edge则不传播；防止 over-blocking                |
| concurrent reservations         | 超 limit 的 turn/action 请求               | exactly limit allowed；记录 denied latency                    |
| deadline-crossing bash          | deadline前启动长命令                       | 当前可越界运行；只能称 admission-time deadline                |
| no read/write/process authority | 真实 tool call                             | 无 OS-observable read leak/mutation/process start             |
| process authority external path | shell 参数写 Location 外                   | 当前可能成功；不得称 Location sandbox                         |
| process authority network       | loopback listener probe                    | 当前可能连接；属于 coarse host delegation                     |
| unknown capability              | 仅 `organization.approve`                  | 不意外开放 tool                                               |
| missing/wrong Basic auth        | 每个 principal route                       | 401、无 state/event mutation                                  |
| no-password permission path     | Session/tool issue/revision                | 若可完成，auth claim 限于 direct routes                       |
| direct DB rewrite               | Contract/event/head tamper                 | out-of-model；展示 assumption，不算产品 fault rate            |

每项保存输入坐标、pre/post Contract、binding、frontier、artifact hash、OS side-effect oracle、wall time 和故障 phase marker。

## 5. 公平强基线

主基线 `CI-DQ` = CI + immutable artifacts + durable queue，不使用无恢复能力 agent 或 prompt-only strawman。

`CI-DQ-Core` 必须具有与 treatment 相同的 SQLite、scheduler cadence、Location、model、tools、Snapshot/replay/evaluator、auth、budget、retry；另有 durable job version、CAS artifact manifest、owner/lease、独立 release service、accepted/rejected decision log 和 consumer export。

`CI-DQ+Deps` 再加入 versioned dependency invalidation，以检验优势是否只来自 dependency graph。

基线不使用 ProContract 的通用 Contract vocabulary、petition/decision/challenge/release reducer 或 `quiet` obligation semantics；但允许最合理的 idempotency key、immutable manifest、crash recovery 和 release RBAC。

公平性规则：

- 两臂共享 Snapshot/replay/evaluator code，只有 settlement controller 不同。
- 同一 fault DSL 在语义对应 checkpoint 触发。
- workload、artifact、budget、retry、auth、clock、DB mode 一致。
- 正常 operation 与 injected faults 分表。
- 不把 baseline 未实现的恢复当作 ProContract 贡献。
- 不把 authorized release 当作 successful delivery。
- 先由非实现者审核 baseline parity，再冻结实验。

## 6. Outcome metrics

Safety：

- Coordinate False Acceptance Rate：错误 actor/revision/spec/subject/policy/dependency 的 authoritative mutation 中 accepted 比例，按 discharge/revision/challenge/release 分层。
- Semantic False Acceptance Rate：独立 oracle 失败的 frozen artifact 被 discharged 比例；仅在 verifier provenance/adequacy 冻结后解释。
- Evidence-Origin Acceptance Rate：missing/tampered/wrong-verifier report 仍被接受比例。
- Stale-Owner Mutation Rate：takeover 后旧 owner/Session 改变 binding/Contract 比例。
- Unauthorized Side-Effect Rate：未委托 tool/process 的 OS mutation/start/connect 比例。
- Support Soundness Error：support 撤回后仍保持 recognized discharged dependent 比例。
- Audit Gap Rate：返回 receipt 但 event/head/state 不对应的比例。

Delivery 与 quality：

- Authorized Release 分开 discharged 与 principal-released；Successful Delivery 要求 exact export 到达 consumer 且通过 frozen oracle。
- Workspace/Release Divergence 单独报告；Useful Artifact Quality 由独立 evaluator 给出，不能由 replay pass 代替。
- Retained Quality after Recovery 和 Regression Preservation。

Availability/liveness：

- Completion Probability within Deadline；Recovery Time 与 p50/p95/p99 tail。
- Escalation Rate 按 infrastructure/budget/verification/provider 分类；另报 Orphan Duration 与 Duplicate Work。
- False Blocking Rate：valid candidate 因 snapshot/replay/auth/scheduler infrastructure 未交付。

Resource accounting：

- 分开 Reserved/Started/Completed provider turns，以及 Reserved/Started/Side-effecting/Completed tool actions。
- 分开 Counter Overshoot 与 Physical Overshoot；另报 Governance Exemption Cost。
- 报告 DB/snapshot/replay latency、bytes、scheduler wakeups。

主 estimand 是 matched budget 下 Successful Delivery 与 Semantic False Acceptance 的联合结果。Coordinate safety、Useful Artifact Quality 和 cost 不合并成单一“成功率”。

## 7. 现有测试、缺口与最小 hooks

### 7.1 已覆盖

`packages/core/test/pro-contract.test.ts` 的 45 项覆盖 exact retry、hash/revision/dependency、actor-label rejection、handoff/replay/discharge 坐标、challenge/support loss、normal transaction persistence、evaluation、lease/retry/deadline、turn/action counters、provider error 分类和 scheduler cycle recovery。

`packages/core/test/pro-contract-replay.test.ts` 覆盖 frozen materialization、live workspace mutation、protected-file tamper、missing artifact、symlink escape、missing executable 和 report write。

`packages/core/test/pro-contract-constitution.test.ts` 只证明 source-shape discipline，不是安全 theorem。

`packages/opencode/test/server/httpapi-pro-contract.test.ts` 覆盖 direct principal routes 无密码 401、配置 Basic auth 后 issue/release/quiet、missing dependency、exact retry 和 policy alias。

### 7.2 关键缺口

- 无 `SIGKILL`/restart 注入到 transaction、issue-binding、dispatch phases。
- 无 disk-full/I/O/torn evidence write 或 response-loss idempotency。
- 无两个真实 process 竞争同一 lease/DB。
- 无 retired Session control tool 与 no-password permission-reply path。
- 无 fabricated replay、report delete/tamper、verifier identity。
- 无 shell 外部 path/network/deadline overrun OS oracle。
- 无未授权 read/write/process 的 real side-effect test。
- 无 Snapshot omission 对 semantic acceptance 的测试。
- 无 ledger startup verifier/external witness。
- 无 lineage/support 对照、consumer delivery metric、CI-DQ baseline、overhead parity。

### 7.3 可直接复用的现有注入点

- `ProContractKernel.transition`：table-driven invalid commands。
- `ProContractOpenCode.claim/reserve*/heartbeat/reschedule`：显式 `now` + 多 owner layer。
- `ProContractScheduler.Service.runOnce`：TestClock + fake `SessionExecution`。
- `SessionExecutionLocal`：injectable `SessionRunner.Service`。
- `ToolRegistry.Materialization.settle`：旧 Session ID + OS marker。
- `ProContractReplay.Service.verify`：替换 Snapshot/AppProcess/Global paths。
- HTTP：`Server.listen` + 独立 temp data + Basic auth fixture。

### 7.4 最小 future harness hooks

只对无法精确命中的 phase 增加一个 test-only checkpoint service：

- `packages/core/src/pro-contract.ts` / internal `execute`：`after-kernel`、`after-state-write`、`after-event-write`、`before-commit`。
- `packages/core/src/pro-contract/open-code.ts` / `issue`：`after-contract-issue`。
- `packages/core/src/pro-contract/scheduler.ts` / `runOnce`：`after-claim`、`after-session-create`、`after-prompt-admit`。
- `packages/core/src/pro-contract/replay.ts` / `verify`：`after-materialize`、`after-checks`、`before-report-write`。
- `packages/core/src/tool/contract-control.ts` / `contract_report_ready.execute`：`after-capture`、`after-replay`、`before-report-ready`。

hook 默认 no-op，只在 test layer 中 defect/notify；不用环境变量。child 到 checkpoint 写 fsynced phase marker，parent `SIGKILL` 并重启同一 temp DB。另保留无 hook black-box kill stress test，检查 hook 是否改变 race。

建议未来文件：`packages/core/test/pro-contract-fault.test.ts`、`pro-contract-authority.test.ts`、`packages/opencode/test/server/httpapi-pro-contract-auth-boundary.test.ts`、`pro-contract-process-recovery.test.ts`、`packages/core/test/pro-contract-baseline.test.ts`。

## 8. 可辩护的 theorem statements

可辩护：

1. **Coordinate-bound discharge safety**：从 well-formed issued state 经 reducer 到达的任一 accepted discharge 都绑定 current revision、canonical spec hash、current handoff subject；配置 replay 时需 matching passed result，且 principal/replay evidence hash 不同。
2. **Executor non-settlement at reducer boundary**：issuer != executor，accepted discharge 要求 actor/verifier label == issuer，所以 executor label 的 discharge 不能 accepted；前提是外层保证 actor provenance。
3. **Revision authorization and dependency-edge stability**：accepted revision 经 executor petition 与 issuer-labeled decision，`requires` 不变；旧 revision 结果不能 settle 新 revision。
4. **Challenge responsibility closure**：accepted challenge 清除 source 和 live-support descendants 的 current support，并保持 scope non-quiet，直到新 discharge 或 authorized release。
5. **Returned-command atomic recording**：在 trusted SQLite/immediate transaction/无 corruption 假设下，成功返回的 receipt 与 event/head、accepted state/attestation 原子提交；rejected command 不改 Contract state但记录 decision。
6. **Reservation ceiling**：若所有 starts 都经 current-owner reserve，则成功 reservation 数不超过 durable limit；不约束 control tools、replay、未媒介 side effect 或 wall time。

不可辩护或只复述假设：

- “accepted Contract is correct”或“hash proves evidence”。
- “principal/executor 已隔离”或“所有 unauthorized mutation 不可能”。
- “ledger tamper-proof”。
- “deadline bounds physical execution time”。
- “authority confines process to Location”。
- “replay 是独立 verifier”。
- “support withdrawal epistemically complete”。
- “ProContract guarantees liveness/exactly-once work/RSI safety”。

论文先给 1–4 的纯状态性质，把 5–6 标为 implementation lemmas。不要用大量隔离假设把 non-bypass 写成形式正确但经验空洞的 theorem。

## 9. 最便宜的决定性 pilot

不调用 provider；使用 deterministic fake SessionRunner、local temp Git/SQLite、loopback listener 和 child Bun process。总运行分钟级，无 Docker、cloud、download 或 benchmark。

P0 两臂：当前 ProContract 与 frozen `CI-DQ-Core`。每臂运行 7 个 fault-free controls，以及 10 组 faults：exact retry/response loss、pre-commit kill、issue-binding kill、post-claim kill、stale owner、retired Session、stale revision/subject、missing/tampered replay report、support-vs-lineage、unauthorized/deadline-crossing process。

确定性 case 各 3 次验证 harness；lease/concurrency/kill case 各 20 次观察 race tail。输出 coordinate/semantic/evidence-origin false acceptance、false blocking、successful delivery、p95 recovery、reservation/physical overshoot 和 normal overhead。

进入完整研究的 gate：

- wrong revision/spec/subject/owner acceptance 为 0，且 valid controls 两臂都完成。
- restart 后无永久 orphan，或 orphan 明确 escalated 且可恢复。
- retired Session 与 permission path 的真实可达性已确定；export 与 current-worktree oracle 分开。
- baseline parity 由非实现者复核，fault injector 在两臂有对应语义。

Stop/pivot：

- retired Session、permission path 或 normal API 越过 principal boundary：停止 non-bypass claim，限定 trusted-caller coordinate safety。
- T2/T3 隔离后 fabricated/missing evidence 仍 accepted：停止 evidence-bound settlement claim。
- process 越界或 physical deadline overshoot：分别改称 coarse delegation、admission accounting。
- `CI-DQ+Deps` 等价，或 ProContract false blocking/recovery 更差且无 safety gain：pivot 到抽象/责任语义/constraint placement。
- semantic false acceptance 主要由 verifier inadequacy 决定：收窄为 identity integrity。
- kill hook 改变 race/phase 不稳定：只保留定性 mechanism test；只有 P0 在至少两类 fault 上可重复，才扩展 paid campaign。

## 10. 本次执行记录

未修改 runtime、既有 docs、tests、branch 或 commit；未使用 provider、外部 network、Docker 或 cloud。HTTP 测试使用本地服务。

从 `packages/core` 执行：

`bun test test/pro-contract.test.ts test/pro-contract-replay.test.ts test/pro-contract-constitution.test.ts`

结果：47 pass，0 fail，219 assertions，3 files。

从 `packages/opencode` 执行：

`bun test test/server/httpapi-pro-contract.test.ts`

结果：3 pass，0 fail，21 assertions，1 file。

这些结果只支持现有测试覆盖，不支持尚未执行的 fault、isolation、baseline 或 semantic-quality 结论。
