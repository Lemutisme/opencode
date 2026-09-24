# Researcher 反馈策略 v2：独立代码审查

2026-09-20。独立审查者 `/root/design_review`，未参与产品实现。依据用户本轮要求及已通过的[专项设计](pro-contract-researcher-feedback.md)，审查 research 宿主层增量、相关评测与测试。修改前基线为 `/workspace/researcher-baselines/20260920T173028Z`；既有未提交实现不能以 HEAD 差异替代。

最终结论：**独立代码审查通过，C1–C7 全部关闭，无剩余实施阻断**。结论绑定下文 22 项源码／测试清单及 runtime 身份，覆盖本轮 research 宿主机制；不代表真实 reviewer 判断质量、Principal 认可或资格评测通过。未启动真实校准或资格评测。

## 发现与复核（保留初轮状态）

| 编号 | 发现与实际影响                                                                                                                                                                                                                                                                               | 状态／关闭依据                                                                                                                                                                                                        |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1   | `index.ts` 在最终 response 后重新 capture 发现候选变化时直接抛错；`unavailable → recover → freezing` 保留 `submission:true` 和旧候选，必然重复失败，错误提示中的“recover and repair”没有可达修复路径。                                                                                       | 源码已修复：变化时撤销 submission、实验与当前候选资格，round/reviewVersion 递增并返回原权限内 execution；保留原反馈／回应。已独立复核，待生产回归证据。                                                               |
| C2   | `reviewer.environment` 在创建材料及收集终态 reviewer job 前仍可直接失败或因当前 host 配置变化拒绝整个 run。指定 reviewer agent 不可用属于 reviewer 可用性问题；现路径没有独立 unavailable outcome，advisory 可能停在全局 unavailable。                                                       | 源码已分类：v2 环境准备失败保留真实原因，经真实 prepared job 的取消归档 absent unavailable；完成 job 不因之后的无关当前环境变化而丢失意见；归档 identity／epoch／材料仍验证。已独立复核，待生产不可用 reviewer 反例。 |
| C3   | 新 `review-feedback.capture` 对 job、映射和材料进行了绑定，但初版未核对实际 reviewer Location；旧 validator 明确比较 plan/review directory。若 review job 在另一目录执行，允许引用的归档内容本身并不能证明 reviewer 查看的是指定材料。第一次修补的历史 replay 目录取自当前 job，仍可能自比。 | 已增加 collect 的 Location 比较，并对 reviewer／verifier 完整 `job.input` 重算 fingerprint，绑定原不可变 job 全部字段；历史 replay 不需要错误地引用当前候选目录。源码修订已收到，待最终稳定版本复核。                 |
| C4   | v2 计划 prompt 初版继承 `Unclear scope blocks admission` 和 `disabled until a plan is approved`，execution prompt 仍标 `Approved plan`。这向模型继续传达普遍 reviewer 否决语义，与 advisory 的宿主准入及设计 D1 冲突。                                                                       | 已按 required／advisory 分支表达 scope 意见和门槛，v2 执行提示为 Host-admitted plan；新增实际 validation/test 选参与评估关系提示。源码复核关闭。                                                                      |
| C5   | 新评测 `evaluate.ts` 导入的 `dimensions` 函数被 `finalizeScoring` 内同名数组遮蔽，实际调用将抛 TypeError。另新增维度仍把 v2 structured raw 交给只接受 v1 的历史 scorer，合法 v2 会被误标 unavailable。                                                                                       | 类型检查也证实前一错误，原失败日志保留。已要求重命名局部数组，并为新维度增加严格 v2 outcome／raw 解析及反例，保持历史 `score` 与旧真值不变；待修复及回归。                                                            |
| C6   | `research-eval/archive.ts` 的根 hash 集合仅覆盖旧 run 字段；无 bundle 的修复后失败／取消结果不会递归保留 response、admission 及新增反馈历史，新增评分按这些 hash 读取归档时会失败。                                                                                                          | 已加入当前及历史 outcome/response、admission、references、lastExperiment 的 hash 根；待无 bundle 归档回归及最终复核。                                                                                                 |

初轮同时建议在 response 时重放 outcome 证据、正式 experiment 前验证 host admission receipt。实现者已接入这两项检查；最终复核仍需覆盖原始 raw／映射／receipt 损坏反例。

独立运行 SDK 五个轻量套件 `research-feedback`、`research-planning`、`research-schema`、`research-store`、`research-tap`：45/45 通过，134 assertions。该结果先于最终评测修订，不替代生产流程回归；未并发启动重型进程测试。

另已逐字节比较修改前 tar 与当前 33 份 `specs/pro-contract-researcher-s*` 历史设计／实施／审查／校准记录，均未变。

评测范围保持明确：当前 S6c launcher／driver 显式发行 v1；其 final probe 的 legacy prerequisite 判定没有转换为完整 v2 调度协议。本轮新增三维评分用于保留的 v2 outcome 和回应，生产 v2 通过独立进程套件验证；不宣称完整 v2 cohort 启动器已经验证。未来 v2 cohort 须另冻运行器、更新 prerequisite 行为并验证，不能复用历史矩阵掩盖行为差异。

## 后续复核

