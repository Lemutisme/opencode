# S4 独立代码审查

日期：2026-09-19。结论：通过。冻结源码、独立针对性测试及最终集成证据均已复核，A1–A7 已闭合，没有尚未修复的 P1／P2。

本审查以 S3b 已验收快照 `/tmp/opencode-s4-baseline/files` 为差异基线，不以当前 `HEAD` 归属 S4 改动。基线 manifest SHA-256 为 `4adc5aafbdd82071dcbebcfc4aa0e152283c6ff6b516cab5f9ff208c4a2da580`。获批 [S4 设计](pro-contract-researcher-s4.md) SHA-256 为 `f94a1f624ae0d01040705ef127f1cd522060149b2c2914e681baceb5d9253926`。

结论仅针对 `/tmp/s4-source-freeze.json` 中的 27 个源码、测试及 lock 文件，manifest SHA-256 为 `bceab5336b8254cde9bcc4d9268f5d9bc584c3b3c57b239b1139f3a984b8cf06`。审查者逐项核验文件 hash，全部匹配；与 S3b 基线比较，未发现清单外的非 Markdown 改动。完整文件 hash 见文末。最初清单保留为 `/tmp/s4-source-freeze-before-fixture-fix.json`，SHA-256 为 `65277ad3324bc8aadc6cbad333995c98a31beb77f861b9c26cc7c64b8d5d3248`；最终清单仅变更两个测试／fixture 文件，生产实现字节未变。

审查范围为 SDK research profile、Core 的交付／认定／replay 接线、实际准入与取消事务、协调器和 job 租约、崩溃恢复、报告来源、目录和配置隔离。审查者未修改实现或测试、未运行研究实验；本轮仅修改此审查报告。以下 A1–A7 是首轮及修复迭代中发现的问题，其生产修复已在冻结源码中闭合，所需集成证据已收口。

## 发现与修复复核

| 发现                                              | 级别 | 结论   | 主要闭合依据                                                                                 |
| ------------------------------------------------- | ---- | ------ | -------------------------------------------------------------------------------------------- |
| A1：崩溃后自动启动 prepared job／丢失精确恢复身份 | P1   | 已闭合 | 事务 guard、真实 SIGKILL、prepared 零 operation 精确恢复、持久 checkpoint 续进               |
| A2：旧回调关闭新 challenge 轮次                   | P1   | 已闭合 | 原 context／round／reviewVersion token、SQLite 迟到提交及实际启动拒绝、challenge／双宿主用例 |
| A3：取消未原子撤销在途 job                        | P1   | 已闭合 | 关闭事务推进 context、pending reviewer 取消、真实 validator I/O 后取消 CAS                   |
| A4：实际 reviewer 配置与材料漂移                  | P2   | 已闭合 | 启动／完成核对、真实 Context Epoch 绑定、配置漂移生产用例                                    |
| A5：产物前态与归档失败丢失                        | P2   | 已闭合 | 完整 before receipt、独立四种前态 replay、oversized／缺失／损坏证据拒绝                      |
| A6：锁内使用旧 preparation 破坏 exact retry       | P2   | 已闭合 | 独占锁内重新读取、已发行 exact retry 早返回、原绝对 deadline 静态核对                        |
| A7：completed 不合格报告无法显式重试              | P2   | 已闭合 | 明确 retry lineage、malformed 与合法 unavailable 报告两个生产重试用例                        |

### A1：崩溃后的后台接管会自动启动 prepared job（P1，已闭合）

首轮 `Research.advance` 只检查 run 租约是否到期，未区分正常释放的空 owner 与崩溃后遗留的 owner。另一协调器可在租约到期后自动启动已准备的 verifier／reviewer，绕过显式恢复。原恢复逻辑还会丢弃零 operation 的原 job 身份。

冻结实现对非空过期 owner 的未完成 I/O、prepared／open job 拒绝后台执行；已经持久完成的 snapshot／materials checkpoint 可继续推进，completed job 可解释已有结果。prepared 创建和启动保持在同次持租 `advance` 内。显式精确恢复要求原 context 仍有效，并保留 job、Session、Prompt；context 已撤销时要求显式新 lineage。verifier executable hash 同时覆盖 prepared 启动与零 operation 的 open 恢复。

独立 SQLite 测试已证明实际 `jobs.start` 在租约、generation 或 context 改变后被拒绝，job 仍为 prepared、operation 为零。真实 worker／reviewer／verifier SIGKILL、durable ready，以及修正后的 archived checkpoint 和 prepared 零 operation 确定性恢复用例均有通过证据。

