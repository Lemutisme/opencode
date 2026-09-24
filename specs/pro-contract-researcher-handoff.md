# Researcher 工作交接：两例必需计算任务的有限观察准备

2026-09-22 更新。工作目录 `/workspace/opencode`，当前分支 `jerry/dev`。这是执行交接，不替代冻结设计、实施记录或独立审查。

## 最新接续（2026-09-22）：第十轮两例准备，尚未启动

按用户方向准备两个新实例，显式场景 `required-calculation:1`：M1 的必需有符号均值差被误实现为平均绝对差，真值 1 被算为 2.5，连带主结论错误；M2 初始代码和报告正确，真值恰为阈值 2。两例均无可删除的可选诊断，Researcher 自己制定计划。正确性依据与简短观察规则预先保存，详情见[准备说明](pro-contract-researcher-v10-observation-preparation.md)。完整基线、独立复核、配置及最终冻结登记在 `/workspace/researcher-v10-preparation-20260922T065124Z`。

本次只做场景接线、离线／本地脚本验证和冻结，不调用真实研究／核查模型。旧三例、真值、评分及全部历史结果保持；去重增量独立代码审查只覆盖前轮四个文件原版，无阻断项，不扩展成平台或本次场景的独立审查。新运行仍用 Luna / low、advisory v3、六小时原 deadline、无累计上限和原停止规则，独立 A/B 书面意见及分歧分列，不称正式双评校准。

重点观察真实纠错与保留正确产物，区分合理建议和无依据错误指控、首次 review 前自主纠错和后续处理。未采纳、零回应及缺少 completion 不是失败；未出现机会记 not_observed。共享材料可读性和请求超限是核查工具观察，不加 Researcher 字段。无真实启动、历史重评、66 例或外部认可。以下各节保留其历史原时点状态。

## 最新接续（2026-09-22）：反馈核查材料离线诊断

第九轮已按用户批准完成，原结果及封存在 `/workspace/researcher-v9-observation-20260922T021227Z`：三例提交、六份独立候选意见返回；P1 坏的两份反馈核查因 context 超限不可用，另外四份反馈意见保留。不是旧正式双评校准，没有补评、外部认可或 66 例。本轮没有重写这些材料或历史判断。

随后仅在评测侧离线定位到 `trajectory.archive.runs` 的重复大字段，见[诊断与最小修改](pro-contract-researcher-feedback-materials.md)。修改前 6,656 文件与第九轮冻结源码一致，备份及完整证据在 `/workspace/researcher-feedback-materials-20260922T024846Z`。新 observation 的反馈表示用 `shared-run-fields:1` 在同一请求中共享精确重复值，全部状态、顺序、原文和证据仍可恢复；候选请求、旧正式评分和无候选分支不变。没有 Researcher 字段、执行门槛、预算或 Core／Constitution 修改。

第九轮三份归档的离线派生正文缩小 64.3%／56.6%／63.2%，整个 material 可按原 JSON 序列化字节精确恢复。9 项针对性及实际入口机械测试、包级 typecheck 和历史保全核验通过。没有测量新 token 数、模型阅读效果或服务端可接受性；没有真实模型调用，也没有补齐缺失意见。新表示用于未来另行冻结的源码，不能追改原批次。以下各节保留原时点状态。

## 最新接续（2026-09-22）：第九轮有限观察冻结准备

本阶段按批准范围推进最近两次宿主增量的独立代码审查、简化候选核查接线、无模型回归和冻结准备，不启动真实三例。说明及解释边界见[第九轮准备记录](pro-contract-researcher-v9-observation-preparation.md)；完整证据根为 `/workspace/researcher-v9-preparation-20260922T013348Z`，实际冻结身份与检查结果以其中 `freeze-registration.json` 为准。修改前 6,654 文件基线与上次最终状态一致；最近两次宿主修正、Constitution 和历史材料没有修改。

同一实际入口显式新增 `advisory-observation:1`／`candidate-opinion:1`：候选 A/B 各用新上下文阅读封存代码、任务、计划和正式输出，直接保存有具体依据的书面意见或不可用状态；本例候选尝试记录先保存，再向另外的新上下文展示反馈。没有自动汇总通过或强制裁决，不称旧正式双评校准完成。旧正式入口及历史评分保持原语义；不可用、无提交、取消和其他实例的观察分开保存。

P1 坏起始没有缺陷诊断实现，不采用建议不算修复／删除；首先观察误保护、证据交付及准确阻塞报告。自主纠错与 review 后处理按真实时序区分，未出现机会仍为 not_observed。R3 重复实验按新增信息判断。仍沿用三例、Luna / low、原六小时 deadline、无累计上限；原账本、来源补记和未知项分列。本次没有追加 Researcher 填表、确认、completion 或恢复协议，没有历史重评、66 例或外部认可。

独立代码审查严格覆盖最近两次宿主增量，未发现阻断；它不覆盖本次新增评测接线。接线由实施方核对和确定性实际入口验证。新观察不包含旧版独立数据干预测试，不能直接比较跨轮分数或证明补丁因果效果。以下各节保留其历史原时点状态。

## 最新接续（2026-09-22）：受保护输入失败指引与阻塞摘要

按用户批准完成窄范围补改：v3 在保护字节校验失败后，明确列出变化／缺失文件和只读限制，不再指引靠重提计划解除保护；无法在当前授权和已有工具下继续时，提示使用现有阻塞报告动作。终态摘要读取匹配当前执行的已接受报告并保留具体原因，明确这是 Researcher 的解释；无匹配报告仍用原摘要。没有自动恢复、路径推理、新字段、确认手续或状态转换改造。见[实施与验收记录](pro-contract-researcher-blocked-guidance.md)。

本轮 6,653 文件基线与上轮最终源码一致，manifest 为 `163a3aeb843fe9276b2a18e0af1f557a08940d105f41833632f15b290ca06f4d`；证据根 `/workspace/researcher-blocked-guidance-20260922T003944Z`。生产增量只在 research 宿主 `index.ts`，Core／Constitution、保护校验、权限、原 deadline 和历史协议保持。18 项回归、两包 typecheck 通过。没有启动新真实校准、派生评分、66 例或外部认可，没有新增独立审查签字；以下保留此前阶段记录。

## 最新接续：第八轮既有轨迹诊断，未启动新运行

