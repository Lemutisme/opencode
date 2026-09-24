# 发行边界与无候选终态：实施记录

本轮限定为第五轮之后的两项基础设施修正。修改前工作树完整基线位于 `/workspace/researcher-infra-20260921T035216Z/baseline`，6,603 项，与第五轮最终快照逐项一致。HEAD 不是未提交成果的完整基线；原 Core、Schema、Server 等改动均保留。本轮变动为 25 个源码／测试文件及六份当前／新增文档，不启动真实模型、第六轮或 66 例评测。

## 实现

新增显式 `infrastructure:{version:1,startup,operation,cleanup}`，仅与 `repair-lifecycle-v1` 组合，随配置、冻结测量、运行结果和失败证据绑定。省略字段保留第五轮旧门。新增 `candidate-or-terminal:1` 要求固定三分母中的实际候选全部双人评分／必要裁决封存，其他实例全部封存失败或缺失证据，然后才允许任何反馈展示及最终评分。无候选不编造候选质量、first/second 判断或外部认可。正常 `not_submitted` 的反馈评分使用带 terminal 引用的 indeterminate phaseOne；没有发生的机会仍为 not_observed。

SDK research 发行入口增加可选可信 observer，记录 decode、准备、准备锁、snapshot service/capture/save、materialize 和 contract commit 的 start/exit，以及真实失败或 interruption。日志绑定 request、Contract、宿主 PID 和操作期限。没有改变研究 manifest 或向 Core 引入研究决策。

新宿主客户端分别约束启动、单次 IPC 等待及清理。启动与操作不越过实例原 deadline；等待到期关闭该连接的新命令准入并请求 supervisor 清理，不把等待结束解释为工作停止。迟到响应保留完整结果和请求身份，但不把超时反记为成功。重复 stop 复用第一次清理结果和期限。宿主进程分为 gone/replaced/alive/unknown；清理确认还要求 supervisor 成功回收进程树。启动抛错也保全清理证据。

新实例在任何发行准备前写 attempt 坐标，失败发生在 run 创建前也能归档。清理确认后复制 DB/WAL/SHM，再只读查询副本；复制前后检查已有及原本缺失的数据库文件。清理未知时不读取活动数据库认证终态，只保存有时间边界的日志和 unknown。原账本、中断状态与实时用量竞态均未改；发行前缺少操作快照继续明确不完整。

`seal-terminal` 绑定 cohort、事件链、runtime、策略、实例、原始坐标、原结果、证据截止及文件清单。实际候选、已归档正式运行及可信 get/history 响应中的候选不能因后续收集或清理失败被降级。私有 IPC 请求与回应按 ID/action/Contract 配对；其他原始评审 JSON 只作为原文，不因形状像 run 就成为候选证据。封存后新候选或证据变化使旧封存失效。

## 独立审查

独立 agent `/root/infra_review` 完成设计审查及代码增量审查。设计 D1/D2 澄清清理证据和终态截止语义后关闭。代码首轮 R1 发现失败路径可能漏掉 monitor 已见候选；R2 发现报告覆盖 terminal 并跳过部分身份校验，均有原始记录。修复保留可信 IPC 结果、原 wrapper.cleanup 内嵌候选；报告保留真实封存并校验 attempt、runtime、策略、原 deadline、transport/audit。后续复核还收窄了候选证据来源，防止把模型原文提升为宿主事实。

最终审查与精确源码身份见本轮独立审查记录及证据目录。收尾还发现并修正评分者材料仍显示旧 finalQuality 的元数据不一致：仅新策略附加与冻结 scenarios 完全相同的 infrastructure／candidate-or-terminal:1；旧入口说明及所有 rubric／真值不变。新候选、not_submitted 和旧入口三条路径最终定向复验 3/3、109 个断言通过，材料与 launch.identities 的冻结测量深比较相同；不再无关地扩大测试。审查不替代研究语义判断，也不构成真实新批次的冻结。

## 验证与失败记录