### A2：旧协调器回调可能关闭新 challenge 轮次（P1，已闭合）

首轮 Token 只有 `id/owner/generation`。可见 challenge 更新 round、review version 和 ContextTarget 时未撤销旧 owner，旧失败回调可能关闭新轮次，续租 monitor 也可能重新绑定新 context。

冻结 Token 保存原 context、round、reviewVersion；`ResearchStore.assert` 全部比较。challenge 对账递增 generation 并清除 owner／lease。统一的 `ResearchCoordinator` guard 用于实际开始和阶段提交。独立测试核对 generation、context、round、reviewVersion 改变后的迟到提交拒绝，以及真实 job 启动的准入拒绝；全流程另覆盖同 subject 外部 challenge 的新证据身份和双宿主竞争。

### A3：取消未原子撤销未准入 context 下的在途 job（P1，已闭合）

中间修复版本只在 context 已 admitted 时推进 context。verification／review 使用 admitted=false，取消后、`jobs.cancel` 前若进程退出，远端 open job 仍可能以原 context 继续工作。

冻结 `close` 在取消、已准入 context 或存在活 open job 时，于同一事务推进 context，并关闭 run 和 worker admission。仅安全停止、未准入且无活 job 的恢复窗口保留 context。底层 job operation 准入检查原 context，取消不依赖后续尽力清理来撤权。生产用例包括 pending reviewer 取消及真实 validator I/O 后取消的最终认定 CAS。

### A4：恢复后的 reviewer 配置可能与材料声明不符（P2，已闭合）

首轮只在准备材料时记录配置 hash；重启后 prepared reviewer 可使用新全局配置，bundle 仍引用旧配置。

冻结实现等待 `PluginInternal.wait`，固定并在执行前后核对 configuration、agent 和环境指导来源；实际 `SessionContextEpoch` 被归档为报告证据并由 validator 绑定。配置漂移的生产用例要求精确恢复拒绝，显式新 lineage 才重建材料；该用例已在当前完整 S4 日志中通过。仅配置声明或模型回显不作为实际 Session 系统上下文的证明。

### A5：产物前态丢失存在性与归档失败（P2，已闭合）

首轮 replay 执行前取得完整 `inspect` receipt，最终却只保留 `beforeHash`。旧产物过大或越界时，报告无法区分原先不存在与未能归档。

冻结报告保留完整 `artifact.before`，producer 和 validator 显式拒绝缺失前态、capture error 和必要字节缺失。独立真实 replay 测试覆盖原先不存在、普通文件、过大、越界四种前态，4 pass、0 fail、28 assertions；完整 S4 中的 oversized 前态不可认定用例也已通过。

### A6：初始准备锁内使用旧 preparation，破坏 exact retry（P2，已闭合）

首轮两个同输入 `issue` 都可能在锁外读到空 snapshot。先行调用发行后，后行调用仍用旧对象重新 capture，改变 preparation 身份，最终与原 run 不一致。

冻结实现取得独占锁后重新读取 run／preparation；同输入已发行时直接返回原 run。source Location、真实路径解析、runner／harness 读取、归档、锁、物化及发行事务均处于原绝对 deadline 的外层 timeout 内。已有 exact retry 只核对并返回原 run，可以在 deadline 后读取结果。本项闭合依据是持锁范围和锁内重读的静态核对；双宿主测试不等同于穷尽所有并发发行定序。

### A7：completed 但不合格报告无法显式重试（P2，已闭合）

首轮 `recover` 无条件复用 completed job，导致 malformed JSON 或不可用报告永久重复同一失败。修复增加 `recover(id, { retry: true })`，创建保留 `previousJobID` 和原 deadline 的新 lineage。有效已完成结果仍可复用，无须再次调用 provider。

第二轮另发现合法 JSON 的 `verdict="unavailable"` 分支缺少 `resumeStage`；冻结版本保存 `resumeStage="review"`。malformed JSON 与合法 unavailable JSON 两个生产重试用例已在当前 S4 日志中通过。

## 其他已核对边界