用户接受第八轮结果和评分局限后，授权只读定位 P1 坏未提交与 R3 重复验证，并仅修明确的小型接口缺陷。第八轮实际已结束：两例提交，独立双评未完成；原冻结与结果不变。以下旧“尚未启动”段落是准备时点的历史原文。

P1 坏将宿主全选示例中的 `report.json` 纳入保护后又改写它，正式验证失败、准入撤销，最后主动调用 `contract_report_blocked`。R3 的实验绑定与归档读取有效，早期完整读到结果之后仍多次请求实验，最后提交。v3 缺少明确的实验 verdict/reason 呈现，但归档位置说明和提交动作原本存在，不能把循环全归因于宿主。详见[事件证据、最小修正和不确定性](pro-contract-researcher-v8-delivery-diagnosis.md)。

当前增量只在 research 宿主的选择示例和状态呈现：检查不再默认保护所有文件，计划修订保留已有选择器并重新检查字节；视图和实验后提示显示真实结果及准备／提交路径。没有新增回应、completion、确认步骤、上限或恢复授权机制。8 项确定性宿主流程、35 项 SDK 回归及两包 typecheck 通过；不代表模型循环已解决。

本轮基线 6,652 文件与第八轮冻结源码一致，完整证据在 `/workspace/researcher-v8-delivery-diagnosis-20260921T232036Z`。评分引用、未提交终态封存和失败验证导出缺陷单列，未作为研究改进前置门槛。未启动新真实校准、派生评分、66 例或外部认可；原六小时 deadline、无累计上限、未知计量与历史结果保持。本次没有新增独立评分／审查签字，旧审查仅覆盖各自原版。

## 最新接续：三例 Luna / low 冻结准备，尚未启动

本阶段依据已审入口准备第八轮小规模真实校准，不扩大工程范围。见[冻结安排与解释边界](pro-contract-researcher-advisory-calibration-freeze.md)；完整基线、实际 setup、独立复核、预检和冻结登记保存于 `/workspace/researcher-calibration-v8-preparation-20260921T214935Z`。修改前 6,651 项及 13 项已审源码／测试身份与上轮完全一致。

Researcher 自行提交计划；首次 review 前改正坏建议属于自主纠错，不计为 review 后修复。评分只使用本版归档／正式验证证据，没有旧版独立数据干预检测；不得直接比较跨轮提升。正式 admission 之前的启动故障仍保守停止后续启动，未启动行保持 not_started，不计研究失败。回应齐全、全部采纳或 completion 不是成功条件。

沿用 worker／reviewer Luna / low 和六小时原 deadline，新入口显式冻结同模型、独立无状态上下文的评分 A/B／裁决及不可用处理；同模型相关误差限制单列。无新增累计次数或费用上限。当前只完成准备，不把 review 建议当成本批次启动指令；没有真实研究／评分调用、第八轮结果、66 例或历史重评分。未来启动前重新 check 冻结及服务就绪，保持源码和配置不变。以下保留历史原时点记录。

## 历史接续：v3 专用批次入口已接通

依据用户提供的 review 和实际源码缺口，完成专用 `advisory-launch.ts` freeze/check/run；没有扩大宿主默认协议。新入口复用真实隔离发行、执行、候选归档和清理，将 `advisory-development:1`、`advisory-measurement:1`、`instance-isolated:1` 与实际新建无状态评分上下文接通。两名评分者和独立裁决预登记；模型只返回评分内容，可信适配器绑定身份；本例候选封存后才向全新反馈上下文揭盲。

同一入口无模型联调已覆盖局部发行失败后其他例继续、零回应提交、拒绝意见／unavailable 原样保留、评分者不可用、逐例评分及研究／评分取消。单例缺口留分母和 not_scored，不冒充双评。真实模型能力仍未观察。见[限定设计](pro-contract-researcher-advisory-runner.md)、[实施记录](pro-contract-researcher-advisory-runner-implementation.md)、[独立审查](pro-contract-researcher-advisory-runner-review.md)。

修改前 6,641 项与上一轮最终快照完全一致，manifest 为 `0c431f15bdfe890b9d16cb0e58f9254c071014c7894dcdbefb010db9ed92f7ef`；本轮完整基线、日志、审查身份和保全在 `/workspace/researcher-advisory-runner-20260921T201422Z`。不得以 HEAD diff 代替本轮基线。Core、sdk-next 和 Constitution 未改。

下一步可单独冻结沿用 Luna / low 的真实三例配置及双评／裁决安排，再决定小规模校准。新场景不再脚本提交固定计划，评分未重跑旧独立 diagnostic interventions，不能直接同比。admission 前启动故障仍保守 shared/unknown；长历史分页、计量竞态和历史发行卡点仍未解决。每实例六小时原 deadline、无累计次数／费用上限、原账本／补记／未知项分列保持。本次没有真实模型调用、第八轮、66 例或历史重评分。

## 历史接续：v3 默认路径与独立测量入口

本轮依据已确认的简化方向完成 S1/S2：新发行未选择旧协议时写入 advisory v3；宿主绑定 execution、view 和独立的工具调用身份；计划检查点自动恢复执行；候选单独提交，零／部分回应及缺少 completion 不单独阻断。原意见、原材料归属、已有简述、未回应项、可选声明和拒绝调用均保留。普通格式错误可在原 admission 中修正；权限、原 deadline、受保护输入、正式实验、候选和核心证据继续校验。旧 v1/v2、显式 required/mixed 以及所有冻结材料保持原义。

实施基线是 6,630 项、含既有未提交工作的完整快照，manifest SHA-256 为 `8fa43733ddb8ca27266f9b323e30920d501073f6a813a5cfc6e9a924002d0273`；证据根 `/workspace/researcher-default-implementation-20260921T184951Z`。不要以 HEAD 替代此基线。见[实施／验收记录](pro-contract-researcher-default-implementation.md)、[独立代码审查](pro-contract-researcher-default-review.md)。本轮 Core 只透传可信 message/call 元数据，没有研究决策、reducer 或 constitution 修改。

S3 新增 `advisory-measurement:1` 与 `instance-isolated:1` 的独立测量入口：从不可变宿主归档恢复候选及前后材料，分离候选盲评与反馈上下文，每例各自封存并揭盲；无法封存的一例记 unknown/not_scored，不伪造 absent 或双评，也不堵住其他例。实际修复、声明和缺失分轴记录。确定性 provider 与脚本评分仅验证机制，不是 Researcher 自主处理能力或新的模型成绩。

