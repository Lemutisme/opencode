# Researcher v2 评测运行器：独立设计审查

2026-09-20。审查者为独立 agent `/root/design_review`，未参与运行器产品实现。依据用户批准的第四轮测量设计与 v2 运行器范围、`AGENTS.md`、第三轮校准记录、当前反馈策略及现有运行器，审查[专项设计](pro-contract-researcher-runner-v2.md)。本次只新增本审查记录，不修改历史审查结论。

基线为 `/workspace/researcher-runner-baselines/20260920T214200Z`；独立核对 manifest SHA-256 为 `8cebc62237cbf121fe6ee00d4a8626af2365d368d3719be083ce3af6770a92fe`。初评设计 SHA-256 为 `f9b626c8d9bbc2e9c304bc64d31ee6be8cb1abba54024b88ad3d6fbfadd360ef`。

最终结论：**设计通过，可进入实施**。D1、D2 已修订并独立复核，无剩余设计阻断。签署绑定专项设计 SHA-256 `fc81180887b30fed9b411f38706ef72142aeb7064cfc78b8098014d62188dd8c`。设计通过不等于实现、模型能力、最终候选或 Principal 认可通过。

## 初评发现

| 编号 | 问题及影响 | 所需关闭条件 |
| --- | --- | --- |
| D1 | 用“最早的 plan outcome”定义首评，会跳过已经调度但未产出 outcome 的首个 reviewer attempt；之后的成功报告可能替换原失败，改善可用率或改变 P1 测量目标。 | 先绑定最早计划评审 job／attempt，再保留其真实 outcome、raw 或 absent／unavailable；后续成功 outcome 不得替代。未触达和未知状态保留分母。 |
| D2 | R3 的计划由真实 Researcher 生成，并非预先冻结的正确计划。若把原语料的非缺陷标记用于动态首计划，或用最终正确候选反推初始计划，就会错误标记 reviewer 判断。 | 明确 R3 初始计划真值另做先行盲评封存，或其判断质量保留未评分；最终 reviewer 独立绑定其实际 reviewed candidate。P1 的固定初始计划仍绑定原标签。 |

复核关闭：D1 已改为先选择最早计划评审 job／attempt，包含 fingerprint、generation、plan 和 context；无 outcome 保留真实状态和 partial／absent，不合成 outcome、不替换首个 attempt。D2 已明确 R3 初始计划判断质量为 `not_scored`，本轮只保存其可用性和原始意见；最终 reviewer 只与其实际最终候选及封存候选判断对应。P1 固定标签保持不变。

## 已满足的设计边界

- 新配置明确使用 `feedback-v2`，缺省保留 legacy 发行、停止条件、冻结身份和 qualification 语义。当前新入口只支持三例 development，拒绝把它套入旧 66 例资格矩阵。
- P1 原探针保留。新 followup 只有初始计划可由脚本提交；后续回应、实现、实验、读取及提交来自真实配置的 worker 上游。脚本不能使用 `packet.preparation`，也不能被统计为真实 Researcher 能力。
- 同一轨迹分列首评、逐项反馈处理和最终候选；宿主准入、host ready 和外部认可分别记录。不因后续成功覆盖误拒、漏检、不可用或未完成实例。
- optional comparison 可移除。污染诊断移除记为 remediation by removal，合规诊断因误拒而放弃记为 relinquished；都不是实际修复 validation／test 关系，也不是有依据的反驳。
- retained 分支公开条件式执行接口，通过固定 harness 保存真实输出，并在隔离评分进程验证实际数据依赖。ID 自述和 `fixed` 声明不能代替实现证据；客观失败不能被文字评分抵销。
- 反馈机会逐 outcome／finding 绑定；真缺陷、无据意见、不可用可以分别观测。没有对应机会时记 `not_observed`，自发纠正与反馈修复分开，未完成独立评分记 `not_scored`。
- 自然 reviewer 与确定性 local fixture 分开。本轮不新增会伪装成自然判断的注入接口；未来真实受控反馈实验需要独立冻结。
- 候选盲评先于 reviewer／处理轨迹揭示；两名独立注释者和必要裁决绑定材料及 rubric。oracle 留在可信评分侧，控制器不代替 worker 决定修复，也不主动 root challenge。
- 保留同协议的脚本至真实调用移交、一次性 bootstrap 及失败分母、全部历史反馈与无 bundle 归档；继承原 deadline、单次操作限制、隔离、取消、未知执行审计和完整计量，不增加累计请求／实验／费用预算。

## 实施审查重点

1. `provider.ts` 目前因为 script hook 强制 Chat Completions，`instance.ts` 也按同一条件选择 SDK。新 followup 必须保持冻结上游协议，分别验证 Chat Completions 与 Responses；旧 probe 的行为按旧语义保留。
2. bootstrap attempted 必须在响应发送前持久记录并参与恢复判定，不能仅用内存计数或“当前尚无 plan”作为再脚本化条件。未产生指定计划时，不把另一份动态计划套入原 P1 标签。
3. `controller.ts` 的 probe 首评停止、final prerequisite decline 和 legacy root challenge 不可泄漏到 v2 followup。首次 ready 的候选和首次 reviewer 的身份各自封存；暂态 feedback 不得触发全局取消。
4. `evaluate.ts` 目前只有一个候选、一个 raw 和一份真值。新轨迹必须保持初始 review 材料、最终候选材料及处理轨迹的不同身份，读取归档快照，不能从可变工作目录补齐。
5. v2 不沿用 legacy 的 invalid review／非 accept 且 gate open 即 mechanism failure 规则。旧 `score.ts`、qualification 和前三轮真值应保持原语义，新增指标使用独立版本。
6. 实际 selected threshold 与 test contrast 必须来自隔离执行；至少包含不同 validation 唯一最优、test 变化不影响选择、伪造 IDs、同 test 选参、虚假 fixed 和合法移除的反例。未触发反馈处理机会不能通过 fixture 的标准答案自动补足。

本次审查没有启动真实模型调用、第四轮校准或 66 例资格评测。
