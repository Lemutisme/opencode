# S5 独立实现审查

日期：2026-09-19。状态：独立实现审查通过。C1–C6 均已修复并完成复核，最终源码、接受测试和相关兼容回归证据已核验，未发现未解决的 P1／P2 问题。

差异基线为 `/tmp/opencode-s5-baseline/`，manifest SHA-256 为 `a9fcae0c4c85fd1e599d918136ae24c913d0714f84962d8e37162d1a449b4446`，没有以当前 `HEAD` 将 S1–S4 的未提交内容重新归属 S5。获批 [S5 设计](pro-contract-researcher-s5.md) SHA-256 为 `91a403dfd33fcc01d1d727377f947d08d4971ccfdc83d959f0ab7e23a9023879`；参照 [独立设计审查](pro-contract-researcher-s5-review.md)。

最终源码清单为 `/tmp/s5-source-freeze.json`，SHA-256 `5555fb1ca78ab4d9025b35531f3c29bbf5d473c1d98834aba9df73ea851e0ae0`。独立对比确认 28 个代码／测试文件全部匹配，无遗漏或多余代码／测试差异，最后复核结果为 `/tmp/s5-review-final-freeze-check.json`。此前 26 文件候选保存于 `/tmp/s5-source-before-native-fix.json`，SHA-256 `be3bc37dd67ceccc5a270c28db0f710f4eb98de6de4f1328382df89641867cf4`；此后仅增加 `open-code.ts` 的 native context 旋转修复、`pro-contract-driver.test.ts` 的两项回归，以及 `pro-contract.test.ts` 对相同 native 行为的预期更新。四份 S4 设计、设计审查、实施记录与代码审查文档均与原基线相同。

审查者读取 Core admission／permit／execution context／control request，以及 SDK planning、protocol、reviewer、plan evidence、阶段协调与认定 validator。没有修改实现、测试或 S4 历史文件，没有启动研究实验或重型并发回归；工作树唯一写入为本报告。

## 可修复发现

| 编号 | 级别 | 问题                                                                             | 当前状态                                                    |
| ---- | ---- | -------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| C1   | P1   | profile 查询返回新 validator 对象，所有研究 exact 认定被最终身份 CAS 拒绝        | 已修复；稳定对象独立探针及 S4／S5 实际认定回归通过          |
| C2   | P2   | 最终验证遗漏计划附加保护文件的执行前后 receipt                                   | 已修复；非空附加保护 E2E 与 Core replay 回归通过            |
| C3   | P2   | 最终评审的合法 unavailable 报告提前消耗发布 context，重试无法认定                | 已修复；只归档不推进 context，显式重试及 exact 认定通过     |
| C4   | P1   | pending revision 被拒绝后仍可恢复旧计划批准和实验记录                            | 已修复；Core 原子撤销、旧 permit／认定 CAS、S5 重新规划通过 |
| C5   | P2   | 只读摘要请求在写事务内执行文件 I/O，且 stat 后读取没有实际字节上限               | 已修复；事务外硬上限读取及实际工具返回值 E2E 通过           |
| C6   | P2   | native petition 撤销 context 后，sweep 先退租会使 claim 复用已有工作的旧 Session | 已修复；独立两项回归与原样 S1 十项进程测试通过              |

### C1：validator 对象身份不稳定，S4 和 S5 的 exact 认定均回退

首轮 `ResearchAdapters.validatorNode.get` 对每次查询执行 `{ ...validator, identity: profile }`。Core `principalAttest` 在材料 I/O 前保存 validator 对象，最终事务重新查询后检查 `active !== validator`。因此材料即使全部有效，也必然被拒绝为 `recognition validator changed during verification`；影响 `research-final:1` 和 `research:1` 两个 profile。

修复要求每个 profile 在 layer 建立时创建一个稳定对象，后续查询复用，仍保留两者独立 identity。不能删除 Core 的最终 CAS 来容忍这种不稳定性。

实现方已改为稳定的 `validator` 与 `planned` 对象。独立探针构造实际 validator 服务和内存 SQLite，分别连续两次调用两个 profile 的 `get`，两者均为 `sameObject: true`，identity 也分别正确。日志 `/tmp/s5-review-validator-identity.log` 是修复后的证据，不冒称修复前运行。冻结源码保持该实现，S4 和 S5 完整流程的实际 external exact recognition 均已通过。

### C2：最终 replay 只检查固定 harness，遗漏计划的附加保护 receipt