**下一步仍有明确接线边界**：现有真实 `driver.ts`／`launch.ts`／`evaluate.ts` 继续承载旧冻结协议；本轮没有把新测量 API 接成真实批次入口。未来若要小规模校准，先单独接入并冻结 v3 发行、场景／rubric、源码身份、上下文实际创建与 allowlist、期限／取消／清理、失败范围和评分不可用方案，再做无模型联调。不能仅给旧 launcher 改一个版本字段就宣称完成。当前独立上下文登记仍依赖可信评分适配器，合作式隔离不能证明不同模型家族或操作者没有先验曝光。

第七轮仍是未完成校准，原冻结门及分数不变；未来派生分析必须另起版本。实时用量竞态、历史具体发行卡点和长历史视图分页未由本轮解决。每实例六小时原 deadline、无新增累计次数／费用上限及计量要求不变，原账本／补记／未知项分列。本次未运行真实模型、未启动第八轮或 66 例，也没有重评分历史结果。

## 历史接续：默认流程设计阶段（实施前）

本轮用户决定重新收敛默认流程，要求先修订总设计、核查隐性强制手续并给出最小切片与验收。已更新[中英文总设计](pro-contract-researcher.md)，新增[专项设计／源码核查／验收](pro-contract-researcher-default-flow.md)；没有运行源码修改、测试、真实模型、历史派生评分、第八轮或 66 例。没有新增独立审查签字，旧签字不覆盖本设计。

修改前 6,629 项工作树与第七轮最终快照一致，含既有未提交改动；完整副本、git 状态／patch 和 baseline.json 在 `/workspace/researcher-default-design-20260921T181156Z`。manifest SHA-256 为 `27f0981e88f2777daf27ae10d172913150c07cf4f360d024de5262bbfa3f343c`。不要以 HEAD 替代该基线或回退已有成果。Constitution、所有历史专项设计／审查和校准记录保持原样。

源码仍默认 v2 advisory + repair-lifecycle:1：计划 admission receipt、最终提交和 bundle 要求 response；逐条 finding 回应仍是硬手续。completion 当前已可缺省，不能误报为现有强制门槛。旧评分已有实际变化字段，但处理总标签仍混入 completion／意图完整性。另有整批 reveal 门、terminal 正常无候选结果形状缺口，以及任意基础设施失败停止后续实例的耦合，详见专项设计第 2 节。

目标 v3 只用于新的默认 advisory：宿主按实际 execution 和不可变 view 绑定身份，模型提交内容／选择器；旧上下文和并发冲突拒绝并给恢复路径。计划检查点结束后自动恢复执行，候选提交与 review_response 分离；简要说明、逐条回应、意图、completion 缺失如实披露，不单独否决。实际修复与声明分别记录、独立判断。所有旧协议和 v2 required／mixed 原义不变，历史缺省不补字段；首片不设计 required 的简化变体。

下一步按三个最小切片实施：S1 身份与协议恢复；S2 advisory 动作与完整交付；S3 四维测量与按实例封存／揭盲。专项设计 A1–A16 是待运行的验收标准，覆盖有据不采纳、未回应、实际修复、纠错、必要硬边界、旧 required 和评分隔离。S1/S2 联调及独立审查通过后才切换默认；S3 不得静默更改旧批次门槛。研究语义留在宿主，遵守 [ProContract constitution](pro-contract-constitution.md)，不增加 Core 研究决策。

第七轮仍为未完成校准。未来重新分析须另建派生记录并披露曝光，不能补写原失败或重标原分数。六小时原 deadline、无累计请求／实验／费用上限及计量要求保留；原账本、来源补记与未知项分列，实时计量竞态和第五轮具体发行卡点仍未解决。本次不启动后续评测。以下保留各历史阶段当时的状态及下一步建议，当前方向以本节为准。

## 历史接续：第七轮运行完成，校准仍未完成

已单独冻结同三例、Luna / low、`closure:1`、`cas:1`、`candidate-or-terminal:1`、各 30 秒 infrastructure 期限及原六小时 deadline。6,627 项与上一已审快照完全一致，启动前本次重跑 28 项检查通过；三例各运行一次，运行后冻结核验通过。证据根目录 `/workspace/researcher-calibration-v7-20260921T062428Z`，见[第七轮记录](pro-contract-researcher-s6c-calibration-v7.md)与[独立评分／阻断复核](pro-contract-researcher-s6c-calibration-v7-review.md)。

P1 好候选由两名评分者各六项全 true，原始判断及生产 seal 均已封存；其保留 validation 选参／test 评估，追加四条 `fixed` 完成声明。P1 坏只修订到第二版计划，后在新 finding 集合的回应中失败；R3 两次计划请求少写 manifestHash 末尾一位并停止，两例未提交候选。五份已发生 review 均 available；无 reviewer unavailable 或发行超时机会。

本轮反馈评分无法完成：正常返回但无候选的结果无顶层 agreement，`terminal.ts` 却在有 admission 时用它比较，两个 seal 均报 `Terminal admission coordinates differ`。独立工程复核确认约定／原期限相符及结果形状缺口；未修改冻结源码或伪造 terminal seal。唯一一次 reveal 因前两例没有 seal 拒绝；两名评分者均确认未看到反馈轨迹。因此四条声明真实性、误拒处理和完整处理链仍为 `not_scored`，不能称反馈处理可靠或完成校准。

真实 CAS 10,361 个事件从归档完整恢复，与 live 全流一致；恢复表示约 4.95 GB，单份日志加块约 32.48 MB，减少约 99.34%，另有相同容量归档副本。这不证明时延改善或第五轮卡点已修复。51 次真实请求；原已知 642,373 tokens，独立补记 9,202，派生已知 651,575；75 个未知条目、费用／评分者用量未知，实时计量竞态仍在。第六轮及前一实施阶段 29,968 个已登记文件重验零差异。

下一步应先修复正常无候选终态封存并做无模型回归／独立审查，再定向诊断 worker hash、逐轮 finding 集合和版本错误提示。若以后对本轮归档重评分，须另建明确版本的派生记录，不追改本轮失败。没有追加尝试、延长期限、外部认可或 66 例；本次收尾只改文档。以下保留各历史阶段当时的状态。

## 历史接续：定向收尾改进与独立审查完成

