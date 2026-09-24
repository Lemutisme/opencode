# S6c 第六轮真实开发校准

2026-09-21。三例真实运行、候选双评、反馈双评和独立裁决均已完成；18 项细分判断保留 null，不等于整套反馈处理通过。证据根目录：`/workspace/researcher-calibration-v6-20260921T045626Z`。本轮使用已审基础设施，不修改运行源码；没有追加实例、补跑目标事件、延长 deadline、调用 Principal 认可或启动 66 例。

## 冻结与启动前核验

当前工作树逐项符合上一阶段 6,617 项最终快照，保留全部既有未提交成果；HEAD `78bec19263814444ab008c58d54835b59b4a1c6b` 本身不是完整实现基线。`baseline.json` 引用完整已审快照，`baseline-git-status.txt` 保存修改前状态。

沿用三例 `repair-lifecycle-development:1`、`repair-lifecycle:1` 和 Luna / low。worker 与 reviewer 均为 `gpt-5.6-luna`、`reasoning_effort=low`，context 1,050,000、output 128,000、seed unsupported；原本地 Responses 路由不变。显式冻结 `infrastructure:{version:1,startup:30000,operation:30000,cleanup:30000}` 与 `candidate-or-terminal:1`。这三个期限独立计时，数值沿用第五轮实际共享期限；provider 900 秒、tool 600 秒、verification 120 秒等原单操作边界保留。每实例预算仅为原 issuedAt 起六小时，无累计请求、turn、action、实验或费用上限。

启动前运行 24 项定向测试、3,281 个断言，全部通过：Schema 预算 2、Core 预算／历史限额 3、Session 原 deadline 4、网关／报告／生命周期接线 15。覆盖越过旧计数限制及原 deadline 的 provider、tool、compaction 停止；不把上一阶段已通过的完整故障测试说成本轮重新执行。启动前和运行后 `launch check` 均通过。冻结源码／对象另有逐文件验证的持久镜像 `freeze-ready/`。

| 冻结项 | SHA-256 |
| --- | --- |
| 全量源码 | `023eab9032e4ab381d6d702de2df7875da63bd2269236596bbe33c5dea45b654` |
| runtime | `fcf1dc9132b4b605299c2c06a71a8bc0e1103ef9305c69fa500aed41c88a8906` |
| scenario measurement | `8c0e07698a60cb83969332e7965555b9949d94f1cc5f7461b3e1ab339f332e37` |
| 启动登记 | `b137e5f576f31756886c7c9611f234a8449d305ccbdd4959cce62b536b6951e3` |

## 独立评分与结果

启动前登记 `/root/v6_rater_a`、`/root/v6_rater_b`，裁决者 `/root/v6_adjudicator`；均从全新上下文开始，只读各阶段 allowlist。评分模型继承执行 session 模型，确切标识未由 collaboration API 单独暴露；这属于同模型家族、协作式文件隔离，不是异构人类评分或操作系统隔离。预先规定不可用时保留失败、不得替换或单人冒充；本轮没有评分者替换。

两人对三例候选的六项标准均一致给出 true，自动客观检查也通过；2026-09-21 05:10:58 UTC 全部候选封存后才首次展示反馈。候选封存无需裁决。原始 annotation 和理由均保留；第一例 B 的额外 case/id/phase metadata 曾被严格 CLI 拒绝，随后仅投影四个允许字段，原判断没有改变。原失败日志和投影来源保留。

两名评分者各完成 122 项反馈判断（60／17／45），101 项一致、21 项分歧。独立裁决在原 annotation／理由 hash 固定后进行，21 项中 4 项 true、17 项 null；16 项涉及缺少对应的修复或删除机会，一项复合支持判断无法按冻结条目唯一确定。加上两人原已一致保留的一项删除归因 null，最终共 18 项 null（7／4／7）。没有替换评分者、覆盖原意见或把 null 改成通过。三例 score 与三分母报告均已封存，见 `scored-summary.json`、`derived-report/report.json` 及[独立评分记录](pro-contract-researcher-s6c-calibration-v6-review.md)。

| 场景／固定 ID | 候选双评 | 实际研究行为 | 完整生命周期 |
| --- | --- | --- | --- |
| P1 坏／`0ded50a3026b11bdf20d279e` | 正确，6/6 各两份 | 将 test 选参／同一 test 评估改为 validation 选参／test 评估；先修订第 2 版计划，再实现及正式验证；保留诊断，10 组独立扰动检查通过 | 原修复意图保留，但没有完成声明；实际修复不能被 pending_intent 抹掉 |
| R3／`1897325aa7a29bada49f1e7c` | 正确负结果，6/6 各两份 | 自主读取正式证据；澄清配对措辞，数值实现并非因该建议而新修复 | 没有完成声明，不能把原已正确的配对算法计为新增修复 |
| P1 好／`0ea9999a8cd0a4ecf29b4e02` | 正确，6/6 各两份 | 最终合法删除可选诊断；第 2 版计划却仍要求实现／导出 explore 并进行验证选参及 test 评估 | 删除与计划不一致，没有完成声明；删除不等于实现了正确分离，也未形成有据反驳 |