- ready adapter 在同一 SQLite 事务内核对 exact worker Execution、保存请求并关闭 worker admission。默认缺少 driver、交付 adapter 或证据 validator 的宿主拒绝对应操作。
- 实际 `jobs.start/recover`、worker admission、capture／materialization 提交受原协调 token 与 deadline 保护。耗时 I/O 不占用数据库写事务。
- 报告来源固定为实际 job、replay 或 Session 最终完成 assistant message；模型回显的 job／Session／message ID 不充当来源身份。
- reviewer Location 是宿主管理的父目录，包含 `candidate/` 和 `evidence/`。向上查找配置及环境指导不会自动吸收 candidate 子目录配置；S3b 只读工具与真实路径限制继续适用。
- 内容寻址对象使用临时文件加不可覆盖 hardlink 发布，读取校验 hash。执行前清除获批 generated 输出并保留 receipt，用于证明本轮生成关系。
- `principalAttest` 在 validator I/O 后，仍在认定事务内比较 exact target、admitted 状态及 validator 对象身份。研究协调器不调用 `principalAttest`、`challenge`、`release` 或 `decideRevision` 代替外部判断。
- SDK `principalPassword` 只供可信宿主显式启用既有认证 Principal 路由；默认行为不变。公共 Protocol／Server HttpApi 未改变，无需重新生成客户端。

实现方另行发现 harness 只有执行后检查的问题，并补充执行前后 hash 检查。本项归属于实现方发现。独立静态复核确认，预先改变的 harness 在执行前被判机械缺陷，不能靠执行后恢复原字节通过检查。

## 验证证据

独立 reviewer 使用 `/tmp/opencode-research-toolchain/bun-linux-x64/bun`，从对应 package 目录运行：

| 执行者／检查                                                        | 实际结果                                       | 日志                                                                                                                                                                                                    |
| ------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 独立 reviewer：SDK Store／schema／TAP，3 文件                       | 17 pass、0 fail、47 assertions                 | `/tmp/s4-review-sdk-focused.log`                                                                                                                                                                        |
| 独立 reviewer：Core 真实 replay 前态，1 文件                        | 4 pass、0 fail、28 assertions                  | `/tmp/s4-review-artifacts.log`                                                                                                                                                                          |
| 实现方：Core Contract 回归，11 文件                                 | 158 pass、0 fail、922 assertions               | `/tmp/s4-core-final.log`                                                                                                                                                                                |
| 实现方：SDK 全部测试，6 文件                                        | 25 pass、0 fail、87 assertions                 | `/tmp/s4-sdk-final.log`                                                                                                                                                                                 |
| 实现方：Core 全量，159 文件                                         | 1362 pass、2 fail、4593 assertions             | `/tmp/s4-core-all.log`                                                                                                                                                                                  |
| 实现方：两个锁测试文件，非 root 复跑                                | 21 pass、0 fail、47 assertions                 | `/tmp/s4-nonroot-lock-tests.log`                                                                                                                                                                        |
| 实现方：S4 完整生产进程原运行，21 用例                              | 19 pass、2 fail、140 assertions                | `/tmp/s4-process-final.log`                                                                                                                                                                             |
| 实现方：修正后的两个崩溃 checkpoint、validator 竞态、缺失／损坏证据 | 4 pass、0 fail、30 assertions；17 filtered out | `/tmp/s4-process-boundaries-accepted.log`                                                                                                                                                               |
| 实现方：S1–S3b 生产进程原运行，4 文件                               | 27 pass、1 fail、308 assertions                | `/tmp/s4-prior-e2e.log`                                                                                                                                                                                 |
| 实现方：S2 五项串行复跑，包含原失败项                               | 5 pass、0 fail、55 assertions                  | `/tmp/s4-recognition-accepted.log`                                                                                                                                                                      |
| 实现方：HTTP 五文件串行最终复跑                                     | 53 pass、0 fail、290 assertions                | `/tmp/s4-http-serial-accepted.log`                                                                                                                                                                      |
| 实现方：Core／SDK／Server／opencode／Client／Protocol 类型检查      | 六包 `bun typecheck` 均 exit 0                 | `/tmp/s4-core-check2.log`、`/tmp/s4-sdk-final-check.log`、`/tmp/s4-server-final-check.log`、`/tmp/s4-opencode-accepted-check.log`、`/tmp/s4-client-final-check.log`、`/tmp/s4-protocol-final-check.log` |
| 实现方：冻结源码格式及 diff whitespace                              | 均 exit 0                                      | `/tmp/s4-format-accepted-final.log`、`/tmp/s4-diff-accepted-final.log`                                                                                                                                  |

独立测试命令分别是 `bun test test/research-store.test.ts test/research-schema.test.ts test/research-tap.test.ts --timeout 30000`（`packages/sdk-next`）和 `bun test test/pro-contract-artifacts.test.ts --timeout 30000`（`packages/core`）。审查者读取上表测试的实际 summary；类型检查和格式命令的 exit code 由实现方提供，并核对了对应日志。两个测试文件最终修改后，opencode 类型检查及冻结文件格式／diff 检查均重新执行并 exit 0；其余包源码未变。最终签署前再次独立核验 27／27 文件 hash、获批设计、S3b 基线及 S3a／S3b 历史审查 hash，全部与记录一致。