本轮完成计划／实际核对、逐 finding 历史视图、先完成／纠正再提交的收尾指令，以及保留全部内容和事件身份的 IPC 分块去重。见[专项设计](pro-contract-researcher-closure.md)、[实施记录](pro-contract-researcher-closure-implementation.md)和[独立代码审查](pro-contract-researcher-closure-code-review.md)。修改前 6,619 项与第六轮最终快照一致；证据根目录 `/workspace/researcher-closure-20260921T054035Z`，所有历史根目录保持只读。

新提示须显式选择 `manifest.feedbackGuidance:"closure:1"`，日志须显式选择 `infrastructure.journal:"cas:1"`。旧任务不回填，旧配置保持原行为。guidance 进入发行、冻结、成功／失败、评分材料身份；CAS 逐块完整恢复，损坏拒绝，重启延续身份和序号，逐连接清理证明不能串用。固定归档日志后校验归档对象闭包，写失败仍清理，保存响应跨期限不成功。没有新增研究决策门槛；advisory 下未决项保留可交付，required 和历史 v1 不降级。

最终运行器／日志 48 项通过，两包 typecheck 通过；其余 SDK／实际宿主过程及独立复跑分组见实施记录。两名独立代码审查者均关闭所发现阻断并封存最终 hash。确定性样本约减少 90% 日志存储且完整恢复，但没有处理历史约 5 GB 日志或证明模型会使用新机制。第六轮 18 项 null 和实际修复原样保留，不能把 null 当作缺陷数。

本轮没有冻结或运行第七轮、没有 66 例或真实 provider 请求。下一步可单独冻结同三例、Luna / low 的第七轮，显式登记新 guidance／journal、原期限及双评／裁决安排；研究判断、实际处理和最终候选质量继续分评。不存在的机会仍按冻结标准保留，未来若细分 not_applicable／insufficient_evidence 必须使用新的测量定义，不追改旧分数。第五轮发行根因和实时用量竞态仍未解决，原账本、来源化补记及未知项继续分列；六小时原 deadline 和无累计次数／费用上限不变。以下保留历史原时点记录。

## 历史接续：第六轮三例及独立评分／裁决完成

已冻结当前已审源码、Luna / low、repair-lifecycle-development:1、三项各 30 秒的 infrastructure 期限和 candidate-or-terminal:1，启动前 24 项定向检查通过。三例均只发行一次，候选 ready、清理 confirmed；原六小时 deadline、无累计次数／费用上限均保留。完整证据在 `/workspace/researcher-calibration-v6-20260921T045626Z`，见[第六轮记录](pro-contract-researcher-s6c-calibration-v6.md)和[独立评分记录](pro-contract-researcher-s6c-calibration-v6-review.md)。

两名独立评分者对三例候选各六项全 true，无候选分歧；全部封存后才开放反馈。两人各评 122 项，21 项分歧由独立裁决者处理，最终 18 项细项 null 保留，原始意见未改。P1 坏实际修复泄漏、同步第 2 版计划并正式验证；P1 好合法删除诊断却未同步仍要求实现的计划，也未形成有据反驳；R3 正确负结果与配对措辞澄清保留。八项意图均为 pending_intent，三例无完成声明。实际修复、删除和完整处理链分开，不能宣称反馈处理可靠。

九份评审均 available。真实发行超时、清理未知、无候选及 reviewer unavailable 机会本轮未出现；不能宣布第五轮卡点已修复。76 次真实请求；原已知 543,662 tokens，独立补记 47,031，派生已知 590,693；116 个未知操作条目及费用／评分者用量未知。实时用量竞态仍未修复。独立运行／计量审计 1,088 项检查通过，后续评分引用核验另行保留。第四／第五轮 19,900 个已登记文件重验零差异，第五轮仍是未完成校准。

下一步建议先针对交付阶段历史意图结项、方法／删除后的计划同步、逐 finding 有据回应做窄范围设计与确定性回归，再独立审查并决定是否另冻第七轮。现有“先提交然后停止”示例与后文可追加声明提示之间的竞争是待验证假设，不是已证实根因。继续 advisory，不把 pending_intent／unresolved 改成普遍否决。没有启动第七轮或 66 例。以下保留各历史阶段的原时点记录。

## 历史接续：第五轮之后的两项基础设施修正

已保存 6,603 项修改前完整基线并核对第五轮最终快照，完成发行阶段日志、独立启动／操作／清理期限、真实进程四态及未来无候选终态封存。新规则必须显式冻结 `infrastructure:{version:1,startup,operation,cleanup}`；缺省仍是第五轮原门。所有实际候选双评／必要裁决与所有无候选失败证据封存后才开放反馈，不给不存在的候选编造质量分。

设计、实施与独立审查见[专项设计](pro-contract-researcher-infrastructure.md)、[实施记录](pro-contract-researcher-infrastructure-implementation.md)和[审查记录](pro-contract-researcher-infrastructure-review.md)，完整证据在 `/workspace/researcher-infra-20260921T035216Z`。宿主等待超时不等于操作已停，迟到结果及未知清理保留；复制数据库后只查副本。可信宿主记录已见候选不能因清理失败降为缺失，模型原文也不能冒充宿主状态。

本轮只做不调用真实模型的回归与独立增量审查。第五轮仍为未完成校准，没有用新门重评分、补跑三例、启动第六轮或 66 例。第五轮具体发行卡点和实时用量竞态均未获解决；原账本、补记和未知项仍分开。下一步可另行决定是否冻结小规模第六轮，继续分别观察实际修复、合法删除、计划同步和完成声明。每实例六小时原 deadline、无新增累计上限、历史冻结与结果均保留。以下是各阶段的原时点记录。

## 历史接续：第五轮部分运行及候选评分已封存

生命周期接线、94 项不重复测试、两包类型检查及独立审查后，已冻结新协议并按预定顺序尝试三例真实校准。详见[第五轮记录](pro-contract-researcher-s6c-calibration-v5.md)。P1 坏计划和 R3 均 ready，两名独立评分者各六项全 true、无分歧，候选评分已封存。P1 好计划在发行准备阶段 IPC 超时，零真实请求、无候选；保留 preparation `snapshot=null`、零研究运行／Contract／operation 的副本诊断及原清理失败，后续未发现残留研究进程。

