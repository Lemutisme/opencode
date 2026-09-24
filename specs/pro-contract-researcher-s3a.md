# S3a：执行 driver 完整生命周期

状态：实施设计，已根据独立审查的 F1–F3 修订，正在实施。用户已批准按主计划进入 S3a。S2 基线保存在 `/tmp/opencode-s3a-baseline`；本切片不覆盖 S3b、S4 或真实研究实验。

## 目标与边界

每份 OpenCode binding 只有一个持久的 driver 身份。原生 driver 保持现有执行行为；宿主可注入完整的通用 driver，用于接线和故障测试。当前生产入口没有研究 driver，也没有研究任务发行参数。缺少 driver、版本不匹配或初始准入关闭，均不能回退原生执行。

Core 只识别有限生命周期决策，不识别研究阶段。纯 kernel 不变。计划／方法审查、受控 reviewer job、权限等待后的执行许可检查和研究认定清单仍由后续切片实现。

## 身份与宿主接口

- binding 增加可选 `driver` 字符串（包含实现版本）和持久 `admission`（开关、递增版本、原因、获准的 `ContextTarget`）。历史缺省值严格解释为原生 driver 和打开的初始准入；新 binding 显式保存两者。自定义 driver 的有效准入还要求保存的 target 与当前制度上下文一致；已提交的旧 open 不能跨 revision/challenge/resume 继续生效。原生 driver 明确保留自动执行兼容。
- `Execution` 继续携带 Contract/revision/Session/Prompt/owner/generation，并绑定 driver 与准入版本。执行授权检查完整身份、当前准入、原始期限及 lease。
- driver 注册表是构图时注入的不可变服务，不是逐请求覆盖或第二套运行时。原生身份不可被覆盖，重复身份或缺少任何生命周期方法的注册失败。找不到精确身份即关闭执行。
- driver 接口提供 activation、claim/recovery、heartbeat 和 outcome 决策。回调为有限、同步、无 I/O 的策略函数，输入为复制的当前状态，不能保留并修改事务内对象。耗时宿主工作必须在事务外完成，再通过精确 CAS 更新准入。
- outcome 的通用输入包括正常结束、可重试错误、终止错误、解码错误、中断、dispatch 失败及 blocked；输出只允许保持等待、同 attempt 重试、新 attempt 重试或 escalation。原生策略保持现有分类；自定义 driver 必须显式实现全部方法。

## 原子发行与准入

`bindings.issue` 在一个 immediate 事务内执行 Contract issue、binding 创建和历史 Session 映射；底层已有事务上下文及 savepoint 能覆盖嵌套 Core 命令。SQL 故障回滚整个发行，不留下可被 scheduler 观察到的半成品。

发行前复制输入。同 ID 重试必须同时匹配条款以及 location/model/executionPolicy/driver；冲突经 command guard 留下 rejected ledger event，不能先记 accepted 再由 HTTP 检查报错。已有 binding 的当前准入和计量不得因重试复位。自定义 driver 必须已注册，初始准入必须关闭。

宿主通过 `setAdmission` 对捕获的 binding 坐标及准入版本做 CAS，同时提交 S2 的当前 `ContextTarget`，在事务内比较。因为 revision/challenge/resume 可以先改变 Contract 而 binding 尚未 claim，仅检查 binding revision 不足以阻止旧开门请求。这里复用当前制度上下文身份，仍以独立的 admission version 管理开关，不把两者当作同一个计数器。

打开只允许无执行在途、Contract 可执行且未超时；关闭立即禁止新 provider/control admission，但保留现有 lease，直到 drain 和 dispatch 均已结束。正常等待释放执行 lease，保留语义 attempt、累计用量和原始期限。再次打开生成新 Session 和新 prompt，隔离此前已准入但未 promoted 的旧队列；上下文延续材料由宿主显式提供，S3a 不承诺保留同一 Session。与 revision/challenge 对应的语义 attempt 变化保持现有规则。

完整 Execution 检查与 `sessions.prompt(resume: false)` 的 durable admission 在同一事务内；wake 仍是提交后的 advisory 操作。create/admit/wake 的本地在途标记由同一个 binding 服务持有，关闭屏障同时检查 dispatch 和 drain。零用量接管复用 prompt 时读取已有 `SessionInput` 的原始 prompt，不能因为 Session 已创建而改变同 ID 重试内容。

准入关闭不声称任意 shell 已经隔离。scheduler 负责中断本地在途 drain，等待中断完成再回收；跨进程只能等待旧 lease 到期。S3b 才完成所有实际副作用入口的许可检查。

## 生命周期归属与原子性

