# S3a 独立设计审查

审查对象为 [S3a 实施设计](pro-contract-researcher-s3a.md)、主计划第 7.1／9 节，以及 S2 后的 OpenCode binding、scheduler、Session drain 和 Server／sdk-next 服务图。最初设计 SHA-256 为 `203c57e839ff3122fa75c06fe326cf1d35a198afa45879c6c3f125b6d0dea80f`；增加 `ContextTarget` CAS 后、本轮发现所对应的设计 SHA-256 为 `6c3cda24ee5e51fc625a6495a666f366d4d0132af4e66bcb925ef58f270107c0`。源代码基线由实施方保存在 `/tmp/opencode-s3a-baseline`。

最终结论：修订后的设计通过，F1–F3 三项 P1 均在设计层关闭，没有遗留 P1／P2 设计阻断。复核通过的设计 SHA-256 为 `f78307a60a62c5d3703cfa5e96981ee83a9983bc802467dad7734dd7383f69e9`。以下保留初轮发现及其验收条件，修订对应关系见文末。实现和真实边界测试完成后仍需独立代码审查；本次没有执行 runtime 测试，也没有修改 runtime。

## F1 · P1：只等待 drain，不能封闭尚未登记为 active 的 dispatch

设计“原子发行与准入”以 drain 已结束或本进程没有该 drain 作为回收条件，但 [scheduler](../packages/core/src/pro-contract/scheduler.ts#L72) 在 claim 后还要查询／创建 Session、构造 prompt、持久准入并 wake。这段工作尚未出现在 `SessionExecution.active` 中。[SessionV2.prompt](../packages/core/src/session.ts#L360) 的持久准入本身也不会检查调用方原先 claim 的 `Execution`。

可达顺序：claim A；A 的 dispatcher 停在 Session 创建或 prompt 准入前；宿主关闭准入；scheduler 因没有 active drain 而清 lease；宿主重新打开并 claim B；最后 A 恢复并准入旧 prompt。若沿用同一 Session，B 的 runner 会读取当前 binding 并为旧 prompt 使用 B 的许可。A 的结束回调被 fence 并不能撤销已经写入的 Session inbox。

还存在相邻情况：A 的 prompt 已持久化但尚未 promoted，随后关闭并清理。仅为 B 换一个 prompt ID，不能阻止同一 Session 队列中的 A prompt 在 B 的准入下被消费。

需要的修正：

- 完整 `Execution` 检查与 `SessionV2.prompt(resume: false)` 的 durable admission 进入同一个写事务；随后 wake 仍为 advisory。不得在事务内启动 provider 工作。
- claim 后的 dispatch 工作纳入同一 owner 管理的进程内在途屏障。关闭／回收既检查 dispatch，也检查 drain；清理标记必须在成功、失败、中断和 scope 退出时释放。
- 对已经持久准入的旧 inbox 明确处理。S3a 可以在正常等待后换新 Session 和 prompt，同时保留语义 attempt、累计用量及 deadline；退休 Session 继续保留历史映射。另一方案是在同一 Session 内对 inbox 做精确、持久的授权与取消设计，不能仅换 prompt ID。
- 重试相同 prompt ID 必须复用原始 prompt 与 delivery。不能因为 Session 已创建就从首次任务正文换成恢复提示，从而触发 exact retry 冲突。

验收需要在 claim 后／admission 前，以及 admission 后／wake 前分别设置 barrier；关闭、清理、重新打开后放行 A，确认旧请求不能为 B 准入或执行 provider 工作，且等待不消耗额外 attempt。

## F2 · P1：开门时比较 ContextTarget，不会使已经打开的旧授权自动失效

增加 `setAdmission` 的 `ContextTarget` CAS 可以拒绝延迟送达的旧开门请求，但当前设计的持久 admission 只有开关、版本和原因，没有保存该授权所适用的上下文。[Contract store](../packages/core/src/pro-contract.ts#L332) 会在 accepted revision、challenge 依赖闭包、resume 等制度转换中推进上下文，binding 此时可以仍未变化。

可达顺序：宿主为上下文 A 成功打开准入；随后 Contract 接受修订或被 challenge 后恢复，进入上下文 B；scheduler 为 B 激活／claim 时仍读到 `admission.open=true`。新的 `Execution` 只绑定当前 revision 和旧 admission version，不能证明宿主批准过 B。同 revision 的 challenge／resume 更不能只用 revision 比较发现。

需要的修正：custom admission 持久保存宿主批准的完整 `ContextTarget`，并在 activation、claim、heartbeat、provider/control/action admission 内与事务中的当前 target 比较；不匹配必须按关闭处理。或者在权威上下文转换事务中直接撤销 execution admission。原生自动调度可以保留明确的兼容规则，custom 不应隐式继承旧授权。

清理和期限守卫也要理解这种“字段仍 open、授权实际上已失效”的状态。旧 phase 回调只能完成旧工作的清理，不得为新 phase 重排或升级责任。普通 `activate` 不推进 S2 phase，因此复用 S2 target 不妨碍已批准的正常激活；admission version 仍是独立的执行开关代次。

验收需要覆盖两种顺序：旧开门请求晚于转换，以及开门先成功、转换随后发生。至少包含 accepted revision、同 revision 的 challenge／resume，以及依赖 challenge 使下游上下文失效；确认 custom 无 provider／control admission，native 兼容不变。

## F3 · P1：blocked 决策发生在工具内，不能同时宣告 drain 清理完成

设计要求 `contract_report_blocked` 同事务记录 blocked 并执行 driver 决策。但 [当前工具](../packages/core/src/tool/contract-control.ts#L326) 在自己的 `execute` 内调用重排；[当前 reschedule](../packages/core/src/pro-contract/open-code.ts#L450) 会清 dispatched 和 lease。把这两步简单合并为一个事务，仍会在工具返回、同 turn 其他工具结束、drain finalizer 完成之前释放所有权。

custom driver 的 blocked 结果若为 wait，宿主随后可看到关闭且无 lease 的 binding，并重新打开新工作；旧 drain 却可能仍在执行或清理。直接在工具内等待／中断自己的 drain 则会造成自等待。若 driver 的 retry 决定只留在内存里，blocked 提交后崩溃又会丢失原决定，恢复可能按普通 completed 再做一次不同处置。

需要的修正：blocked 与 driver 的有限处置意图同事务持久化，先禁止新准入并保留 lease；工具返回后，由 drain cleanup 消费该意图一次，再释放或重排。恢复路径在原 lease 到期后处理同一持久意图。外部 close、制度上下文失效和已完成的 Contract 状态必须限制旧意图，不得借清理重开工作。claim 也不能因 attemptKey／revision 改变就绕过仍有效的旧 lease。

正常完成回调、pending revision 和中断应共用清理不变量，但不能照搬 provider authorization：pending、verification、release 或 admission version 的关闭变化可以禁止新工作，同时仍允许精确旧身份退租。有限 DB finalizer 要能在 fiber 已中断时完成；实际 runner 仍保持可中断。

验收需要在 blocked 已提交而工具或另一个同 turn 工具尚未结束时暂停；验证 open／claim 被阻止、旧 lease 保留。随后分别正常退出、中断、崩溃恢复，确认处置仅发生一次，wait 在 `maxAttempts: 1` 下不增加 attempt，retry 分类不被 generic completed 覆盖。

## 其他实施验收约束

- 原子发行应通过真实 SQLite 写入故障验证 Contract、recognition context、binding、Session 映射及 accepted ledger 全部回滚。同 ID metadata 冲突只产生明确 rejected 结果，不能复位已有用量或 admission。
- stale lifecycle callback 的拒绝必须发生在任何 Contract 命令之前；它不能为了记录拒绝而改变 ledger。provider/control 请求本身的审计规则与这种内部旧回调不同。
- 心跳使用事务中的当前时间，不续已过期 lease。deadline 扫描独立于 driver 许可和执行候选筛选，覆盖 closed、缺 driver 和 pending revision；现有 `bindings.due` 排除了 pending，不能直接充当完整期限扫描。
- 宿主 callback 抛错或返回无效结果应使该 binding 关闭，不能使其他 Contract 的期限守卫长期不运行。回调是可信、有限策略代码，不应在 SQLite 事务内进行 I/O。
- Server／sdk-next 的方案应将同一 replacements 传入 `AppNodeBuilder` 和 `LocationServiceMap`，并共享 memo map／scope。验收应比较宿主、HTTP handler、scheduler、SessionExecution 和 Location runner 的 binding owner／实例，还应验证两个独立 host 的注册表隔离和 scope 关闭后的资源释放。
- S3a 仅建立通用生命周期和宿主接线。实际 leaf 许可、权限等待后再授权、reviewer job 和研究冻结屏障仍属于 S3b／S4；不能把本轮设计通过写成研究执行隔离已经完成。

## 修订复核

| 发现       | 状态       | 修订后的设计约束                                                                                                                                                                                                                                           |
| ---------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1 · 原 P1 | 设计层关闭 | “原子发行与准入”要求完整 `Execution` 检查与 admit-only 同事务，wake 在提交后；同一个 binding 服务管理 dispatch 和 drain 的在途屏障；等待后换新 Session／prompt，并保留 attempt、用量和期限。零用量的 exact prompt retry 读取原持久输入。                   |
| F2 · 原 P1 | 设计层关闭 | “身份与宿主接口”让 custom admission 保存获准的完整 `ContextTarget`，其有效性要求与当前制度上下文相同；已提交 open 不能跨 revision／challenge／resume。native 自动行为被明确保留，cleanup 与期限守卫不依赖已经失效的旧授权。                                |
| F3 · 原 P1 | 设计层关闭 | blocked 与 `pendingOutcome` 同事务持久化，保留 lease，正常 cleanup 或过期恢复消费原意图一次；内部待处理决定与外部 close 分开，后者强制 wait。任何 attemptKey／revision 变化都不能绕过有效 lease，本地 dispatch／drain 屏障按 Contract 计数并允许交接重叠。 |

设计还补充了 pendingRevision／verification／release／ContextTarget 失效时只做旧工作的退租，以及独立于 `due` 的期限扫描。完整 `ContextTarget` 包含 S2 context version，因此可信宿主修改认定上下文也会使 custom 执行准入失效；这是保守的明确关闭行为，不能把 recognition version 和 admission version 合成一个计数器。

上述关闭只说明方案覆盖了反例。实现验收仍须真实执行本报告的 dispatch、blocked、旧回调、上下文转换和崩溃恢复用例，核对中断 finalizer、事务时间、共享服务实例及 scope 释放。评审文档经 Prettier 检查；无 Markdown 数学表达式需要额外定界处理。