日志位于 `/workspace/researcher-infra-20260921T035216Z/validation`。全部测试从包目录执行；无真实上游模型调用。完整流程使用本地脚本 HTTP 响应驱动真实 research 宿主、正式实验和候选：两例完成候选双评／裁决，第三例实际发行前失败，终态封存后两例反馈分别评分，报告保留三分母和无候选 not_scored。此处评分者为 fixture 标签，验证接线，不冒充独立模型能力评分。

| 范围                                       | 结果                |
| ------------------------------------------ | ------------------- |
| 新策略冻结／终态、无候选评分、跨实例与旧门 | 4/4                 |
| 发行阶段及真实子进程故障                   | 9/9（最终隔离复跑） |
| 两候选＋一发行前失败的完整封存／评分       | 1/1                 |
| 旧生命周期完整实例                         | 11/11               |
| 第四轮 response:1 完整实例                 | 8/8                 |
| 生命周期版本与全队列盲评门                 | 3/3                 |
| 用量补记回归                               | 29/29               |
| 既有冻结／启动及默认入口                   | 6/6                 |
| SDK schema、store、planning                | 18/18               |
| opencode、sdk-next 类型检查                | 通过                |

以上为 89 项不重复测试，独立复跑及重复子集不累加。19 项完整实例回归在最终元数据小增量之前完成；增量后定向重验上述三条路径及 opencode 类型检查。该增量不改变 rubric、研究控制或旧协议执行。宿主 9/9 覆盖实际等待到期后仍执行、迟到原响应、清理未确认、重复 stop 不重置期限、取消、原 deadline、启动失败及进程被杀后只留下阶段 start。终态 4 项中的正常 not_submitted 是明确标注的手写评分 fixture，不冒充真实自主研究；完整两候选／发行前失败测试走实际生产路径。

首次测试与命令失败全部保留：测试标注把 validDefect 与 unsupportedObjection 同时填 true 被评分器拒绝，随后按既有 fixture 事实修正；默认五秒不足以完成多次源码／封存核验，扩大测试时限后重跑；冻结校验与执行方测试文件编辑重叠，正确拒绝 Installed source differs，随后停写并重跑；一次 host late 用例在两秒启动期限处超时；同字节源码的独立执行及执行方隔离复跑均为 9/9，原失败保留，不能由并发时间差断言底层 I/O 根因。测试时限不改变真实六小时 deadline 或生产运行预算。早期类型与格式命令失败亦保留，不将其算为最终通过。收尾测量断言因冻结函数返回宽联合而产生两项 TypeScript matcher 类型错误，最终仅用擦除后的 unknown 类型参数修复，深比较及运行时断言未变；opencode-types-complete.log 确认最终检查通过。

## 保留的限制与下一步

第五轮仍是未完成校准：两个正确候选的独立证据、第三例发行超时与原清理未确认、整批反馈未评分全部保持。新增阶段日志提高未来故障可定位性，不能据此断言第五轮具体卡点。P1 坏实际合规删除但无完成声明的原因仍待独立观察；删除与实现修复继续分开。实时用量竞态仍未修复，原账本、独立补记和未知项分列，派生已知总量不是完整计量。

旧的“评审批准才能实验／交付”保证仍适用于历史 v1 和显式 required 阶段；advisory 的 unresolved 不自动成为阻断。权限、身份、版本、原 deadline 和核心证据机械门槛继续严格。每实例六小时墙钟，无新增累计请求／实验／费用上限，单操作边界及网络凭据隔离保持。

本轮通过后可另行决定是否冻结少量第六轮开发校准；必须显式冻结新基础设施策略及双评／裁决安排。三例及新旧场景变化不支持整体可靠性或跨轮模型提升结论。没有改写旧真值、重评分第五轮、补跑目标事件或启动 66 例。

## 最终保全入口

完整源码、逐文件差异和审查身份分别见证据目录的 `final-source/manifest.json`、`final-delta.json`、`independent/reviewed-inventory-final.json` 和 `final-integrity.json`。`final-identity.json` 记录 runtime 与全量快照 hash。原记录与早期失败日志均保留；没有提交、回退或清理原工作树。

`history-integrity.json` 核验第五轮 11,931 个文件、第四轮 7,969 个文件及前三轮冻结源码／对象，全部零差异。历史根目录只读；新增报告不写回历史批次。
