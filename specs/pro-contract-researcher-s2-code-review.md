# S2 共享精确认定边界独立代码评审

审查日期：2026-09-18。设计依据：[S2 实施说明](pro-contract-researcher-s2.md)，设计复核通过的 SHA-256 为 `3734fd6889dd9e39018ff4cae3bbd1258b6386be58b94067faf0420b7387470e`；设计问题及关闭条件见 [独立设计评审](pro-contract-researcher-s2-review.md)。源码 HEAD 仍为 `78bec19263814444ab008c58d54835b59b4a1c6b`，S1 前置变更保留，实施方另存 `/tmp/opencode-s2-baseline/tracked.patch` 与原 `pro-contract.ts` 作为 S2 比较基线。

**最终代码评审结论：通过，C1–C5 均已关闭，没有剩余 P1／P2 问题。** 核心事务和身份设计已经落实，评审方在下文记录的最终 runtime 上独立运行 21 项 recognition 回归，全部通过。本文区分评审方实际运行、静态核对与实施方报告，不把正在补充的应用 E2E 记为评审方已执行。

评审方只修改本报告，没有修改 runtime、测试、方案或实验 artifacts。实测均为包目录内的单元／集成测试或独立 `:memory:` SQLite 进程，没有启动研究任务或冻结 cohort。实现方在审查期间持续修订，下文保留已复现问题及修复依据。

**C1 · P1 · 已关闭：空字符串拒绝理由被转换成批准。**

`Validator.validate` 返回 `Effect<string | undefined>`，`undefined` 表示通过，字符串表示拒绝。首版 private `execute` 最后以 `rejected ? ... : undefined` 构造 decision；空字符串经过前面的 nullish 合并保留下来，随后被 truthiness 当作通过。

评审方在真实 Core service 和隔离内存库中，将已交付 Contract 配置为 admitted 的 custom profile，注册 `validate: () => Effect.succeed("")`，再提交完整 target 和非空证据。实际得到 accepted receipt、`support.valid: true` 和 `status: discharged`。这是校验器拒绝未能阻止认定的授权错误。

实现方已改为 `rejected !== undefined`，空理由持久化为 `command rejected without a reason`。新增回归同时覆盖 custom validator 和 `withCommandGuard` 的空字符串拒绝，并核对 ledger、未 discharge、同一操作重试只验证一次。源码核对确认拒绝值不会再因空理由丢失。

**C2 · P2 · 已关闭：positive evaluation 绕过 native 的非空证据规则。**

首版 `settleEvaluation` 正分支在完成 activation／handoff 后安装无条件通过的 `RecognitionAuthority`，没有执行 native 有限校验。评审方用同一真实 Core service 分别调用普通 `principalAttest` 和 positive evaluation，二者均传 `evidenceHash: ""`：前者拒绝，后者 accepted 且 `support.valid: true`，Attestation 表保存了不符合共享 Schema 的空证据字符串。

private `execute` 现对 discharge／challenge 统一检查非空证据，positive evaluation 最终还调用内建 native validator。普通最终拒绝会退出 savepoint，回滚中间 Contract、context 和 ledger 变化，再在外层保存本次拒绝。评审方独立运行的 recognition 套件中，正负 evaluation 空证据、无部分状态和历史拒绝重试的新增用例均通过。

**C3 · P2 · 已关闭：共享依赖重复遍历导致有效 DAG 的指数耗时。**

首版 `validSupport` 只维护当前访问集合，返回时删除节点，每条路径都会重新计算同一个祖先。在每层两个职责、每个职责依赖上一层两个职责的合法 DAG 上，评审方直接运行生产函数得到：

| 职责数 | 依赖边数 | 首版计算耗时 |
| ------ | -------- | ------------ |
| 25     | 46       | 2 ms         |
| 37     | 70       | 73 ms        |
| 45     | 86       | 1,118 ms     |

这段同步递归也用于 immediate 认定事务，稍大但合法的依赖图就会长时间阻塞事件循环和其他写入。实现方增加按 Contract ID 的结果 memo，并单独保留递归栈检测环。评审方核对修订，并独立运行 80 节点分层 DAG 回归：全部有效、祖先失效和回边成环三种情形均正确，测试约 2.5 ms 完成。

**C4 · P2 · 已关闭：Core 接受空 `operationID` 并产生违反公开 Schema 的成功 receipt。**

共享 `OperationReceipt` 和 HTTP payload 规定 `operationID` 为 `Schema.NonEmptyString`，但 `Interface` 使用普通 string，operation 提交路径未检查非空。评审方在真实 Core service 中提交合法 target 和证据，仅将 `operationID` 设为 `""`，实际得到 accepted receipt，Contract 进入 discharged，回执仍含空 ID。CLI 目前也只有 string／demandOption 约束，缺少与 Protocol 相同的内容检查。

修订后的共享 `prior` 入口使用 `OperationReceipt.fields.operationID` 的 NonEmptyString Schema 校验。四类操作均先经过该入口，attest 也在外部 validator 前拒绝；缺失身份不推进 ledger／状态，不伪造无效 ID 的回执。评审方独立运行四入口回归，核对失败及不变的 quiet／ledger frontier，随后在最终 21 项套件中再次通过。真实 CLI 用例已补充空参数拒绝和 ledger 不变断言，其执行结果由实施方报告。

