# 发行边界与无候选终态：独立审查记录

原始记录及逐文件快照均保存在 `/workspace/researcher-infra-20260921T035216Z/independent`。以下保留独立 agent 的设计与实施意见。最终源码审查关闭阻断；执行方随后完成的回归与证据核验以[实施记录](pro-contract-researcher-infrastructure-implementation.md)为准。

---

# 独立设计审查：发行边界与无候选终态封存

审查者：`/root/infra_review`。2026-09-21。只读核对专项设计、第五轮记录以及 `host.ts`、`host-process.ts`、`instance.ts`、`launch.ts`、`lifecycle-blind.ts`、`evaluate.ts`、`observe.ts`、`isolate.c` 和 Researcher 发行实现；没有调用真实模型、运行第五轮评分或修改源码。本次没有重跑测试。

结论：同意两项有限改造与显式新策略。设计有两处必须在实施前消歧的边界；修正文档后可关闭，无需扩大架构。第五轮根因仍不能确定，原校准状态不变。

## 阻断 D1：停止证明必须区别读取失败和原进程消失

专项设计第 15 行要求 supervisor 正常清理并核对原 host 不活跃，这是正确方向。但现有 `observe.ts` 的 `processIdentity` 将所有 `/proc` 读取失败合并为 `undefined`，`sameProcess` 再将其解释为不相同。若实现直接复用这一结果，权限/I/O 错误会被错误用作已停止证明；启动阶段还可能没有完整 host 身份。

必要修正：新清理证明使用明确的 `alive / gone / replaced / unknown` 观测；只有可核验的进程不存在或 boot/start 身份已替换，才能作为原 host 不活跃的证据，其他读取失败保持 unknown。保留 supervisor、host 身份及观测来源。只有受信 supervisor 完成树清理，且身份观测满足声明要求时才 confirmed；126、信号终止、清理等待到期、身份未取得或无法核验均不能凭客户端等待结束变为 confirmed。启动失败也必须保留这份报告，不能因 `start()` 抛错而失去 handle/log/清理证据。重复停止不能延长同一清理期限。

主执行方已表示采用明确四态观测；请将其写进设计及回归断言。

## 阻断 D2：终态封存必须精确定义证据截止、unknown 与已存在候选

第 25 行同时写“无法证明可评分材料缺失则拒绝”与“清理未确认时可封存本次归档没有可评候选”。前者若解释为证明运行中绝无候选，后者永远不可达；后者若只检查缺少 `scoring.json`，又会允许把仍在产生、已存在但评分准备失败的候选降级。需要明确该门认证的是哪一种事实。

必要修正：终态区分已证实未发行/未提交、已知候选不可用，以及无法确定候选是否产生；绑定固定证据截止、完整的已保全证据清单及原事件链。unknown cleanup 可封存的是截止时已获取材料和未知项，绝不能声明宿主已停或候选实际上不存在。任何已知实际候选、subject、提交记录或 `candidateAvailable=true` 均拒绝无候选分支；缺少评分文件或保全失败本身不是不存在的证明。若截止以后发现实际候选或原归档新增/变化，旧 terminal 不得继续授权展示；保留旧封存，并要求明确的新材料处理，不可静默覆盖或追认。门及 finalize 都要检查这些绑定。

原 deadline 的绑定不能以 Contract/run 成功创建为条件：`instance.ts` 在发行前写入 admission 坐标，run 创建前失败仍已有原 issuedAt/deadline，应原样保留。只有从未产生坐标的 not_started 条目才可标记未生成；丢失坐标须记 unknown，不能重置或省略成不存在。

主执行方已表示采用证据截止和 `candidate unavailable/unknown` 区分；请将具体语义写进设计及回归断言。

## 必须保持的实现与验证边界

- 发行观察器记录开始、成功、失败和中断；缺失 exit 只说明观测未闭合。IPC 超时后关闭新命令准入并进入停止流程，不再在同一可活动 host 上发只读命令来证明未发行。迟到 IPC 回复留存但不逆转超时结果。
- 失败保全覆盖整个尝试，包括目前 `try` 之前的 launcher、agreement/provider 准备，以及 host 启动失败；不能只覆盖 `research-issue` 之后的错误。完整树停止确认前不从活动 DB 推断终态，确认后在校验稳定性的副本上诊断。
- 新基础设施策略及新门必须显式冻结并跨 setup/deployment/config/result/failure/scoring 绑定；字段缺省继续使用旧门。不能给第五轮添加新 terminal 来解锁原反馈评分。
- 两个实际候选和一个无候选失败的确定性完整流程，须从生产候选准备、两名封存、terminal、reveal 到 finalize/report，不能只单测门返回。应故意保留一个候选评分分歧，验证未裁决先拒绝展示。
- 故障测试须观察等待到期后子进程仍能工作这一事实、迟到回应、取消、原 deadline、清理不确定及日志保全。测试不调用真实模型，不据此推断研究能力。
- runtime、策略、实例、event、证据截止或候选材料串用/变化均拒绝；正常 `not_submitted` 不制造空候选质量评分。失败行保留分母，`not_scored` 与 `not_observed` 分开。
- 不改变研究 advisory 语义，不把 unresolved 意图变成门槛，不修实时用量竞态，不断言第五轮无完成声明的原因。

