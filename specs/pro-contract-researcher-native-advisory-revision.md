# 原生 advisory review：审查回应与收敛修订稿

日期：2026-09-23。状态：设计边界已收敛，待实施与验证。本文根据用户转交的 Claude、Codex 后续审查及执行 session 的独立源码核对，修订[原方案](pro-contract-researcher-native-advisory-proposal.md)；原方案及[前次修订前版本](/workspace/researcher-native-advisory-doc-baseline-20260923T230237246273Z/pro-contract-researcher-native-advisory-revision.md)及[本次交接澄清前版本](/workspace/researcher-native-advisory-doc-baseline-20260923T234541010176Z/pro-contract-researcher-native-advisory-revision.md)保留。本次只修订本文，没有修改代码、运行测试、启动研究或评分。审查认可的是设计边界，下述验收不能读作已经通过。

目标保持：普通 Researcher 保留任务与部署授予的原生执行能力，自主处理独立意见；原任务决定验证与提交，Principal 决定方向、授权和最终认可。遵守 [Constitution](pro-contract-constitution.md)。以 `78bec19263814444ab008c58d54835b59b4a1c6b` 为能力参照，不整体回滚，不改历史协议、冻结任务、评分或预算。

## 1. 推荐变更

首片只接可选的 `contract_request({kind:"review",payload:{}})`。宿主按方案 A 接纳：忙时返回暂不能审阅并保持执行开放；满足条件时保存授权材料，复用受控 reviewer job 做串行审阅，正常路径恢复原 Session，崩溃断点按第 5 节处理。`contract_check` 和 `contract_report_ready` 均不增加 review 钩子或条件。有无 replay 均能使用同一请求入口；Researcher 不请求 review 时不额外暂停，交付也不等待意见。

reviewer 首片返回普通文本。保留其原文、job 状态、材料归属和读取记录，不要求严格 JSON、selector、逐条回应、修复意图或 completion。附件由宿主导出，不写进 kernel handoff，不作为原生提交的依赖。

代价明确：review 只在 Researcher 主动请求时发生，可能完全未发生。方案 A 要求避免因 review 暂停中断其他已经启动、受跟踪的工具；当前模型回合仍可能提前结束，暂停后同回合的后续调用不会启动，恢复后需由 Researcher 决定是否重新发出。审阅与恢复消耗原 deadline 内的时间，不承诺完全无损或宿主永久不可用时仍可恢复。

## 2. 对审查发现的独立判断

| 发现 | 判断与处理 |
| --- | --- |
| F1：投递与后续 attempt | 成立。暂停时 `SessionV2.prompt` 仍检查执行授权。通过 admission 暂存、scheduler 派发是现有接口下的合适入口；恢复输入绑定目标 Session 与固定消息 ID，按 durable inbox 状态决定是否投递，不能仅匹配当前派发 promptID，详见第 4 节 |
| F2：触发与时间 | 成立。删除 check 自动触发；即使自愿请求，也须有单次期限、恢复余量和重复材料处理规则，详见第 3 节 |
| F3：只用 request | 采纳。组合 native 与严格 Researcher handler，不另装一个会覆盖旧 handler 的服务。未启用合同仍保持 adapter unavailable |
| F4：暂停会中断工具 | 无条件关闭的风险成立。改用方案 A：同一事务检查其他持久 pending／running 调用，忙时拒绝暂停；当前模型回合与后续调用仍受影响，须通过三种并发场景验证 |
| F5：宿主存活依赖 | 成立。沿用完整原生恢复路径与启动对账，不单凭 lease 到期重开，也不新增仅针对 review 的外部清理证明门槛；恢复不代表证明残留进程全部退出 |
| F6：缩小意见采集 | 采纳只参数化 `ResearchReviewer` 所需配置与存储依赖，不拆整个 `ResearchFeedback`。旧解析失败仍保存 raw，不能描述为旧系统删除了原文；新入口让原文直接成为意见载体 |
| F7：附件不应阻断 | 采纳并明确分开原生提交证据与审阅副本。审阅归档损坏只取消该意见的可信使用，不否定独立成立的原生提交证据 |
| F8：附件范围 | 采纳最小附件，不新增“缺少处理说明”的字段或评分维度。已有自然语言处理说明仍留在原会话／报告里 |
| F9：幂等、并行及资格 | 采纳持久化固定输入和提前资格检查。不采纳无条件合并并行请求：不同调用不是重试，过期授权不能为合并而放行 |

