# Researcher 定向改进：修复记录、引用选择器与用量补充

2026-09-21。依据第四轮真实校准及用户最新建议，仅开展本设计、确定性回归、实现和独立审查。不启动第五轮、66 例或新的真实模型调用。原六小时 deadline、无累计次数／费用上限、既有源代码成果和全部历史材料保留。修改前完整工作树保存在 `/workspace/researcher-followup-20260921T005437Z/baseline/`，6,583 项，manifest SHA-256 为 `1ff371074290c0d18e34799c42ef36567fd1d740d128345292d4b6cc1b561cb6`，与第四轮收尾源码一致；不能以 HEAD 代替未提交基线。

## 事实与范围

第四轮 P1 坏真实修复了算法，但只读反馈阶段先报 fixed，绑定计划仍为旧方法；P1 好移除了诊断，但绑定计划仍承诺保留。当前 response 只有 fixed/rebutted/unresolved。新接口需要表达将要修复，并在已有正式验证之后追加事实记录。宿主检查来源、时序、版本和证据身份，不判断算法修复是否在研究意义上成立；未决项不恢复为普遍 veto。

计划和最终评审提示均列出 Allowed evidence 的完整 hash，随后要求结构化选择器。v2 统一只列可直接拷贝的 {jobID,id} 对象；完整映射仍不可变归档，材料中的 hash 仍可作为身份数据，但不再作为模型输出的另一种引用语法。旧 v1 hash 协议保留。

R3 plan 控制调用关闭 admission、触发原 provider turn 中断。网关独立归档了后续 response.completed 的 5,395 tokens，Core runner 未消费尾部 usage 事件，因此 interrupted 操作 usageEvents 为空。状态中断与已产生用量可以并存。只在 research-eval 添加有来源的补充记录与派生报告，不伪造 Core finish、修改操作状态或重复追加 legacy usage 事件。

## A. 版本与反馈生命周期

在不可变 manifest 增加独立 `feedbackProtocol`，值为 `response:1` 或 `repair-lifecycle:1`，与 advisory/required 策略正交。旧已发行任务省略字段按 response:1 解释，精确发行重试采用原字段；新 v2 发行默认 repair-lifecycle:1，调用方可显式选 response:1。v1 不启用新协议。已有 feedback-development:1 运行器显式继续 response:1；本轮不改变该场景或评分真值，不将新机制测试冒充第五轮。

保留原 Response schema／语义。新协议的初始 `review_response` 有显式版本，逐 finding 使用 `repair_planned`、`rebutted` 或 `unresolved`；不在这一步使用 fixed。要求 `planChange:retain|revise`，以及原 summary/action。repair_planned 是意图，不保证完成；rebutted 是待独立判断的主张，不自动批准。

| 原阶段／声明 | 请求 | 后继与准入 |
| --- | --- | --- |
| plan feedback，retain | continue | 按原 required/advisory 策略准入 execution；可开始计划内实现 |
| plan feedback，revise | repair | exploration，必须提交下一版计划；旧准入和实验失效 |
| delivery feedback，retain | repair | execution，在原方法内修复；旧候选验证和实验失效 |
| delivery feedback，revise | repair | exploration，修订计划后重新准入、实施、实验与验证 |
| delivery feedback，retain | submit | 原身份和证据检查后提交；未决／未完成意图如实披露，不自动阻断 |

revise 不能配 continue/submit；final-only 没有可用的计划阶段，明确拒绝 revise。计划阶段没有写权限，不能通过完成措辞跳过修订。方法、数据使用或诊断保留／删除变化必须由 Researcher 选择 revise 或在 execution 提交下一版计划。宿主能约束显式声明与版本，不从自然语言或代码猜测所有方法改变；遗漏声明仍交独立判断，不能宣称机械系统证明语义一致。

## A.1 追加完成记录

新增 `contract_request(kind:'review_completion')`，仅用于 repair-lifecycle:1 的 delivery feedback，发生在本轮候选已经冻结、正式验证和独立评审之后、提交回应之前。此阶段只有 read/control 权限，便于把记录明确绑定已验证快照；它不启用写权限，也不自己提交候选。planned research 还须有匹配当前计划／候选的成功正式实验；final-only 使用已完成的提交验证。

