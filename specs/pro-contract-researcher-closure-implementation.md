# 收尾呈现与 IPC 去重：实施记录

2026-09-21。完成专项设计、独立设计审查、宿主／运行器改动、确定性回归及两项独立代码审查。本轮没有启动第七轮或 66 例，没有真实 Researcher／reviewer provider 调用，没有改历史评分或旧实验材料。证据根目录：`/workspace/researcher-closure-20260921T054035Z`。

## 基线与实现

修改前当前 6,619 项文件、链接、mode 与第六轮 final-source 完全一致，完整保存于 `baseline-source/`，manifest SHA-256 `be007dc8204ecbb6aeecdeeb0b59e5d360a6d71d683eb679708f604f91738817`。保存了 HEAD、分支、完整 dirty 状态及 patch；没有还原此前实现。增量限 SDK research 宿主、research-eval、相关测试与文档，Core 未改。

`manifest.feedbackGuidance:"closure:1"` 显式启用新提示，仅接受 v2 repair-lifecycle:1；没有该字段仍按旧提示执行。发行指纹、精确重试、setup/deployment/frozen/scenarios、attempt、成功／失败记录及第二阶段材料都保留该版本；混用拒绝。新字段不改变评分真值、修复声明协议或任务授权。新交付视图包含完整历史 outcome/response/raw（含空 finding／response）、原计划、逐项意见和声明链。`outcomeHash + findingID` 是意见身份，`current` 只表示声明适用于当前身份，不表示研究修复成立。

有计划的任务先核对实际代码／报告、方法、数据和诊断状态；方法变化先修订计划，再按新版本实验及验证。final-only 按原约定核对，不要求不存在的计划。交付先读证据、逐项检查历史意图、追加有据完成／纠正或披露 pending，最后 review_response 提交并停止。未决项无需变成 fixed 才能提交；已有要求不冒充新增修复。最终回应摘要进入 feedback bundle，不覆盖较早的 ready 摘要。workspace read 是当下观察，归档验证和提交重捕获仍核验候选漂移。

`infrastructure.journal:"cas:1"` 显式选择分块内容寻址日志；缺省仍使用 inline。64 KiB JSON UTF-8 块保留完整 payload/result，每个描述符绑定 journal、连接、序号、字段、请求、动作与 Contract。重启沿用文件身份和连续序号，每个连接独立保存 cleanup。损坏引用、空事件、跨身份引用及不完整尾行拒绝。写入失败关闭准入并实际执行原有有界清理；存储错误不等于操作成功。同步写入后再检查绝对 operation／实例 deadline，迟到记录不能借 timer 延迟获得成功。

归档先固定日志，再保存块与逐连接清理文件，用归档 loader 检查完整闭包。缺失／损坏保留可得原始材料和 unknown；不把 live 读取当作封存证明。只有全部已观察连接各自确认清理且最新记录匹配才复制数据库，旧成功不能证明新宿主已结束。CAS 私有回应中的已有候选继续阻止无候选降级。没有改 history API、轮询频率或最早候选选择。

## 实际验证

所有测试均为本地确定性 fixture，不是模型能力测量。日志在 `validation/`；早期失败和后续修正记录均保留。

| 已完成验证 | 结果与边界 |
| --- | --- |
| SDK feedback／planning | 29 pass；独立 reviewer 另行复跑同 29 项通过，不重复加总 |
| 完整反馈宿主过程首轮 | 28 pass、314 assertions；包含权限、原期限、核心证据损坏、历史/required/advisory 行为 |
| 修正后独立过程复跑 | 4 pass、98 assertions：计划型 legacy/closure、final-only legacy/closure，覆盖合法 opt-in 冲突、省略字段精确重试及非法组合 |
| 空历史回应新增过程 | 1 pass、10 assertions：unavailable → responses:[] repair → 新 closeout，完整原回应和 raw 保留，无虚构完成声明 |
| 最终运行器／日志联调 | 48 pass、378 assertions，7 个文件；`runner-tests-2.log`，111.04 秒 |
| 最终两包类型检查 | `packages/sdk-next` 和 `packages/opencode` 的 `bun typecheck` 均退出 0 |

运行器联调包含实际修订计划、执行、实验、完成声明、候选提交及带 guidance 的评分材料；脚本预设动作只验证接线，不计作 Researcher 自主能力。历史未选 guidance 的场景、真值与盲评封存保持；无 retained 发行失败保留分母和 unknown，不编造候选评分。CAS 覆盖完整 JSON／Unicode 往返、历史增长、离线恢复、跨身份和损坏拒绝、已有候选保护、同实例重启、第二次清理未知、请求／响应阶段存储失败与清理文件失败。FIFO 由独立辅助进程按时释放，实际阻塞同步响应写入越过操作期限，验证不交付成功；没有生产测试 hook。

重复递增历史样本的原序列化内容 21,078,547 字节，CAS 日志加 72 个对象合计 2,112,876 字节，约减少 90%。所有响应完整恢复。此数只描述确定性样本；未重新编码第六轮约 5 GB 日志，不宣称真实批次时延降低，也不能据此倒推第五轮卡点。

初轮验证暴露过：归档 glob 漏对象；新测试的 raw/JSON loader 和 TypeScript 断言错误；不存在实例目录的 glob 错误；旧最小 fixture 没有 manifest；CAS 终态测试默认 5 秒不足。对应修正后最终 48 项及两包 typecheck 通过。没有删除坏例或修改期望真值。完整宿主过程、修正后子集及新增过程分开记录，不声称最终全部过程在同一轮跑完。

## 独立审查与保全

[设计审查](pro-contract-researcher-closure-design-review.md)关闭存储失败清理、恢复身份和逐连接清理三项边界。[独立代码审查](pro-contract-researcher-closure-code-review.md)分别核对 SDK 与评测基础设施；保留所有原始发现和关闭依据，最终无遗留阻断。最终审查 hash 与工作树重新比对；`final-delta.json`、`final-source/manifest.json` 和 `final-summary.json` 绑定本次增量及验证材料。

历史 v1 和显式 required 阶段仍保留独立 accept 才能实验／提交的保证；该保证不适用于 v2 advisory 默认任务。Principal 最终认可与候选提交仍分离，普通建议、原已满足要求、实际修复、合法删除、有据反驳和完整处理链不能互相替代。

第六轮八项未结意图及 18 项 null 原样保留；null 多数为缺少对应机会，不等于产品缺陷数。本轮未改评分测量真值，not_applicable／insufficient_evidence 的进一步拆分留给显式新测量版本。实时用量竞态与第五轮发行卡点仍未解决；后续继续分别报告原账本、来源化补记和未知项，派生已知数不是完整计量。独立审查 agent 用量未由接口返回，不填零。

下一步是单独冻结第七轮的小规模配置，显式选择 closure:1／cas:1、同三例与 Luna / low，并冻结双评／裁决安排和机会解释。真实校准才能检验模型是否实际采用新收尾顺序；本轮未冻结或启动该批次。每实例原六小时 deadline、无累计次数／费用上限和全部历史材料继续保留，66 例继续暂缓。
