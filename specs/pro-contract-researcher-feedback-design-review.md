# Researcher 反馈策略 v2：独立设计审查

2026-09-20。审查者为独立 agent `/root/design_review`。只审查设计和现有实现，不参与本轮产品实现；本文是本次唯一编辑。依据用户本轮最新要求、`AGENTS.md`、总设计、handoff、第三轮校准记录和 `packages/sdk-next/src/research` 当前源码，评估 [专项设计](pro-contract-researcher-feedback.md)。

最终结论：**设计通过，可进入实施**。三项设计澄清均已写入并复核，无剩余设计阻断。签署绑定专项设计 SHA-256 `d7ec1d0d1d015db5d0d3dfaeaebe5c782a0056e63d865353c91e6c47f9ce91ae`。这是设计结论，不代表实现、测试、实际模型质量或外部 Principal 认可已通过。

收尾格式化后再次读取专项设计，语义未变；当前 SHA-256 为 `88d2d03d2a59f92212c3299ae90552040eea4d51e401a9f24d9a4e7eb7c10194`。原审查绑定 hash 作为历史保留。

## 初评发现与关闭依据

| 编号 | 初评问题与影响                                                                                                                                                                                              | 修订及复核                                                                                                                                                                                                                                                                         |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1   | 当前 `planning.ts` 以 reviewer `scope` 和 `accept` 联合决定准入。新设计仅写“宿主检查 scope”时，可能保留 `unclear` 或 `needs_principal_revision` 的隐性模型否决，使 advisory 在措辞误判时仍永久停顿。        | 专项设计明确 advisory 下 reviewer 的 scope 同样属于待回应意见；硬门槛来自冻结约定、显式越权请求及可验证保护项。Researcher 自己请求越权的计划仍不能执行。关闭。                                                                                                                     |
| D2   | 当前捕获和解析失败通过异常进入 `unavailable`，没有独立完整报告。若新实现合成 `Review{verdict:unavailable}`，或把所有证据读取异常吞掉，会混淆未取得意见与损坏核心证据。                                      | 新增独立 `ReviewOutcome`，分别记录 availability、真实可选 review、complete/partial/absent、可取得原始材料、job 实际状态及失败／解析原因。未生成和已归档后损坏明确区分；核心身份与证据仍严格拒绝。关闭。                                                                            |
| D3   | 新 feedback／submission 阶段引入新的执行窗口；若仅按 reportHash 保存回应，而没有当前执行身份、事务 fencing 和清理后候选复核，旧 worker 可回应新报告或将旧审查提交为新候选。非 planning profile 也可能遗漏。 | 新段明确同事务检查 execution/context、阶段、reportHash/planHash/subjectHash；admission receipt 绑定 policy/plan/outcome/response/context；submit 等待 drain／工具清理后重新 capture；非 planning 的 v2 最终反馈同样适用；继承 CAS/generation、取消、原 deadline 和恢复规则。关闭。 |

## 设计满足的边界

- 运行准入、reviewer 结论、候选提交和外部 exact 认可分别表达。`ready` 只表示候选可供外部处理，不能改名成研究成功；Principal 决策策略不进入本轮实现。
- 默认 advisory 允许原约定内修复、反驳和保留未决项；原始意见、逐项回应、旧版本历史及未决风险进入 bundle。Researcher 声称 `fixed` 不等同于宿主验证已经修复。
- v2 将 Core handoff 延迟到最终反馈完成并再次确认候选之后，避免普通 reviewer finding 必须外部 challenge 才能修复。显式 required 阶段保留有效 accept 门槛；缺少策略的既有任务仍解释为旧语义。
- 新发行默认显式归一化为 v2；既有任务按已发行输入做 exact retry；显式 `{version:1}` 保留历史协议的发行入口。不得用新默认回写旧 run、冻结配置或评分真值。
- reviewer 错误可成为诚实的 unavailable outcome，并按策略继续反馈或提交；不能伪造 review，不能自动重审至 accept，不能越过仍存活的未知执行或损坏的核心证据。
- 结构化引用通过每个 job 的不可变映射解析为完整 hash；job/context/plan/candidate/materials 身份均参与验证。未知、歧义、跨 job、跨候选和过期引用拒绝，raw、映射、解析结果共同保留；第三轮错误 hash 不补造。
- P1 严重级别只保留意见和升级记录，不新增“模型标 P1 就暂停全部工作”的规则；与校准用例 P1 的名称明确区分。

## 实施与代码审查必查项

现有 `planning.ts`、`plan-evidence.ts`、`adapters.ts` 和最终 bundle 发布都直接依赖 `plan.approved`、`report.review.verdict === "accept"` 或 context 版本链。本轮必须逐处区分 v1／required 与 advisory，不能只改 prompt 或最外层 gate。

1. 宿主 admission receipt 必须在重新使用和最终认可时验真，不能把旧 `approvalHash` 机械替换为 outcome hash 后省略 response、policy 或 context 绑定。候选变化后的正式实验身份仍需重新成立。
2. outcome 的 schema、捕获状态和有效 review 应保持一致；重复 finding ID、未知 response ID、跨报告回应、过期 execution、未回应意见及损坏归档均需实际反例。required 的 unavailable 或 changes_requested 只能进入修复／明确恢复路径，不能提交。
3. structured evidence 映射必须与创建 job 时的输入一致，并在归档／认可时重放解析；仅检查调用方提供的 `jobID` 字符串不够。映射内容或 raw 被改动应失败。
4. 新 feedback 与 submission 阶段必须经过现有权限、取消、deadline、cleanup 和恢复边界。不能为了继续 advisory 研究而吞掉一般异常、重启不明执行或重置期限／计量。
5. 最终包应保留历史及当前反馈；修复动作不能先删除旧意见再生成新候选。最终 submission 和 exact recognition 都须继续核查核心 verification、受保护输入和实验材料。
6. 验证应分别覆盖计划／最终评审、planning／final-only、advisory／required／legacy，以及 reviewer malformed、job 无最终答复、修复后重新实验和 stale candidate。P1 回归应实际比较 validation/test 的选参与评估关系，并覆盖措辞变体；确定性脚本只能证明流程，不能证明模型判断质量。

本轮应保持每实例原六小时墙钟、单次操作限制、完整计量及历史工件，不引入累计请求／实验／费用上限。本次审查没有调用真实模型，没有启动第四轮校准或 66 例资格评测。