不采用“约十行代码即可”的成本承诺。输入投递、派发失败、重启与清理的交叉行为尚未实际验证。

## 3. 启用、请求与时间规则

首片仅接入宿主通过现有原生签发路径发行、并显式登记 review 配置的新合同；不自动接管 `contract_propose` 的模型自提合同，也不修改已获批条款。这是首片的接线范围，不表示模型自提合同原则上不能获得 review。宿主启用时绑定 reviewer 模型、agent、指令、允许提供的材料范围、单次时间策略与原任务身份；这些由宿主维护，不新增模型填表。提前确认 `filesystem.read`、deadline-only 预算和可工作的请求处理／恢复组件。不支持时明确报告 review 能力不可用，不改变合同权限、预算或将普通合同拒绝为研究失败。在新任务签发时，经 Principal 批准的 brief 中中性说明可选的 `contract_request({kind:"review",payload:{}})`，建议单独发出 review 请求，并说明忙时拒绝与暂停效果；不要求请求或回应，不静默修改历史／冻结 brief，也不为每次请求增加确认。native handler 仅接受严格空对象 `payload`；其他内容返回可纠正的输入错误，不关闭 admission、不启动 job。它不接受模型自定 reviewer 指令或材料选择，但空 payload 不代表 reviewer 不会受到所读研究材料的影响。

native handler 的短 immediate 事务只包含授权／身份／期限校验、幂等及缓存元数据查询、忙闲检查、请求记录写入与 admission CAS；快照捕获、materialize、blob 写入和模型调用均在事务外。对于需要新 job 的请求，用可信 `call.messageID` 调用 `SessionStore.message`，核对消息属于当前 Session、本次工具调用存在，仅排除可信 `messageID + callID` 标识的自身。不要用 `SessionStore.context` 加载完整历史；消息缺失或归属不符时返回无法核对，不按空闲处理。当前 runner 每回合只产生一个 assistant 消息，且上一回合工具结束后才进入下一回合，因此此局部读取覆盖当前受跟踪的并行调用。存在其他 `pending`／`running` 调用时返回“暂不能开始审阅”，admission 及版本不变，不排队；只有无其他在途调用且时间等条件满足，才在同一事务中记录请求及暂停归属并关闭 admission。任一步失败不得留下半次接纳，不能用事务外状态或 `activity.has` 代替原子检查。job 仍须等待根执行退出并通过既有启动检查；请求工具不在自身执行中等待根 Session 结束。

源码支持这一原子边界：[SessionStore](../packages/core/src/session/store.ts) 与 binding 使用全局 `Database`，嵌套事务复用连接并使用 savepoint；`Tool.Called` 的持久投影发生在工具执行授权之前。其他调用先落盘且仍在途则检查返回忙，接纳事务先提交则后来的调用被授权检查拒绝。实际装配必须复用同一 Database 和事务上下文，并用第 7 节三种并发场景验证；这不要求增加 runner 的待暂停状态。

快照与缓存时序明确如下：精确重试先查询原请求，不重新生成其输入。新的明确请求在授权检查后、事务外捕获预查询快照，再在短事务中重新核对授权并查询完整缓存键；命中时返回绑定该捕获材料的缓存意见，不宣称它代表持续变化的在线工作区。未命中且按 A 接纳后，宿主在根执行停下、事务外再次捕获，作为实际审阅材料，再 materialize／写 blob，固定并持久化 job 输入。分别保存预查询快照和实际审阅快照身份；两者不同不沿用旧缓存结论或移绑意见，实际 job 与附件只绑定后者。捕获失败如实记为 review 不可用；暂停后准备失败则按恢复路径交还研究，不使原生提交依赖审阅准备成功。

