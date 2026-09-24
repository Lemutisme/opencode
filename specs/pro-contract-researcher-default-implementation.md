# Advisory v3 默认流程：实施与验收记录

2026-09-21。依据[专项设计](pro-contract-researcher-default-flow.md)与用户提供的独立 review，先落实可信工具调用身份，再连通最短默认路径；S3 保持独立测量工作。独立代码审查见[单独记录](pro-contract-researcher-default-review.md)。本轮没有真实 provider 调用、校准、66 例、外部研究认可或历史重评分。

## 1. 基线与职责边界

工作树为 `/workspace/opencode`、分支 `jerry/dev`、HEAD `78bec19263814444ab008c58d54835b59b4a1c6b`。原树含大量既有未提交成果，不能以 HEAD diff 当作本轮变更。修改前 6,630 项与上一设计阶段 `final-source` 完全一致，manifest SHA-256 为 `8fa43733ddb8ca27266f9b323e30920d501073f6a813a5cfc6e9a924002d0273`。完整副本、patch、状态、日志和最终保全记录位于 `/workspace/researcher-default-implementation-20260921T184951Z`。

Constitution 没有修改。Core 只为 `ProContractDelivery` 请求增加可选的通用 `call:{messageID,callID}`，由 canonical tool 从 `Tool.Context` 注入；原授权检查先执行。没有修改 reducer、认可语义或增加研究决策。Principal 仍在外部负责方向、授权和最终认可。

## 2. S1/S2 的最终行为

新发行未选旧协议时保存 `reviewPolicy:{version:3,plan:"advisory",delivery:"advisory"}`。显式 v1、v2、旧 feedback 字段和已发行精确重试保留原选择；v3 不接受旧反馈字段或 required 混搭。required/mixed 继续显式使用 v2。没有原地迁移或历史字段回填。

`research_view` 提供短 view、研究内容、合法动作、原 finding 选择器、历史计划版本及当前材料适用性。模型不再填写 manifestHash、plan 递增版本或 review hash；宿主据真实 execution、view 和不可变映射绑定它们。`inspect_inputs` 提供受保护输入选择器，修订不能删除或改绑已受保护路径。view 与材料版本绑定，审计追加不使未变材料失效；同一 finding 的追加仍核对前驱。

调用 receipt 使用 Contract、Session、assistant message ID 和 tool call ID；完整 payload、kind 和 execution 另外比较。相同内容的新调用不被当成重试。精确重试在事务内重新授权后返回原 receipt；同身份不同内容保存冲突。关闭 admission 后旧上下文仍被拒绝，不为读取 receipt 重开权限。协议错误保存原请求和可恢复错误，不改变 run；修正使用新调用、原权限和原 deadline。

工作区输入观察与 evidence read 在写事务外进行，结束后重核授权和 view；状态变更与成功／拒绝 receipt 原子保存。慢文件读取不能持有 SQLite writer 阻塞续租和取消。长历史当前为按需完整只读视图，尚无分页，不能宣称解决规模问题。

计划检查点结束后，advisory 准入 receipt 不含 responseHash，自动恢复执行。`prepare_candidate` 请求真实捕获／验证／独立 review；`resume_work` 与 `submit_candidate` 是独立动作。零回应、部分回应、未提供简述、没有意图或 completion 不单独阻断。P1 标签没有额外否决权。已记录的简述可在提交时沿用；交付同时保留逐项 unaddressed。

v3 bundle 保存全部原意见／raw、可用性、未回应项、optional records、当前适用性、独立 submission、原命令及冲突命令。completion 始终是待独立核验的声明。实际修复可由代码和实验成立，同时标声明 absent；真实声明不由宿主语义批准。`ready` 是候选，仍需外部 exact attestation；旧 challenge 责任与权限边界保留。

## 3. S3 的实现范围与未接线范围

新增 `advisory-archive.ts`、`advisory-measurement.ts`、`instance-scoring.ts`，采用 `advisory-measurement:1`／`instance-isolated:1`。`archive.collect` 追加收集 v3 可选记录及独立 submission，原分支保持原义。