关闭上述两处设计消歧后，本人支持进入有限实施和独立代码复核；本报告不是第六轮启动批准或已完成的代码审计。

---

# 独立设计复核：阻断关闭

审查者：`/root/infra_review`。2026-09-21。复核专项设计修订文本，SHA-256：`885563ce9dfb97fa2321bf5cd8db6a0ddaaaef690df2507ef341760264d1de91`。本次仍为只读设计复核，没有运行测试、调用真实模型或修改源码。

结论：D1、D2 已关闭，可按限定范围实施；没有剩余设计阻断。此结论不替代后续增量代码与确定性测试审查，也不授权启动第六轮。

D1：修订明确 `gone / replaced / alive / unknown` 四态，只有可核验 ENOENT 或 boot/start 身份替换证明原 host 不活跃；权限与 I/O 失败保持 unknown。confirmed 同时要求 supervisor 成功回收，且 startup 抛错仍持久保全启动、清理证据。实施须使用新的证明语义，不能沿用 `processIdentity(undefined)` 直接认定停止。

D2：修订明确终态认证证据截止和清单，分别保留 absence/unavailable/unknown；迟到候选或相关归档变化使原 terminal 失效。检查包含 cleanup-failure 内嵌 result，候选不能因评分或清理失败被降级。发行未返回成功也要保留已建立的 admission 坐标。正常 not_submitted 使用带 terminal 引用的 indeterminate phaseOne，禁止编造双评；run 创建前没有 review 的条目不伪造自身反馈评分。

旧门继续由缺省策略保留，新策略显式绑定；第五轮仍为未完成校准，原双评、未评分、故障和 deadline 不改变。`design-review-1.md` 的故障测试、全流程评分、跨身份拒绝和失败保全检查应作为代码审查依据保留。

---

# 独立增量代码审查：需修正

审查者：`/root/infra_review`。2026-09-21。对照修改前基线，只读审查初版基础设施增量；没有修改源码、调用真实模型、重跑重型宿主测试或更改第五轮。另运行一个仅构造归档对象的确定性最小复现，不启动研究宿主。复现时 runtime identity 为 `9c1512c8dd06a3ebd8a058dbd1a5f30868a6c679f473d25235214d09819febaf`。主执行方仍在联调测试，本报告不宣称测试完成。

结论：暂不通过。两项阻断须修正，其中 R1 直接违反候选不可降级边界。

## R1：归档里已存在候选，仍可封存 unknown terminal

位置：`terminal.ts` 初版 120–130、210–221；`instance.ts` 初版 374–399、463、469–535；相关 `controller.ts` 的每版本 `put(archive, run)`。

`material()` 只从 result/failure/audit/partial 的指定字段收集 run。虽然枚举整个 `archive/objects`，却仅验证各对象内容 hash，不检查已归档 run 或 collect 对象里的实际候选。正常执行中 monitor 在每次观测时已经归档 run，终态收集也归档完整历史；之后的 IPC、collect 或清理失败会跳到 catch。清理 unconfirmed 时无法读 DB，catch 没有保全已获得的 monitored，且 `completion.result` 直到 stop 成功后才赋值，因此指定字段可能全部无 run。终态封存会把真实已存在候选降为 `unknown / not_scored` 并允许全批次展示门继续。

无模型复现：`independent/terminal-existing-candidate-repro.ts` 创建合法三实例事件链，在第一例 archive 中放入相同 contract ID、ready、subjectHash/bundleHash 的 run 对象，再调用真实 `sealTerminal()`。它成功返回 unknown terminal，且 inventory 本身列出了已存在候选对象。输出完整保存在 `terminal-existing-candidate-repro.json`，临时证据根为 `/tmp/independent-terminal-candidate-3yDK1i`。