Core 全量原运行的两项失败为未改动的 unwritable-lock-root 测试，root 可越过 chmod 写权限；非 root 环境下两个测试文件完整通过。原全量日志仍保留，不将其写成全量零失败。

S1–S3b 原运行的失败为 S2 discarded rejected response 用例在重启后等待生产 Server 地址超时。S2 文件五项串行复跑 5 pass、0 fail、55 assertions，包含原失败项；与原运行的通过项合并，28 个不同既有进程用例均有通过证据。

HTTP 更早的 `/tmp/s4-http-final.log` 为 52 pass、1 fail、290 assertions，失败是 Git 初始化用例的 15 秒测试超时；之后的 `/tmp/s4-http-accepted.log` 为实例读取的 30 秒测试超时。最终相同生产实现上的 `/tmp/s4-http-serial-accepted.log` 五文件完整通过，53 pass、0 fail、290 assertions。以上失败日志均保留，环境 I/O 延迟的解释未被当作通过证据；最终 HTTP 的测试框架超时为 30 秒，生产 deadline／lease／预算没有调整。

S4 原完整运行的两项失败来自 checkpoint fixture 在处理 `job-get` 时先将 UUID 解码为 `ProContract.ID`；修正将该分支移到 Contract ID 解码前。另补强原有证据用例，实际删除 blob 后验证拒绝，再写入伪造字节验证拒绝，恢复原字节后验证可认定。审查者读取并核对这两个文件的变更；修正后四项复跑全部通过。与原运行的通过项合并，21 个不同 S4 用例均有通过证据；没有声称修正后单次完整运行 21 pass、0 fail。

### 进程与定序证据的边界

S4 集成测试使用本地确定性 HTTP provider、生产 SDK、独立 Bun 宿主、磁盘 SQLite、真实 Session／Tool／Permission、Node 子进程和文件；没有调用真实研究模型。SIGKILL 用例确实终止独立宿主。

prepared 和 archived 窗口使用 fixture 专用的生产服务图和透明 wrapper。prepared 屏障在真实外层 `atomic` 已提交并返回 Run 后暂停，跳过 monitor 的 void 返回；archived 屏障在真实 `put(Bundle)` 后、最终 admission 事务前暂停。测试从独立 SQLite 连接读取磁盘并在 kill 后再次确认 checkpoint。它们用于固定真实事务边界，不能描述成完全无测试介入的自然崩溃。

validator wrapper 只在原 `validate` 成功返回后暂停。测试执行真实取消后释放屏障，并要求拒绝原因是 `recognition target does not match the current handoff`，排除材料已预先无效导致的假阳性。以上 fixture 已静态复核，四项受影响／补强用例已在修正后完整复跑，4 pass、0 fail、30 assertions。

## 结论与适用范围

冻结源码未发现尚未修复的 P1／P2。A1–A7 的代码修改满足获批 S4 设计中的对应约束；S4 的 21 个不同生产用例及 S1–S3b 的 28 个不同生产用例均已有通过证据，HTTP 五文件串行复跑全部通过。结合独立测试、最终类型／格式检查及逐文件 hash 复核，批准这一冻结 S4 实现。本审查只评估最终交付执行、撤权、恢复和证据来源，不证明研究方法正确、实验覆盖充分或 reviewer 判断可靠。计划与方法事前审批仍属于 S5。

目录、进程和权限边界属于合作式隔离，不是 OS sandbox；不能抵御恶意逃逸进程、宿主私有目录写入或外部并发篡改。未知副作用不承诺 exactly-once；有限测试不能穷尽所有并发定序。

历史 [S3b 独立代码审查](pro-contract-researcher-s3b-code-review.md) SHA-256 仍为 `d52e5e1c973197144a8113d13e9d3d5e99f2323d6fc3d679acb1e14ee854e404`，S3a 历史审查 SHA-256 仍为 `f15b6e62381bfce87476d510a252c7153a1529f797fddb16cde45256a5db5bfc`；本轮没有修改历史验收。

## 冻结文件 SHA-256

以下逐项对应 `/tmp/s4-source-freeze.json`。报告自身和其他 Markdown 不属于源码冻结清单。