导出器从内容寻址根恢复 run/history、唯一候选映射及冻结文件 allowlist；校验 inputHash、archive bytes、verification 和完整 evidence。只支持 UTF8 regular file，拒绝 symlink、目录、重复条目、二进制和超单次读取限制；空文件有效。候选盲评包含原任务、真实文件、计划和验证。反馈包另外保留最终候选、历史快照、会话、jobs、意见、回应及声明；全新反馈上下文能独立检查前后材料。source provenance 另行持久化，不从当前工作树重建旧候选。

测量按研究结果、reviewer／Researcher 处理、审计完整性、基础设施四轴报告；细项保留 scored、not_observed、not_applicable、insufficient_evidence、not_scored。没有 completion 不撤销独立 actual repair 判断；有 fixed 不自动使其 supported；删除与实现修复可分别冻结 rubric。评分真值没有变化。

每例预登记 Contract／agreement／deadline／files、候选 A/B、独立裁决和新的反馈 A/B／裁决上下文。执行上下文别名和同阶段同评分者不构成独立性。每次 grant 和判断封存留 receipt，错 receipt／候选／rubric／证据拒绝；分歧未裁决、单人或不可用不能揭盲本例。其他例不等待该例。缺证保留 unknown/not_scored；可信、已停止且清理确认的 exhaustive observation 才能证明 absent，无候选仍留分母、没有伪造质量分。正常 result 从 `monitored.run.input` 归一，旧 `terminal.ts` 未重写。

隔离调度 helper 区分已确认局部故障与共享／未知安全故障，逐例只执行原定机会，保留原六小时坐标；客户端超时不证明进程停止。相同 CAS 对象若被多例共享，其损坏会真实影响所有依赖例，不能硬标成局部。

**这不是新的真实批次运行器。** 现有 `driver.ts`、`launch.ts`、`evaluate.ts`、`lifecycle-blind.ts` 仍执行旧冻结版本。未来还要显式接入真实 v3 发行／场景、codeHash 来源核验、实际评分 Session 创建／访问 allowlist、取消与清理适配器，并冻结运行／评分安排。当前 context registry 的可信身份由评分适配器提供；合作式登记不证明外部上下文没有先前曝光。未来批次不能只修改旧入口字段后直接启动。

## 4. 验收证据

全部测试采用本地确定性 provider 或故障 fixture，不是实际模型自主能力评分。真实校准未发生的机会仍只能记 not_observed。本轮没有要求模型演示 A1–A16 全部行为。

| 设计项  | 本轮证据及解释                                                                                                                                                                           |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1–A2   | 实际宿主 planned/final-only × changes_requested/P1/malformed 四条零回应出口；另有简述反驳、部分 finding 回应、原意见全部归档和明确提交。                                                 |
| A3–A4   | 实际宿主从 wrong 到 42 的代码／验证归档进入分轴测量，completion absent；独立测量 fixture 保留 unsupported claim、repair、removal、无机会／不适用。脚本判断不是 Researcher 自主能力证据。 |
| A5–A6   | 格式纠错、未知 target、旧 view、精确重试／冲突／新调用、前驱及原子回滚；实际工具上下文透传。并发版本 CAS 沿用 store 回归。                                                               |
| A7      | canonical tool 越权／过期、关闭 admission、慢读期间撤权；旧宿主 deadline 穿越证据 I/O、取消和受保护输入回归仍执行。没有为新协议延长期限。                                                |
| A8      | v3 实际候选变更与核心 artifact 损坏均不能 ready；计划改版与正式验证接通。                                                                                                                |
| A9      | v3 malformed 和 reviewer pre-launch failure 如实 unavailable 后零回应提交；跨 job／旧引用和未知 job／清理安全沿用共享 parser／job 与历史回归。                                           |
| A10     | 历史计划意见仍绑定原 plan.version，当前材料标记按 exact outcome；bundle 保留全部未回应项，v3 exact 外部 attestation 可执行。Core challenge 及旧宿主责任传播回归保持。                    |
| A11     | v1/planned 与 v2 response/lifecycle/closure/required 全流程回归；legacy fixture 显式写入原 v2 策略以保持测试原真值，未把旧测试改成 v3。                                                  |
| A12–A14 | 两例封存独立揭盲＋一例 failed/unknown/absent、评分者不可用、分歧需裁决、错身份／证据、污染上下文别名、独有对象损坏；目标例缺失不拖住其他例。                                             |
| A15     | 新调度 helper 验证局部失败继续、running/unknown cleanup/shared integrity 停止、重复 schedule 拒绝、原 deadline 不变；真实 launcher 尚未接此策略。旧 infrastructure 故障测试另行复跑。    |
| A16     | 四轴保留各事实、声明缺失与 unsupported、未观察／不适用／缺证／未评分；无旧值重标或派生评分。                                                                                             |

