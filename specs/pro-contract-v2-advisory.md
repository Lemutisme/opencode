# ProContract V2 原生执行的独立审阅（advisory）：设计稿

日期：2026-10-08。状态：设计稿，供 Principal 决定，未授权实施。基于 `procontract-closure` / `66128706b2`（运行时 `bc8af80928`，上游 2.0.20），分支 `closure-advisory`。

## 0. 目标与原则

**目标：**在 Researcher（V2 原生 worker）执行长任务的过程中，在每个关键节点提供一次独立的第二意见，降低低级错误和方向性错误的概率。

**两条 advisory 原则（Principal 已定）：**

1. 只提建议，决定权始终在 Researcher；审阅不能阻碍任务推进和收敛。
2. 关键节点必须审阅；Researcher 可以在合适的节点暂停等待审阅，但暂停必须发生在合适的节点。

**三条实施原则（Principal 已定）：**

1. 基于 `procontract-closure`（V2）。
2. 尽量不改基础设施，只做 reviewer 必需的部分。
3. 吸取上一轮 `native-advisory` 工作的经验教训（见第 6 节）。

## 1. V2 现状（已核实）

- **worker：**`packages/sdk/script/contract-worker.ts` 在受限容器中用 V2 SDK 创建 Session，提示中附交付说明，随后由 `drainDelivery` 等待 Session 停下；交付仍未完成时，往收件箱放一条新提示让它继续（同一分配、同一原始 deadline）。
- **工具：**插件 `contract-profile.ts` 只保留 `glob`、`grep`、`patch`、`read`、`shell`，外加 `contract_delivery`。所有工具的执行都包在 `delivery.exclusive(...)` 中，这是一个串行队列，保证候选的修改和交付检查不交错。
- **交付：**`contract-delivery.ts` 提供 `probe`（登记公开行为反例）、`status`、`handoff`（重新构建、运行 `validate.sh`、重放全部已登记 probe，全部通过才记为 ready）和 `blocked`（记录具体原因并结束）。
- **网关：**`native-programbench.py` 对每个模型请求核对四件事：来自 worker 进程本身（按 PID）、模型和档位精确匹配（固定 `max`）、工具在白名单内、合同仍为 active。
- **工具调用不会切断回复：**V2 的 `session/runner/step.ts` 会把 provider 流读到结束，再等待所有工具 fiber 完成。工具执行期间模型回复已经完整，usage 不会丢失。
- **会话级权限：**`session.create` 接受 `permissions`；整类拒绝（`resource: "*"`）的工具会从发给模型的工具列表中移除（`core/src/tool.ts` 的 `whollyDisabled`）。`patch` 的权限名为 `edit`。

## 2. 什么是合适的暂停节点

**判断标准：**

- 由 Researcher 自己的动作或自然停顿形成，不打断正在进行的回合，不中断模型请求或工具；
- 此时候选处于一个有意义、可审阅的状态（Researcher 认为做完了、认为做不下去了、或者正在验证行为），而不是改到一半；
- 审阅期间 Researcher 不会改动候选，意见回来后它仍然完全自主。

**由此排除的做法：**在任意工具边界或按时间强行暂停、中断正在进行的回复。这正是上一轮在停止边界、用量丢失、调度器竞态和故障保护上遇到大量问题的根源。

**节点表：**

| 节点            | 触发时机                                                                                       | 暂停方式                                                  | 审阅关注点                                                     |
| --------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------- |
| 交付前          | 第一次 `handoff` 通过机械检查时                                                                | 在 `handoff` 工具调用内同步审阅；不记录交付，返回意见     | 实现是否真的满足任务，覆盖是否有明显缺口，summary 是否言过其实 |
| 报告 blocked 前 | 第一次 `blocked` 时                                                                            | 在 `blocked` 工具调用内同步审阅；不记录 blocked，返回意见 | 障碍是否真实，是否遗漏了可行的路径，是否过早放弃               |
| Session 空闲    | Session 自行停下、交付仍未完成，`drainDelivery` 即将重新提示时                                 | Session 本来就已空闲；审阅后把意见并入重新提示            | 为什么停下，当前方向和进度是否有问题                           |
| 中途            | 距上次审阅（或开始）满 `afterMs` 后的下一次 `probe` 或 `status` 调用，且候选自上次审阅后有变化 | 在该工具调用内同步审阅；工具照常执行，结果后附上意见      | 方向、架构和已发现的反例是否合理，有无低级错误                 |

