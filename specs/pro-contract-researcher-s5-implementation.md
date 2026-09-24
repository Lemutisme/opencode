# S5 实施与验证记录

2026-09-19。状态：实现、接受测试与独立代码审查均已通过。C1–C6 全部闭合。

## 范围与入口

本切片新增显式选择的 `research:1`。嵌入式宿主继续使用 `OpenCode.create({ research: true })`，发行任务时指定 `research.issue({ planning: true, ... })`。省略 `planning` 保持 S4 `research-final:1`。原生 Contract 不自动升级。

Principal 的原始任务、固定方法/数据、验收要求、权限和绝对 deadline 不由 Researcher 计划改写。Researcher 在该任务内通过 `contract_request({ kind: "plan", payload: Plan })` 提交版本化计划；独立只读 Session 对照原始任务和清单审查。`accept` 还必须有 `scope: within_task`、有效证据引用且无阻断 finding。范围不明或需要外部修订时，只开放规划所需读取和控制请求。

通过后开放实现所需写入；任意 bash、reference 和组合执行仍不开放。正式实验通过 `contract_request({ kind: "experiment", payload: {} })` 请求，关闭 worker admission、等清理屏障、冻结候选，再运行受控验证 job。实验通过后可请求最终交付；最终冻结 subject 必须与该实验一致。最终 review 和外部 exact 认可沿用 S4 的机制，并重新检查计划、审查和实验的来源。

## 实现位置与设计细化

- Core：`Binding.admission.capabilities` 和 `ExecutionPermit` 叠加原始权限；canonical `contract_request` 路由当前 profile；FileMutation 与 replay executor 保留真实叶子限制。Core 不解释研究阶段。
- SDK：`research/planning.ts` 处理计划请求、独立审查及批准；`protocol.ts` 固定有限实验协议与阶段提示；`reviewer.ts` 共用审查环境和最终消息来源检查；`plan-evidence.ts` 验证计划到最终发布的 exact 身份链。原 coordinator 继续负责事务、期限、取消、恢复和最终交付。
- 规划和执行中的 `inspect_inputs` 返回 `{requested:true,result:{protected:[{path,hash}]}}`，只提供观测，不批准输入或关闭 admission。它在数据库写事务外读取工作区内普通文件，逐块计算 SHA256，单次最多 64 个路径、合计 16 MiB、30 秒且不超过原 deadline；开始和结束均重新验证原 execution、context、阶段与读取权限。真实读取受上限约束，不依赖事前 stat；文件增长不能先无限分配后拒绝。端到端测试使用真实返回的 `result.protected` 构造下一计划。
- Core 在接受修订 petition 的同一事务中推进通用 recognition context；拒绝 petition 不回退这一坐标。旧 worker permit、job 和最终认可 CAS 都立即失效，即使提出和拒绝发生于两次 SDK 轮询之间，或发生于认可 validator I/O 之后。保留已有 handoff 身份，使原任务仍可被准确检查或外部 challenge。新计划仍由 Researcher 提交，不让内部 reviewer 决定外部修订。
- 原生 Contract 的隐式重新准入在 context 改变后创建新 Session／Prompt。清理流程会先退租；不能只靠 `leaseExpired` 判断是否换 Session。该补充仅针对 native driver，非原生宿主仍由 `setAdmission(open: true)` 创建新 Session。保留同一 semantic attempt、完整用量和原 deadline。
- 最终合法 `unavailable` 报告只归档，不消耗发布 context 转换。显式 retry 使用新 job lineage；成功后仍满足原执行 context → handoff → published 的两次合法转换。其他撤销造成的 context 改变必须重新规划；已 handoff 时需要外部 challenge 才可回到执行。
- 正式实验的 policy 包含计划额外保护文件；最终验收的 policy 必须保持发行时的 hash，因此 generic job/replay 的 `additionalProtected` 只增加宿主检查，不能替换原 policy。它属于不可变 job 输入及执行 permit fingerprint，最终 replay 对合并集合记录 before/after，认可验证器同时核对额外集合与 receipt。这样增加计划约束时不会改写 Principal 验收 policy。

SDK 增加的数据保存在原有 JSON run/event 和内容对象中，无数据库迁移；没有改变公共 Protocol/HttpApi，无生成客户端修改。所有改动以 `/tmp/opencode-s5-baseline/manifest.json` 为基线，不能把 S1–S4 未提交内容误算成 S5。

## 实验运行限制

