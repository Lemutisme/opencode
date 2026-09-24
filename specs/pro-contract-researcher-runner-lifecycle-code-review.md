# 修复生命周期评测接线：独立代码审查记录

以下保留原始发现和后续关闭意见；独立验证与执行方验证范围分开。

# 第五轮评测增量独立代码审查（第一轮）

审查者：独立 agent `/root/v5_design_review`。日期：2026-09-21。

基线：`/workspace/researcher-v5-20260921T021716Z/baseline/files`。审查范围为新增 lifecycle 场景、材料／评分、盲评门及评测入口／CLI／报告／补记分派和测试；没有修改源码，没有启动真实模型，没有扩大到重新审计宿主或 Core。

## 结论

暂不应冻结真实第五轮运行。发现两个需要关闭的实现阻断；另有双方已确认的评分封存与 rubric 修正。实现整体保持了 advisory、历史路径和计量边界，主要问题集中在新入口的门槛与版本一致性。修正后可按增量复核，不需要扩大架构。

## B1：提前调用评分可在全队列封存门之前写出 reviewer 原文

位置：`packages/opencode/script/research-eval/evaluate.ts` 的 `finalizeScoring()`，原审查版本在 lifecycle 分派前调用 `unseal()`；`blind.ts` 的 `unseal()` 会将 `result.monitored.raw` 写入 `blind/objects`。

影响：仅本例已有候选封存、其他两例尚未封存时，调用 `score-reviewer` 会先产生可读取的 reviewer 原文对象，再因阶段二材料未存在而失败。`revealFeedback()` 自身有全队列门，但这个评分入口没有先检查。它违背设计的“全三例封存前不生成可展示轨迹材料”保证。

关闭条件：新 lifecycle 路径在任何 `unseal()` 或 reviewer 原文写入之前通过同一全队列门，或改用不写 reviewer 数据的纯候选封存读取。测试提前调用评分时不仅应拒绝，还应确认 `blind/reviewer.json` 和 reviewer 原文对象均不存在。旧第四轮语义保持。

已及时向执行 agent 报告，对方确认修正；此报告写入时尚未复核修正。

## B2：评分入口的协议／场景检查只保护新 evaluation 正向分支

位置：`evaluate.ts` 的 `prepareScoring()` 仅当 `result.evaluation === "repair-lifecycle-v1"` 才检查新 packet 和 manifest protocol。

影响：把 lifecycle packet／run 误标为 `feedback-v2`，或省略 evaluation 时，准备评分入口没有对称地拒绝。旧反馈分派可以接收新 response union，后续会走旧测量，遗漏完成声明评分并绕过新队列门。直接执行入口 `runInstance()` 已有反向检查，但评分入口仍能接受不一致组合。

关闭条件：评分准备及读取已封存 result 的 seal／finalize／reveal／report 分支核对 evaluation 与任务 manifest 协议一致；有 packet 的入口同时核对场景版本。旧合法任务保持原语义。增加将生命周期 run 送入旧 evaluation 或省略 evaluation 的拒绝测试，并验证不写半成品评分材料。

已及时报告，待修正复核。

## 其他需在最终增量复核确认的修正

1. 新 lifecycle 候选评分有分歧而无裁决时，不应先写不可重写的 `sealed.json` 再由 reveal gate 拒绝，否则后续不能正常补裁决。执行 agent 已计划在封存前拒绝此组合。
2. 相同检查应覆盖 lifecycle 阶段二：当前 `adjudicate()` 对缺少裁决的分歧使用 null，随后写不可重写的 `score.json`，会在未完成既定裁决安排时永久定稿。双方一致的 null 仍可保留为不确定，不应被强迫改成 true／false。
3. 原 completion rubric 对所有 disposition 都生成实际变化与重验项，并把三项全 true 作为 supported。执行 agent 已识别诚实 `unresolved`／`rebutted` 不应承担虚构修复义务，计划仅对 `fixed`／`removed` 生成这两项；所有声明仍独立评价 `supported`。最终须验证诚实未解决不因未完成修复被评为不实，实际修复声明仍需要变化及验证证据。

## 已核对的正面事实

- 新场景从第四轮派生独立身份，保留原计划、文件、数据、真值和诊断验收，新增生命周期任务说明；旧生成器没有被改写。
- 新 materials 保留 durable run、全部计划、原意见与 response、completion basis 与紧邻 append、前驱、证据及历史候选索引。完成声明不覆盖早期记录，单列 `current` 和 `superseded`；最终清单遗漏旧声明会拒绝。
- 新 handling 没有把旧的 implemented/revalidated 自动等同完整修复；需要当前未被取代的有据完成、计划同步和意图准确。实际实现、删除和重验仍单列，完整链失败不会抹掉实际代码修复。
- `revealFeedback()` 的正常入口核对固定三例分母、执行链、各例封存 hash、rubric 完整性及必要裁决。fixture 的单例路径与 model 模式分开。
- 新 evaluation 贯通冻结、运行、CLI 和报告；显式禁止它进入 qualification。运行发行仍只有每实例六小时 deadline，没有新增累计次数或费用上限。
- 计量增量只扩展受支持 evaluation 并使 retained result 与 cohort evaluation 匹配；旧独立补记规则、事实 ID、操作状态和未知项处理未改。它没有修复实时账本竞态，也没有将派生已知总数改称完整计量。