首轮 verifier 仅在 `purpose="experiment"` 时把 `plan.protected` 加入 policy；最终 delivery 分支传空列表。最终 validator 同样只比较 `manifest.verification.harness`。所以非空计划保护文件虽然接受了正式实验的检查，最终 replay 没有它们的 before／after receipt，不满足冻结设计第 4 节的最终保护检查要求。

最终 subject 与成功正式实验 subject 相等提供了间接约束，因此本项不声称已经复现任意源码逃逸；问题是最后一次实际执行及其证据缺少获批保护输入的直接检查。

修复不能直接改写 Principal 已冻结的 `spec.evidence.replay` 或放宽 Core `reportReady` 对 `policyHash` 的 exact 比较。实现方已增加通用 `additionalProtected`：不改变原 policyHash，只增加保护检查，并绑定不可变 job 输入及实际 replay 的 ExecutionContext fingerprint；最终 validator 重新核对声明和合并 receipt。独立静态复核确认 replay 将它与原 policy 的 protected 合并，用于执行前、执行后和 fresh artifact 清理的路径保护；额外检查只增强约束。最终 validator 同时核对 job 的附加声明与合并 receipt。S5 完整流程已包含非空附加保护文件的最终 before／after 断言并通过；Core artifact／replay 回归也已通过，并检查原 policyHash 不变。

### C3：最终 unavailable 报告后重试破坏限定的 context 链

首轮最终 reviewer 返回合法 `verdict="unavailable"` 时，仍无条件调用 `setRecognitionContext`，将 handoff context 推进到原执行版本加 2，并保存 `resumeStage="review"`。此路径未设置 `replan`。

随后 `recover(id, { retry: true })` 创建的新 reviewer 使用这一加 2 context；accept 后再次发布为加 3。`ResearchPlanEvidence.validate` 正确要求 plan review、experiment 和 final verification 共享原执行 context，final review 只能加 1、published 只能加 2。因此重试能够进入 ready，却必然在 exact 认定时失败。

本问题区别于 malformed JSON：后者在发布前抛错，通常保留原 handoff context，可以按正确链创建新 reviewer。不能借放宽 validator 为只比较 revision／specHash 来修复合法 unavailable 的路径。

建议 S5 的非 accept 最终报告只归档，不消耗认可发布转换；或者明确停止并要求外部 challenge 后重新规划。无论选择哪条，都必须与 API 的恢复语义一致。实现已对 S5 合法 unavailable 只保存 report／bundle 和恢复阶段，不调用发布 context 转换；旧 job 输入仍保持原坐标。`recovers a valid unavailable final review and preserves exact recognition identity` 已在 S5 进程日志中通过，覆盖显式重试及真实 exact 认可。

### C4：修订申请的暂存与拒绝未永久撤销旧批准

Core 的 `petition-revision` 和拒绝 `decide-revision` 均不推进 recognition context；仅接受修订才推进。首轮 S5 `close` 只有在 context 改变时清除 `plan.approved` 和 `experiment`。

可达路径是：当前计划已批准、正式实验已成功；worker 提出 revision petition；S5 观察到 pending revision 后关闭 admission，但保留旧批准和实验；Principal 拒绝申请；显式 `recover` 恢复 execution，旧实验可继续用于 ready。这与设计第 6 节“pending revision 后旧批准不得继续使用”的失效规则不符。

独立实际 Core 服务探针执行 issue、petition、拒绝 decision，三项命令均 accepted；pending 期间和拒绝后的 context 均与原始 context 完全相同。日志为 `/tmp/s5-review-pending-context.log`。S5 后续恢复路径的判断来自生产代码静态核对，不将这个 Core 小探针称为完整 S5 E2E。

第二轮的 `revisionEpoch` 中间修复从持久 ledger 查找 accepted petition，能阻止 SDK 阶段提交，却未进入实际 worker／job 准入和 Core 认定的最终事务。独立探针在生产 planned driver、ExecutionPermit 和 SQLite 中捕获 permit，然后在同一事务提出并拒绝 petition：epoch 从 -1 变 2，旧 write capability 和旧 provider operation callback 仍获准进入，日志 `/tmp/s5-review-petition-permit.log`。这里没有调用真实 provider，证明的是生产 operation 准入与记账路径。认定也存在对应的 I/O 后窗口：旧 epoch 已校验，随后 petition／reject 完成，原 target 未变，最终 CAS 无法看见这一失效。基于实际准入缺口，本项提升为 P1。