**每个节点的次数规则：**

- 交付前、报告 blocked 前：每个分配各一次。第二次调用直接按原逻辑执行，不再审阅，决定权在 Researcher。
- Session 空闲、中途：只在"候选自上次审阅后有变化，并且距上次审阅已满 `afterMs`"时触发，避免 Researcher 停下、被提示、再停下的循环里反复审阅。

**关于中途节点的已知风险：**SBNO 实验里 Researcher 只在交付前几秒调用检查。ProgramBench 中 Researcher 调用 `probe` 的频率未知；如果 probe 也只集中在最后，中途节点就会退化。因此建议先看 ProgramBench 实际轨迹再启用（见第 9 节）。Session 空闲节点不依赖 Researcher 的调用习惯。

## 3. 审阅机制

**同步审阅服务**（新文件 `packages/sdk/script/contract-advisory.ts`，供 worker 调用）：

1. **捕获材料：**在 `delivery.exclusive` 内复制候选快照（与 `contract-delivery.ts` 的快照范围相同，排除 `reference` 和 `.git`），写到 `state/advisory/<序号>/candidate/`。同时写入 `context/` 下的纯文本文件：任务提示、交付说明、已登记 probe 的列表和最近一次检查结果、Researcher 的 summary 或 blocked 原因。长行在空白处折行，每行不超过 1,000 字符；规范内容另存于证据日志，文本文件只用于阅读。
2. **运行 reviewer：**释放 `exclusive` 后，在同一个 worker 进程里新建一个 reviewer Session：
   - 位置为该次快照目录；
   - 模型和档位与 Researcher 相同（`max`），满足"reviewer 不低于 Researcher"，网关无需改动；
   - 会话权限拒绝 `edit`、`shell`、`contract_delivery` 和 `external_directory`，只剩 `read`、`grep`、`glob`。
3. **提示：**沿用第五轮验证过的写法：独立阅读材料；不能运行代码，依赖运行行为的结论要说明推理并标为未验证；按工具返回原文引用代码；只提建议，不能批准或阻止交付。
4. **等待意见：**等 reviewer Session 结束，取最后一条助手消息作为意见；受审阅时限 `reviewMs` 和原始 deadline 共同约束，到时中断 reviewer Session（这是 reviewer 自己的会话，不影响 Researcher）。
5. **投递：**按节点返回给 Researcher（见第 2 节节点表），意见前附核实提示：reviewer 不能运行代码，它对运行结果、测试、库函数语义和代码原文的断言都是未经验证的判断；因具体断言修改代码前先自行核实。
6. **证据：**在 state 目录追加 `advisory.jsonl`，记录节点、序号、时间、材料哈希、意见、reviewer Session ID 和结束方式，并导出 reviewer 的消息和事件。

**必须避免的死锁：**插件把所有会话的工具都包在 `delivery.exclusive` 中。若 reviewer 在 `handoff` 持有 `exclusive` 时运行，它自己的 `read` 会排在同一个队列后面，形成死锁。因此：快照在 `exclusive` 内捕获，审阅在 `exclusive` 外进行；插件对 reviewer Session 的工具不套用 `exclusive`（reviewer 只读快照副本，不需要与候选修改串行）。

**失败时放行：**审阅出错、超时或剩余时间不足时，不阻碍推进。交付前和报告 blocked 前节点按原逻辑执行（记录交付或 blocked），并在返回结果和证据日志中写明"审阅未发生"及原因；空闲和中途节点照常提示或返回工具结果。

**时间约束：**剩余时间不足 `reviewMs` 加一段余量时，不启动审阅，按失败放行处理。审阅不延长原始 deadline，也不新增任何累计上限。

## 4. 开启方式与 ProgramBench 兼容

