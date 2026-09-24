# Researcher 定向修正实施记录

2026-09-21。范围依据第四轮三例结果与用户后续建议：[设计](pro-contract-researcher-repair-lifecycle.md)、[独立设计审查](pro-contract-researcher-repair-lifecycle-design-review.md)。本轮没有启动第五轮真实校准、66 例或任何新的真实 provider 调用。未请求 Principal 决定日常修复／计划维护，未改历史评分真值。

## 基线与边界

修改前完整工作树保存在 `/workspace/researcher-followup-20260921T005437Z/baseline/`，6,583 项，manifest SHA-256 `1ff371074290c0d18e34799c42ef36567fd1d740d128345292d4b6cc1b561cb6`。分支仍为 `jerry/dev`，HEAD 仍为 `78bec19263814444ab008c58d54835b59b4a1c6b`。Git 基线不代表工作区已有实现。本轮没有提交 commit。已有未提交修改保留，主要新增改动限 sdk-next research、research-eval 及其测试／文档，Core／公共 Protocol／Server 未增加研究语义。

完整证据根目录为 `/workspace/researcher-followup-20260921T005437Z`。最终文件清单、源码差异和保全身份见该目录 `final-identity.json`；失败日志和最初审查意见也保留。

## 回应与计划的生命周期

新 v2 发行默认固化 `feedbackProtocol:"repair-lifecycle:1"`。历史省略字段的任务、显式 response:1 任务仍用原回应协议；发行精确重试保留原字段及身份。v1 不能启用新生命周期。`feedback-development:1` driver 显式 response:1，防止本轮默认升级悄悄改变旧场景的测量。

新初始回应为 version 2，逐 finding 记录 `repair_planned/rebutted/unresolved`，并明确 `planChange:retain|revise`。revise 必须搭配 repair；planned 任务回到 exploration、撤销旧准入与实验，提交新版计划后再实验。同方法修复仍回到 execution。final-only 没有计划阶段，拒绝 revise。普通计划维护留在原任务授权内。

新 `read_review_evidence` 在只读 delivery feedback 提供当前验证／正式实验允许清单内的文件、完整 hash、候选／计划身份及最多 16 KiB 的片段。真实 inventory 路径包括 `artifacts/result.txt`，不猜测工作区路径。读前后都检查执行权限及原 deadline，单次不超过 30 秒。

`review_completion` 同阶段追加声明，发生在实际候选冻结、验证、评审之后及当前回应之前。宿主核验原 response/finding、当前评审归档、计划／候选／验证 job、正式实验、被引用完整 blob 和原 deadline；仅当前验证／实验的证据集合可作完成证据。计划 hash 单独绑定身份，不能代替验证证据。宿主生成时间、context、round、basisVersion/basisHash，并核验原 durable run 与紧接着的追加事件。精确重试先匹配 canonical 请求，返回原 hash／时间；不同陈旧前驱拒绝。追加也受 30 秒或剩余 deadline 限制。

完成声明区分 fixed、removed、rebutted、unresolved。修订链不覆盖原意图或提前声明；变更候选／计划后，旧记录保留并标明不匹配当前候选。交付与 exact recognition 重验完整链。当前 reviewer 不被宣称已经审过其后追加的声明；下一轮材料可读取此前原意见、回应、原文、完成声明和所引归档证据。

这些是机械绑定，不能证明科学修复成立。未完成意图和 unresolved 可在 advisory 下如实提交；required 仍要求对应阶段 available accept。`ready` 仍为候选提交，外部 exact attestation 才能 `accepted`。

## 引用界面

新 map 固化 `promptVersion:2`，条目附材料标签，分别指向计划、任务背景、验证、实际证据路径、计划评审和实验。模型获得可直接拷贝的完整 `{jobID,id}` 选择器；计划和最终 v2 prompt 均删除竞争性的 Allowed hash 语法。hash 留在不可变归档与身份数据中，宿主按原 job map 严格解析。

旧 v2 renderer 的逐字文本保留，map 重建按是否存在 promptVersion 分派；旧 v1 hash 协议不变。未知、跨 job、过期、歧义及 hash-as-ID 仍拒绝。第四轮两个 unavailable 原始 accept 不补写、不重新评分。

## 独立用量补充

新增离线入口 `packages/opencode/script/research-eval/usage-reconciliation.ts`，输入原 feedback-v2 cohort，向输入树外的新目录写 `research-usage-reconciliation:1` sidecar 和 `research-usage-report:1` 报告。只读原文件，不打开旧数据库、不调用宿主执行、不改原 ledger/accounting.correct、状态、计数或评分。合法完成的 Chat/Responses SSE、唯一请求、原 cohort/result/操作/传输链和 双方已知的用量字段都须吻合；重复去重，冲突／缺失／截断保留未决，费用保持 null。

独立调查定位 R3 plan 提交关闭 admission 与 provider usage 消费尾部之间的竞态：网关已捕获 `response.completed`，原 Core 操作先中断，因此 usageEvents 为空。归档没有完整调用栈，不能声称知道哪一条内部 authority 检查赢得竞态。完整传输包含 input 4,593、output 802，总 5,395。

