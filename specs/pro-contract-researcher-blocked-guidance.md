# 受保护输入失败指引与阻塞摘要补改

2026-09-22。承接[第八轮交付诊断](pro-contract-researcher-v8-delivery-diagnosis.md)，依据用户批准，只修正失败信息和下一步指引。没有新研究协议、自动恢复、路径推理、确认动作或模型必填字段；不启动新真实校准、派生评分、66 例或外部认可。

## 修改前身份

完整工作树基线在 `/workspace/researcher-blocked-guidance-20260922T003944Z/baseline`，6,653 文件。manifest SHA-256 为 `163a3aeb843fe9276b2a18e0af1f557a08940d105f41833632f15b290ca06f4d`，与上轮最终基线加增量逐项一致，没有未知差异。已有未提交工作保留，HEAD 不是本轮比较基线。

## 有限判断与实现

本补改中的“没有直接恢复路径”只描述既有 `protectedBefore` 校验失败分支：宿主撤销计划准入并回到 `exploration`，该阶段开放的能力仍是 read／observe／control。工作区写入未获准，新计划不能移除或重绑保护项。没有搜索其他行动路径，也没有判断未来外部干预后能否恢复。

生产修改仅在 `packages/sdk-next/src/research/index.ts`：

1. v3 失败提示从实际 verification replay 的 `protectedBefore` 中列出发生变化或缺失的文件。使用专门的只读失败提示，避免继承“提交下一版计划就能恢复”的指引。说明新计划不能恢复原始字节，当前已有工具没有直接还原动作；可在现有权限内检查文件／视图，无法继续时使用已有 `contract_report_blocked`。不新增停止条件，工具权限和状态转换原样保留。
2. v3 进入原有“worker 已停止且 admission 关闭”分支时，读取 Core 已接受的 `blocked` 记录。仅在关闭 admission 的原因与报告一致、当前 Contract revision／绑定 context 一致、报告时间不早于该 Session 创建时，摘要保留原始原因，并明确标注为 Researcher 的解释。它不自动成为已证实根因、正确候选或任务完成。
3. 缺少匹配报告时仍保留原通用失败摘要；lease 过期等原有独立分支不变。终态继续为 `unavailable`，未提交不会被补造成提交。v1/v2 及 required 分支的旧提示／摘要保持原样。

Core 已经保存报告并把原因传到 admission；本次不修改 Core、Schema、Constitution 或公开 API。最终摘要只是利用已有的可信记录，不要求模型再次证明或重填阻塞说明。

## 验收与回归

扩展现有真实宿主／确定性 HTTP fixture，覆盖受保护数据被改写与缺失两例：

- 真实捕获与验证后进入只读探索；提示列出 `data.txt` 及实际 changed／missing 状态，不再要求提交下一版计划来解除约束。
- 原 protected 列表与原 budget 不变；只读阶段写入不能落盘，删除保护项、实验和候选提交仍被拒。
- 通过 canonical `contract_report_blocked` 提交原因，Core 接受后，research 终态摘要保留具体原文及其来源，bundle 仍不存在。
- 使用测试夹具调用已有的显式 host recovery，再以其他原因关闭新 Session；旧的 blocked 记录仍存在，但不会被当作本次停止原因。这个测试不增加产品恢复机制，也不恢复第八轮历史实例。

共 18 项回归通过：默认 advisory 宿主套件 10 项（包含先单独通过的两例新回归）、调用身份／权限／deadline SDK 回归 6 项、历史 planned 路径的保护与 deadline 回归 2 项。sdk-next／opencode 包类型检查及格式检查通过；逐项结果和完整日志见本次证据目录的 `validation-results.json`。这些测试使用临时任务与固定响应，只验证机制，不构成真实模型处理能力或研究质量评分。

## 保留的限制

本次修正让信息和当前能力一致，不能证明模型一定更顺畅地完成研究，也不解决 R3 重复实验的因果不确定性。发生保护字节损坏后，既有授权下可能仍然不能继续；如实报告阻塞是有效的收尾，不等于任务完成。

评分引用、未提交终态封存、失败验证导出和实时计量问题继续单列，未成为本补改前置门槛。第八轮冻结内容、结果、独立评分缺口及原 deadline 不变；不修改历史失败报告来套用新摘要。历史保全核验范围见 `preservation-check.json`，增量及副本见 `source-delta.json` 和 `final-files`。