请求引用既有 responseHash、findingID、当前 planHash（如有）、subjectHash、verificationHash、前一 completion hash（同一 response/finding 的追加链）、处理 fixed/removed/rebutted/unresolved、依据和非空证据 hash 列表。宿主从 run 和原 response/outcome 填入 contract、manifest、context、round、实验身份与时间，不接受模型替写这些字段。证据必须在当前验证／正式实验的明确允许集合内（计划 hash 只作身份字段，不能单独充当完成证据），且读回完整 blob 验证哈希；禁止任意存在的 blob 冒充完成证据。

宿主机械验证原回应确在当前 run 历史、finding 唯一、原意见／原回应完整、当前计划与实验／验证 job 的身份和实际结果一致，以及原 deadline／执行授权仍有效。声明 revise 的原回应只能由更新的计划版本关联完成。未知、跨任务／意见／候选／版本、过期、损坏引用和错误前驱拒绝。I/O 之后在同一 CAS/事务内重新检查原执行、run 版本和 deadline。原始 response 永不覆盖；同一当前 basis 下相同请求的精确重试幂等：在拒绝旧前驱前按 canonical 请求查已存记录，返回原 hash／宿主时间，不重复追加，且仍检查当前授权／deadline 与未改变的候选证据。冲突或其他陈旧前驱拒绝。

此边界不调用要求当前 submit 回应的整体发布验证。复用独立的机械验证函数，并让计划 admission 只验证其实际选中的历史 plan outcome/response；最终发布仍要求完整 responses。完成记录另绑定宿主生成的 basisVersion、basisHash，归档追加前的 durable run；历史重放必须与 ResearchStore 的该版本事件相同，再用当时的计划、round、context 和 job 验证。不得用后来候选重解释旧记录。

记录只证明这些材料与该声明绑定，不能证明 finding 被实际解决。fixed 和 removed 必须分别表示实现修复与删除；独立评分仍可认为声明无据。补充记录可以把之前声明更正为 unresolved，全部旧版本保留。对同一修复再次编辑或换计划时，旧记录保留其旧身份，不可冒充新候选的完成；最终包标出是否匹配当前候选。

反馈 prompt 提供尚未追加完成的 repair_planned 目标、合法当前证据及调用示例。新增同阶段只读 `read_review_evidence`，参数为 source=verification|experiment、允许清单内的 path、offset、length（最多 16,384 字节）；返回来源验证／候选／计划身份、完整文件 hash、大小、实际字节和 eof。final-only 可以读取 verification。使用完整 blob 校验及 I/O 前后授权／deadline 核验，不通过任意路径或 hash 读取宿主文件。Researcher 应先读取证据再记录实际处理。未完成意图、反驳与未决风险都进入交付，不设“所有 finding 必须 fixed”门槛。required 阶段仍必须 available accept；Principal 的任务授权和最终 exact 认可不变。

completion hash 链写入 Research run 的追加历史。交付包、精确认可验证和评测归档都保留原 outcome、response、完成记录和被引用证据。当前最终 reviewer 只评已冻结的候选和证据，其材料可包含更早的完成记录；当前评审之后追加的记录是 Researcher 的声明，在交付及外部评估中可见，不能宣称已经被该 reviewer 审过。这样不产生材料引用环或为审这条声明自动再审一次。历史 bundle 无新字段仍按旧协议读取。最终用同 plan/candidate/verification/round 标出记录是否仍适用，与语义成功分开。

## B. 单一引用规则

新 v2 plan/delivery prompt 移除 hash 形式的 Allowed evidence 列表。由不可变 map 渲染具名条目与完整合法对象，例如 `plan: {jobID:exact,id:plan}`；JSON 输出样例直接使用本 job 的合法对象，不再用省略号鼓励重构。map 的 hash 仍作为归档和宿主解析证据，原 raw／map／resolution 均保留。解析规则不放松：未知、歧义、跨 job、版本或候选拒绝。历史错误 hash 不猜补。

必须保留旧 v2 renderer 的逐字结果：当前 capture/validate 会检查原 job prompt 是否包含 map 对应的 renderer 文本。新 map 带不可变 `promptVersion:2`，旧 map 省略字段仍使用原 renderer；归档 map 身份的重建也按该字段分派，不给旧 map 自动补新版本。不能只修改公共 prompt 函数而使所有历史 v2 evidence 重放失败。

## C. 状态独立的用量补充