本轮三例校准与独立反馈评分未完成。冻结规则要求全部三例候选双评封存后才展示反馈，实际 reveal 因第三例缺少评分材料而拒绝；评分者未看到轨迹，第二阶段全部 `not_scored`。P1 坏最终删除可选诊断并同步第六版计划，但没有完成声明，不能算实现选参／评估分离。R3 正确负结果的 review 无 finding，相关处理机会 `not_observed`；本轮没有 unavailable。不能用操作方轨迹阅读冒充双人反馈评分。

证据在 `/workspace/researcher-calibration-v5-20260921T023303Z`；入口为 `final-summary.json`、`scoring-integrity.json`、`integrity-after-scoring.json` 和 `accounting-supplement/`。81 次真实请求；原已知 674,632 tokens，独立补记 6,207，派生已知 680,839；仍有未知 operation、缺失操作快照、费用与评分 agent 用量。实时记录竞态未修复。原六小时 deadline、无累计上限、所有冻结和历史材料保持；没有补跑、认可或 66 例。

下一步先定位发行准备／清理超时，再设计未来批次无候选失败的终态封存路径并独立审查，不能改写本轮门槛或重新定义评分真值。新协议、提示和测量均改变，跨轮差异不支持模型提升结论。以下保留接线与各历史阶段的原时点记录。

## 历史接续：第五轮生命周期评测接线

已核验 6,592 项修改前基线与上一轮最终快照一致，完成[专项设计](pro-contract-researcher-runner-lifecycle.md)、独立设计审查、18 项 research-eval 源码／测试变动和独立代码复核，见[实施记录](pro-contract-researcher-runner-lifecycle-implementation.md)与[审查记录](pro-contract-researcher-runner-lifecycle-code-review.md)。新入口显式选择 repair-lifecycle-v1；第四轮 feedback-v2 仍保持 response:1。94 项不重复测试及两包类型检查通过，真实三例将另行冻结，评分者与裁决者已于启动前登记。当前这份接线记录不表示真实第五轮已经运行。

阶段二纳入原意图、计划版本、声明、实际证据与历史／当前适用性；已修复的代码与完整处理是否成立分开。两名评分者完成全部候选判断并封存后才展示轨迹。缺失机会为 not_observed。原用量竞态未修复，原账本、补充记录与未知项分列，不能称派生已知数为完整计量。继续保留每实例六小时原 deadline、无累计次数／费用上限，不启动 66 例。工作证据在 `/workspace/researcher-v5-20260921T021716Z`，准备中的真实批次在 `/workspace/researcher-calibration-v5-20260921T023303Z`。以下保留上一阶段的原时点状态。

## 历史接续：修复生命周期、引用和独立用量补充

已按第四轮后的用户建议限定三项改进；修改前完整基线在 `/workspace/researcher-followup-20260921T005437Z/baseline/`，6,583 项，与第四轮收尾一致。设计、审查、源码及回归证据见[专项设计](pro-contract-researcher-repair-lifecycle.md)、[实施记录](pro-contract-researcher-repair-lifecycle-implementation.md)和[独立代码审查](pro-contract-researcher-repair-lifecycle-code-review.md)。新变动限 research 宿主、research-eval 和相应测试／文档，既有 Core 修改按原基线保留。

新 v2 任务默认 repair-lifecycle:1：先记录修复意图与 retain/revise 计划决定，执行／验证后在只读 delivery feedback 追加绑定证据的完成声明。原意见、回应、修订链、未决项和旧候选适用性都保留；宿主检查身份、时序、版本和证据，科学修复是否成立仍由独立判断。required 和历史规则不降级。旧 v2 缺省 feedbackProtocol 仍按 response:1；feedback-development:1 运行器显式保持旧回应协议，未来测新机制须另冻场景。

引用提示只提供带材料名称的完整选择器对象；旧 map renderer 逐字保留。独立离线用量补充确认第四轮 62 条既有记录，另补一条 5,395 tokens；派生已知 487,696，原已知 482,301 和 interrupted/unknown 操作不变。补充报告不意味着操作成功或完整费用已知。全部派生证据在本次目录，历史根目录未改。

本轮未启动第五轮真实校准、66 例评测或新真实 provider 请求。下一步应先独立检查本次实施证据，再决定是否另冻少量开发校准；其目的应验证模型是否实际更新计划、读取证据并如实完成／更正回应，不能以宿主可提交代替研究可靠性。原每实例六小时 deadline、完整计量及无累计次数／费用上限继续保持。以下历史阶段的结果和当时边界原文保留。

## 历史接续：第四轮三例及独立评分完成

用户明确批准冻结后直接运行三例。核验上一阶段 6,582 项源码未变后，冻结 `feedback-development:1`、验收规则、`gpt-5.6-luna / low` 和两名独立评分者／一名裁决者；启动前和运行后 check 均通过。真实校准及评分详见[第四轮记录](pro-contract-researcher-s6c-calibration-v4.md)，证据根目录为 `/workspace/researcher-calibration-v4-20260921T001927Z-4lzxoaet`。runtime 仍为 `3ab6f4ecfe171af0d643d7c8af665f53554b277b2dea9830cadde4fe32ea93f2`。

三例均 ready，候选六项标准由两名评分者分别判正确；全部候选封存后才展示评审及回应轨迹，九项第二阶段分歧已由第三人裁决。P1 坏首评正确，worker 后续确实修复选参／评估分离并通过十项隔离检查，但回应时提前称 fixed，且计划未同步，完整处理仍 unresolved。P1 好首评误拒，worker 未有据反驳，最后删除可选诊断但未同步绑定计划；最终候选可正确，不能算实现修复或完整披露的删除补救。R3 自主读取全量证据、提交正确负结果；声称修复的导出原已存在，该 finding 的处理也 unresolved。

两个 P1 最终原始 accept 因将 hash 放进结构化引用 id 而真实记为 unavailable，均如实回应后提交；R3 最终为有效 accept。缺失机会保持 not_observed。没有自动认可、额外真实重跑或 66 例资格评测。两名评分者与裁决者是独立上下文、同一模型家族的 agent，材料访问为合作式限制，不冒充异构人类盲评。

63 次真实 wire 请求，原账本已知 482,301 tokens，完整传输合计 487,696。差额为一条 R3 interrupted／unknown 操作的 5,395 tokens，按原 operation/request 单列对账，不覆写账本；费用与独立评分 agent 用量未知。原六小时 deadline 和无累计次数／费用上限不变。评分后完整性检查通过：367 个内容寻址对象、事件链及前三轮冻结镜像／对象零错误，原评分和封存未变，进程已退出。