最终修复改在 Core accepted `petition-revision` 的同一事务中推进通用 recognition context；拒绝 petition 不回退它。新 target 保留原 revision／specHash 和已有 handoffID，产生新 version／phaseID；non-native 的旧 admitted 状态不继承。旧 worker permit、旧 job root context 和认定 I/O 后的 exact target CAS 因此都立即失效。中间 SDK epoch 方案已移除，没有保留两套撤销坐标。

独立修复后探针确认 planned context 从 2 到 3，旧 write 与 provider operation 均为 Failure。native 的 handoffID 被保留，Recognition view 仍可用，旧 target 被拒为 `recognition target does not match the current handoff`，当前 target 可认定。日志为 `/tmp/s5-review-petition-fixed.log`。静态核对表明 native 旧 drain 会退租，后续 claim 可绑定新 context 并维持原 attempt；S4/S5 非 native admission 则必须由宿主重新授权。Core 包含 native control 的回归、S4 完整流程及新 S5 修订拒绝后的计划恢复用例均已通过。

独立运行新增的 Core 认定 I/O 竞态用例，在实际 validator 暂停后提出并拒绝 petition，再释放旧 validator；最终 exact CAS 拒绝旧 target，1 pass／0 fail／10 assertions。SDK 同事务 petition／reject 用例也已独立运行，旧 coordinator guard 被拒，1 pass／0 fail／6 assertions。两者分别记录于 `/tmp/s5-review-petition-cas.log` 与 `/tmp/s5-review-petition-guard.log`。

### C5：只读摘要操作的 I/O 与上限边界

实现方补充 `inspect_inputs`，让没有 process 权限的 Researcher 通过只读请求获取计划保护文件的 SHA-256。这个补充不授予计划批准或阶段转换，属于自主规划所需的观察能力。

初稿将 realpath、stat 和 readFile 放在外层 `state.atomic` 中，会在整个文件读取期间占用数据库写事务，使并发取消／撤销不能在结束前生效。其长度检查先累计 stat，再无界 readFile，最后才比较实际长度；文件增长时仍可能先读入超过声明上限的数据。

修复已将整个观察分支移出写事务，使用 scoped 文件句柄和 64 KiB 分块 SHA-256，按 16 MiB aggregate 实际读取量加 1 字节检测超限；stat 只是提前拒绝条件。请求限制 1–64 个 literal workspace 路径，realpath 必须在 workspace 内，文件必须是 regular file；读取前后均校验原 execution、context、研究阶段、原 deadline，以及 Spec 和 admission 的 read 能力。整次 I/O 另受原 deadline 与 30 秒操作期限中的较早者限制。`deliveryNode` 已提供 FSUtil 服务与依赖，generic tool 仅增加可选返回结果。静态复核及生产 E2E 均通过，后者从实际工具返回值取得摘要并用于构造计划；不将此观察视为原子文件快照或恶意进程隔离。

### C6：native 撤销 context 后的 Session 旋转遗漏

完整历史进程回归的两项 S1 同内容修订申请 ABA 测试均失败：无论旧权限回复为 once 还是 reject，替代 Session 都未能出现，错误为 `Replacement Session never claimed the expired lease`。日志保留于 `/tmp/s5-previous-process.log`。

静态定位表明 C4 增加的 petition context 变化使 `sweep` 进入 inactive 分支，调用 `retire` 清除 dispatched 与 lease，但保留旧 Session ID。Principal 拒绝 petition 后 revision 和 attemptKey 不变，后续 `claim` 的 rotate 只检查 attemptChanged 或 leaseExpired；因退租已清除后者，它把新 context 绑定到了已有工作的旧 Session。

独立实际 Core／SQLite 小探针执行 native issue、claim、准入一次 turn、petition、reject、sweep、再次 claim，得到 context 从 1 到 2，`sameSession: true`、`samePrompt: false`、attempt 从 1 到 1，累计 turn 保持 1，记录 `/tmp/s5-review-native-context-before.log`。该证据证明 Session 旋转遗漏，不声称旧 permit 已重新获得新 context 的权限。

修复仅对 native 在已有 attempt 且 binding context 与当前 target 不同的 claim 中旋转 Session／Prompt，同时保留 semantic attempt、attemptKey、原期限和累计用量。non-native 仍需显式 `setAdmission(open: true)`，该边界已提前创建新 Session；本次不再改写自定义 host 已取得的新 Session 身份。新旧冻结源码比较也确认所有 non-native 分支及 S4／S5 SDK 代码保持相同。

