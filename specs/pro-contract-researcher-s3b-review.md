# S3b 独立设计审查

审查对象为 [S3b 实施设计](pro-contract-researcher-s3b.md)，初版 SHA-256 为 `dcae9303546c6559f599294790ebfad2f62df374dc3af65d2d06230aa51596eb`。源码参照当前 S1–S3a 工作树；`HEAD` 为 `78bec19263814444ab008c58d54835b59b4a1c6b`，但本报告引用的实现包含尚未提交的修改，不能仅用该 commit 重建。实施方保存的基线为 `/tmp/opencode-s3b-baseline`。

最终结论：修订后的设计通过，初轮发现的两项 P1 均在设计层关闭，没有遗留 P1／P2 设计阻断。复核通过的设计 SHA-256 为 `e88eafaa02aa84c90f13e586967b97c810ab0df08c0750c79aa98ab93378582e`。以下保留初版的反例和验收条件，关闭依据见文末。这些约束仍需后续代码审查和真实边界测试验证。本轮仅静态审阅设计与当前实现，没有执行 runtime 测试、启动实验或修改 runtime。

## F1 · P1：先预留 Session ID 再创建，仍可能采用不匹配的普通 Session

初版[发行条款](pro-contract-researcher-s3b.md#L17)要求先原子保存 job、输入和持久 Session 映射，再创建 Session，同时禁止事后认领普通 Session。这个发行顺序需要 Session 创建入口共同执行 reservation 约束；初版未明确覆盖 `SessionV2.create`。

现有 [公共创建协议](../packages/protocol/src/groups/session.ts#L129) 允许指定 Session ID、Location、模型和 agent，[Server handler](../packages/server/src/handlers/session.ts#L68) 直接调用 Core。[`SessionV2.create`](../packages/core/src/session.ts#L208) 发现同 ID Session 时直接返回既存行；[并发创建的失败方](../packages/core/src/session.ts#L245) 也直接采用获胜 Session。这两个分支都不比较所请求的身份字段。

可达顺序：宿主提交 job J 与 Session S 的映射；宿主尚未调用 `create` 时，另一请求通过普通 Session 创建入口，以相同 S、不同 Location／模型／agent 创建成功；宿主随后调用 `create` 并采用该 Session。发行时查询“没有既存普通 Session”不能关闭这个窗口。仅在公共 switch／revert 处拒绝修改，也无法阻止最初创建出错误身份。如果后续许可只核对 job 行和捕获坐标，实际 runner 仍可能使用被抢占 Session 的配置；即使后续拒绝执行，也不满足原子发行和精确采用的身份保证。

需要的修正：

- 把 Session reservation 纳入权威创建事务或投影边界。受控 Session 的首次创建必须符合持久 reservation；普通创建不能以不同配置占用这个 ID。检查与写入之间不能再留一个可等待的竞争窗口。
- 同 ID 的既存采用和并发竞争后的采用都核对完整固定身份，至少包括 Location／workspace identity、模型／variant、agent 及对应 job 归属。普通 Session 原有“重用 ID 即采用”的行为可以保留，受控 Session 必须走精确分支。
- 许可捕获和实际执行还应核对真实 Session 与 job 的固定坐标。marker 缺正文时仍拒绝，不得因无完整配置而退回普通创建或执行。

验收需要在 marker 提交后、Session 创建前设置 barrier，分别通过 Core 与公共 HTTP 抢占同 ID，并覆盖两个创建请求同时竞争投影的路径。不同固定字段必须冲突且不能发生 provider／tool 工作；合法精确重试保留唯一 Session、唯一冻结 prompt 和原 job，不产生第二份身份。另保留“先有普通 Session，再发行 job”拒绝用例。

## F2 · P1：只限制 reviewer 启动，不能阻止主 binding 随后重新执行

初版[生命周期条款](pro-contract-researcher-s3b.md#L48)要求主 binding 停止后 reviewer 才可启动，用于避免主执行者同时写入候选，但没有明确双向互斥。root admission 关闭与 `ContextTarget` 无效是不同条件；同一上下文仍可能重新打开主执行。

当前 [`setAdmission(open)`](../packages/core/src/pro-contract/open-code.ts#L466) 检查主 binding 的 dispatched、local operations、pending outcome、driver、root 状态和 deadline；[`claim`](../packages/core/src/pro-contract/open-code.ts#L519) 也只检查主执行相关状态。主 admission 关闭后再打开可以沿用同一 `ContextTarget`。因此“同一个 root 上下文仍有效”不足以保护已经运行的 reviewer。

可达顺序：root 在同一上下文等待，主 binding 已停止；宿主启动 reviewer；随后宿主打开主 admission，scheduler claim 并执行写工具。reviewer 的 job、owner、generation、lease 和 root context 均仍有效，于是 reviewer 与主执行者并发访问同一候选。S4 冻结材料可以增强结果可重复性，但不能代替 S3b 本已承诺的主任务停写条件。

需要的修正：

- `jobs.start` 与主 `setAdmission(open)`／`claim` 在一致的事务边界执行双向检查。reviewer 启动要求主 binding 已停止且无未结束 dispatch／drain／local operation；主任务打开和 claim 要求没有与其互斥的活动 reviewer。
- 明确取消中和清理中的 job 仍占用互斥屏障。不能因为持久状态已经 cancelled 或 lease 已撤销，就在实际读操作／子进程尚未退出时开放主任务。进程退出后的回收须遵守原 lease、恢复和 unknown-operation 规则。
- 若采用先撤销 reviewer 再恢复主任务的策略，必须完成有界清理后才能打开主 admission。不能将 reviewer 放入主 binding，也不能通过推进主 binding 身份吞掉独立 job 历史。

验收应覆盖 reviewer start 与主 open／claim 的两个相反交错顺序，以及 cancel 已提交但清理尚未结束的窗口。相同 `ContextTarget` 下也必须互斥；清理结束后，合法主任务恢复仍保留主 binding 的原会计和 deadline。独立 verifier 在 root verification 下的执行权限不应因此被错误绑定到主 binding 的 active 许可。

## 已覆盖的设计边界与实施验收约束

- **通用 Core 机制与主 binding 保留。** job 存储、执行许可和 operation 会计属于执行适配器；不向 kernel 加入研究阶段，不以 reviewer 替换主 binding 的当前 Session。验证必须同时检查持久主 binding 和历史 Session 映射，不能只观察 SDK 返回值。
- **持久受控身份与缺 driver 时拒绝执行。** 独立 marker 在正文缺失、取消、完成和进程重启后继续阻止普通执行回退；prompt 的 admit-only 与 resume／wake／直接 runner 都在范围内。driver 再注册不构成自动 start 或恢复许可。实现不得为复用现有 driver 的 binding 参数而伪造一个主 binding。
- **实际执行授权的位置。** canonical `Tool.settle` 使用可信许可 service，Registry 仅传递环境；leaf 保留权限与副作用顺序，符合 [Tool 架构约束](../packages/core/src/tool/AGENTS.md#L12)。当前 [raw settle](../packages/core/src/tool/tool.ts#L162) 可被直接调用，验收必须包含缺 service、缺捕获身份和旧身份调用。不能以“Effect 上下文为空”推断为普通 Session，也不能借新增 Registry callback 绕开 canonical boundary。
- **独立 reviewer／verifier 和原 deadline。** reviewer 的有限只读集合、Location 范围与 agent 权限取交集；verifier 固定 snapshot／policy／hash，不借 root active 权限执行。修订还要求这些能力属于 root 已有 authority，并按实际工具实现的受控声明检查，不能只允许注册名而放过同名替换。provider、正常及 overflow compaction、叶子副作用和每条验证命令都需要使用原捕获许可及原 deadline。权限批准后发生的异步准备不能把最后一次检查留在真实写入／spawn 之前很远的位置。
- **完整会计与 unknown。** usage 到达即保存原始可选字段，缺失不转成零；每次 provider／compaction／验证进程都有持久开始记录。实现必须保留现有 S3a turns/actions 语义，避免 operation ledger 与组合工具嵌套记录导致重复扣数。迟到 usage 可以补写原 operation，但不能改变 job 完成状态、许可 generation 或 root 认定。
- **恢复与取消。** 零执行 job 仅由宿主在 lease 到期后显式恢复；已开始工作不得自动重放，新 lineage 继续使用原 deadline 并保留所有历史。SIGKILL 验收还需覆盖 provider 已结束而 job 完成回调未提交的窗口：不得因为没有 running operation 就误判为从未执行，也不得自动再次调用 provider。保守拒绝并由宿主另建 lineage 符合此设计。
- **范围限制。** 本轮不声称共享目录、任意进程、网络或凭据已获得强隔离；也不审查 S4 研究报告冻结、解析与验收流水线。当前本地 executor 的宿主权限不是本报告新增发现，但 reviewer 不得获得该任意执行能力。

## 修订复核与验证限制

| 发现       | 状态       | 修订后的约束                                                                                                                                                                                                                                                 |
| ---------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1 · 原 P1 | 设计层关闭 | [Session 创建约束](pro-contract-researcher-s3b.md#L18)要求预留 ID 的创建、既存采用和并发冲突恢复在权威事务内核对固定 Location／model／agent，runner／provider 另核对实际持久 Session；[验收项](pro-contract-researcher-s3b.md#L74)加入普通 create 抢占竞争。 |
| F2 · 原 P1 | 设计层关闭 | [双向互斥条款](pro-contract-researcher-s3b.md#L50)要求 job start 检查主 binding lease 与本地在途操作，主 open／claim 检查活动 job，关闭仍等待已有操作清理；[验收项](pro-contract-researcher-s3b.md#L74)加入 job 启动后主任务不能再次准入。                   |

复核版本还增加了[实际工具实现身份与 root authority 交集](pro-contract-researcher-s3b.md#L21)，其余重点边界未被弱化。实现验收应执行本报告列出的两个方向的竞争顺序和清理中窗口；不能仅验证顺序调用的正常路径。设计通过只表示反例得到方案覆盖，不能提前声称上述执行隔离已实现。

本轮只新增本评审文件。没有运行 Core／Server 测试或 typecheck，也没有修改设计、源码、生成文件、既有迁移或实验配置。文档不含需要定界的数学表达式；Markdown 格式和源码链接在写入后单独检查。