必要修正：保全并绑定每次可信 host 回应中观察到的候选身份，而非仅保全成功完成监控后的结果。terminal 要核对已经留存的 run/collection/monitor 索引，任何已知 subject、bundle、实际提交均拒绝无候选分支；collect 中途失败和正常候选之后 cleanup unconfirmed 也应覆盖。原 cohort wrapper 的 `cleanup` 内嵌 result 同样是已绑定证据，不能仅检查可能缺失的本地 `cleanup-failure.json`。目前 host-control 对 response/late_response 只记录 id/error，丢掉 result；可信迟到响应若含候选也必须保全，不能因请求已超时而丢弃这一事实，且不能将请求反记为成功。

回归应至少包含：已归档 candidate run 但 failure 没有 monitored；终态收集部分失败；已形成候选后清理 unconfirmed；wrapper.cleanup 内嵌候选而本地派生文件缺失。预期均拒绝 terminal，保留真实失败状态。

## R2：发行前失败的报告覆盖已完成 terminal，并提前跳过身份校验

位置：`feedback-report.ts` 初版 69–88。

新 `!failure.agreement` 分支 spread 了已包含 checked terminal 的 fallback 后，无条件写 `terminal: "not_sealed"`。本轮目标路径恰好是 run/完整 agreement 建立前失败，因而正常完成终态封存后生成的正式报告仍显示未封存。现有完整流程测试只断言 `scoring` 序列，没有发现这项错误。

同时，该分支在原本 codeHash/evaluation/原 deadline 校验之前 return；报告若没有 terminal 文件，其新早退分支只比较 infrastructure，不能拒绝错误 runtime、实例或原坐标。缺少 agreement 应导致采用 attempt 与原 failure 的校验路径，不能跳过身份校验。

必要修正：保留实际 checked terminal；只有确实未封存才标 not_sealed。无 agreement 的发行前失败仍核对原 attempt、contract/instance、runtime/evaluation、issuedAt/deadline、传输/审计对象，并明确资料缺失为 unknown。回归同时断言 terminal hash、原坐标与错误实例/版本拒绝。

## 已确认方向及待最终核验

D1 的四态进程观察、单独有限 cleanup、重复 stop 复用同一 promise/期限、启动失败留存清理文件以及停止后副本 DB 读取已进入实现，未见把 `processIdentity(undefined)` 直接当 gone 的旧错误。新策略显式绑定，旧配置缺省路径保留，宿主阶段 observer 没有引入 Core 研究决策。

修复后还需完成已约定的确定性覆盖：实际超时后继续执行、迟到响应、阶段 start 无 exit、取消、原 deadline、无候选正常 run 的完整 feedback 评分、前例失败造成 not_started、跨实例/策略/事件拒绝以及旧门兼容。报告必须分列原账本、补充和未知，不消除第五轮未完成状态。

上述结论是本次有限增量审查，不是整个 Researcher 的安全审计或第六轮启动批准。

---

# R1 修复后的来源边界

`terminal.ts` 的 `candidateInArchive` 不区分受信宿主 run 与原始模型报告。`archive.ts:collect()` 会递归抓取 Outcome 的 `rawHash` 并把原始 reviewer JSON 按同一内容寻址规则写到 `archive/objects`。因此模型原文 `{ "id": "pct_eval_...", "stage": "ready", "subjectHash": "..." }` 即使被宿主如实记录为 unavailable，也会被新增扫描误认作候选。这组字节与最小复现中的对象无法仅凭结构区分来源。

必要边界：候选存在检查从可信 host RPC（按 action/contractID 绑定）、monitor 观测索引、已验证 run/collection 引用及原 result/failure/audit 出发。未经可信来源绑定的 raw review、artifact、session message 仍保全，不得单凭同名字段构成候选存在事实。对无法证明来源的旧归档可拒绝为证据缺口，但不能称已存在候选；本轮新策略应产生可核验索引。

---

# 独立增量代码复核：源码阻断关闭

审查者：`/root/infra_review`。2026-09-21。复核 R1/R2 修复及后续来源约束，独立执行轻型确定性检查；没有修改仓库源码、启动真实模型、重跑重型研究宿主集成或更改第五轮。

结论：R1、R2 已关闭，当前有限增量没有剩余源码阻断。完整实施验收仍需主执行方完成其正在运行的回归与最终证据核验；本报告不把超时测试记为通过，也不构成第六轮启动批准。

## 修复核验