时间策略至少明确以下关系，具体数值在启用配置中显式提供，首片不依赖隐含的“整个合同剩余时间”：

- 单次操作期限覆盖接纳后的准备、等待和审阅；从首次请求接纳时计算，重试、重启或换状态不续期。
- 启动前要为审阅、已有取消／清理操作及恢复后继续研究留出时间。不足时直接记录未启动，保持 admission 开放；准备后启动 job 前再次检查。第二次不足时不启动 job，已有 prepared job 按第 5 节取消，记录未启动；根执行已退出且任务授权与原 deadline 仍允许时，以一次性未启动说明保留 Session 重开，不续期或放宽到期条件。
- 停止审阅的时刻不得晚于原 deadline 减去清理和恢复预留时间。超时调用现有 `ContractJobs.cancel`，保存部分材料，通过第 5 节的既有取消与恢复检查后恢复；停止等待不等于进程已停止。
- `ContractJobs.cancel` 当前有两段各 30 秒的等待，不能将整个清理预算误算成单个 30 秒；外层仍要有明确的停止与未知清理状态处理。

这些是单操作期限与触发条件，不是累计次数或费用上限。恢复预留不能保证所有任务来得及完成修改与最终 replay，只避免计划内审阅占满剩余 deadline；原六小时 deadline 不重置。

重复审阅比较同一合同／revision、subject、材料与所附证据集合及 review 配置，不能仅看 `subjectHash`。三类请求分别处理：

| 情况 | 行为 |
| --- | --- |
| 同一可信调用的精确重试 | 在授权允许时复用原 receipt／请求状态与 job，不重复执行 |
| 相同完整审阅输入已有完整可用意见 | 返回明确标注的缓存意见，不再次暂停；不以 accept 作为可缓存条件 |
| 前次失败、不可用或中断后的新明确请求 | 允许相同材料发起新 job，保留前次失败；重新检查授权、时间和忙闲状态 |

不自动重试或重审到 accept，也不因材料未变永久禁止失败后的新明确请求。触发缓存与调用幂等是两件事：job ID 关联可信请求身份，材料目录、Session／消息 ID 和完整 job 输入先持久化，精确重试不得重新生成路径而造成 fingerprint 冲突。

并行的第二个独立请求若已失去授权，应被拒绝且不产生第二次暂停。能在仍有效的授权下识别同一已接纳请求时可以返回其状态；不得为了“合并”绕开外层授权检查。存在已接纳请求时，恢复文本只呈现该请求；若两个独立请求都因忙而被拒，研究保持开放，单个调用被拒不使整个研究终止。关闭后旧调用能否返回 receipt，受现有授权边界限制，不承诺绕过该边界的幂等读取。

## 4. 同 Session 恢复与一次性意见投递

[Session prompt](../packages/core/src/session.ts) 在 durable admission 前调用 `permits.capture`；[原生授权](../packages/core/src/pro-contract/open-code.ts)要求当前 dispatched 执行身份。因此不能在暂停时直接向根 Session 塞入反馈，原方案的表述不充分。

推荐在 `setAdmission` 增加显式的保留 Session 分支，仍满足原 context、无在途执行／job、无 pending revision、原 deadline 未到等检查；保持原 capabilities，不把普通原生执行缩成只读。恢复不增加语义 attempt，不清零用量。重新 claim 更新 generation，旧执行身份继续无效。

