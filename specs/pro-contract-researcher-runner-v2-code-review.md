# Researcher v2 评测运行器：独立代码审查

2026-09-20。独立审查者 `/root/design_review`，未参与产品源码或测试实现。依据用户批准的范围、[专项设计](pro-contract-researcher-runner-v2.md)及[独立设计审查](pro-contract-researcher-runner-v2-design-review.md)，复核运行器接线、逐项评分、隔离验证、归档、历史兼容和显式认可边界。本次仅编辑本审查记录。

修改前基线 `/workspace/researcher-runner-baselines/20260920T214200Z`，manifest SHA-256 `8cebc62237cbf121fe6ee00d4a8626af2365d368d3719be083ce3af6770a92fe`。工作树已有未提交成果不是本轮新增；独立比较使用完整基线，不用 HEAD 代替。

最终结论：**独立代码审查通过**。W1–W4、S1–S7 均已关闭，无剩余阻断；最后修订后的 v2 集成、历史兼容、冻结与启动检查、包内类型检查及格式检查均已通过。此结论覆盖运行器机制及本地确定性 fixture 接线，不证明真实模型的研究能力，也不构成第四轮校准、资格评测或 Principal 认可。

## 最终签署身份

独立审查者于 2026-09-20 签署以下源码身份。签署前再次逐项核对全部 18 份新增或修改的 source／test 文件内容及 mode，零差异；这些文件全部位于 `packages/opencode/script/research-eval/`。runtime 身份另经审查者两次调用实际 `codeIdentity()` 独立核验。

| 对象                          | SHA-256                                                            |
| ----------------------------- | ------------------------------------------------------------------ |
| 已批准专项设计                | `fc81180887b30fed9b411f38706ef72142aeb7064cfc78b8098014d62188dd8c` |
| 修改前完整基线 tar            | `1e1b4ef92b818796e8633ea42dc2492435dd5128139ea0c1612a4eed6487ba17` |
| 最终 `source-changes.json`    | `6c9605f5ac64f20e3d0ac60cbc24d1cd4635d81513fa7a47e4dde7159a1f7959` |
| 最终 `source.patch`           | `83ca3cf706cdd4b2c3c8596dcf3509f5fe3f0ef6cb048066f8fb4435313c4714` |
| 最终 runtime `codeIdentity()` | `3ab6f4ecfe171af0d643d7c8af665f53554b277b2dea9830cadde4fe32ea93f2` |

源码清单、补丁及最终日志位于 `/workspace/researcher-runner-validation`；早期 `*-pre-s7` 清单与补丁保留为过程证据，不属于本次签署身份。

## 接线发现与关闭依据

| 编号 | 初评问题与影响                                                                                                                         | 修订及复核                                                                                                                                                                                                    |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1   | 把 outcome／reportHash 的存在当作 reviewer 已触达，导致从未调用模型的 absent unavailable 被算进已触达分母。                            | v2 初始和最终 exposure 均只由对应 job 的实际 provider wire／response 决定。legacy target 统计保持原语义；不可用 outcome 本身不产生触达。源码关闭。                                                            |
| W2   | 多次诊断干预复用同一个可写目录，首次候选可改写 `candidate.mjs` 或 `run.mjs`，让后续输入执行另一份源码。                                | 每次输入新建独立目录，从保留的原源码重建候选及 harness。自修改候选、常量输出、伪造 ID 和同 test 选参反例均进入单测；数据还包含一致的数组／ID 置换。源码及已见单测关闭。                                       |
| W3   | Responses bootstrap 的终帧缺少已安装 SDK 强制要求的 usage，可能在真实 SDK 路径解析失败；直接补零又会把脚本记成真实已知 provider 消耗。 | 完整终帧满足实际 SDK schema；脚本 operation 单独标 `script:initial-plan-only`，wire 为零、tokens 为 null、unknown 为 true。最终版本完整 Responses 修复／unavailable 流程及两种协议 bootstrap 单测通过。关闭。 |
| W4   | v2 research 入口仍可接收旧 corpus packet，调用者可能将历史任务静默改用 v2。                                                            | 任何 v2 输入先验证新场景版本，followup／research 入口及不支持的故障模式分别检查。setup／deployment／freeze 同时保留显式策略版本；缺省仍 v1。源码关闭。                                                        |

Bootstrap 在输出前独占创建记录、写入并同步文件及父目录，保存 operation、Session、context、plan hash 和协议；记录存在或计划已出现即不能再次脚本化。脚本仅生成第一次计划请求，不读取候选答案 preparation，不替后续 worker 回应、实现、实验或提交。脚本存在不再把整个新轨迹强制切到 Chat Completions。