R1：新 hostControl 在私有 IPC response/late_response 交给调用者之前持久写入原 result，保留 request ID、action 与 contractID。terminal 从 command_start 配对核对该索引，仅解释 research-get/history/issue/cancel/recover 的结构化 run 返回，并核对 run.id。monitor/collect 的中途异常及 cleanup 失败不再丢掉已观察候选。原 result、retained collection、停止后 audit 及原 wrapper.cleanup.result 仍检查，failure.contractID 增加直接跨实例绑定。

复核中发现并关闭了修复带来的来源问题：任意 archive JSON 可能是 reviewer 原文，不能因含有 id/stage/subjectHash 就提升为宿主候选事实。最终实现不再按任意 JSON 形状推断候选。新增独立 `terminal-trusted-response-repro.ts` 保留原复现不变，用新的受信索引复现真实边界：同样 candidate-shaped 原文只保全为 unknown；加入配对的 research-history 迟到响应后，实际调用 sealTerminal 被拒绝。结果保存在 `terminal-trusted-response-repro.json`。超时仍是超时，迟到响应没有反记为成功。

R2：报告保留 checked terminal，不再覆盖成 not_sealed。无 agreement 的发行前失败在返回前核对 wrapper 实例、runtime/evaluation、contract、六小时原坐标、attempt 一致性及 transport/audit 内容 hash。完整生产 fixture 日志 `validation/terminal-integration-2.log` 显示两候选加一发行前失败从双评/裁决封存到展示、评分及报告完成，1 项测试、45 个断言；这是我读取的主执行方日志，不冒充本人重跑。正常 not_submitted 的 phaseOne 明确是带 terminal 引用的 indeterminate，没有虚构 first/second。

其他确认：DB/WAL/SHM 稳定性复核已覆盖原本缺失文件的新出现；测试子进程移入 test/，不再误纳入 runner runtime。独立运行的杀进程测试保留 snapshot_capture start 而不制造 exit。旧策略缺省路径和旧全候选门保持；没有 Core 研究决策或新的 unresolved/P1 自动否决规则。

## 独立执行与真实测试状态

- `independent/host-control-final.log`：最终源码 9/9 通过，50 个断言。包含等待到期后真实子进程仍执行、原文迟到响应、cleanup unconfirmed、取消、deadline、startup 无 ready、重复清理以及杀进程后无阶段 exit。
- `independent/terminal-trusted-response-repro.json`：最终源码的受信候选拒绝与原文不冒充候选检查均通过，未运行模型。
- `independent/light-regression-final.log`：最终源码三项定向测试中 unknown cleanup 与 not_submitted 通过；hidden-candidate 用例在 30 秒测试期限处超时，没有通过结论。该轮与主执行方完整源码冻结验证并发。主执行方相同源码的 `validation/infra-regression-final.log` 已显示这四项基础设施测试全部通过，其中 hidden-candidate 为 4.36 秒；我核对了日志。不能仅凭这一时间差断言底层 I/O 根因已证实。
- 早期独立 `light-regression-1.log` 的两次默认 5 秒超时、`light-regression-2.log` 的 3/3 通过，以及中间来源约束版本的最小复现均保留。它们不代替最终源码验证。
- 两包最终类型检查日志只含正常 tsgo 命令退出记录，由主执行方运行。其最终套件当时仍进行中，且 host late 有一次 startup_timeout；本人对应最终 host-control 9/9 已通过，原失败仍应保留并在整体报告交代。

## 已审身份与限制

最终已读 30 个源码/测试/支持文件，其中 24 项相对修改前基线有变化，完整字节在 `reviewed-files-2/`，逐文件 SHA 在 `reviewed-inventory-2.json`。该 inventory SHA-256 为 `11eb30e93cd1edc381d7ce11174ec632a11ddc165dd5cb1567b673ebf7fce2d1`。最终独立受信响应复现的 runtime identity 为 `3744523872f5ad14b30d81e91681cad7cff5b5ebc9ae0de1ce4782810a6765c9`。后续源码变化需要按差异复核。

第一版 reviewed-inventory-1 是审查结束时快照，采集时主执行方已经开始 inline 修复；不要把它误称为 R1 初始复现的精确源码版本。初始事实由保留的复现输出、其 runtime hash、原报告代码位置和基线共同说明。

此审查只支持基础设施增量的正确边界，不证明真实 Researcher 已可靠使用完成声明，不解决实时用量竞态，也不改变第五轮未完成校准、两个正确候选、整批第二阶段未评分及 66 例暂缓的结论。

---

# 评分材料与冻结门策略一致性补充审查

