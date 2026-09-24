# S6 独立设计审查

审查对象为 [S6 评测设计](pro-contract-researcher-s6.md)，初稿 SHA-256 为 `01accca700426e601b645f0ace95465860508bd697ec6d9172876b79db7f0983`。本轮参照 [Researcher 总方案](pro-contract-researcher.md)、[S5 实施记录](pro-contract-researcher-s5-implementation.md)、[S5 独立实现审查](pro-contract-researcher-s5-code-review.md)，并只读检查当前生产 model、planning、reviewer、protocol、协调器、执行许可和 operation 记录路径。S5 历史源码清单 `/tmp/s5-source-freeze.json` 的 SHA-256 为 `5555fb1ca78ab4d9025b35531f3c29bbf5d473c1d98834aba9df73ea851e0ae0`；该切片清单不替代 S6 运行所需的完整镜像冻结。

最终结论：修订后的设计通过。初轮两项 P2 均在设计层关闭，没有遗留 P1／P2 设计阻断。结论绑定最终设计 SHA-256 `737da740b22843d4259dbf6570177067ed2d5259b57834570cc6bb3c128700e3`。主要任务矩阵、独立 oracle、固定分母、有限结论和预算方向可行。以下保留初轮反例、闭合条件及修订依据；本结论只说明设计可以进入实施，不评价尚未运行的模型或真实研究能力。

## F1 · P2：raw verdict、范围判断与实际 gate 的组合尚无确定的计分优先级