宿主按 hash 固定独立 `runner.mjs`，父进程只负责 Node test orchestration 和 TAP reporter，不加载候选。测试子进程启用 Node permission，读取冻结目录，只可写清单明确声明的 generated 文件，不授予 child process、worker 或 native addon 权限。测试框架不支持这些参数时失败关闭。

原始设计中的同进程 reporter 被独立设计审查发现可由候选伪造 TAP 并提前退出，已改为父子进程分离。实际反例测试确认伪造内容成为注释，缺失的真实测试不能通过。运行期间修改保护文件再恢复，以及借输出路径建立 symlink/hardlink 或启动子进程，也有真实 Node 反例测试。

隔离仍为 `cooperative`，不是恶意代码 OS 沙箱；网络、原生运行时漏洞、宿主同用户进程不因此获得强隔离保证。适配器仅覆盖当前固定 Node TAP 协议；其他研究计算需要另行设计适配器。测试 provider 是确定性 HTTP fixture，验证的是实际生产状态机和强制机制，不衡量真实 reviewer 的方法判断质量。

## 独立审查与验证

源码／测试冻结清单为 `/tmp/s5-source-freeze.json`，SHA256 `5555fb1ca78ab4d9025b35531f3c29bbf5d473c1d98834aba9df73ea851e0ae0`，包含相对 S5 编辑前基线的 28 个变更文件。独立审查者已核对 28/28 文件、完整差异集及未变的 S4 历史文档；全部接受测试已完成，最终签字见 [独立代码审查](pro-contract-researcher-s5-code-review.md)，报告 SHA256 `2ef26deb4cc63949125913827a53174909410cc963b39586a010bd8504962108`。

冻结设计：[S5 设计](pro-contract-researcher-s5.md)，SHA256 `91a403dfd33fcc01d1d727377f947d08d4971ccfdc83d959f0ab7e23a9023879`；[独立设计审查](pro-contract-researcher-s5-review.md) 已通过。

实施过程中的独立代码审查发现并修复六项问题：不同 profile validator 必须保持稳定对象身份；最终 replay 须保留额外计划保护文件的实际 receipt；最终 `unavailable` 不得提前推进发布 context；修订 petition 的失效必须进入 Core 原子事务；输入观测不得在写事务中执行无限文件读取；原生执行在被撤销上下文后重新 claim 必须更换 Session。修复、复核及源码指纹见 [独立代码审查](pro-contract-researcher-s5-code-review.md)。

验证使用 Bun 1.3.14、Node v24.21.0；重型进程套件串行执行。接受测试证据：

- `/tmp/s5-plan-recovery-frozen.log`：最终冻结版本的计划 reviewer 崩溃恢复补验 1 pass / 0 fail / 11 assertions（11 项未选中）。整组 12 项运行时已加载补充断言前的测试，故对此用例单独复验；其余 11 项未再改动。
- `/tmp/s5-native-process-fixed.log`：修复后的原样 S1 进程整组 10 pass / 0 fail / 151 assertions；`/tmp/s5-native-cli-fixed.log`：CLI 修订补验 1 pass / 0 fail / 6 assertions。此前 28 项旧进程回归中的另外 18 项已通过；独立审查确认最终 native 条件不改变非原生 driver/job 路径。
- `/tmp/s5-http-regression.log`：公共 HTTP、两代 SDK、OpenAPI、错误响应与权限边界 53 pass / 0 fail / 290 assertions。
- `/tmp/s5-core-accepted-final.log`：Core 8 个相关文件 146 pass / 0 fail / 911 assertions，包括捕获的旧 worker/job 许可拒绝、validator I/O 后 petition／reject 的 exact CAS、额外保护 receipt 和原生控制回归。
- `/tmp/s5-sdk-verified.log`：SDK 5 个相关文件 24 pass / 0 fail / 77 assertions，包含真实 Node 协议、schema、durable store、TAP 与受控 job。
- `/tmp/s5-process-verified.log`：S5 完整生产流程 12 pass / 0 fail / 153 assertions。覆盖真实输入观测到计划提交、阶段许可、范围拒绝、非空保护文件、替换计划、正式实验、最终交付／exact 认可、缺失或篡改材料、修订拒绝后重新规划、取消、SIGKILL 与原始期限。正式实验崩溃恢复本次实际走 `replan: false`、context 2 → 2 的显式新 job 路径；不据此声称已执行该用例中的 context 撤销分支，后者的重新规划行为另由修订用例覆盖。
- `/tmp/s5-s4-regression.log`：S4 完整交付进程回归 21 pass / 0 fail / 157 assertions，含 Core petition 撤销后的兼容验证。
- `/tmp/s5-core-accepted-check.log`、`/tmp/s5-sdk-final-freeze-check.log`、`/tmp/s5-opencode-final-freeze-check.log`：三个变更包的 `bun typecheck` 通过。
- `/tmp/s5-protocol.log`：真实受限 Node 协议 4 pass / 0 fail / 12 assertions。