- worker 输入新增可选字段 `advisory`，例如 `{ nodes: { submission, blocked, idle, midcourse: { afterMs } }, reviewMs, instructions? }`。字段缺失时行为与 `procontract-closure` 完全相同。
- `native-programbench.py` 新增可选参数（如 `--advisory <配置文件>`），把配置写进 worker 输入，默认不传。网关、工具白名单、模型和档位核对都不变：reviewer 的请求来自同一个进程，工具是白名单的子集，模型和档位相同。
- **计量：**reviewer 的模型请求与 Researcher 来自同一个 PID，网关账本无法区分两者。worker 导出 reviewer Session 的消息（含 usage），报告时据此分列 Researcher 与 reviewer 的用量，网关总数不变。
- 不开启 advisory 时，ProgramBench 可以直接跑；开启时只需加这一个参数。

## 5. 不需要的东西

Core、Server、Schema、Protocol、kernel 和网关核对逻辑都不改。上一轮的作业基础设施、执行许可、admission 暂停、持久化审阅请求库、blocked 路由、A0 和 Research 宿主都不需要：V2 不做隐式重启恢复，审阅状态只需在本次分配内维护，外加证据日志。

## 6. 吸取的经验

| 上一轮的教训                                                     | 本设计的做法                                                                  |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 只靠主动请求时 reviewer 从没被用过                               | 关键节点由 worker 自动触发，第一版不提供主动请求                              |
| 暂停和中断带来停止边界、用量丢失、调度器竞态、削弱故障保护等问题 | 只在合适的暂停节点同步审阅，不中断回复或工具；V2 先读完回复再等工具，用量完整 |
| 重启恢复和持久化对账非常复杂                                     | V2 本身拒绝隐式恢复，审阅状态只在本次分配内                                   |
| 改动 Core 公共路径前低估副作用                                   | 不改 Core；设计先经独立审查再实施                                             |
| reviewer 对运行行为的断言会出错，Researcher 会照着改             | 沿用第五轮的两段提示                                                          |
| 单行 JSON 材料分页读取被截断                                     | 材料写成纯文本文件并折行                                                      |
| 未审查的大块工作被整体带入                                       | 新分支只包含 advisory 本身                                                    |
| 文件系统卡顿导致基础设施中断                                     | 沿用 V2 容器部署；评估时运行写入放在本地盘                                    |
| SBNO 中 Researcher 只在交付前调用检查                            | 中途节点先观察 ProgramBench 轨迹再启用；空闲节点不依赖调用习惯                |

## 7. 改动清单

- 新增 `packages/sdk/script/contract-advisory.ts`：材料捕获、reviewer Session、意见收集、证据日志。
- `contract-delivery.ts`：`handoff` 和 `blocked` 增加可选的节点钩子；机械检查通过后由钩子决定是否先审阅。不改检查逻辑和日志格式。
- `contract-profile.ts`：reviewer Session 的工具不套用 `exclusive`；`drainDelivery` 增加空闲节点钩子。
- `contract-worker.ts`：读取可选的 `advisory` 字段，创建审阅服务，结束时导出 reviewer 记录。
- `native-programbench.py`：可选参数，默认不传。

## 8. 测试计划

只用脚本化 provider，不发真实模型请求：

- 不开启 advisory 时，现有 `contract-delivery.test.ts`、`contract-profile.test.ts` 和 Python 测试全部不变并通过。
- 每个节点：触发与不触发的条件、次数规则、第二次调用按原逻辑执行、意见与核实提示送达、失败放行（出错、超时、剩余时间不足）。
- reviewer 只有 `read`、`grep`、`glob`，不能读快照以外的路径，不能修改候选；快照与候选后续修改相互独立。
- `exclusive` 不死锁：`handoff` 审阅期间 reviewer 能正常读文件；同一回复中排在后面的工具调用在审阅期间的行为符合预期。
- reviewer 请求通过网关的工具与模型核对；用量分列正确。
- 容器内用 `--fixture` 运行一次开启 advisory 的完整资格检查，以及到期和取消检查。

## 9. 需要 Principal 决定的事项

1. 节点设计是否认可，尤其是"合适的暂停节点"的判断标准和排除的做法。
2. 第一版启用哪些节点。建议实现交付前、报告 blocked 前、Session 空闲三个节点（都是 Researcher 自己形成的停顿），中途节点先设计好但默认关闭，待看过 ProgramBench 轨迹中 `probe` 的分布后再决定。另一个选择是第一版只做交付前。
3. 默认参数：`reviewMs` 建议 30 分钟；空闲和中途节点的 `afterMs` 建议 45 分钟。
4. 失败时放行（审阅未发生时按原逻辑执行并如实记录）是否认可。