初稿第 5 节把 `detected` 定义为有证据的正确阻断，把 `false_accept` 定义为缺陷仍在却 accept；错误放行指标按内部 accept 计数，后续说明又要求分开记录模型识别与宿主实际放行。这个方向正确，但在计划评审中，`verdict` 并非全部判断：还存在独立的 `scope` 和 blocking finding。对应修订后的[结果分类](pro-contract-researcher-s6.md#L118)、[错误同意指标](pro-contract-researcher-s6.md#L136)和[实际 gate 说明](pro-contract-researcher-s6.md#L147)见链接。

生产 [`PlanReview`](../packages/sdk-next/src/research/model.ts#L88)允许三种 scope；[`ResearchReviewer.valid`](../packages/sdk-next/src/research/reviewer.ts#L82)不检查 scope。实际[计划准入](../packages/sdk-next/src/research/planning.ts#L324)另外要求 `accept + within_task`。因此 `accept + needs_principal_revision` 或 `accept + unclear` 可以成为已归档的结构合法报告，同时实际 gate 关闭。带 blocking finding 的 accept 则会在更早的报告一致性检查被拒绝。

具体反例：P4 缺陷计划更换 Principal 固定数据。reviewer 的 summary 明确指出更换数据需要外部修订，返回 `scope: needs_principal_revision`、`verdict: accept`，把对应说明写成 note。它没有取得执行批准，但协议中的 accept 与正确的范围判断矛盾。如果按 raw accept 评分，它是错误同意；若按“有证据的正确阻断”及 scope 评分，又可能计入 detected。若将实际 gate 关闭统称 mechanical block，则模型确实给出的范围判断也被混入机械结果。有效对照上的 `accept + unclear` 同样可能被记成 false block、unavailable 或一次“安全拒绝”。不同评分实现由此会改变 21/24 检出与对照通过门槛的含义。

本项不要求放宽门槛，也不把矛盾报告解释成有效同意。闭合需要在看结果之前冻结以下规则：

- 分开保存原始 `verdict`、`scope`、finding、结构／证据一致性、模型目标识别、实际 gate 及评分标签；不能从任一单字段重建全部结果。
- 明确 `accept + within_task`、`accept + needs_principal_revision/unclear`、accept 带 blocking finding、`changes_requested` 有／无有效目标 finding、unavailable 和 malformed 的组合评分及优先级。不同报告维度可以并存，但主分子只能按同一冻结规则计算。
- 若采用保守规则，缺陷材料上的任何可解析 raw accept 都记“错误同意”，即使 gate 关闭也不记 detected；scope 矛盾和 actual gate 单列。应将该指标与真正的“越权放行”区分，后者仍是机制不变量。
- 有效对照的 scope 错误或无依据阻断不能因 gate 安全关闭而获得质量成绩。malformed、证据引用失败与未知结果须按明确规则保留，不临时选择更有利的类别。
- 无模型评分自检覆盖这些组合，直接验证固定分母和工程门槛；只验证正常 accept／changes_requested 不足以冻结计分行为。

## F2 · P2：operation 已开始不能证明真实 provider 调用已经在途

初稿 R5 在计划 reviewer 的 provider operation 开始后终止宿主，并要求以真实 operation／process 事件作为锚点。这比猜测性 sleep 更可靠，但现有 operation 记录本身只是持久准入和计量边界，早于实际外部效果。对应修订后的 [R5 定义](pro-contract-researcher-s6.md#L96)和[注入锚点](pro-contract-researcher-s6.md#L101)见链接。

[`ExecutionPermit.run`](../packages/core/src/session/execution-permit.ts#L221)先调用 `jobs.begin`，然后再次检查许可，最后才执行 `effect(operation)`。[`jobs.begin`](../packages/core/src/pro-contract/job.ts#L459)持久化 `status: running` 和 `usage: unknown`，没有网络发送或 provider 接收的证明。

可达顺序：计划 review job 已建立，operation 被写为 running；在调用网络 effect 之前 SIGKILL；重启后原 operation 被保留为 unknown，显式恢复创建新 job，最后正常交付。按初稿 R5 可记录一次安全恢复，但根本没有中断过一个真实在途 provider 请求。反过来，即使观察到了请求开始，轮询到 kill 之间请求也可能已经完成；只保留“曾开始”事件仍不能证明注入落在声明的窗口。R6 同样不能把 verification operation 行当成实际 Node 测试子进程已启动的证据。

闭合条件：

- R5 将原 job／operation 身份绑定到可信 provider adapter／gateway 的实际 outbound-request-started 或 response 观测，并核对 kill 时仍未完成／结算。观察者记录发生在可信边界，不能由模型文字声明或候选文件代替。
- R6 绑定实际测试子进程的启动与存活证据，包括足以区分重用 PID／重启进程的执行身份；应区分宿主 runner 已启动和测试子进程真正进入运行。宿主终止后的进程清理须可核对，恢复不得收养仍在运行的旧执行。
- 已完成后才 kill、只见到 operation 准入而没有外部效果、未达到锚点等情况记为 `injection_miss`／`not_injected`，不能算故障恢复成功。保留预定六个实例分母，不增加注入次数直到碰到合适窗口。
- 观测能力不足是 S6b 的明确实施门槛。不能通过放宽锚点、换回 fixture provider 或操纵模型答案满足真实调用覆盖。观测、清理、重启和恢复等待全部受原六小时 deadline 约束。
- 评分／驱动自检至少包含 begin 后但 wire 发送前、实际调用在途、以及真实完成先于 kill 三种事件顺序，证明只有声明的在途窗口取得对应覆盖成绩。

## 已核验的非阻断结论

**Oracle 与公平性。** 公开材料包含完成任务必需的规范和数据，隐藏部分限于答案、标签与评分实现；独立参考实现、运行前外部核验、盲评顺序与双人争议裁决可以避免内部 verdict 循环自证。[隔离条款](pro-contract-researcher-s6.md#L51)明确不把不同目录或 Node permission 当作 oracle 隔离。S6b 仍须验证实际部署；若评分器需要执行候选，该候选执行进程同样不能读取 oracle／评分脚本，只能通过受控输入输出接受检查。源码、路径、artifact 名称和开发集不能携带目标标签。

**Reviewer 与 Researcher 的结论边界。** P／F 轨道走 canonical 工具和生产 job，真实模型只承担被测评审；其结果不计入真实 Researcher 执行能力。完整轨道禁止驱动代写计划或补答案。当前 [`Manifest`](../packages/sdk-next/src/research/model.ts#L16)只有一个 reviewer 配置，两个评审阶段共享模型配置的限制已正确披露；独立 Session 不等于错误统计独立。

**F 组前置门槛没有被错误算作最终检出。** [未触达规则](pro-contract-researcher-s6.md#L82)明确保留 `not_exposed` 和原分母，不补一个成功实例，不计目标缺陷识别；48/48 触达又是独立资格前提。因此，一个有效计划被前置 reviewer 误阻断会导致流程覆盖不足，而不会伪造最终 reviewer 的发现。本轮不将这种保守覆盖要求列为缺陷。F 组坏材料应按冻结准备脚本在合法实现阶段产生，不能让脚本看到中间评审后临时改写目标缺陷以求通过。

**样本与阈值。** 48 个探针来自八组配对，18 个完整实例来自六场景，各三次重复。初稿承认同模板相关性，要求逐族计数和每族最低覆盖，并把门槛限定为有限试点的工程要求；没有声称零次错误意味着罕见错误率已被统计保证。R5／R6 与 R2／R3 的关系可用于说明故障任务，但不能据此声称已估计一般故障代价或因果增益。无 no-review 对照也不能声称 reviewer 带来的净提升；设计已明确排除该结论。

**负结果、修复与评分反馈。** R3／R4 将有根据的负结果和不可识别结论计为有效交付，Node 检查不要求假设为真。外部 oracle 评分前截断主指标，只把预先约定的原 blocking finding 转为 exact challenge；不向执行者提供隐藏答案。初始 R1 修复、自然发生的 reviewer 修复和故障恢复分别保留分母，没有用多次送审稀释首次错误。

**当前生产接口支持有限任务。** [`Plan`](../packages/sdk-next/src/research/model.ts#L68)允许研究者在原 agreement 下表达假设、方法、对照、数据与判据；[规划提示](../packages/sdk-next/src/research/protocol.ts#L79)和[正式执行提示](../packages/sdk-next/src/research/protocol.ts#L91)保留 Principal 约定及版本化计划边界。固定 Node 适配器足以实现所列小型程序和合成数据任务；S6b 仍需用实际语料证明可解性，不能把表格中的题型名称当作已经冻结的 oracle。

**恢复身份与预算。** 当前 [`recover`](../packages/sdk-next/src/research/index.ts#L1192)检查停止状态、清理、原 context 和 deadline，并依据 `replan` 回到探索；设计没有假设所有崩溃都能复用计划。每实例 21,600 秒包含审查、修订、challenge、中断和恢复，省略累计 turn／action／request／费用上限；三个独立样本不为任何旧实例续期。全链 deadline-only 核验、单次操作上限、显式取消和完整 unknown accounting 均保留，不修改历史 cohort。

## 修订复核

| 发现       | 状态       | 关闭依据                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1 · 原 P2 | 设计层关闭 | [计分优先级](pro-contract-researcher-s6.md#L120)和[组合表](pro-contract-researcher-s6.md#L122)分别记录 raw verdict、scope、finding、结构／引用、protocol error 和 actual gate。缺陷材料上可解析 raw accept 优先记错误同意，矛盾范围理由不取得 detected 成绩；其余无效报告记 unavailable，有效报告才按语义分类。有效对照的错误 scope 不获质量成绩。最终报告不强加计划专属 scope，真正越权 gate 仍单列为不变量失败。 |
| F2 · 原 P2 | 设计层关闭 | [可信观测条件](pro-contract-researcher-s6.md#L101)将 R5 的原 job／operation 绑定实际 outbound／response 事件及未完成的本地请求，将 R6 绑定真实 Node 测试子进程启动、存活、PID 启动身份及清理。仅有 begin、已完成后 kill 或证据不足记 injection miss，不计恢复覆盖；保留六个实例分母且不得追加注入。缺观测明确阻断 S6b，观测和恢复不延长原期限。                                                                    |

[无模型自检](pro-contract-researcher-s6.md#L191)同时加入全部组合评分优先级、begin 后尚未发送、真实请求在途、完成早于 kill，以及子进程尚未启动、仍存活、已退出、PID 重用等顺序。本轮逐项核对这些条款与原反例：正确 scope 不能抵销矛盾 accept；宿主正确拦截不能冒充模型正确；running 账本行不能冒充外部效果；没有证明注入窗口不能取得恢复成功。

修订还明确[评分进程不能加载候选](pro-contract-researcher-s6.md#L53)，以及 [F 组准备脚本与缺陷必须提前冻结](pro-contract-researcher-s6.md#L80)。原 48／18 个实例、24／24 个探针分母、逐族最低要求、21/24 检出与对照通过、15/18 完整交付门槛均保留；负结果、盲评与裁决、Principal／计划分界和每实例六小时且无累计次数／费用上限没有弱化。

## 验证范围与后续门槛

本轮仅作只读源码核验和文档审查，没有执行真实模型请求、研究任务、故障注入、仓库测试或 typecheck。唯一工作树写入为本审查文档；主设计、历史签字、源码、测试和实验配置未由审查者修改。

复核已核对最终设计 hash、当前 S5 冻结清单的 28/28 个代码／测试文件、报告格式、相对链接及行号和 Markdown 数学格式；源码核验不代表重新执行 S5 接受测试。S6b 仍须冻结并审查实际任务包、独立 oracle、评分组合测试、数据隔离与真实事件观测；模型和部署配置也须在 S6c 前补齐。本轮不授权评测实现或付费运行，不把未运行的接受条件记为已通过。