**C5 · P2 · 已关闭：feedback-screen 报告的重复坐标可能与实际 export target 不一致。**

首版迁移已从 export 捕获 `expected`，但报告并列的 `revision`／`specHash`／`subjectHash` 仍取自更早的轮询结果。轮询和 export 之间若出现 challenge／重新交付，报告会混合两个候选的坐标。该问题来自调用顺序的静态核对，未运行实验复现。

实施方已用共享 Schema 解码 export target，并让报告所有重复坐标都来自该 target；评审方核对了修改。没有改变运行中或冻结 cohort 的源码副本及 artifacts。

**事务、恢复与入口核对。**

- private `RecognitionAuthority` 是 discharge／challenge／revision decision 的必需条件，默认拒绝；public Core 方法和 evaluation helper 明确装配精确检查。普通调用方不能仅通过可选 S1 guard 绕过 gate。该能力仍属于可信进程内 Core，不能替代宿主与 worker 的数据库、凭据和网络隔离。
- `operation` 在 immediate 外层事务中重新检查全局 ID 与请求指纹，Contract 转换、ledger、主 operation 与 attempt receipt 一起提交。内容冲突有自己的不可变拒绝，原操作不覆盖。同内容重试先返回历史 receipt，再在一致快照中计算当前支持，未再次运行 reducer 或校验器。服务端时间不进入指纹。
- 上下文版本随 accepted 的新交付、失败 replay、challenge 全依赖闭包、accepted revision、resume、release 推进；包括仍为 dormant 的下游。保留 profile，清除旧引用；custom 必须重新发布。重复 issue 和缺上下文读取不会自动降级为 native。
- 宿主发布比较保存的完整 `ContextTarget`；外部 validator 接收 clone 的请求／视图，最终事务重新检查 target、准入、validator 实例及预先保存的 identity。缺 validator 的拒绝持久化后，同操作不会因后续安装校验器而变成成功。challenge 和原 petition 决定不依赖验收 validator。
- evaluation 正负分支先共同校验原 evaluation context、delivery target／attestation／依赖支持，再选择动作。正分支的 savepoint 把普通拒绝转换成失败以回滚全部中间步骤；数据库异常传播到外层，不生成伪成功 receipt。负分支只能 challenge 报告指向的 delivery 轮次。
- 历史恢复核对全局序号、前序 hash、事件 hash、ledger head 和全体 Contract 投影，重放 accepted 事件；失败 replay 不被认作 handoff。迁移只新增上下文／操作表，旧事件及 attestation 字节不改写，不伪造历史幂等操作。
- Protocol／Server 的 schema 与认证边界、409 中的 operation receipt、CLI 显式 expected／操作 ID、TUI 使用显示时的 target、两代 SDK 生成调用面及 export 捕获的身份均已静态核对。TUI 不把历史成功但当前支持失效显示为当前 discharge。S1 permission completion 继续绑定原 petition，不重新依赖已过期执行 lease。

**全账本恢复的成本与缓存。**

首版每次 `get` 都读取全库并从零重放，runner 每个绑定 provider turn 和 scheduler 也调用该入口。评审方对生产 `recover` 的纯计算实测：100／1,000／3,000 个仅 issue 的完整事件约需 7／64／351 ms，不包括 SQLite 读取。该行为使普通执行读取承担不必要的历史重放成本。

实现方加入 service-local cache，只有完整 events、ledger head 和 Contract 数据内容指纹一致时复用恢复结果；context 每次仍重新读取。评审方核对了快照、并发和 savepoint 回滚关系：缓存绑定内容，不以单独 head 推断状态未变，回滚后不同内容会重新验证。

评审方随后在真实内存库中预置 3,000 个一致的 Contract／issue 事件并调用生产 `get`：首次约 411 ms，后两次约 30／32 ms，均无 unavailable。缓存消除了相同快照的重复 reducer 工作，仍然存在全表读取、JSON 解析／序列化和新 frontier 的全量重放成本；这些数字只说明该合成规模下的变化，不是大型长期数据库的性能保证。增量 checkpoint／索引优化未纳入本次已完成声明。

**评审方验证与范围。**

先前独立从 `packages/core` 执行 `bun test test/pro-contract-recognition.test.ts`，当时版本为 19 pass、0 fail、153 assertions，包含 C2、C3 的新增回归。实际使用环境中已有的 Bun 1.3.14 可执行文件；没有安装依赖。此后分别独立运行 C1、C4 新增用例，得到 1 pass／10 assertions 和 1 pass／15 assertions；最终完整重跑见下文，不将这些重跑累计为不同测试。

实施方另报告 S2 真实 HTTP、现代及旧 SDK、Effect Client、并发重复、接受／拒绝丢响应后的 SIGKILL 重启测试通过；这些是实施方报告，尚未作为评审方独立运行的检查。最终包级 typecheck、完整相关回归与应用 E2E 以实施方最终结果及后续核对为准。本报告不证明 S3a driver 生命周期、S4 研究报告／冻结、真实研究质量或强隔离已经完成。

