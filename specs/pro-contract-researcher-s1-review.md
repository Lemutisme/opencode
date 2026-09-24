# ProContract Researcher S1 独立代码评审

审查日期：2026-09-18。基线 HEAD：`78bec19263814444ab008c58d54835b59b4a1c6b`。设计依据为 [实施方案](pro-contract-researcher.md)的 SHA-256 `09bd167cbb63c9cdbcc5c7e74ca9c89f00aec45965674ab59d3a93dcc7a73f55`，范围与设计复核见 [专项实施评审](pro-contract-researcher-implementation-review.md)。

**结论：S1 独立代码复核通过，没有未解决的阻断项。** 审查发现的一项 P2 准入计量时间问题已修复，并增加回归。变更实现了工具控制路径的当前执行授权、原 turn 身份传递和 exact petition 完成；没有实现 Principal Agent、研究 driver 或研究阶段状态。结合已核对的代码与实施方报告的包级测试、类型检查结果，可按 S1 的限定范围交付。

本次只读审查运行时代码及测试，新增本报告；未修改实现或测试、安装依赖、启动研究实验。测试执行由实施方完成，下文分别说明源码核对、测试覆盖和收到的运行结果，不将其描述为评审方另行独立运行。

验证范围更正：下文 runner 延迟响应测试的 `LLMClient` 使用脚本化事件流，属于 Core 集成测试，不是实际提供商 HTTP 测试；持久化测试是数据库重开，不是进程重启。后续另增的生产应用测试及其结果见 [S1 应用 E2E 报告](pro-contract-researcher-s1-e2e.md)，不纳入本次原独立审查的已审范围。

**被审版本。**

被审 runtime 为 `packages/core/src` 下七个修改文件。以下命令输出的 SHA-256 为 `e08420fea228d524cae5a97f6c49a32de86cb3f6993061ba5e121a507f762a32`：

```sh
git diff --binary -- packages/core/src | sha256sum
```

该指纹相对于上述 HEAD，包含本轮修订后的时间检查与历史 generation 注释。主要修改测试的文件指纹如下；未修改的相关测试也被用于回归。

| 测试文件                                                  | SHA-256                                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------ |
| `packages/core/test/pro-contract-control.test.ts`         | `50b81b02fc9ba7a06cda9de0be3d6754b0c75d2b9ed7ff666c79cec741d4084c` |
| `packages/core/test/session-runner.test.ts`               | `d86cda235a9bce30cc4a14c67d1611f00a1bf5f985680e24b7addb2dca77fd4e` |
| `packages/core/test/session-runner-tool-registry.test.ts` | `ba1ed4d935c67507bca895a9269acea384d1aff6b9c76e10f4b3912102fc8924` |
| `packages/core/test/lib/tool.ts`                          | `0def03beb3410741b2bce1a8fdb6606b8704d0ef1755b9864c87368eada0b518` |

**C1 · P2 · 已关闭：使用等待前的时间可能给已过期执行继续计数。**

第一版在 `reserve` 的事务内继续使用调用方进入方法前捕获的 `now`。registry 先读取时间，再经过 binding 查询和事务连接等待；如果等待跨过 lease 或 deadline，旧时间仍会使检查通过。`contract_check` 因而可能增加一次 action，随后 leaf 使用当前时间拒绝；provider turn 也存在同类问题。最终 Contract 状态 guard 使用当前时间，故这不是旧 handoff 被接受的漏洞，但违反 S1 未准入拒绝不新增用量的保证。

