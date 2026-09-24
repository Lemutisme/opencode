# Advisory v3 批次接线：限定设计与验收

2026-09-21。接续默认流程实施，不改变研究宿主协议或 Constitution。本轮只实现并通过实际入口做无真实模型联调；不启动第八轮、66 例或历史重评分。

## 1. 版本与场景

新增专用 `advisory-launch.ts` 入口，显式 `advisory-batch:1`、`advisory-v3`、`advisory-development:1`、`advisory-measurement:1`、`instance-isolated:1`。旧 launch、评分和冻结配置继续原义。复用现有隔离 host、provider、runInstance、CAS 导出及 InstanceScoring。

新三例保留 P1 好／坏与 R3 数据、科学真值及诊断证据要求，去掉旧“每条 finding 必须回应”要求和 lifecycle 强制措辞。原 P1 建议计划作为公开输入；由 Researcher 自行制定／提交实际计划，不由脚本发行计划或代写回应。故 reviewer 看到的第一版计划可能已经改变；原固定计划探针成绩只能另列，不能直接同比。意见未采纳、零回应、没有 completion 本身不判研究失败。

## 2. 冻结与执行

配置严格解码，固定完整脏树源码副本、runtime hash、三个公开场景及 oracle、rubric、worker／reviewer 和评分 A/B／独立裁决的完整模型路由与参数、启动／操作／清理期限、CAS 日志。运行模式显式为 model 或 local-fixture；后者只能 loopback 无认证。冻结核验和同一批次入口用于两种模式。冻结目录和批次目录不得复用。

每例实际开始时写唯一 attempt 与原六小时 deadline，评分绑定从实际 agreement 获得；此前已冻结全部场景、文件 allowlist、评分角色和 rubric，不依据结果选评分者。上下文绑定在授予任何材料前封存。每例只有原定一次机会，无累计请求／实验／费用上限；正常提前完成可停止。显式取消和共享安全不确定停止后续执行，所有未开始实例保留分母。

实际 host 停止并完成可信清理后，归档候选或终态。客户端超时不能证明停止。失败只有在停止、清理、实例隔离和 runtime 完整性均有证据时才局部继续；未知／共享故障停止后续研究，但仍允许对已封存完整实例独立评分。没有完整候选归档时记 unknown；只有停止后的穷尽数据库观察证明没有候选时记 absent。失败、残留操作账本、传输和清理证据保留，不把用量未知推成零。

## 3. 独立评分适配器

每例预登记候选 A/B/裁决、反馈 A/B/裁决共六个唯一执行上下文；明确采用 `stateless-request:1`，每个上下文是新建的单次无工具模型请求，并非仅标记一个可复用的 Session 名称。请求只含固定评分指令、该 grant 的材料和 rubric；没有共享会话、previous response、文件／网络工具或其他实例材料。两位评分者可使用同一模型，但分别请求且不能看到彼此判断；仅裁决者在两份判断封存后看到同阶段判断。传输层据预登记执行身份绑定 context、rater、materialHash、rubricHash，模型只输出 items。

先完成本例候选双评及必要裁决／seal，才向全新反馈上下文发送 reviewer 与轨迹。其他实例是否失败或封存缺失不影响本例。无候选使用可信 terminal seal，不给不存在候选造质量分。缺评分者、格式错误或争议未裁决如实 not_scored，不重试到满意、不用单人代替双评。各次完整请求、响应、usage 或未知原因以 CAS 封存，追加每次开始／结束记录；无状态请求本身是评分上下文，不建立可泄漏前序材料的 provider conversation。

四轴 rubric 区分正确候选、reviewer 判断和 Researcher 真实处理、审计完整性、基础设施。实际修复／删除／有据反驳、无依据声明分别记录；未发生机会记 not_observed，不适用与缺证分别记录。审计缺失不推导研究错误，声明不证明实际修复。Principal 最终认可不由评分适配器执行。

## 4. 工程验收

- B1：同一 freeze/check/run 入口使用 loopback fixture，完成真实隔离发行、计划检查点、实验、候选提交／CAS 恢复、双评、必要裁决和本例反馈揭盲。
- B2：P1/P1/R3 新场景与 v3 精确绑定；无脚本修复／回应；legacy 配置仍拒绝混用新协议。
- B3：changes_requested/P1 或 malformed unavailable，零回应仍能执行和提交，原始意见及未回应项进入反馈材料。
- B4：一例发行／执行失败或候选封存损坏不阻止其他完整实例双评和反馈；终态必须有停止和清理证据，unknown 不冒充 absent。
- B5：评分 A/B 独立请求，候选材料不含 reviewer／轨迹；反馈只在本例 seal 后开放；交叉身份、单人、评分者不可用和分歧没有裁决都不得假封存。
- B6：显式取消能停止 host/provider、确认清理并保留后续未开始行；共享清理未知不继续启动；保持原 deadline。
- B7：配置／runtime／源码／材料漂移拒绝；完整评分传输与用量可恢复；原账本、补记、未知分列。
- B8：针对性测试、opencode typecheck 和独立增量审查通过；真实模型能力没有被确定性脚本代证。

长历史分页、实时计量竞态和历史发行卡点未因接线消除。失败 fixture 用于机制验证，不在真实批次人为制造反馈或追加尝试。独立审查如发现阻断，修复后再核验，不临时扩展协议。

## 5. 独立审查后的接线约束

实际评分采用新建无状态传输上下文，并不创建 SDK Session；没有 provider conversation、previous response 或工具。角色模型、参数及不可用方案先冻结，实际 context/execution 在整批开始前登记；每例 agreement／deadline 只从本例实际 attempt 和 admission 绑定。未开始行没有虚构的发行身份。

终态使用前重建冻结的公开任务，核对 attempt、admission、result/failure、audit 的身份、配置与原 deadline，并校验 audit 引用的日志／清理／数据库 blobs。`stable_copy` 还必须有 runs/history/operations/preparation/contracts 的完整观察，才允许 absent；用量未知不代表清理后仍有进程运行。admission 记录之前的启动失败本片仍保守 shared/unknown；实际发行失败 fixture 位于 admission 写入后、research-issue 前。

runtime 漂移或读取失败停止后续研究／新评分请求，同时保留已有封存、事件和所有未开始行。评分传输原 usage 独立索引；null、畸形或不一致 usage 记 unknown。所有 worker、reviewer 和评分者凭据来源在消耗实例机会前检查。旧评分 API 明确拒绝 v3；不能把新结果塞进旧 v2 scoring/reveal。

本片候选盲评读取精确归档文件、计划和正式验证，不另运行旧 diagnostic interventions。因此保留科学真值不等于继承旧动态评分的检测能力；这也是新旧比较限制。单次评分请求／响应各限 16 MiB，超界不截断成完整评分材料，而是保留 unavailable／部分传输与原材料；没有累计请求或费用上限。长轨迹仍可能超出此适配器或模型上下文，未宣称解决分页。