固定的一次性消息 ID、目标 Session、任务上下文及文本／delivery 存在 Core binding 的 `admission.input` 中，由新增保留 Session 分支与重开 admission 在同一次 `setAdmission` CAS 中写入；宿主表可保留相同投递信息的副本。它们是通用投递元数据，Core scheduler 只读 binding 与 Session inbox，不读取 SDK 宿主表、不依赖研究模块。[scheduler](../packages/core/src/pro-contract/scheduler.ts)在目标仍匹配且该消息尚未进入 durable inbox 时，始终使用这个固定 ID 投递，即使本次派发的 `promptID` 已因 `dispatch-failed` 更换也不丢弃。若该 ID 已存在，须按现有精确重试规则核对 Session、内容和 delivery；冲突不能当作已投递。已入 inbox 但尚未提升到会话历史时复用／唤醒原输入，已经提升后按原生规则继续，不克隆意见消息。

后续新 attempt 换 Session 时，旧一次性输入不再适用，text 和 delivery 均回到原生规则，首条输入保留原 brief；未投递意见保留为历史记录，不静默移绑。旧研究调用不带新选择字段，仍按原行为处理；不用全局清空旧 `admission.input` 的办法改变历史流程。

投递、重开与“已恢复”记录必须可对账：宿主在重开后、记录已恢复前崩溃，可核对 binding 中的固定消息 ID、目标 Session、context 和完整输入，确认已经执行过该次重开，不能再次关闭／打开研究或重复发送意见；不能只凭宿主进度标记或只凭消息 ID 作结论。明确区分 admission 已重开、消息已入 inbox 和消息已提升，后两者仍不证明模型理解意见。覆盖已 claim、写入 inbox 前派发失败的断点；不新增模型确认动作。

方案 A 的告知放在获准的 brief 与 native handler 返回内容中，Core 的通用 `contract_request` 描述保持不变：其他受跟踪工具在途时不接纳暂停；接纳后当前模型回合可能提前结束，同一回合在 admission 关闭后到来的调用不会启动，恢复后如仍需要，须由 Researcher 重新发出，宿主不自动补跑。“建议单独请求”不是新增批次语法门槛；同批其他调用若已完成不因此拒绝，实际按事务内 pending／running 状态判断。请求工具自己的返回仍可能被记为 interrupted；恢复说明重述已持久化请求、意见或不可用原因及可定位证据，不依赖触发工具一定返回成功，不把未启动调用记为执行成功。

reviewer 使用 materialize 出来的快照，绑定的是捕获字节，不宣称在线工作区在暂停前后始终稳定。后台进程能否在父工具结束后存活仍是未核验边界，不因增加 review 而偷偷禁止原先获准的执行方式。

## 5. 宿主重启与主执行恢复

把“继续审阅”与“恢复原研究”分开。首片不自动重跑已中断 reviewer；启动时对账自己接纳且尚未恢复的请求，保留真实 job 终态、完整或部分输出及中断／未知原因，再决定是否恢复主执行。

恢复至少要求：暂停确属该请求；合同 context、权限、原 Session 与原 deadline 仍有效；没有其他主体接管；在途执行、job 和清理状态允许恢复。关闭时在 `admission.reason` 写入包含请求 ID 的确定性标记；对账需匹配关闭状态、完整 reason、context、合同和请求记录，不以最初的 admission 版本号判断归属，因为 `settle(wait)` 会再次递增版本但保留 reason。执行恢复 CAS 仍使用刚读取的当前 binding，不能绕过版本检查。不能把取消、修订或其他故障关闭的 admission 当成 review 暂停重开，也不能恢复到期任务。

正常运行时沿用 `ContractJobs.cancel` 的取消、activity 等待和 lease 检查；已有活动或有效 lease 未退出时不重开。重启后按状态调用已有路径：`open`／`prepared` job 使用 `ContractJobs.cancel`，由它保留取消状态、等待旧 owner 的 lease 并在需要时调用 audit；其他终态只有仍带 owner 时才调用 `audit`，已有 owner 清除则保留终态。不能直接 audit 活跃 job，也不调用可能重新启动 job 的 `recover` 来自动续审。若现有取消／audit 返回尚未满足条件，则保留状态，不能自行清掉 owner 或绕过检查。根执行使用现有 [sweep](../packages/core/src/pro-contract/open-code.ts) 退役，随后通过完整 `setAdmission` 检查；不能只看到 lease 过期就直接重开。