下一步先处理引用选择器混淆、回应／计划／动作不一致和中断用量对账，回归并独立审查后再决定后续开发运行；66 例继续暂缓。三例正确不证明研究整体可靠；新策略、延续任务和诊断接口均与旧场景不同，不能归因于模型提升。本轮未改实现源码，收尾只更新本文、中英文总设计并新增第四轮记录；保全入口为证据目录中的 `final-summary.json`、`final-integrity.json` 和 `final-identity.json`。以下内容保留各历史阶段当时的范围与未完成事项。

## 历史接续：v2 development 运行器

用户批准先补运行器、明确第四轮场景测量范围、确定性联调及独立审查，继续暂缓真实第四轮和 66 例评测。已保存新基线 `/workspace/researcher-runner-baselines/20260920T214200Z`，完成[设计](pro-contract-researcher-runner-v2.md)、[独立设计审查](pro-contract-researcher-runner-v2-design-review.md)、[实施及验证](pro-contract-researcher-runner-v2-implementation.md)和[独立代码审查](pro-contract-researcher-runner-v2-code-review.md)。D1–D2、W1–W4、S1–S7 均已关闭。

新配置必须显式选择 `evaluation:"feedback-v2"`；旧配置省略时保持 v1。P1 新 followup 只脚本提交一次计划，其后由上游 worker 实际回应、修复、实验及提交；旧探针保持原义。新公开执行证据接口使场景与前三轮不再逐字节相同，另冻版本为 `feedback-development:1`。首评、逐项处理和最终质量独立记录；原误拒不会因最后成功而消失。无最终候选也能评价已发生的首评和反馈。

最终 v2 实例／单测 18/18、评测回归 39/39、legacy 完整实例 8/8、冻结／启动 5/5，以及两包 `bun typecheck` 均通过。真实 unavailable 和候选正确性分开；虚假 fixed 即使 ready 仍被评错，单项修复也不因无关的最终错误而被抹去。上述结果来自确定性 fixture，只验证机制，不能当作真实 Researcher 能力。

验证、差异清单和完整源码保全位于 `/workspace/researcher-runner-validation`，最终 runtime 为 `3ab6f4ecfe171af0d643d7c8af665f53554b277b2dea9830cadde4fe32ea93f2`。本轮只改 research-eval 的 18 个源码／测试文件及七份当前／新增文档；基线原文件无缺失，前三轮冻结源码与对象核验零错误，失败日志和现场保留。最终完整归档身份见该目录 `final-identity.json`。

本轮没有冻结真实模型第四轮配置、启动真实校准或 66 例资格评测。后续应先冻结模型／运行器／场景／验收标准和独立评分安排，再运行真实三例开发校准；该真实运行不在本轮已执行范围。既有 v1 “批准后才能实验／交付”保证仅适用于历史任务和明确 required 阶段。六小时原 deadline、无累计次数／费用上限、隔离和计量要求保留。

## 历史接续：反馈策略实施

用户确认 reviewer 默认提供独立意见、Researcher 负责回应、运行宿主按明确策略准入。本轮在保存完整工作树基线后，完成[专项设计](pro-contract-researcher-feedback.md)及[独立设计审查](pro-contract-researcher-feedback-design-review.md)，实施 v2 不可变策略、handoff 前反馈／修复循环、独立准入 receipt、真实 unavailable outcome、job 绑定的结构化证据引用和完整交付反馈记录。具体测试、失败修复、源码身份与结论见[实施记录](pro-contract-researcher-feedback-implementation.md)及[独立代码审查](pro-contract-researcher-feedback-code-review.md)。中英文总设计新增当前策略章节；旧普遍批准保证仅适用于 legacy 和明确 required 阶段。

本轮设计、实现和独立代码审查已完成，C1–C7 全部关闭。最终 SDK 46/46、评测回归 15/15、新版生产流程 14/14 及两包类型检查通过；旧流程的恢复时序失败修正后定向复验通过，首次失败均保留。实际证据 I/O 跨 deadline 的回应、实验和交付三处边界均有生产回归。

新任务默认 advisory；历史缺省策略任务与显式 v1 保持原义。原权限、deadline、受保护输入、候选身份、正式实验、核心证据和 exact recognition 继续严格。P1 严重性本身不自动暂停工作；P1 语义回归检验真实选参与评估关系，不改旧真值。

本轮没有启动第四轮真实校准、66 例资格评测或真实研究试点。S6c runner 仍明确使用 legacy v1；新增三维评分与无 bundle 反馈归档不能冒充完整 v2 cohort 启动验证。未来运行需单独冻结并核验 v2 的 controller/probe/评分入口，保留原六小时每实例墙钟、原 deadline、完整计量，无累计次数／实验／费用上限。

基线在 `/workspace/researcher-baselines/20260920T173028Z`，本轮验证日志在 `/workspace/researcher-feedback-validation`。既有未提交成果、前三轮原始 hash 错误与误拒、冻结配置／源码和所有历史结果均保留。以下为本轮开始前的交接状态，仅作历史依据。

## 历史接续：第三轮读取与提交接口已走通，尚未完成最终验收

已修正实验前后提示、新增 worker 有界只读 `read_experiment`，并将公开报告引用与 oracle 统一为结构化对象；候选改变后重验及严格 hash 校验保持有效。11 个实现／测试增量通过单测 10/10、生产读取流程 3/3、Responses R3 1/1、P1／F2／R3 回归 5/5、两包 typecheck 和独立实现审查。新批次 `/tmp/opencode-s6c-luna-v3-hgkys5l_` 使用与前两轮逐字节相同的 Luna / low setup，runtime 为 `dee0c6cdc81062bcc2c9ec2e4187061b5d39a4f35212bcddabe22b1ebaf22997`。

三例全部实际运行：P1 坏计划因 test 选参泄漏被阻断；R3 计划获准、一次实验通过，自行完整读取归档后请求提交，同一候选提交验证通过并进入最终 review，但 reviewer 三处将同一个 64 位证据 hash 写成 63 位，宿主严格拒绝为 `unavailable`；P1 好计划被 reviewer 以“独立诊断”的措辞阻断。独立候选审查确认 R3 负结果正确、P1 好计划遵循 validation 选参与 held-out test 分离，现有拒绝理由缺少污染事实。没有宿主 `ready` 或 exact 认可。