当前 [reserve 事务](../packages/core/src/pro-contract/open-code.ts#L205)在实际读取 binding 后计算 `Math.max(now, Clock.currentTimeMillis)`，对身份、lease 与 deadline 的准入检查使用这个值。它保留原有显式时间参数的保守行为，同时不能用过去时间延长授权。

[新增回归](../packages/core/test/pro-contract-control.test.ts#L171)先捕获时间，推进测试时钟使 lease 过期，再以旧时间和原执行身份请求 action／turn；二者均拒绝，计数仍为零。源码与该反例直接对应。此项在本报告所记录的被审版本中关闭。

**权威事务与拒绝审计。**

[内部 `CommandGuard`](../packages/core/src/pro-contract.ts#L134)只提供受信适配器检查，并在嵌套使用时保留上层 guard。[store execute](../packages/core/src/pro-contract.ts#L207)在原有 immediate 事务内读取状态、执行 guard、决定是否调用纯 reducer，然后沿原有账本路径保存 accepted／rejected decision。拒绝保持物化 Contract 状态不变，仍推进不可变 decision ledger；没有通过伪造 revision 强迫 reducer 拒绝。

[binding control](../packages/core/src/pro-contract/open-code.ts#L175)先确认命令属于 token 的 Contract，再以同一 Database 服务读取当前 binding 和 Contract。该读取处于 store 事务的 Effect context 中，SQLite 适配器复用同一事务连接。没有把 Session、lease 或 generation 放进 kernel 命令，也没有在 registry 新增授权回调。

ready 的成功 handoff、snapshot unavailable、replay unavailable／timeout 的 escalation，以及 revision petition 都通过该 guard。blocked 先提交受 guard 保护的报告，再让 `reschedule` 在自身短事务中核对相同执行身份；它的耗尽 escalation 也带 guard。若两步之间发生接管，后一步不会修改新执行。capture、replay 和 permission 等待均位于写事务之外。

各控制 leaf 检查已经返回的 receipt，再在事务外转为 `ToolFailure`。这保留了已提交的拒绝记录。[直接事务回归](../packages/core/test/pro-contract-control.test.ts#L136)核对 rejection frontier、账本命令与不变的职责；真实 replay 接管测试进一步覆盖最终工具失败后拒绝事件仍然存在。工具准入时尚未形成状态命令的拒绝，则由 runner 的持久工具错误事件记录。

**原 turn 身份与 claim generation。**

[runner](../packages/core/src/session/runner/llm.ts#L363)从本次 provider admission 所读取的 binding 构造 `Execution`，将其用于 turn 准入，并通过 [registry 上下文](../packages/core/src/tool/registry.ts#L90)传给 leaf。[组合工具](../packages/core/src/tool/action-fusion.ts#L123)将同一身份继续传给子动作。leaf 不重新读取当前 binding 来替换原身份；执行坐标不进入模型输入 schema。

[执行检查](../packages/core/src/pro-contract/open-code.ts#L539)比较 Contract、Session、prompt、revision、owner、generation、dispatched、lease、active／pending 和 deadline。[每次成功 claim](../packages/core/src/pro-contract/open-code.ts#L372)推进 generation，即使 Session、prompt 和 owner 没变，旧 token 也不能因重新 claim 而复活。历史 JSON 缺失 generation 按零处理，新 claim 从该值递增；当前服务 owner 仍须匹配，缺少工具执行身份则拒绝。

[runner 延迟响应集成测试](../packages/core/test/session-runner.test.ts#L3354)使用 Session prompt、实际 runner 和原控制 leaf：脚本化 provider 流暂停时，同一 Session 被 reschedule／claim 到新 prompt；旧 response 随后调用 `contract_report_blocked`，持久历史中得到授权错误，Contract 没有 blocked 变化，action 计数不变。该测试没有通过测试 helper 在调用时自动补当前身份，能够证明原 turn 到工具的实际接线。

**修订申请与外部批准。**

[revision 工具](../packages/core/src/tool/contract-control.ts#L361)先以当前执行身份提交 petition，再等待既有外部 permission。批准完成仅携带原 revision、规范化条款 hash 与 accepted petition 的账本 frontier，不复用已暂停的执行 lease，也没有授予下一 revision 的执行权。

[exact 决定检查](../packages/core/src/pro-contract.ts#L480)与决定提交处于同一事务，比较当前 pending hash、revision 和最近一次 accepted petition 事件。被拒绝的重复 petition 不会取代原申请身份；同条款被拒后重提则有不同 accepted 事件，旧批准和旧拒绝都不能落到新申请。

无说明 `DeclinedError` 的处理限于该 leaf 的 permission 等待，用 `catchDefect` 精确识别该既有错误，其余 defect 重新抛出。普通 Permission 服务没有被改写，其他工具原有用户拒绝语义保持不变。显式 interruption 不转换为批准或拒绝；原 pending 保留，等待集合清理，外部可以读取并显式处置。

新增测试覆盖超过 30 秒 lease 后批准原申请、拒绝的重复 petition 不干扰该批准、无说明 reject、批准与拒绝两种 ABA、等待被中断后 pending 可见，以及重新打开数据库后读取 pending 并显式拒绝。[数据库重开测试](../packages/core/test/pro-contract-control.test.ts#L182)验证持久责任不依赖原 Permission deferred 存活；它不声称自动恢复未知的用户批准。

**计量、兼容性与范围。**

授权查询不计 action。普通 registry 计数仍适用于 `contract_check`；ready、blocked 与 revision 保留原控制计数豁免，ready 配置 replay 时仍显式计一次 action。真实进程 replay 在完成前被接管时，成功、失败、unavailable 或 timeout 都不能影响新执行，已合法发生的一次 action 仍保留。timeout 用例让已启动的真实进程超过单操作期限，不用模拟报告代替超时路径。没有新增累计预算、复位原 deadline 或改变冻结 cohort 配置。

本次新增的是可信内部 Core 输入与执行元数据，没有修改公共 Protocol／Server HttpApi 或持久 kernel Schema，因而不需要用伪造字段强迫公共调用方迁移。`decideRevision.expected` 是可选的内部精确完成条件；原公共调用路径仍具有原来的“决定当前 pending”语义，本轮不宣称公共修订接口已具有 exact 请求保证。Principal 策略与精确认定 S2 均未实现。

S1 的声明继续限于工具控制路径。[旧 drain 的终止处理](../packages/core/src/session/execution/local.ts#L53)及完整 scheduler／driver 生命周期 fencing 仍按计划留到 S3a；本次没有把工具 guard 误报为所有旧进程副作用都已被阻止。冻结写入屏障、shell 隔离、研究 reviewer 与完整研究 profile 也不属于本轮通过的内容。

**验证证据与最终状态。**

评审方检查了新增测试源码、上述运行代码和适用 `AGENTS.md`，并运行 `git diff --check`；格式检查通过。实施方已报告以下结果：

- control／ProContract／Location／registry／action-fusion 第一组 113 项通过。
- 完整 Session runner 与 Constitution／export／observation／replay 第二组 131 项通过，包含脚本化 provider 事件经过真实 runner 到原 leaf 的延迟响应测试。
- 最终 control 套件 18 项通过、0 失败、102 个断言，包含最后补充的数据库重开、重复 petition 与真实 replay timeout；这是对前组对应测试的重跑，不累计为另一组全新用例。
- `packages/core` 的最终 `bun typecheck` 退出码为 0；全部 11 个修改的 TypeScript 文件通过 Prettier 检查。

以上是相关回归，不是全仓库测试，也不证明研究质量、进程隔离或后续切片已经完成。最终 runtime 指纹保持不变；评审方核对了最终测试增量，C1 已关闭，当前没有剩余 P1／P2 阻断。