按崩溃断点处理：job 已启动（其启动检查已确认根执行不在途）时，完成 job 终态对账并满足原生条件后可保留原 Session 重开；admission 已关闭但根执行退出尚未确认时，先由原生 sweep 退役旧执行，再使用已有换 Session 的重开分支，由原 brief 接手，不注入针对旧 Session 的一次性意见。授权变化、任务取消、其他主体接管或到期时不恢复。

首片限定单宿主部署，并具备上述启动对账接线。`activity` 是进程内计数，lease 到期不证明残留进程全部退出；只读 reviewer 的 grep／glob 也可能运行内部 ripgrep 进程。因此恢复只表示满足现有原生恢复标准，不记为操作系统清理已获证明。保留中断、未知用量与原生残留进程局限；不新增仅针对 review 的外部监督证明门槛，部署可自行采用更强保障。宿主永久不可用时不保证自动恢复，原 deadline 仍生效。

## 6. 意见与提交证据的范围

只复用／参数化 [ResearchReviewer](../packages/sdk-next/src/research/reviewer.ts) 的配置、独立环境核验、最终消息与 raw 保存能力，不搬运严格 `ResearchFeedback` 的 plan、manifest、verification 或 selector 协议。部分输出和失败源消息仍保留，不能把中断文本冒充完整意见。

每次审阅保存宿主可核验的任务、subject、材料清单、job／Session 身份、原文和状态。文字引用由 reviewer 自己承担判断责任，宿主不将其中任意路径或 hash 自动解释为已验证证据。工具读取记录用于检验 reviewer 实际访问了哪些材料，不证明它正确理解或覆盖了全部材料。自然语言意见不要求解析出 accept。

宿主附件只列意见、所审 subject／上下文、可用性，以及与最终 handoff 的材料身份是否相同。没有 handoff 就没有该匹配结论。附件不修改 kernel handoff，不增加回应、completion 或处理说明完整度字段。

两类故障分别处理：

- 提交所需 replay／证据不可用：仍按原生 `contract_report_ready` 的原规则处理。本接线既不放宽，也不额外增加要求。
- review 归档或副本完整性损坏：保留故障，不能把受损内容当成可信意见呈现；原生提交若有自己独立有效的证据，仍可进行。若损坏实际涉及提交依赖的同一证据，则按该依赖处理，不能只凭“review 故障”标签放行。

## 7. 最小工程范围与拟议验收

最小范围为：SDK 中组合 native 与旧 Researcher delivery handler；有限审阅请求的持久化、scope 内处理和启动对账；`ResearchReviewer` 的小范围参数化；`setAdmission` 的显式同 Session 恢复及 scheduler 对一次性输入的选择。方案 A 的接纳检查位于宿主，不增加 runner 等待队列或待暂停状态；同 Session 恢复和可靠投递仍需既定执行适配改动。`contract_check`、原生提交、kernel、旧解析器和旧研究状态机保持原义。

请求记录只描述“接纳、job、采集、恢复”的操作进度；跳过／失败是结果，不引入研究计划、实验和提交状态机。复用原生 scheduler 与 `ContractJobs`，不复制调度主研究的第二套循环。新增的宿主接线仍有故障责任，不能因只有几个状态就称为零成本；不要求装配整个严格 `ResearchModel.Run` 或 `ResearchCoordinator`。

delivery 服务只能在 SDK 组合点装配一次，兼容 native 与研究 profile；native handler 按合同启用记录选择，不让一个合同启用就开放所有合同。未启用合同仍保持原 adapter unavailable，原 `contract_report_ready` 不经过这个 handler。