| 入口                                               | S3a 处理                                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| scheduler activation                               | 同事务读取 binding、driver、准入与当前 Contract，再调用该 driver；关闭或缺失不激活                           |
| claim / takeover                                   | 同事务检查精确 driver、准入、原始期限及新 attempt 上限；claim 增加 generation                                |
| heartbeat                                          | 只续本地 owner、该 driver 同意且尚未过期的 lease，不能使过期 lease 复活                                      |
| provider / control / action reservation            | 缺 driver 或准入已变化即拒绝；预算 escalation 与判断在同一事务完成                                           |
| drain / terminal-provider-error / dispatch-failure | 捕获原始 `Execution`，交给该 driver；不得以 revision 单独 escalate，也不得临时补发新身份                     |
| `contract_report_blocked`                          | 同事务验证身份、记录 blocked 和持久 pendingOutcome；立即阻止新执行，保留 lease，drain 完成后只消费原决策一次 |
| 正常等待                                           | 持久关闭准入及等待原因；不标为 blocked，不增加 attempt，不重置用量或期限                                     |
| pending revision                                   | 保留 pending，结束旧 lease；不得当作失败或消耗新 attempt                                                     |
| 原始 deadline                                      | 通用期限守卫在事务内重读当前状态并升级责任，同时中断本地计算；不依赖缺失 driver 的许可                       |

生命周期回调检查 driver、Contract/revision/Session/Prompt/owner/generation、有效 lease 和当前状态。准入关闭本身不阻止当前 drain 的清理回调，但只能得到等待结果。重新打开必须在清理完成后，因此旧回调不能重排新的执行。stale 回调没有 Contract、binding、计量或 ledger 副作用。

claim 的任何 attemptKey/revision 变化均不能绕过尚有效的 dispatched lease；本地已知 dispatch/drain 清理尚未结束时也不能接管。进程内屏障按 Contract 计数，允许 dispatch 与新 drain 的短暂重叠。

blocked 的内部 pendingOutcome 禁止新执行，但与外部关闭 admission 区分：外部 close 强制 wait；正常 drain cleanup 只消费已保存的原决策一次，不能改判为 generic completed 或无条件 wait。

blocked 工具不得等待自己的 drain，也不得提前退租。若进程在记录 pendingOutcome 后崩溃，恢复者在 lease 到期后消费同一意图。pendingRevision、verification、release 或 ContextTarget 已失效时允许退租，但不能执行旧 phase 的调度策略。独立期限扫描覆盖准入关闭、driver 缺失和 pendingRevision，不依赖只挑可执行 binding 的 `due` 查询。

所有来源于检查结果的 escalation 均在同一事务中完成，删除目前先检查再另开事务升级责任的窗口。保留底层制度层接口用于可信 issuer 和非 OpenCode adapter；本切片封闭的是实际 OpenCode 生命周期入口。

## 服务图接线

Server 路由构建器接受同一组 Core node replacements，并传播到 LocationServiceMap。`sdk-next` 的 host 选项用这组 replacements 同时构建宿主服务和 HTTP 服务，复用一个 memo map 和 scope。宿主获得的 binding 服务与 scheduler、SessionExecution、Location runner 使用同一实例；测试验证 owner 一致及请求实际受注入 driver 控制。

不增加公共 HTTP 发行字段；CLI／HTTP 继续只发行原生 Contract。若仅新增嵌入式 TypeScript host 选项，不需改生成 SDK；如实施中改变 Protocol，再按仓库规则生成两代客户端。

## 验证矩阵

1. 真实 SQLite 触发 binding 写入故障，验证 duty、context、binding、Session 映射和 accepted ledger 原子回滚；同 ID metadata 冲突记录拒绝。
2. 原生和测试 driver 共存，逐项覆盖 activation、claim、heartbeat、outcome、blocked、dispatch 失败和 takeover；缺失或不同版本拒绝恢复。
3. `maxAttempts: 1` 下多轮关闭／打开／正常等待，attempt 恒为 1，计量累积，deadline 不变。
4. 用同步 barrier 延迟终止错误与正常 drain 回调，完成同 revision 的 takeover 后放行旧回调；新执行和账本均不改变。
5. pending revision、真实 blocked、终止错误、verification handoff、release、到期的原生兼容回归。
6. 生产 Server 子进程、本地 HTTP 模型、磁盘 DB、自然 lease 到期、`SIGKILL` 重启覆盖原生恢复与过期回调；测试宿主进程覆盖自定义 driver 等待持久化及 driver 缺失恢复。
7. sdk-next 真路由集成验证注入穿过同一服务图，独立宿主互不共享 driver；关闭宿主释放 scheduler 和相关资源。

## Constitution change gate

强化 obligation conservation、exact identity、effect authority、auditable rejection。反例是旧 drain 终止错误升级新 owner、原生 scheduler 偷接自定义阶段、正常等待消耗唯一 attempt、发行中断留下无 binding 的 duty。只有绑定、执行回调和 Contract store 的共同边界能把检查与修改放入同一事务；外部适配器包装无法堵住已有入口。

kernel 无新增命令、状态或依赖，沿用纯 reducer 与 constitution 回归。新增概念只有通用 driver 身份、不可变注册表和版本化准入；删除无完整身份的 drain escalation／reschedule 路径和分离发行窗口。集成验证以上述真实边界为准，不把文档审查等同于实现验收。