审查者：`/root/infra_review`。2026-09-21。主执行方在收尾发现此依赖遗漏后请求独立确认；本人只读核对源码，未修改仓库或运行测试。

确认需要修复。`launch.ts` 的 identities 在 infrastructure 显式存在时冻结 `scenarios.infrastructure` 与 `finalQuality: candidate-or-terminal:1`，实际展示门及报告也执行新规则；`lifecycle-evaluate.ts` 的 `material.measurement` 却直接引用常量 lifecycleMeasurement，其中 finalQuality 仍是旧的 `all-cohort-candidate-seals-before-feedback-reveal:1`。这会给独立评分者提供与实际冻结规则不同的说明，不应随本轮最终交付保留。

限定修正可在 lifecycleMaterials 仅对 result.infrastructure 存在时附同一 policy 与新 finalQuality；缺省旧策略继续保留原材料说明。科学判断 rubric、真值、历史封存及第五轮均不改。此修正无需扩大宿主架构，但会改变新的评测材料字节，必须纳入本轮最后源码身份及定向验证。

必要断言：两候选加一个 terminal 的真实生产 fixture revealed.material.measurement、正常 not_submitted 材料均与新冻结 scenarios 一致；旧 lifecycle 流程仍显示旧门。可直接将 launch.identities 生成的 scenarios 与实际 measurement 等值比较，以防两处分支再次漂移。

本项不在此前 code-review-2 的已查30文件清单内：lifecycle-evaluate.ts 原本没有本轮差异，依赖元数据传播遗漏由主执行方收尾检查发现。需在补丁完成后更新已审清单和最终结论；此前快照与报告保留。

---

# 独立代码审查最终追加记录

审查者：`/root/infra_review`。2026-09-21。以 `code-review-2.md` 为基础，独立复核收尾发现的测量说明传播遗漏及四文件小增量。本人没有修改仓库、并发再跑宿主实例或调用真实模型。

最终结论：本轮限定基础设施增量审查通过，无剩余源码或设计阻断。R1 候选存在证据、R2 发行前报告及元数据一致性问题均已关闭。该结论不等于未来真实校准完成，不授权改变第五轮或启动 66 例。

`lifecycle-evaluate.ts` 只在 result.infrastructure 明确存在时，将同一基础设施策略与 `candidate-or-terminal:1` 追加到实际评分者材料 measurement。无 infrastructure 的路径保留原 measurement JSON 语义。没有改科学 rubric、评分真值、生命周期判据或历史门。

`terminal.test.ts` 与 `infrastructure.test.ts` 将实际展示给评分者的完整 measurement 与 `launch.identities(...).scenarios` 深比较，覆盖两实际生产 fixture 候选加发行失败，以及正常 not_submitted；`test/lifecycle.ts` 明确断言旧 finalQuality 及 infrastructure 缺省。两处 `expect<unknown>` 只是擦除后的静态类型宽化，运行时仍执行完整 toEqual 比较，没有弱化断言。

本人核对主执行方最终日志 `validation/measurement-integration-final.log`：三条定向路径 3/3 通过、109 个断言；`validation/opencode-types-complete.log` 正常通过。此前完整 lifecycle 11/11（512 断言）和 response:1 8/8（152 断言）日志已核对；这 19 项在元数据小增量之前完成，小增量之后按其影响重新覆盖三条路径，并未冒称再次重跑全部 19 项。两处最初的测试 matcher 类型错误仍保留于 `opencode-types-final-2.log`。

此前独立执行的 host-control 9/9、可信响应来源复现及共享运行期间的一次定向超时，仍按 `code-review-2.md` 原样记录，不将失败重标为通过，不把重跑次数累计成更多独立用例。

最终 31 个已审源码/测试/支持文件中，25 项相对修改前基线变化。逐项字节快照：`independent/reviewed-files-final/`；SHA 清单：`independent/reviewed-inventory-final.json`，清单自身 SHA-256 为 `c3f3cf538a039b0812ddea86f964755eaf83e6450cc0fd195f85cbff9d1585e5`。本人独立计算最终 runtime identity：`fcf1dc9132b4b605299c2c06a71a8bc0e1103ef9305c69fa500aed41c88a8906`，留存于 `runtime-reviewed-final.txt`。所有前版报告、失败日志、复现和文件快照均保留。

边界不变：新策略支持有来源的终态封存与真实候选双评后展示；unknown cleanup 不证明宿主已停，原始 reviewer 文本不证明候选存在。原 deadline、六小时预算与历史语义保留。实时用量竞态、第五轮未完成校准及真实模型的完成声明可靠性均未因此解决。