第二名外部评分者再次工具流断开，未返回 annotation；保留失败，没有伪造双人盲评。三个分母及待评分材料完整保留。共 19 次真实 wire 请求、117,819 已知 tokens；两条无 wire 的 probe worker 操作 token 仍 unknown，费用为 `null`。全部原六小时 deadline 不变，进程已清理，冻结核验及历史保全通过。

下一步处理 reviewer 结构化证据引用并复核 P1 误拒语义，先设计、回归和独立审查，再另冻开发批次；不修补本轮 raw hash，不重标好计划，不启动 66 例资格评测。详见[第三轮记录](pro-contract-researcher-s6c-calibration-v3.md)。本轮未启动第四轮；已有未提交改动、英文方案和历史批次保留。

## 历史接续：第二轮已进入正式实验，仍未完成交付

已按独立建议修正计划阶段提示、公开观测映射、P1 好坏配对及对应 oracle／rubric；保持严格 hash 校验和 `gpt-5.6-luna/low`。回归、两包 typecheck 和独立实现审查通过后，新冻结三例开发批次 `/tmp/opencode-s6c-luna-v2-heu41unf`，runtime hash 为 `41a03d93bed9fff6ff6782b7bd1ec634ba54e886c63e3aff398e7ca244f6f561`。

冻结顺序为 R3、P1 坏、P1 好。R3 第一版计划获准，26 次正式实验均通过且候选与结果完全相同，但模型未调用 ready，反复读取工作区中不存在的归档工件并重新实验。已显式停止诊断：R3 `cancelled`、两个 P1 `not_started`，三个分母及原 deadline 保留，无超时或最终评审。独立复核确认四对原始数据的效应为 1、未达两单位阈值；这只能证明数值负结果，不能认作完整交付。

下一步先分开实验前／后的提示、提供按当前实验允许清单且有界的只读工件访问，并统一公开引用格式与 oracle：本次报告使用“文件名＋括注”，公开 schema 允许，但既有 oracle 暗含裸文件名要求。补回归及独立复核后再新冻三例；继续保留旧批次，不启动 66 例资格评测。详见 [第二轮记录及后续边界](pro-contract-researcher-s6c-calibration-v2.md)。本轮未做正式双人盲评或 exact 认可，现有未提交改动及英文方案保留。

## 历史接续：首轮真实开发校准发现前置问题

用户随后允许复用本机 Codex 服务、采用更快更便宜模型并进入实测。已完成本机免密 Responses 接线、回归及独立审查，并用 `gpt-5.6-luna/low` 运行三例开发批次。P1 坏计划发现目标泄漏，但附加了不适用的最终交付要求；R3 在计划阶段循环后因证据 hash 格式错误进入 `unavailable`；最后的 P1 好计划对照已启动并被显式取消。全部三分母、失败和部分响应保留，控制器及宿主已清理。

独立诊断确认计划提示混入最终交付要求，以及公开 split 缺少观测 ID 对应这两项前置问题。下一步须在新版本澄清阶段提示和语料，再回归、独立复核及重冻三例开发校准；暂不启动 66 例资格批次。详见 [本机接线与首轮实测记录](pro-contract-researcher-s6c-local-calibration.md)，证据在 `/tmp/opencode-s6c-luna-development-iwehh2n1`。未做正式双人盲评或模型资格认可。

以下正文保留离线接线收尾时的交接状态，其中“真实请求为 0”“仅支持 HTTPS Chat Completions”和模型／凭据待指定等描述属于先前阶段；当前状态以上述接续记录为准。历史设计、签字及运行配置未改写。

## 当前状态与用户授权

S1–S5 已实施并有独立审查和测试记录。S6a 设计已通过独立审查；本轮按用户已同意的顺序完成 S6b 实施、确定性生产自检、独立 agent 审查、修复及复核。没有启动 S6c 真实模型资格评测、付费运行或真实研究试点。

已执行的顺序为：

1. 实现独立评分、实例账本和失败分类。
2. 用一组好坏计划、一组好坏交付物及一个完整任务贯通生产 research 路径。
3. 补齐全部任务语料、隔离和故障观测，用确定性 HTTP 响应验证评测工具。
4. 进行独立实现与语料审查，保留反例，修复并复核 F1–F8。

最终 48 个探针与 18 个完整任务的确定性自检全部通过。工具通过不等于模型质量通过，报告保持 `qualification: not_run`。用户随后批准推进下一步，已完成 [S6c 初轮准备](pro-contract-researcher-s6c.md)及[离线运行接线](pro-contract-researcher-s6c-wiring.md)：真实宿主／代理入口、冻结核验、恢复、盲评、exact 认可与派生报告已实现并用本地 fixture 验证，独立复核见[接线审查](pro-contract-researcher-s6c-wiring-review.md)。确切 worker／reviewer 模型、受信部署、凭据引用及评分者仍待指定；真实模型请求、真实开发校准和资格发行实例均为 0，实际资格配置尚未冻结。

## 必读依据

- [总方案](pro-contract-researcher.md)：架构、切片和 Principal／Researcher 边界，当前进度见第 9.11–9.13 节。
- [S6 评测设计](pro-contract-researcher-s6.md)：冻结矩阵、评分优先级、分母、门槛与预算。SHA-256：`737da740b22843d4259dbf6570177067ed2d5259b57834570cc6bb3c128700e3`。
- [S6 独立设计审查](pro-contract-researcher-s6-review.md)：保留两项设计反例和关闭依据。SHA-256：`afe66d2b7eda522fdb7a97ed4e473d61f544efb20ba1ba32f116a265c635684d`。
- [S6b 实施记录](pro-contract-researcher-s6b-implementation.md)：实现范围、测试命令、完整批次、源码 hash、历史失败和适用限制。
- [S6b 独立代码审查](pro-contract-researcher-s6b-code-review.md)：F1–F8 原始发现、修复和最终独立结论。
- [S6c 准备](pro-contract-researcher-s6c.md)及[机器可读清单](pro-contract-researcher-s6c-preparation.json)：当前输入缺口、三例开发校准安排、66 实例顺序和真实接线要求；`launchable: false`，不能当作已冻结运行配置。
- [S6c 接线实施](pro-contract-researcher-s6c-wiring.md)及[独立接线审查](pro-contract-researcher-s6c-wiring-review.md)：新增 CLI、配置与双阶段评分、反例修复、最终代码身份和本地验证记录。
- [S5 实施记录](pro-contract-researcher-s5-implementation.md)及[独立代码审查](pro-contract-researcher-s5-code-review.md)：生产能力与前置边界。