Controller 先选择最早创建的 plan job，再查同一 job 的 outcome；不跳过无报告的首个 attempt。v2 首评不会终止 followup，不调用 legacy root challenge；首次 ready 只封存候选，外部评分及 exact 认可仍分开。

## 测量发现与关闭依据

| 编号 | 初评问题与影响                                                                                                                                         | 修订及复核                                                                                                                                                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1   | `validDefect=false` 被直接解释为 unsupported objection，普通建议或肯定性 note 也会凭空产生误拒处理机会。                                               | 新增独立 unsupportedObjection，区分真缺陷、无据反对、ordinary_feedback 与未定；矛盾的两个 true 拒绝。没有对应机会维持 `not_observed`。源码关闭。                                                                                    |
| S2   | 首个 attempt 已产生 wire／partial raw，但没有 host outcome 时，评分层重新标成未触达。                                                                  | 无 outcome 分支读取原 attempt 的 exposure；有实际调用但无有效报告为 unavailable，未调用为 not_exposed，原 job／raw／capture 保留。审查者曾独立调用实际 helper 核对 partial 情形。源码关闭。                                         |
| S3   | 最终 snapshot 是所有评分的先决条件，取消／超时直接跳过准备；已有首评和回应会因未交付而失去评分入口。                                                   | v2 无候选分支显式封存 `not_submitted` 材料，最终质量保持 indeterminate，仍可封存并评分已有首评及反馈。取消／超时不再自动跳过 v2 评分；已声明 subject 却缺失快照仍严格拒绝。源码关闭。                                               |
| S4   | 单项 implemented repair 要求整个最终候选正确，另一无关错误会抹去已经完成的真实修复。                                                                   | 单项按相关修复、因果、正式重验和必要的客观证据评分；整体最终质量独立保留 incorrect。审查者独立调用 helper 验证只改最终质量不会抹去已证明的单项处理。源码关闭。                                                                      |
| S5   | 首评 target rubric 未说明冻结的目标机制；反过来，给所有后续结果套同一个原始 target 又会错判真实模型产生的新缺陷。                                      | phase two 才揭示 P1 seed 对应的冻结 oracle target，仅 seeded 首评要求命中该机制。后续／最终按其实际候选的具体缺陷判断；R3 自主首计划仍不套用原好标签。源码关闭，见下述 S7 联动项。                                                  |
| S6   | v2 失败报告仅保留 wrapper，不验真内部 failure／transport，也不呈现已发生的 operation 消耗及未知项。                                                    | 核对 failure 内容 hash、runtime、evaluation、contract、原六小时 deadline 及 transport hash；输出已有逐 operation 计量、未匹配传输和 accountingIncomplete。脚本 token 仍为 unknown；没有数据时不冒充已知零。源码及已见损坏反例关闭。 |
| S7   | S5 将后续 plan 的 target 改为任意实际缺陷后，`diagnosticRequired` 仍以 P1／plan／target 为条件；合法移除 optional 比较会错误否定后续不相关缺陷的修复。 | 硬诊断要求现仅用于已匹配 seed 的首评 target；其他 finding 按各自修复证据评价。新增合法 removed 状态下不相关修复仍成功的反例，最终 `v2-s7-final.log` 验证通过。关闭。                                                                |

自发修复改用独立、绑定时间顺序及实际证据的 spontaneousTargetCorrection 注释；不能仅从正确最终结果推断，也不能用对其他缺陷的反馈冒充与 P1 目标相关的反馈。合法移除和误拒后的退让分别保留，不计为 validation／test 实现修复或事实反驳。自然模型结果与 local-fixture 来源分开。

实施者收尾自查另加入 candidateAvailable：没有实际最终候选时，即使注释者把缺失项标为 false，最终质量仍为 indeterminate，不能伪造一个错误交付；取消后的首评／反馈继续可评分。审查者已读取该分支及相应 fixture 断言。

最终候选先行盲评：准备材料包含保留的源码、最终计划、正式输出和隔离执行证据；在双人判断封存前，不生成 reviewer／反馈材料。随后 annotation 绑定完整轨迹及 rubric hash，第三方裁决保留原两份判断。v2 的最终 scorer 不再使用 legacy 的“非 accept 而 gate open 就机制失败”规则。

## 归档、认可和历史边界