只读对账确认 62 条既有 provider 用量，另补 operation `b319ae96-3454-4ab8-b69d-aa96113ea65f` 一条事实。原已知 482,301，补充 5,395，派生已知 487,696；原状态仍 interrupted，原 usage unknown、usageEvents 空。125 个操作计量仍未知，包括 123 个非 provider 和两个 scripted 初始计划操作；外部评分 agent 用量和费用未知。此已知小计不等于完整计量，也不表示操作成功。最终派生目录为 `/workspace/researcher-followup-20260921T005437Z/accounting-v4-reviewed/`，报告 SHA-256 `5b48f079542e4694f83c72c9f630c66edb06e20136a048897e086ab88de00f11`，sidecar 为 `7c636ac616b5a56bf0ef31de95d6e095d10351e75f02ab32925d698e1da348a0`。

独立审查反例使对账器补上两类分母保全：同操作 wire 的坏 requestID 不能先过滤再宣称唯一；失败实例早期 partial 与较晚 retained 快照的新增／冲突操作必须进入未决记录。事件本身缺失身份也不能拿 wrapper 身份回填为完整来源。原反例、初次错误聚合形状假设和每次派生报告都保留。

## 独立审查

[生命周期／引用独立代码审查](pro-contract-researcher-repair-lifecycle-code-review.md)关闭 C1–C6；[用量补充独立代码审查](pro-contract-researcher-repair-lifecycle-usage-review.md)关闭两项分母遗漏及事件身份回填问题。原审查全文逐字复制入 specs，最初发现、反例、修订和最终签字均保留。设计审查由独立 agent 在实施前完成，审查通过的设计字节另存 `design-approved.md`，hash 与原签字一致。

## 验证与保全

验证仅采用真实生产宿主配合本地固定 HTTP fixture、实际数据库／归档 I/O 和原冻结文件；脚本测试不证明真实 Researcher 能力。所有测试从包目录运行，类型检查使用 `bun typecheck`。

实际通过的验证包括 SDK 47 项、research-eval 定向单测 23 项、用量补充 28 项和完整生产反馈流程 26 项；v2 完整实例联调 8 项及 legacy 定向完整实例 5 项通过。最终日志索引见本记录收尾。新增流程覆盖意图→新版计划→实验→读取→完成／更正→提交与 exact recognition，同方法修复、删除声明、旧候选记录、pending intent、不伪造 unavailable、required 与历史兼容、跨身份／错误前驱、证据损坏和真实 I/O 跨 deadline。租约／generation 的通用执行边界另有现有生产存储和 authorizer 回归，本轮不声称对每个新命令逐一做了 takeover 注入。

历史只读核验覆盖第四轮 7,969 项归档、最终 identity、前三轮冻结源码分别 6,559／6,558／6,555 项及 644 个内容寻址对象，零变更。原 deadline、六小时每实例墙钟、无累计请求／实验／费用上限不变。

后续需要决定是否另冻一轮小规模真实开发校准，观察模型能否实际更新计划、读取正确证据、追加有依据的完成或纠错；本轮机制通过不能代替该证据。66 例继续暂缓。

## 最终验证索引

所有路径相对本次证据根目录；同一 suite 的失败／中间版本日志保留，不计入最终通过数。独立审查直接读取了类型检查与宿主日志，用量测试由用量审查者另行独立运行。下列 v2／legacy 完整实例联调由 root 在独立签字后继续完成，独立报告没有抢先声称审过尚未结束的联调。

| 验证 | 结果 | 日志 |
| --- | --- | --- |
| SDK research schema／prompt／plan／store／TAP | 47 通过 | `validation/sdk-unit-final.log` |
| 引用测试非空 tuple 类型修正后的重验（包含于上述范围，不另加总） | 25 通过 | `validation/sdk-selector-final.log` |
| 完整宿主反馈及历史兼容流程 | 26 通过 | `validation/feedback-process-final.log` |
| 评测归档／driver／评分／P1 语义／旧计量定向单测 | 23 通过 | `validation/eval-unit-1.log` |
| 用量补充最终独立复验 | 28 通过 | `independent/usage-code-review-final-retest.log` |
| v2 本地完整实例 | 8 通过 | `validation/eval-feedback-instance-final.log` |
| legacy plan／final probes 及 R3 Chat／Responses 完整实例（其余三项未重跑） | 5 通过 | `validation/eval-legacy-instance-final.log` |
| sdk-next 类型检查 | exit 0 | `validation/sdk-typecheck-final.log` |
| opencode 最后用量修正后的类型检查 | exit 0 | `validation/opencode-typecheck-reviewed.log` |
| 19 个变动源码／测试文件格式 | 通过 | `validation/format-final.log` |
| 历史冻结材料／当前 Markdown 检查 | 零错误 | `validation/history-integrity.json`、`validation/markdown-check.json` |

第一次新宿主测试的两项失败来自把读取路径写成 `result.txt`；真实允许清单是 `artifacts/result.txt`，修正后八项新流程与完整 26 项均通过。新增引用测试的普通 map 数组不满足非空 tuple 类型，TS2322 原日志保留，修正后重验及类型检查通过。用量首次真实归档派生错误地假定 embedded evidence 和归档 aggregate 形状相同，失败材料保留；改为核验其共享的精确 operations 投影。独立反例暴露的后续缺口也均保留初版源码、失败观察和修订后结果。