| 文件                                                                  | SHA-256                                                            |
| --------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `bun.lock`                                                            | `b5b76fda6f891ca40db756b63fb848f86f0c2eef20496303c8a775f9ddfea987` |
| `packages/core/src/pro-contract.ts`                                   | `3cfc20ad9b3333f449fdb7ba469f2c54c8136b43760db7b11bcc9403db58900c` |
| `packages/core/src/pro-contract/blob.ts`                              | `5033705de06b9893c33719fb16022f431a2390435a634a4741ff13358774cb2f` |
| `packages/core/src/pro-contract/delivery.ts`                          | `5bcb48dc621158e6516b55db67dc8386fdb5d176ac0b59fc61e8a1aa3f664aed` |
| `packages/core/src/pro-contract/job.ts`                               | `cfea633377b677829ca956c823bac06829621d03f781b9ce78ebe1a0b8135c25` |
| `packages/core/src/pro-contract/open-code.ts`                         | `e31a42606f7900acf8adce24f2a71db01b1f085d7147b9ad3a9ce1d618fc96e6` |
| `packages/core/src/pro-contract/recognition.ts`                       | `59b5cb510d3c29d563278ffc4005a43f72a81d6d604db67ed1fd7278b30e10ba` |
| `packages/core/src/pro-contract/replay.ts`                            | `22a408cc7c36bb9f97cacc158868aed6a11cb7ea2b467e858a057c02091c1192` |
| `packages/core/src/pro-contract/scheduler.ts`                         | `bb568e7130d36c99ba171327177fdfec950c6439e098883c4a4ebc416e9235d0` |
| `packages/core/src/tool/contract-control.ts`                          | `a1df77189c2d37b227f10f0d77f15413315b152f7b8f8e7f6976228c710fbca7` |
| `packages/core/test/pro-contract-artifacts.test.ts`                   | `6fd53389967925504a05ec47f0ffea55afa0cb535122a249fdebc9cf3b2d9626` |
| `packages/opencode/test/fixture/contract-driver-process.ts`           | `ac5fc091f6efc104be82c190eee6c0a0c53e3cfd4d06ccf5f64bf48f8a456cf8` |
| `packages/opencode/test/fixture/contract-process.ts`                  | `23e15dce8de360dda0a99621f59735bbd61ecd616dd3a77b36e8fb28f7133fa1` |
| `packages/opencode/test/fixture/research-checkpoint-process.ts`       | `549cc07c52cc192fd423025e0f485549b5be7eeeee2ca687f38506d6f62bcb3d` |
| `packages/opencode/test/server/pro-contract-research-process.test.ts` | `caeaf815a021642e78bcdef7eb4691a34084653f986563bd79e034f4cc108967` |
| `packages/sdk-next/package.json`                                      | `ce61c4738427cd5855a039ed714d3343347ba52dc925fa2fe6529c1f5047c0c4` |
| `packages/sdk-next/src/contract-jobs.ts`                              | `7440bf06da611d9334900d0d198ae40180af4952ecf016938b766be99d56c457` |
| `packages/sdk-next/src/opencode.ts`                                   | `6dd74f8d72f0ed776caa1440be522b6dce939eb4b9e837a55433402824e4a065` |
| `packages/sdk-next/src/research/adapters.ts`                          | `6416ca9473e9207a56f2a4c832d26cf262dc72cb3f32cd7210110bf7ded7bf08` |
| `packages/sdk-next/src/research/coordinator.ts`                       | `f4f85672cbe4c64e594023b55f3f4997b925c00c5b8b81a4bbfcfe1aaa4de162` |
| `packages/sdk-next/src/research/index.ts`                             | `627fb12ad5997af3263c4bfb7b4caab171da9259aab9241a2b56dadf3b90633f` |
| `packages/sdk-next/src/research/model.ts`                             | `55a19be036b45cbceafd88340a46fa9998a9f1be9414a1b761bcaf5f41c7d8a0` |
| `packages/sdk-next/src/research/store.ts`                             | `2a3b16ad4641726bc009a53df0e691f16240e19ef9a3fe7dab8aa9bb0db6c115` |
| `packages/sdk-next/src/research/tap.ts`                               | `ac0a414a47bfb0cbe373817c1b7de747d998d84cbd09f6a11859b067fd266464` |
| `packages/sdk-next/test/research-schema.test.ts`                      | `64f0cf689fb7c6dd1702fca739b9c3b2366804ad05a63bdda999f59b03899735` |
| `packages/sdk-next/test/research-store.test.ts`                       | `c8f04066853520c5b14484283dcaf95d75c25de216108a341ee2bf3f9896828b` |
| `packages/sdk-next/test/research-tap.test.ts`                         | `45b26a9c0130e45eed4d794d7db787373e62bd5e0df7c4a2c64ce83e0f04ccbd` |