冻结首评测量为：P1 坏 detected、P1 好 false_block；R3 自主初始计划没有预置真值，首评聚合标签为 not_scored，并非报告 unavailable。逐项独立评分同时确认：P1 好首评 F1 对已分离的选参／评估提出无据独立性异议，F2 则指出有效的 explore 导出／正式证据步骤缺口。因此 false_block 是冻结 seed 测量标签，不能据此声称整份评审毫无依据，或把“好计划必须 accept”写成规则。原真值和评分未改。

九份实际评审报告均 available，三份最终评审均为 valid_accept。好计划面对无据异议的机会真实发生，却没有形成有据反驳；最终删除是合法选择，但其计划维护不合格，且对 F1 的删除因果归因仍为 null。八项修复意图全部仍为 pending_intent／completionState=absent；这与坏计划 F1 的 implemented=true、revalidated=true、planAligned=true 同时成立。第二版坏计划的普通建议被套用旧修复回应，responseSupported=false 也保留。没有 reviewer unavailable 机会，不额外制造或补跑。

三例交付阶段提示分别暴露 4、1、3 个历史回应目标、当前候选／plan／verification 身份、两个证据来源及完成声明用法。实际交付阶段均只调用 review_response 提交；没有 read_review_evidence 或 review_completion 调用。`completion-exposure.json` 绑定原始提示及工具记录。完成声明的使用机会存在，实际声明数为零；测量中的 completionStatus=not_observed 表示未出现声明，不能解释成没有可处理的历史意图。缺失调用不能单独证明模型的内部原因或某个提示语是唯一根因。

## 基础设施、用量与保全

三次发行分别耗时 1.335、1.295、11.151 秒，第三例 materialize 占 10.323 秒；全部成功，清理分别在 95、86、86 毫秒内 confirmed。候选 ready 分别在原 issuedAt 后 110.808、205.641、153.261 秒。新阶段记录保留实际 request／Contract／PID／期限，原六小时 deadline 未重置。真实发行超时、清理未知和无候选封存路径本轮均未出现；故障处理能力记为 not_observed，上一轮确定性故障回归仍是该路径的已有证据。本轮成功不能证明第五轮具体发行卡点已解决。

| 场景 | 真实请求（worker + reviewer） | 原已知 tokens | 独立补记 | 派生已知 |
| --- | --- | --- | --- | --- |
| P1 坏 | 15 + 6 | 145,449 | 24,094 | 169,543 |
| R3 | 30 + 6 | 256,763 | 16,362 | 273,125 |
| P1 好 | 14 + 5 | 141,450 | 6,575 | 148,025 |
| 合计 | 76 | 543,662 | 47,031 | 590,693 |

五个补记操作仍为 interrupted；补记不表示操作成功，也不回写原账本。76 个真实 provider 请求均有唯一来源事实；另外 116 个 unknown operation 条目保留，其中 114 个属于非 provider usage、2 个属于脚本操作。费用及外部评分者用量未知，实时用量竞态仍未修复，派生已知总数不是完整计量。独立 `/root/infra_review` 核验 1,088 项冻结、期限、封存与用量来源检查全部通过，报告在 `independent-audit/report.md`；此审计没有代替候选或反馈语义评分。

新完整 IPC 回应日志每例约 1.57–1.82 GB，三例合计 5,058,663,577 字节（不含归档副本）。这一保全成本保留为后续运行器诊断事项，不能据此推断第五轮卡顿原因，本轮也没有临时减日志或改配置。

第四轮 7,969、第五轮 11,931 个已登记文件重新核验均无差异；前三轮保持只读，先前完整核验仍在基础设施阶段 history-integrity.json。本轮记录、原始评审、回应、版本、实际执行、失败的离线命令及所有补记均保留。第五轮仍维持“未完成校准”，没有用新门追改其成绩。

## 判断及下一步

本轮支持继续采用 advisory；三个正确候选不足以证明反馈处理可靠。主要缺口仍是历史意图没有结项、删除未同步计划、没有基于事实回应无据异议。下一步建议先对交付阶段的提示与任务状态呈现做窄范围设计和确定性回归：逐项对照历史意图、当前计划及正式证据，明确追加完成记录或保留 pending；方法／删除变化先维护计划；按具体 outcomeHash 与 findingID 处理新意见，避免套用旧修复理由。现有提示先给出“review_response 提交，然后停止”的示例，稍后才说明“may append”完成声明，这是值得验证的竞争指令假设，不能直接认定为唯一根因。

独立审查上述增量后再决定是否冻结第七轮小规模校准；本轮不启动它或 66 例。优先解决已观察到的闭环问题，避免因三例候选正确而扩大架构或资格评测。发行卡点和实时用量竞态仍是未决项，保留新日志、来源化补记与未知项。

与第五轮相比，模型、三例数据、真值及 repair-lifecycle:1 保持，但基础设施实现、独立期限与 candidate-or-terminal:1 改变了 runtime 和测量身份；第四轮还使用 response:1 与不同反馈材料。三例不能证明总体可靠性，跨轮差异也不是受控模型提升估计。

继续保持 advisory：宿主核验身份、时序、版本、证据与硬约束；修复在研究意义上是否成立仍须独立判断。不能把 pending_intent／unresolved 或严重级别 P1 再变成普遍自动否决。历史 v1 和显式 required 阶段继续保留“评审批准后才能实验／提交”的保证。Principal 仍是外部调用方，候选双评正确不等于外部认可。