**2026-09-18 最终增量复核。**

实施方完成格式化并冻结下列版本后，评审方重新核对空拒绝理由与空 `operationID` 的最终入口逻辑，并从 `packages/core` 独立运行完整 recognition 套件：**21 pass、0 fail、178 assertions**，耗时约 0.8 秒。`git diff --check` 通过。该套件包含两种 evaluation 自身 challenge、正负空证据、正常拒绝回滚、数据库异常回滚、缺 validator、历史迁移及缺失历史／context；这些结果来自真实 store 与生产恢复／支持计算函数。

| 被审文件                                                                      | SHA-256                                                            |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `packages/core/src/pro-contract.ts`                                           | `5c13d6f034c5add7eeea7b205b383b5753fc2157bb05634888274f225a174aa1` |
| `packages/core/src/pro-contract/recognition.ts`                               | `89c7bc7d0f5a1565124d2a9518b367764cffcf8b77f399f2595f87c6cbb46a17` |
| `packages/core/src/pro-contract/sql.ts`                                       | `7c195dc1416f42898d5416b116e7f51125d4edc4cd0bbfbe751f53a3641854cc` |
| `packages/core/src/database/migration/20260918220926_contract_recognition.ts` | `ce85aa460c3d3a5984d09aa24748156a0760291e45bfd4fa90031315c303a1f3` |
| `packages/core/test/pro-contract-recognition.test.ts`                         | `b44685efd3cc099a11d03edca5b5fb019d741cee53c6f6e18e1df10ab01a8b58` |
| `packages/schema/src/pro-contract.ts`                                         | `426a6d34b174fcae47c330007eb07d018c1ab78cc4fa7caed7bfeecefe0d9e03` |
| `packages/protocol/src/groups/pro-contract.ts`                                | `c0c8b27c99b5f916c9fd67a2ca2c33978dffdc1bc934719878cbbdb0b7cbfaaf` |
| `packages/server/src/handlers/pro-contract.ts`                                | `75debdddeae1681f0d46d441e1a6d78b91269812203491c333810f45c18af167` |
| `packages/opencode/script/pro-contract-feedback-screen.ts`                    | `cc60b636c4c5d72bc2088529d83c9b9f65fc0b9a189f7a03a0e7e5884ad58e54` |

保留的 S1 `tracked.patch` SHA-256 为 `0fa733b0baced495cf4de2fe650411d7ba41113baaddd5086395f1d791f00892`，S1 `pro-contract.ts` 为 `cc6582e837fb07152deed5eccf091234b752506c852262048c300050999d30d8`。上述文件指纹标识本次重点审查与回归的代码，不将测试仍在更新时的整个工作树视为单一不可变提交。

截至本次复核，实施方另报告：S1 进程 E2E 9／9、121 assertions；Core 大组 253／253、1,120 assertions；后续 focused 88／88、505 assertions；Schema 12／12、44 assertions；Client 16／16、75 assertions；HttpApi／SDK 41／41、252 assertions。这些集合有重叠，不作总数相加。新增 S2 五项进程 E2E 的最终重跑及包级 typecheck 汇总仍由实施方记录；评审方已静态核对其生产 Server／CLI／SDK、脚本化本地 provider 及 SIGKILL 接线，没有冒充实际云提供商实验。

**2026-09-18 SDK 测试 fixture 补充复核。**

实施方随后报告最终 Core 九文件回归 **260／260、1,178 assertions**，S2 进程 E2E **5／5、55 assertions**，八个包的 typecheck 均通过。以上是实施方运行结果，覆盖并替代相应早期集合，不作累计计数。S2 runtime 保持上表指纹，评审方再次核对 `pro-contract.ts` 和 `recognition.ts`，均未变化。

额外修改仅为 `packages/sdk-next/test/embedded.test.ts`，被审 SHA-256 为 `5afb130aa8e67b44278495d5f380aca7b67ef8ceeabd44b030c677887f441294`。该文件原先每个测试把数据库放入各自的临时 workspace 并在 finally 删除；但 `Database.node` 在第一次模块求值时调用 `layerFromPath(path())`，后续 dynamic import 复用同一模块，继续打开第一个已经删除的路径。

**这项 fixture 修复通过静态独立复核，没有新增问题。** 新代码在首次 SDK runtime import 前创建 suite 级数据库目录，设置 `Flag.OPENCODE_DB`；所有 scoped Effect 结束后，`afterAll` 恢复原 Flag 并删除数据库目录。各测试的 workspace 仍分别创建、分别清理，Session ID 仍随机且独立。测试中的两个 embedded hosts 原本就位于同一路径，其实时通知隔离断言保持不变。当前另一个 `import-boundaries.test.ts` 通过子进程做 bundle 检查，不会先在本测试进程导入 SDK runtime。

评审方检查了该测试 diff、数据库 node 的初始化位置、同包其他测试及清理顺序，`git diff --check` 通过；没有修改 runtime，也未另行重跑 SDK suite。本补充只批准上述测试生命周期修复，SDK suite 的最终运行结果仍由实施方记录。