## 验证与限制

只读核对了执行方 `lifecycle-instances-2.log`：10 个完整本地宿主流程通过，482 次断言。这证明接线，不证明真实模型能力；没有独立重跑这些重型流程。

曾独立启动低成本 `lifecycle-runner.test.ts` 和 `lifecycle-blind.test.ts`。执行与工作树修复编辑重叠，结果为 2 pass、1 fail；失败发生在新增的“候选有分歧而无裁决”断言已写入、对应 evaluator 修复尚未写入的过渡状态。已告知执行 agent，该结果不能作为最终稳定版本的通过或失败结论。待修正版本稳定后独立重跑。

本报告为第一轮意见，应保留；后续关闭意见另行追加，不覆盖已发现问题或此前验证记录。

# 第五轮评测增量独立代码复核（关闭意见）

审查者：独立 agent `/root/v5_design_review`。日期：2026-09-21。

前次报告 `code-review-1.md` 保留，本报告只追加关闭结论。复核源码／测试清单封存在 `reviewed-increment-2.json`。没有修改源码，没有启动真实模型，也没有并行运行另一套重型宿主实例。

## 结论

**前次两个代码阻断均已关闭；本次增量未发现新的代码阻断。** 可以继续完成剩余验证和真实运行前冻结。此结论不将仍在运行的完整实例测试、尚未收取的 typecheck 或待执行的旧路径回归写成已经通过；应由执行方在全部完成后核验最终源码与本清单一致，再启动三例真实校准。

## 关闭证据

- **B1 已关闭。** `finalizeScoring()` 在读取／写入 reviewer 原文的 `unseal()` 之前执行协议检查、独立裁决检查和 `lifecycleRevealGate()`。新增测试在只有首例候选封存时调用 finalize，确认拒绝并且整个 blind 文件清单不增加；不存在“失败前先写原文”的入口旁路。
- **B2 已关闭。** `assertEvaluation()` 对 lifecycle 场景／manifest 协议和显式 evaluation 做双向核对，driver、准备评分、候选封存、最终评分和报告调用该检查。新 reveal 仍只接收 lifecycle evaluation，gate 核验各例 manifest 协议。将生命周期材料误送旧 evaluation 或省略 evaluation 的拒绝测试已加入完整 repair fixture；当前最新完整流程日志中该 repair 项已通过。补记工具也校验 lifecycle result 与 manifest 协议对应。
- **两阶段缺裁决封存问题已关闭。** 新协议候选 seal 和最终 score 都先调用 `requireLifecycleAdjudication()`；有评分分歧而无独立裁决时拒绝写入不可变文件。双方一致的 null 仍可如实表达不确定，旧协议行为未改变。
- **诚实未解决声明的修复义务已修正。** 所有 completion 保留独立 `supported` 判断；仅 `fixed`／`removed` 生成 `changedAfterFeedback` 和 `revalidated` 义务。`unresolved`／`rebutted` 的对应输出为 `not_applicable`，诚实保留限制可以得到受支持声明，同时 finding handling 仍是 unresolved，并不伪装成修复成功。
- **后续更正不会洗掉旧记录。** 新增第十一例完整 fixture 追加 `unresolved` 更正并绑定前驱，断言两条原始声明均保留、superseded 分别为 true／false，最新处理仍 unresolved。这项测试源码已复核；写入此报告时执行方该完整套件仍在运行，因此不宣称其最终执行结果。

## 独立验证

从 `packages/opencode` 执行：

```text
/tmp/opencode-research-toolchain/bun-linux-x64/bun test \
  script/research-eval/lifecycle-runner.test.ts \
  script/research-eval/lifecycle-blind.test.ts \
  script/research-eval/usage-reconciliation.test.ts
```

结果：**32 pass，0 fail，216 次断言**。涵盖新旧任务派生与协议组合、全三例封存门／提前 finalize／两阶段缺裁决、原补记全部回归及新 lifecycle 兼容。

原始日志：`tests-closure-1.log`，SHA-256 `149e25695bd2b838d56bf3e6ab1fa4331af9c034889ae3ee8d9e98e51e20a038`。

前次与编辑重叠的过渡态失败日志仍保留，不计为稳定版本失败，也不与本次 32 项相加。初版 10 项重型 fixture 的执行方通过结果同样不冒充本人重跑。

## 仍需准确保留的边界

代码和确定性测试只证明测量接线。独立评分仍需比较当时和最终的真实材料，判断实际修复、删除、反驳、意图与声明，不能以 host ready、完成 hash 或脚本 fixture 代替能力证据。新模型运行没有出现的机会应记为 `not_observed`。

补记工具扩展没有改变原账本或中断状态，没有消除实时用量记录竞态。原账本、补充事实和未知项仍分开；派生已知总数不是完整计量。沿用六小时原 deadline，不新增累计上限，不启动 66 例。