日志保存于本轮证据根：

| 分组                                     | 最终结果                                      | 日志                                                                               |
| ---------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------- |
| Core 通用控制／Contract／recognition     | 92 pass，558 assertions                       | `core-regression.log`                                                              |
| SDK 协议／规划／反馈／store              | 49 pass，165 assertions                       | `sdk-regression-final.log`                                                         |
| v3 实际宿主流程                          | 8 pass，132 assertions                        | `advisory-e2e-final.log`                                                           |
| 最终宿主归档→独立测量接线                | 1 pass，32 assertions；已有八例之一的增量复跑 | `advisory-archive-final.log`                                                       |
| v1/v2／planned／required 历史宿主        | 64 pass，706 assertions                       | `legacy-host-regression.log`                                                       |
| 新测量与文本归档                         | 8 pass，51 assertions                         | `measurement-final-reviewed.log`                                                   |
| 旧 infrastructure 与 feedback-score      | 5 + 5 pass；同批的新测量 7 项亦通过           | `measurement-compatibility.log`                                                    |
| 旧整批揭盲门                             | 最终 1 pass，19 assertions                    | `legacy-reveal-final.log`                                                          |
| Core、sdk-next、opencode `bun typecheck` | 三包均通过                                    | `core-typecheck.log`、`sdk-typecheck-final.log`、`opencode-typecheck-verified.log` |

中间失败没有删除：最初 eager schema circular import 调整为在 protocol 中提供 prompt；TypeScript 的闭合／品牌类型问题在实现阶段修正；planned unit fixture 最初漏注册 planned driver 后修正测试环境。S3 首轮发现空 stderr blob 被误判缺失，现按键存在性接受真实空内容；局部损坏测试最初复用了同一 CAS 内容，现用不同实例材料验证局部性，明确共享同一 blob 的损坏会影响所有依赖例。`measurement-compatibility.log` 中旧 lifecycle gate 有一次失败：检查期间运行源码仍在改动，正确触发 `Candidate scoring code changed after freeze`；源码稳定后单独重跑通过，未放宽旧身份检查。阶段日志与最终日志分别保留，未用重标评分真值掩盖失败。

最终快照、逐文件差异、审查 hash 核验、Markdown 检查及历史保全结果保存在 `final-validation.json`／`final-source`／`historical-preservation.json`。所有本轮 runtime/test 差异均相对上述完整 baseline 计算；历史 milestone 正文及第七轮封存材料另行逐字节核验。

## 5. 已知边界

实时用量记录竞态及第五轮具体发行卡点没有因本轮得到修复。原账本、来源补记和未知项继续分列；派生已知总数不能叫完整计量。六小时原 deadline、网络／凭据隔离、显式取消、单次操作期限保持，没有新增累计请求、实验、attempt 或费用上限。

第七轮原冻结门与未完成结果保持不变。本轮无第八轮、66 例或历史重评分。下一步是未来真实批次的显式接线／冻结前联调；是否另启小规模校准仍需单独决定，不能从确定性机制测试推出反馈处理可靠。