早期失败记录保留：`/tmp/s5-process-first.log` 为新增工具缺少受控 Session catalog 入口；`/tmp/s5-process-second.log` 为实验 job 的 inputHash 漏绑计划字段；`/tmp/s5-state-protocol.log` 的修订回归失败为测试误用 `recognition.revision` 而非 `recognition.pending`。新增检查的第一轮 `/tmp/s5-process-acceptance.log` 另暴露两项测试夹具错误：worktree 的 `.git` 是普通文件，不能用来测试目录拒绝；Bun.Glob 在临时目录尚未创建时抛出缺陷，改为容忍目录尚不存在的普通目录轮询。类型检查也曾指出测试 transport 对象误标为内部 branded path，已校正类型。`/tmp/s5-process-final.log` 还暴露两处恢复测试的错误假设：`unavailable` 出现时 worker 清理可能尚未完成，测试应等待实际 binding 退租；未知实验恢复若已撤销 context，则必须重新规划而非直接复用旧批准。保留生产限制，修正测试等待及两种合法 context 路径，并在最终日志明确实际执行的分支。兼容回归 `/tmp/s5-previous-process.log` 为 26 pass / 2 fail：两个既有 S1 ABA 修订用例发现 Core 撤销上下文后 sweep 先退租、claim 随后复用了原 Session 的生产回归（C6），并非偶发超时。新增实际 Core／SQLite 回归在修复前 2 fail，修复后 2 pass；修复只补 native 的 Session 旋转，不放宽旧许可。前一候选冻结清单保留为 `/tmp/s5-source-before-native-fix.json`（`be3bc37dd67ceccc5a270c28db0f710f4eb98de6de4f1328382df89641867cf4`）。独立审查核对新旧冻结只差该 native 条件、两项新增测试及同步后的既有 pause 测试预期，因此已通过的 S5／S4 非原生路线结果继续适用；原生进程套件原样复跑。Core 整组曾为 145 pass / 1 fail（`/tmp/s5-core-native-final.log`）：旧 pause 单元测试仍要求复用 Session，与新的上下文撤销语义及既有 S1 ABA 进程要求冲突；已同步为新 Session／Prompt，并保留同 attempt、计数和旧 Session 拒绝断言。这些失败记录不作为通过证据，修复后的测试结果另列。

可复现命令（在对应包目录运行）：

```sh
# 本次环境的 Bun 工具链
export PATH=/tmp/opencode-research-toolchain/bun-linux-x64:$PATH

# packages/core
bun test --timeout 15000 test/pro-contract-artifacts.test.ts test/pro-contract-job.test.ts \
  test/pro-contract-driver.test.ts test/pro-contract-recognition.test.ts \
  test/pro-contract-control.test.ts test/pro-contract.test.ts \
  test/pro-contract-replay.test.ts test/tool-write.test.ts
bun typecheck

# packages/sdk-next
OPENCODE_DB=:memory: bun test --timeout 15000 test/research-planning.test.ts \
  test/research-schema.test.ts test/research-store.test.ts test/research-tap.test.ts \
  test/contract-jobs.test.ts
bun typecheck

# packages/opencode：依次执行
bun test test/server/pro-contract-planning-process.test.ts
bun test test/server/pro-contract-research-process.test.ts
bun test test/server/pro-contract-process.test.ts \
  test/server/pro-contract-recognition-process.test.ts \
  test/server/pro-contract-driver-process.test.ts test/server/pro-contract-job-process.test.ts
bun test --timeout 30000 test/server/httpapi-pro-contract.test.ts test/server/httpapi-sdk.test.ts \
  test/server/httpapi-public-openapi.test.ts test/server/httpapi-schema-error-body.test.ts \
  test/server/httpapi-authorization.test.ts
bun typecheck
```

没有启动真实研究任务、ProgramBench cohort、发布、提交或合并。本切片不替代 S6 的科学质量资格验证。
