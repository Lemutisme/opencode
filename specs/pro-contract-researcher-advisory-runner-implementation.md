# Advisory v3 批次接线：实施与联调记录

2026-09-21。依据[限定设计](pro-contract-researcher-advisory-runner.md)，完成专用真实批次入口与无真实模型联调，未扩展默认宿主协议。独立复核见[审查记录](pro-contract-researcher-advisory-runner-review.md)。本轮未运行真实模型、第八轮、66 例、历史重评分或外部认可。

## 基线与保全

工作树 `/workspace/opencode`、分支 `jerry/dev`、HEAD `78bec19263814444ab008c58d54835b59b4a1c6b`。6,641 项与上一已审最终快照完全一致，manifest SHA-256 为 `0c431f15bdfe890b9d16cb0e58f9254c071014c7894dcdbefb010db9ed92f7ef`。修改前完整副本、状态与 patch，以及各轮验证日志保存在 `/workspace/researcher-advisory-runner-20260921T201422Z`。原树包含大量既有未提交成果，未重置或用 HEAD 取代本轮基线。

修改限于 research-eval 的新入口／适配器和必要兼容接线。Core、sdk-next 宿主协议及 Constitution 没有修改；所有历史专项正文、冻结配置、评分和结果保留。第七轮依然是未完成校准，不因新入口而重标。

## 实际入口

`advisory-launch.ts` 提供 `freeze`、`check`、`run`；`model` 和 `local-fixture` 使用相同发行、隔离 host、监控、归档、评分和清理路径。旧 `launch.ts` 及历史评分保持原版本；旧评分拒绝 v3 输入。配置要求显式 `advisory-batch:1`／`advisory-v3`，完整模型参数与凭据来源、三名评分角色、CAS infrastructure 和各项单次期限。未来可从 `packages/opencode` 使用：

```sh
bun script/research-eval/advisory-launch.ts freeze SETUP.json NEW_FREEZE
bun script/research-eval/advisory-launch.ts check NEW_FREEZE/deployment.json
bun script/research-eval/advisory-launch.ts run NEW_FREEZE/deployment.json NEW_BATCH
```

冻结包括完整工作树、runtime、场景、rubric、角色模型及参数。运行前核对当前源码与完整快照；每次评分前后检查 runtime，读取失败同样拒绝新评分并保留共享停止事件。目录不复用，评分没有选择性重试。各次实际开始保留原六小时 deadline；未开始行不补造 agreement 或时间坐标。

`advisory-development:1` 保留旧三例的数据与科学真值，移除必须回应每条 finding 的任务要求，使用 v3 的 research_view/read_evidence。原 P1 计划作为公开建议交给真实 Researcher；生产路径不再脚本提交计划，也不代写修复／回应。第一版实际计划可能已被 Researcher 改正，不能把没出现的 reviewer 误判或修复机会算作能力成功。

## 归档、终态与故障范围

候选从不可变 tar 恢复冻结文件 allowlist；`result.json` 从正式验证证据恢复，不要求它存在于源码快照。原意见、真实 unavailable、未回应项和 optional records 进入反馈材料。没有 response/completion 不阻断候选，也不证明研究错误或修复成功。

观察适配器重建冻结 task，核对 attempt→admission→result/failure→audit 的实例、配置、原期限，并检查所有被引用的观察 blobs。可信清理、穷尽数据库观察及无候选共同支持 absent；缺表、缺材料、跨实例或清理未知保留 unknown。实际进程已停止和原操作用量仍未知可以同时成立。

确认局部故障允许后例按原机会开始；未知或共享安全问题停止后续研究。独立评分只依赖本例封存，不因另一例 failed/not_scored 永远等待。admission 文件之前的启动失败仍保守 shared/unknown；本片没有证明所有启动故障均可隔离，也未修复历史发行卡点。

## 独立评分与计量

每例候选 A/B/裁决及反馈 A/B/裁决有六个不同 execution/context。每个都是一次全新的、无工具、无 conversation 的真实评分请求；传输适配器绑定身份，模型只返回 items。候选 A/B 只看本例候选材料与 rubric，不见 reviewer、轨迹和对方判断；裁决只在本阶段双评后收到两份判断。封存本例候选后，再向新的反馈上下文揭盲。无候选实例没有虚构的候选质量评分。

研究结果、reviewer／Researcher 处理、审计完整性、基础设施分别呈现。未采纳、零回应和没有 completion 本身不判失败；实际修复、删除、反驳、无依据声明需分别判断。not_observed、not_applicable、insufficient_evidence 和 not_scored 不合并。fixture 的脚本评分仅证明接线，不计模型能力成绩。

完整评分请求、响应、身份、时间与 usage 以 CAS 保留，报告单列逐次评分计量索引。原研究账本、独立补记和未知项分开；本片没有自动补记、没有称已知派生总数为完整计量。实时竞态继续未解决。超单次 16 MiB 或上下文不足的评分如实不可用，不用截断重要材料制造评分成功。

## 验证

- 同一实际入口：确认局部发行失败后两例继续；真实隔离实验、零回应候选提交、归档恢复、候选双评／裁决与逐例反馈评分。
- 一例候选评分者不可用：该例保留未封存与 not_scored，另外完整实例继续评分；不反复请求或单人代双评。
- 研究中与评分中显式取消：停止网络和宿主进程，确认清理，后续实例保持 not_started 和完整分母。
- v3 与旧评分版本边界、原 deadline、归档归属／损坏、runtime 漂移／读取失败、原 usage 可用性另有定向检查。

完整入口初次全套为 5 pass、240 assertions，日志 `entry-full-first.log`。最终增强入口加边界检查为 5 pass、145 assertions（其中三项新边界测试，另三项已通过的完整入口场景未重复），日志 `entry-final.log`；8 项不同的新测试最终均通过。opencode `bun typecheck` 通过，日志 `typecheck-final.log`。独立复跑边界测试 3 pass、16 assertions。兼容组除 host-control 外 30 项通过，单独复跑 host-control 23 项通过，共 53 项不同的兼容／测量检查，未重复记分。中间错误完整保留：最初将生成 artifact 误作源码必备文件；fixture 用共同 brief 前缀误认实例；独立边界 fixture 的临时包名 `test` 被真实 runtime inventory 排除，后改为实际纳入的 `example`。这些修正没有改变科学评分真值。

兼容组合运行中短期限 host-control 测试有 12 项超时，原日志 `compatibility.log` 保留。相同源码和期限单独运行后 23 pass、136 assertions，日志 `host-control-isolated.log`；没有增加这些测试的期限。该现象不能倒推第五轮故障原因。

最终逐文件差异、审查 hash、Markdown 检查、第七轮完整保全及最终源码快照见 `final-validation.json`、`final-delta.json`、`historical-preservation.json` 与 `final-source`。

## 下一步的条件与比较限制

这条入口具备冻结小规模真实批次的机制基础；真实模型是否正确利用独立意见仍未得到本轮证据。未来应另行冻结沿用 Luna / low 的实际配置、评分者／裁决安排与本版场景，再作小规模校准。66 例继续暂缓。

新场景让 Researcher 自行提交计划；评分读取实际归档与正式验证，没有重跑旧独立 diagnostic interventions。协议、提示、计划产生方式和评分证据都有变化，不能把新旧差异归因于模型提升或声称检测能力等价。长历史分页、实时计量竞态和历史发行卡点仍单列；无对应反馈机会只记 not_observed。