- 反馈材料使用内容寻址对象及保留快照，不从可变 worker 目录补候选。首评、后续反馈、回应、实验、提交验证、原始模型输出和传输来源分别保留。基础设施失败尽可能在 host 仍可读时收集完整归档；失败采集不足保持明确。
- `recognize` 仍是外部显式入口。它要求独立正确的 ready 候选、封存评分、原 exact publication／bundle 身份，并拒绝意外 provider 活动；运行器本身不调用它，也不以评分替 Principal 自动认可。评分时的 externallyRecognized 为 false，后续明确认可另留 receipt 和时间。
- 首轮独立比较 6,572 项原文件无缺失；Core、SDK、公共 Protocol、旧 `corpus.ts`、`score.ts` 及 33 份 S 阶段历史设计／校准／审查记录均未改。本轮 source 增量集中在 research-eval，收尾还更新当前总设计、中英文入口及 handoff。
- 六小时预算、原 deadline、单次操作边界、凭据／网络隔离、取消、未知执行审计及完整计量继续保留，无新增累计请求、实验或费用上限。v2 只开放三例 development 接线，qualification 入口拒绝它；旧 66 例矩阵保持原语义。

## 已读取的验证证据

日志位于 `/workspace/researcher-runner-validation`。最终签署读取并核对以下结果；不同轮次有重叠，不将它们相加作为独立测试总数：

| 最终验证                   | 已读取结果                                                                                                                                                                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 最后修订后的 v2 集成与单测 | `v2-s7-final.log`：18/18，223 assertions，130.57 秒。包含 8 条完整 fixture 轨迹及 10 项单测，覆盖两种协议、回应、修复、虚假 fixed、移除、unavailable、R3 负结果、无候选取消、旧 packet 拒绝、失败对象损坏、逐 finding 修复与最终质量分离及诊断隔离。 |
| 最终历史完整入口回归       | `legacy-integration-final.log`：8/8，118 assertions，158.96 秒。覆盖两种协议、R3、R5／R6 故障恢复、R1、封存评分及 exact 外部认可。                                                                                                                   |
| 最终冻结与启动检查         | `freeze-launch-final.log`：5/5，32 assertions，98.40 秒。覆盖 dirty／untracked 完整源码冻结、内容与凭据边界、新场景版本、v2 qualification 拒绝、取消后的三实例分母及累计上限拒绝。完整快照核验期间双方均暂停仓库编辑。                               |
| 包内类型检查               | `opencode-typecheck-s7.log` 与 `sdk-typecheck-final.log`：各自包目录内 `bun typecheck` 成功。                                                                                                                                                        |
| 源码格式                   | `format-final.log`：所有匹配文件通过 Prettier 检查。                                                                                                                                                                                                 |

同时保留以下过程证据及曾经失败的运行：

| 验证                   | 已读取结果                                                                                                                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新 v2 单测             | `v2-unit-second.log`：9/9，69 assertions，包含逐 finding 机会、部分首评、原 deadline 无 bundle、失败计量与损坏证据拒绝。                                                                                    |
| 评测与历史评分回归     | `eval-regressions-final.log`：39/39，2,094 assertions，包含旧 66 行未运行分母、旧计量、provider 隔离、blind、P1 语义及新诊断反例。测试旧矩阵不是运行真实资格评测。                                          |
| 完整 v2 第二轮 fixture | `v2-integration-second.log`：7/7，138 assertions。包含 Chat Completions、Responses、误拒反驳、修复、虚假 fixed、两种移除、unavailable 和 R3 负结果。                                                        |
| 无候选新增用例         | `v2-no-candidate-final.log`：unavailable 与 cancel-after-review 两例断言通过，随后全局 hook 超过默认五秒而使套件失败；该失败保留，不记作整套通过。后续按包内建议显式设置 `--timeout 30000` 的完整重跑通过。 |
| 显式 hook timeout 重跑 | `v2-integration-final.log`：8/8，152 assertions，128.09 秒；包含无候选取消。此结果先于最后的 S7／candidateAvailable 修订，最终签署使用上表的 `v2-s7-final.log`。                                            |

早期 fixture 无条件修复造成循环、早期类型检查失败及上述 hook 失败均保留。审查者未启动重型测试或真实 provider 调用；独立源码审查、轻量 helper 核验及实施者最终运行日志共同支持本次机制结论。本地 fixture 不能用于声称 reviewer 判断、Researcher 反馈处理或最终交付已达到真实模型能力门槛。第四轮真实校准和 66 例资格评测始终未启动。
