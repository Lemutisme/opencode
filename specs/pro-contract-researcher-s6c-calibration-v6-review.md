# 第六轮独立评分与运行审计记录

2026-09-21。本记录对应[第六轮校准](pro-contract-researcher-s6c-calibration-v6.md)，证据根目录 `/workspace/researcher-calibration-v6-20260921T045626Z`。本轮执行已审源码，没有新运行实现或新的代码正确性声明。

## 预登记与隔离

两名评分者 `/root/v6_rater_a`、`/root/v6_rater_b` 和裁决者 `/root/v6_adjudicator` 均以 `fork_turns:none` 新上下文启动，执行前完成 readiness。`scoring-plan.json`、`scoring-instructions.md` 与 readiness hash 被启动登记绑定。评分者继承当前 agent 模型，API 未单独暴露精确型号；独立性来自上下文及协作式 allowlist，不声称人类／异构模型或操作系统隔离。

候选阶段只展示约定、候选文件、最终执行证据及冻结 rubric；不展示 reviewer 原文、反馈轨迹、历史结果或其他评分者意见。评分者不执行候选代码。三例实际候选各有两份独立判断、每份六项均 true，无须候选裁决；全部封存后于 05:10:58 UTC 记录全队列门，再由生产 reveal 接口验证并展示反馈。无候选 terminal 数为零，失败封存路径本轮未观察到。

不可用方案在启动前已约定：保留失败及部分输出，不替换评分者或单人冒充；同上下文仅可在不变材料上续完未完成判断。本轮两名评分者和裁决者均完成，没有替换。

## 原始判断及裁决

候选与反馈共 12 份原始 annotation，各有单独理由文件，位于 `ratings/a/`、`ratings/b/`。第一例 B 候选 annotation 含额外元数据，严格 CLI 首次拒绝；原文件和失败日志保留，新的 CLI 输入只投影四个允许字段，没有改变 hash 或任何判断项。后续独立运行审计验证了该投影。

两名评分者各自完成全部 122 项反馈判断后，24 个原 annotation／理由文件的 hash 写入 `ratings/original-judgments-sealed.json`，才比较分歧并交给裁决者。案例分别为 60／17／45 项，差异为 7／6／8 项，总计 21；101 项原一致值保留。

裁决者只读取原允许材料、双方原意见及争议清单，独立逐项解释；三份 resolution 各绑定原 materialHash／rubricHash 和全部 rubric keys，位于 `ratings/adjudicator/phase-two/`。21 项争议中 4 项 true、17 项 null；16 项为没有对应修复／删除机会，一项因复合支持判断的冻结条目未定义组合规则而保留不确定。另有原两人已一致保留的一项删除因果归因 null。最终总计 18 项 null（7／4／7），均保留在生产 score 中。

没有以裁决消除不确定性、修改真值、删除坏例，或覆盖原评分。最终封存仍区分：实际修复、合法删除、计划对齐、普通建议、无据异议、初始意图与完成声明。八项回应为 repair_planned 且没有完成声明；其中坏计划 F1 的实际修复、正式验证、计划对齐均为 true，不能因 pending_intent 抹掉该事实。好计划最终删除诊断，但 planAligned=false；对某个具体意见的删除归因可以不确定，而删除本身仍有候选证据。

三个候选质量均 correct。首评冻结标签为 detected／not_scored／false_block，最终评审均 valid_accept；九份报告均 available。R3 自主初始计划没有预置真值，not_scored 不表示评审不可用。P1 好首评中无据异议和有效实现缺口并存，不能把单一 seed 标签解释成整份评审均错误。完整结果和限制见校准记录。

## 独立运行及计量审计

与语义评分分离的 `/root/infra_review` 核对已审源码身份、部署、运行时二进制、注册测试日志、六小时原期限、三例单次发行、候选封存、实际发行／清理记录及 76 条用量事实。`independent-audit/report.md` 记录 1,088 项检查、0 失败；报告 hash 为 `243fb59b348a946553da641a413a561bfc85fde8df87a2d29eb92d04bd77cfa0`，原审计清单不改写。

原已知 543,662 tokens，五条来源化补记 47,031，派生已知 590,693；五个操作仍保持 interrupted。116 个未知操作条目、费用与评分者用量未知；实时竞态没有修复。三次发行与清理成功不证明第五轮卡点已解决，真实超时／无候选路径仍 not_observed。

最终评分引用、原意见、裁决及派生报告的身份核验另行追加到 `independent-audit/phase-two-seals.json` 与 `.md`，不改写前一份审计，也不重新评分研究语义。收尾清单见 `scoring-integrity.json` 与 `final-summary.json`。候选正确性不是 Principal 最终认可；66 例仍未运行。