| 验收 | 范围与应有结果 |
| --- | --- |
| 当前原生基线 | 先在 review 关闭时实际运行参照任务的 `./compile.sh`、`python3 validate.py` 与约定产物，明确当前原生路径是否已有退化；源码保留 argv 不等于已证明端到端兼容 |
| 启用对比 | 同任务、授权和部署下启用并实际请求 review，再完成同一执行与提交；包括恢复后的 process 能力。brief 使用相同文本，或明确记录可选能力说明的差异；不另建广泛工具链矩阵 |
| 有无 replay | 无 replay 也可请求 review；未请求不暂停、不新增验证器；`contract_check` 行为不变 |
| 真实读取链 | 确定性 provider 驱动独立 Session 读取封存代码／输出、返回具体原文，随后研究 Session 收到；未触达材料不能靠预制 JSON 冒充 |
| advisory | 不采纳、零回应、无 completion、不符合 JSON 的完整文本、模型不可用均不成为新提交条件；review 归档损坏不污染独立原生提交证据 |
| 恢复连续性 | 正常交接保持 Session，generation 更新，旧调用拒绝，attempt 与计量不重置，capabilities 保持原值；后续新 attempt 有原 brief，同 Session 瞬时中断不重复投递意见；已入 inbox 未提升时不丢失、不克隆 |
| 时间与请求 | 临近 deadline 不暂停；第二次时间检查不足时封存未启动并在原条件允许时恢复；精确重试复用，完整意见可缓存，失败后新明确请求可启动；预查询与实际审阅快照不得移绑；单次超时按既有路径处理，不自动重试 |
| 宿主中断 | 覆盖接纳后未建 job、job 中断、已采集未恢复、已重开未记完成、已 claim 但写入 inbox 前派发失败；按第 5 节调用原生路径对账，并区分保留／更换 Session；不自动续审；有效 lease、在途 activity、授权变化、取消或到期时不误恢复 |
| A：已有长工具 | 确定性 provider 驱动在途长 bash；review 返回忙，admission 及版本保持开放原值，bash 继续运行，不产生接纳后的等待队列 |
| A：后发工具 | 控制事务先后，使 review 接纳后紧跟 bash；确认进程确实未启动，调用未执行的状态在恢复后可见；不以仅返回错误替代实际启动检查 |
| A：单独请求 | 无其他 pending／running 调用时正常接纳，独立审阅后恢复同一 Session；核对可信当前 assistant 消息读取与 CAS 共享 Database／事务，快照和 blob 操作在事务外；三场景不代替恢复与投递验证 |
| 历史边界 | 旧严格模式、显式 required、原 deadline、权限和保护检查仍有效；新分支不改变未选择它的调用 |

上述是有限工程验证，不是新研究或资格评测。它不能证明 reviewer 普遍有益、后台进程全平台行为或多进程部署安全，也不证明真实模型必然会主动请求并正确处理意见。

## 8. 剩余取舍与证据边界

推荐采用方案 A、三类重复请求处理与完整原生恢复标准。还需在实现中落实实际时间参数、持久化和 SDK 装配，并完成约定的并发、重启、连续性与投递验证；两位 reviewer 的设计认可及本次源码核对不等于实现已经通过。范围限于上述接线，不扩展资格平台或新增恢复系统。

当前原生路径相对 `78bec19` 已有较多修改；基线兼容性须独立验证。SBNO 的 12 次失败判断来自既有[试用摘要](/workspace/sbno-task-preparation-20260923T061618Z/trial-summary.json)及[Python 修补记录](pro-contract-researcher-python-verification.md)，不是本轮静态源码检查重新证明了运行结果。

可关闭未来任务的新接线，恢复为普通原生执行；已产生意见和故障保留。运行中／冻结任务不切换协议绕过条件。历史累计预算任务暂不接入，不偷偷改成 deadline-only。保留每实例六小时原 deadline、无新增累计上限和计量未知项。

本轮到文档修订为止。没有自动接续实现、真实模型核查、历史重评、66 例或外部认可。