S6a 两份历史文件未改。任何后续修改都须核对差异和新的审查依据，不能把旧签字套用于变化后的版本。

## 当前实现与必须保留的边界

评测工具在 `packages/opencode/script/research-eval/`，自检入口是 `packages/opencode/test/server/pro-contract-eval-process.test.ts`。复用 `sdk-next` research 宿主、Core job 和既有 Session loop，经 canonical 工具、真实 Node TAP、独立 reviewer Session 和 exact attestation／challenge 运行；没有直接写审批状态。

Principal 提供目标、范围、固定方法／数据、验收、权限与原 deadline；Researcher 只在约定内维护执行计划。评测宿主、内部 reviewer 和 oracle 均无权扩权或改约定，不实现 Principal 选题、分配或决策策略。

当前 `research:1` 使用 `research.issue({ planning: true, ... })`；省略 `planning` 是 S4 `research-final:1`。正式实验只支持固定 Node TAP，生产 research 隔离仍为合作式。S6b 另在 Linux x64 评测部署建立 Landlock／seccomp broker／固定 HTTP gateway 的 oracle 隔离，不能外推为通用生产沙箱或任意 provider 网络部署。

raw verdict、scope、findings、结构／证据、actual gate 和评分分别记录。宿主挡住错误 accept 不能抵销错误同意。评分进程不直接加载候选代码；文本质量仍需完整盲评和争议裁决。未触达、超时、unavailable、基础设施失败及所有错误 ready 均保留分母。

R5/R6 只有真实 provider 在途或实际测试子进程存活的注入窗口才获得覆盖。新旧 job、PID/start/boot、unknown operations、恢复分支和原 deadline 可追溯；错过窗口不得重复注入直到成功。首次 ready、评分完成和认可完成分别计时，外部等待不是 worker 研究时间。

每实例只设六小时累计墙钟预算，无累计 turns/actions/requests/费用/attempts 上限，不用大整数模拟无限。`Resolution.maxAttempts` 现可省略，显式有限历史值保持原语义；公共 Client 和旧 SDK 已重新生成。保留单次操作超时、显式取消、候选执行进程树清理和完整计量。恢复与换 Session 不重置 deadline。历史／运行中 cohort 不变。见 [deadline-only 说明](programbench-deadline-only.md)。

## 验证、源码与保全

最终批次 `/tmp/opencode-s6b-matrix-20260919-final-v2` 包含预登记账本、全部对象和完整源码镜像。矩阵 66/66，771 assertions，821.35 秒；单测 19/19；Core／driver 74/74；Schema 2/2；S5 全流程与 S4 exact 认可／challenge 回归 14/14。七包类型检查通过。详细日志与实际范围以实施记录为准，不把历史验证当作后续 session 已重跑。

最终 31 个源码／测试／生成文件的增量清单 `/tmp/s6b-source-v2-final.json` SHA-256 为 `18bc7bc25d6ea317b02c97d61749407cdd808722ef1f799488fb92d9c07e8995`。批次完整源码镜像 6,533 文件，manifest SHA-256 为 `403e439d9815bf2930edcd45462338d4235a66aff51b91dbbfbca15135a80acd`；当前收尾文档更新发生在该批次之后。临时目录可能被清理，仓库实施／审查文档是查找证据的入口，清单不能替代完整镜像。

S6b 编辑前基线 `/tmp/opencode-s6b-baseline-20260919T072714Z/` 含 6,509 文件，manifest SHA-256 为 `e2b8da36b4f3938053cc7502f4152f8fa6bff11e79410c3191442f9c6ce79441`。已有 S1–S5 未提交改动和未跟踪文件全部保留；没有提交、合并、发布、回退或清理。后续仍须读取 `git status`，不得将 HEAD 当作这些成果的完整快照。

旧的 51/66 未冻结完整确定性自检批次、65/66 冻结失败批次及主动失败自检均保留。F7 的历史校正另写 `/tmp/opencode-s6b-matrix-report-v2`，未覆写旧账本／报告；它仍保留旧失败。旧 R6 现场曾因 SQLite 只读打开而改变一个 `.db-shm` read-mark 文件，DB/WAL 未变，事件已记录；以后数据库取证必须先复制 DB/WAL，只查副本。详见实施及独立审查记录。

环境使用 `/tmp/opencode-research-toolchain/bun-linux-x64/bun` 1.3.14、Node v24.21.0。测试和 `bun typecheck` 从包目录运行；格式用 `bun x prettier`，不直接调用 `tsc`。重型进程套件继续串行。配置变化后另建批次、重新冻结，不能改写已运行或正在运行的版本。

## S6c 当前接续工作

运行接线及独立审查已完成，W1–W9 全部关闭，无遗留 P1／P2。入口是 `script/research-eval/launch.ts` 和 `rating.ts`（从 `packages/opencode` 执行）；`S6B_MATRIX=1` 仍仅为历史确定性测试入口。真实部署当前仅支持固定 HTTPS Chat Completions 路径，尚未验证外部账户／模型可用性。缺失模型或凭据时拒绝创建 cohort；不猜模型，不借用其他登录凭据。

下一运行阶段需补齐确切 worker／reviewer、受信部署与凭据引用，并安排两位独立评分者及争议裁决者；随后先做开发集 P1 好／坏计划和 R3 完整任务，再冻结 66 实例资格配置。真实运行仍未启动。每次变更配置另建快照／批次，不能改运行中版本或替换旧失败。

2026-09-19 初轮准备的 19 项工具、2 项 Core 预算、2 项 Schema 检查及 `/tmp/opencode-s6c-preparation-20260919T190440559Z` 保留为历史记录。新增接线的完整工具测试为 38/38；认可收尾修订另做 R3 端到端回归，S6b 默认生产校准 5/5、当前包类型检查通过。独立实际实例及认可清理失败反例也已验证，详细范围见实施／审查文档。新证据目录 `/tmp/opencode-s6c-wiring-final-fscayis2` 保存代码清单、日志、完整源码快照和保全核验；它不是实际模型 cohort。已有未提交改动、英文方案和历史设计／审查／批次均保留。