新增边界发现 C7：反馈回应及正式 experiment 准入在最初授权后新增了 raw／mapping／source／admission 的读取；`setAdmission(open:false)` 不会复查执行 lease/deadline。最终 submission 的事务在 `reportReady` 与 publication 之间还会构造 bundle。若读取期间跨越原期限或协调器租约，仅靠入口时间检查可能写入已过期回应或发布。已在第一次 mutation 前重新检查原 execution；最终 publication 前检查原 token/lease 与原 deadline，失败让事务回滚，不错误比较已合法前进的 Core context。源码复核通过，真实 I/O 边界回归待最终汇总。

- C3：已直接读取最终 reviewer 和 verifier 检查，完整 `job.input` fingerprint 自校验存在，Location 及历史坐标绑定闭合。
- C5：局部数组已改名；新增 v2 scorer 重放结构化引用，同时检查原 raw、outcomeHash、referencesHash、job、contract、context、round、reviewVersion、manifest、plan、candidate 和材料坐标。已知好计划的错误 scope 意见仍记录 false_block，即使 advisory host gate 已打开。`driver.target` 使用 v2 host admission／legacy approval 各自语义，旧 scorer 未改写。
- C6：已核对归档根 hash 新增项和无 bundle 的历史反馈测试，取消／失败案例可保留完整回应及 admission；不再依赖 ready bundle 间接保全。
- C5／C6 回归日志 `/workspace/researcher-feedback-validation/feedback-eval.log`：15/15 通过，574 assertions；`feedback-eval-typecheck.log` 的包内 `bun typecheck` 通过。包括真实数据 P1 语义回归、v2 scope／跨版本映射反例、无 bundle 归档及历史评分组合。

最终来源核验：独立重算 `/workspace/researcher-feedback-validation/source-changes.json` 中 22 个源／测试文件，0 mismatch；清单 SHA-256 为 `2a392e1603d0e9a60b742eed1aafc48e0027f0208d615ee7c18376bebc58b0c7`。独立执行 `codeIdentity()` 得到 runtime `b20092cc489413fae8e2198eaa3c8d34f2111da413bfae7255aae967fb6c9cd7`，与主执行者记录相同。

## 最终签署与验证边界

已完成最终源码复核和日志核验。上述表格保留初评过程，最终关闭状态如下：C1 的候选变化能拒绝旧提交并返回修复；C2 的 reviewer 启动前不可用产生真实 absent outcome，advisory 可回应后提交；C3 的 job／材料／原始来源绑定保持；C4 的提示准确区分策略；C5 的三项质量维度与宿主准入分开；C6 的无 bundle 历史归档完整；C7 的三个真实 I/O 期限反例均通过。

| 验证                     | 最终证据                                                                                                                                                                                                                                                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新版生产流程             | `feedback-process-final.log`：14/14，111 assertions，176.31 秒。包含回应归档后过期拒绝、bundle 归档后过期回滚 Core handoff、experiment 证据读取后过期不得创建验证 job；缺省策略历史 fixture 的真实 issue 重试、advisory 完整链、required 计划和交付、损坏证据／跨 job／候选变化、readonly 权限及原 deadline 也通过。 |
| SDK 宿主基础与反馈       | `sdk-tests-final.log`：46/46，138 assertions；包括完整消息 schema 编码后 DateTime／reasoning 时间戳／provider error 的保留。审查者另独立运行前一版五套件 45/45。                                                                                                                                                     |
| 评测维度、归档与 P1 语义 | `feedback-eval-final.log`：15/15，574 assertions。实际分析函数的选参与评估关系和措辞对照通过，不规定 reviewer 必须 accept。                                                                                                                                                                                          |
| 旧协议生产行为           | `legacy-process.log`：首次 33/34，保留真实失败；唯一 lease 时序用例在 `legacy-recovery-recheck.log` 中 1/1、20 assertions 通过。`legacy-final-c7.log` 再次验证完整旧计划／实验／交付／exact 认可链 1/1、29 assertions。                                                                                              |
| 类型及格式               | 包内 `bun typecheck` 的 `sdk-typecheck-c7.log`、`opencode-typecheck-final-c7.log` 均通过；22 项源码／测试格式检查 `source-format-final.log` 通过。                                                                                                                                                                   |

全部日志位于 `/workspace/researcher-feedback-validation`。新生产初轮完整消息归档失败、早期类型失败、checkpoint fixture 缺少 planned driver 的发行失败，以及旧恢复测试在 job lease 尚未到期时被 guard 正确拒绝的记录均保留。修复后才使用上述最终结果；没有把最初失败隐藏在汇总之外，也没有声称基线必然复现非确定性时序失败。

签署绑定清单 SHA-256 `2a392e1603d0e9a60b742eed1aafc48e0027f0208d615ee7c18376bebc58b0c7`、runtime `b20092cc489413fae8e2198eaa3c8d34f2111da413bfae7255aae967fb6c9cd7`。清单逐文件及 runtime 均由审查者独立重算。当前策略总设计、中英文入口和专项设计已读取；历史 33 份切片记录保持原字节。

本轮未修改 Core 或实现 Principal 决策策略。配置保证仍是现有合作式环境下的启动前配置身份检查及执行来源验真，不宣称对外部并发配置修改提供全程强隔离。完整 v2 cohort 启动器及真实模型质量仍需以后另冻验证；本轮没有第四轮校准或 66 例资格运行。原每实例六小时墙钟、deadline、完整计量和单次操作边界不变，无新增累计请求／实验／费用上限。