实现方新增的本地 cleanup 和远端 lease expiry 两项实际 sweep→claim 回归，修复前均失败，日志 `/tmp/s5-native-context-before.log`。修复后审查者独立从 `packages/core` 运行 `bun test test/pro-contract-driver.test.ts -t 'rotates a revoked native Session' --timeout 15000`，2 pass／0 fail／26 assertions，日志 `/tmp/s5-review-native-context-fixed.log`。测试检查新 Session／Prompt、generation 递增、attempt 与累计用量不变、旧执行被拒和原 deadline 不变。最终原样 S1 十项进程用例全部通过，包括两种旧权限回复的 ABA 场景与 pending revision 的 SIGKILL 恢复；Core 八文件最终回归也全部通过。

Core 旧 `pauses one attempt while the principal decides a revision` 用例原先断言拒绝 petition 后复用 Session；现同步为保留同一 attempt／计数但必须更换 Session／Prompt、推进 context 并拒绝旧 Session 的 turn reservation。该调整匹配 C4／C6 的撤销语义，focused 用例已通过；原样 S1 ABA 进程测试没有为规避失败而改写。

## 独立验证

| 检查                                                           | 结果                                                                                                         | 证据                                              |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| 实际 validator 服务，两 profile 连续查询                       | 修复后两者对象身份稳定，profile identity 正确                                                                | `/tmp/s5-review-validator-identity.log`           |
| 实际 Core revision petition 与拒绝，SQLite                     | 三条命令 accepted；pending 期间和拒绝后 context 均不变                                                       | `/tmp/s5-review-pending-context.log`              |
| 实际 ExecutionPermit、planned driver 与 SQLite，两阶段能力矩阵 | exploration 拒绝 write／process／reference／compose；execution 仅新增 write；关闭 admission 后旧 permit 被拒 | `/tmp/s5-review-permit-matrix.log`                |
| 实际受控 Node 协议四项测试                                     | 4 pass、0 fail、12 assertions                                                                                | `/tmp/s5-review-planning-protocol.log`            |
| 中间 SDK epoch 修复的实际旧 permit 探针                        | petition／reject 后旧 write 和 provider operation 仍 Success，确认该修复不充分                               | `/tmp/s5-review-petition-permit.log`              |
| 最终 Core context 修复的旧 permit 与 native 探针               | 旧 write／provider Failure；native handoff 保留，旧 target 拒绝、当前 target 接受                            | `/tmp/s5-review-petition-fixed.log`               |
| Core 认定 I/O 后的 petition／reject exact CAS                  | 1 pass、0 fail、10 assertions                                                                                | `/tmp/s5-review-petition-cas.log`                 |
| SDK 同事务 petition／reject 与旧 coordinator guard             | 1 pass、0 fail、6 assertions                                                                                 | `/tmp/s5-review-petition-guard.log`               |
| native petition／reject 后实际 sweep→claim，修复前             | context 1→2，却 sameSession=true；attempt 和累计 turn 均未重置                                               | `/tmp/s5-review-native-context-before.log`        |
| native 本地清理和远端租约过期的 sweep→claim，修复后            | 2 pass、0 fail、26 assertions；旋转 Session／Prompt，保留 attempt、用量和 deadline                           | `/tmp/s5-review-native-context-fixed.log`         |
| 最终 28 文件源码／测试格式与 diff 检查                         | 全部通过 Prettier check；`git diff --check` exit 0                                                           | `/tmp/s5-review-source-format.log` 与本轮工具结果 |

Node 测试从 `packages/sdk-next` 运行 `bun test test/research-planning.test.ts --timeout 15000`，使用 `/tmp/opencode-research-toolchain/bun-linux-x64/bun`。覆盖真实测试与显式输出、保护文件写后恢复与 child process 拒绝、候选打印伪 TAP 后提前退出不能通过、输出路径 symlink／hardlink 不能获得保护文件写权限。测试使用真实 Node 子进程和文件，不调用研究模型。

能力探针直接调用生产 `ExecutionPermit.tool/context`；readOnly 和 process 字段分别为 exploration 的 `true/false`、execution 的 `false/false`。它证明实际服务的授权矩阵和版本撤销，不代替 canonical tool、等待中权限、跨进程和取消的完整生产测试。

已读取实现方 `/tmp/s5-process-final-candidate.log` 的完整 summary：8 pass、0 fail、96 assertions，包含主流程、最终 unavailable 重试、两种越界 scope、计划替换／保护输入变化、plan review 取消／重启／显式恢复及原 deadline。此日志产生于最终 Core petition 撤销修复前，不替代修复后的兼容回归或最终冻结证据。