新增单独版本的 research-eval 只读对账入口，向一个新目录写 sidecar 和派生报告；不覆写冻结结果、事件链、评分、Core 操作或原账本，也不更改现有 legacy accounting.correct。来源绑定原 resultHash、transportHash、归档操作对象及完整 HTTP/stream 捕获，精确匹配 contract/session/operation/job/execution/request 等已有身份。

只支持已有 OpenAI-compatible Chat/Responses SSE 归档，只对可解析、完整、未截断、身份唯一、成功传输的 terminal provider usage 建立 supplemental fact；Responses 必须有 response.completed，不能用 HTTP EOF 代替协议完成。每操作必须恰有一个可唯一匹配的真实 provider wire/request；验证 cohort→结果 wrapper→原对象→操作及传输来源的绑定。传输没有独立 execution 身份时，只从唯一匹配的原操作 source 继承，不凭空生成；成功／失败快照冲突拒绝。

事实 ID 由原对象 hash、request、operation 等不可变来源生成，排除输出路径和本次时间。原 Core 已知用量与传输一致时仅确认、不叠加；比较 input/output/total 及双方已知的分项，reasoning/cache 是其子集，不再次加和。原用量 unknown 且唯一完整来源可解释时提供已知补充。冲突用量、不同请求身份、截断／缺失尾部或多请求归属不清保持 unresolved 并保留原已知账本值，但不把有争议值宣称为已对账有效用量；不能用猜测或零填补。费用保持 null。

派生报告分别列原账本、补充事实、有效已知用量、仍未知项和执行状态。重复运行到新目录产生相同事实身份，不双计；补充不增加 wire/turn/action 次数，不恢复 admission，不把 interrupted 改成 completed，不影响评分。覆盖正常与保留失败实例。独立入口记录原冻结代码身份和本次对账代码 hash，不要求两者相等；输出必须在输入树之外的新目录。第四轮如生成只读派生说明，也写入本次证据目录而不改历史根目录。

## 验证与独立审查

先独立设计审查、关闭阻断，再实施三个工作包。主要变动限 sdk-next research 和 opencode research-eval；Core/公共 Protocol/Server 不增加研究决策语义。

至少回归：意图→修订计划→执行／实验→追加证据完成→提交；同计划修复；删除与修复分开；回应仍只读；原声明与修订链保留；未决及未完成意图可披露提交；required 和旧缺省协议不降级；完成记录精确重试、跨意见／job／候选／计划、错误前驱、损坏证据、I/O 跨 deadline／失权被拒；修改候选后旧完成记录不充当新完成。采用真实宿主和固定 HTTP fixture，不使用真实 provider。

引用回归检查实际生成的两种 v2 prompt 和合法选择器解析，保留旧 hash 协议与拒绝反例。计量回归覆盖 interrupted + complete usage、已知一致不重复、重复捕获、身份冲突、用量冲突、partial、缺失、多请求歧义，以及正常／失败报告；可用第四轮归档作只读取证，不重跑模型。

从包目录运行适当测试及 bun typecheck；保留失败日志。独立代码审查关闭阻断后更新中英文总设计、交接、实施及审查记录，并核验此前四轮材料和当前已有改动完整保留。语义评分仍须独立判断，绝不修改旧真值来掩盖失败。

## 实施审查补充（保留前次设计签字身份）

初次设计关闭版本及 hash 见独立设计审查。实现审查进一步明确：当前 delivery outcome、原 response 所引 blob 和 completion basis 的下一条 durable append 事件都须核验；追加与读取均采用最多 30 秒、且不超过剩余 deadline 的单次超时。完成记录重放不能仅验证一份孤立 basis blob。

新选择器渲染把每项材料名称／路径与可拷贝的 selector 对象并列，map 冻结可选 label；旧无 promptVersion 的 renderer 文本不变。后续 reviewer 材料同时保留先前完成声明及其原意见、原回应与原文，复制相应归档对象和完成／回应所引证据，使其能判断声明针对什么问题。当前 reviewer 之后追加的声明仍未获该 reviewer 审查。

用量补充必须保留带有缺失／非字符串 requestID 的同操作 wire 作为歧义证据，不能先过滤掉它再声称请求唯一。失败实例的早期 partial 与较晚 retained operation 快照都纳入分母；新增／缺失／冲突项单列未决，不把没有被枚举当成没有发生。