## 实现方最终回归的独立核对

下列测试由实现方执行，审查者读取了实际日志和相应用例，并未把它们计作审查者自行运行的测试。C6 之后仅 native claim 和相应 Core 测试变化；此前 S4／S5、SDK 路径和测试源码保持相同，其已通过结果继续作为这些路径的证据。最新 Core 和 native 结果分别列出，不把修复前失败的历史整组日志写成全部通过。

| 范围                                                                                      | 结果                                                                            | 日志                                                                                                               |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| S5 生产进程完整流程                                                                       | 12 pass、0 fail、153 assertions；最后一个用例的冻结版新增断言另行补验，见下一行 | `/tmp/s5-process-verified.log`                                                                                     |
| 冻结版 plan reviewer 未知执行的显式恢复补验                                               | 1 pass、0 fail、11 assertions，11 项 filtered                                   | `/tmp/s5-plan-recovery-frozen.log`                                                                                 |
| S4 生产进程兼容回归                                                                       | 21 pass、0 fail、157 assertions                                                 | `/tmp/s5-s4-regression.log`                                                                                        |
| 最终 Core 八文件，含 permit／job、native control、recognition CAS、replay 与 FileMutation | 146 pass、0 fail、911 assertions                                                | `/tmp/s5-core-accepted-final.log`                                                                                  |
| SDK 五文件                                                                                | 24 pass、0 fail、77 assertions                                                  | `/tmp/s5-sdk-verified.log`                                                                                         |
| 最终原样 S1 native 进程流程                                                               | 10 pass、0 fail、151 assertions                                                 | `/tmp/s5-native-process-fixed.log`                                                                                 |
| 最终 S2 CLI 修订决定与重试 receipt                                                        | 1 pass、0 fail、6 assertions，4 项 filtered                                     | `/tmp/s5-native-cli-fixed.log`                                                                                     |
| HTTP Contract／SDK／schema 错误体／OpenAPI／authorization 五文件                          | 53 pass、0 fail、290 assertions                                                 | `/tmp/s5-http-regression.log`                                                                                      |
| Core／SDK／OpenCode 冻结源码类型检查                                                      | 分别从包目录执行 `bun typecheck`，三项 exit 0                                   | `/tmp/s5-core-accepted-check.log`、`/tmp/s5-sdk-final-freeze-check.log`、`/tmp/s5-opencode-final-freeze-check.log` |

历史四文件进程整组 `/tmp/s5-previous-process.log` 实际为 26 pass、2 fail、300 assertions；失败的正是 C6 的两项 S1 ABA 场景。该日志中 job 11 项、driver 2 项、recognition 5 项均已通过。C6 修复后，原样 S1 全部重跑通过，并另跑直接涉及修订的 S2 CLI 用例；不将旧整组日志伪记为全绿。

S5 完整流程从 canonical `inspect_inputs` 的实际 tool 输出读取 `result.protected`，再提交计划，不再由测试 fixture 将预先计算的摘要作为计划输入。读取拒绝用例覆盖路径逃逸、symlink、非普通文件、单文件／aggregate 超限与路径数量。修订拒绝用例确认旧计划和实验被撤销，恢复只读 exploration 后须提交新版本计划。正式实验取消保留 interrupted 记账，SIGKILL 后保留 unknown 记账且不自动重跑。本次未知实验恢复日志明确为 `replan: false`、context 2 到 2，测试走显式新 job 与 `previousJobID` 路径；不声称本轮同时执行了 context 撤销后的实验重规划分支。独立修订撤销用例覆盖新 context 下重新规划。

## 签署结论与适用范围

C1–C6、新源码冻结、S5 接受流程、Core／native、S4、HTTP、类型与格式检查均已完成复核，冻结版 plan reviewer 恢复补验也已通过。实现方自行发现并修正的 experiment `inputHash` 未绑定 plan／approval／purpose 的问题已在生产代码的 job 创建与 `ResearchPlanEvidence.validate` 两侧核验，不归为审查者首次发现。

批准上述冻结源码作为 S5 实现：显式 `planning: true` 的 `research:1` 计划审查、阶段许可、受控 Node 实验和最终 exact 认可链满足本切片设计；省略 planning 的 S4 路径保持兼容。批准范围限于固定 Node TAP 适配器和已述接受测试，不包含真实 reviewer 的科学判断质量、S6 资格验证或恶意代码 OS sandbox；隔离仍为 `cooperative`。

签署：独立实现审查者 `/root/research_implementation_review`，2026-09-19。结论：通过。
