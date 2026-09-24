# Researcher 评审反馈与运行策略 v2 专项设计

2026-09-20。用户本轮确认的职责优先于 S1–S6 的普遍强制评审规则；历史文件、冻结源码、配置和结果不改写。修改前基线 `/workspace/researcher-baselines/20260920T173028Z`，HEAD `78bec19263814444ab008c58d54835b59b4a1c6b`；工作树已有 190 项改动，不能以 HEAD 代替基线。

## 权责与策略身份

Principal 是外部任务约定和最终认可的所有者；本轮不实现其研究决策。Reviewer 的结论是独立意见。Researcher 必须回应，运行宿主按冻结策略准入；Core 仍只提供通用权限、身份、事务、执行与 exact recognition。

新增不可变 `manifest.reviewPolicy = {version:2, plan:"advisory"|"required", delivery:"advisory"|"required"}`，由 manifestHash/specHash 绑定。新任务发行默认显式写入 advisory/advisory；明确 required 的任务保留对应 accept 门槛。显式 `{version:1}` 可用于保留旧协议的发行入口。已存在且缺少策略的任务按 legacy required/required 解释，精确重试采用已发行输入，不自动迁移。评测历史入口显式保持旧策略，未来评测须另冻版本。不能从任务自然语言推测放宽，调用者须将明确强制要求编码为策略。

分别记录：执行准入（宿主 admission receipt）、评审意见及可用性（review outcome）、候选提交（bundle/ready）、外部认可（exact attestation/accepted）。`ready` 仅表示可供外部审阅的候选；不代表评审 accept、研究正确或外部认可。

## 状态与反馈循环

v1 流程保持原义。v2 在 Core handoff 之前完成最终评审及 Researcher 回应，使普通修复不需要外部 challenge。

| 阶段                                         | 行为与后继                                                                                                        |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| exploration → plan_review                    | 原权限内提交计划；硬约束、版本、agreement 和受保护路径检查不变                                                    |
| plan_review → plan feedback                  | 归档意见或 unavailable，向 worker 提供只读／control 反馈入口                                                      |
| plan feedback → execution                    | Researcher 逐项回应后请求继续，宿主检查 scope、权限及策略；advisory 不要求 accept，required 要求有效 accept       |
| plan feedback → exploration                  | Researcher 修订计划；新版本及新材料触发新评审，旧意见／回应保留                                                   |
| execution → freezing → verification → review | 请求交付，关闭写入、冻结并验证；v2 此时不提前提交 Core handoff                                                    |
| review → delivery feedback                   | 保留意见／unavailable，worker 仅能读和回应                                                                        |
| delivery feedback → execution                | 主动修复：保留旧候选与全部反馈，撤销当前验证／提交资格；候选变化必须重新正式实验和验证                            |
| delivery feedback → candidate submission     | 回应并明确请求提交；重新冻结核对候选身份，检查有效实验／核心证据、策略与回应完整性，再形成 Core handoff 和 bundle |
| ready → accepted                             | 仅外部 exact attestation；reviewer 无最终认可权                                                                   |

回应绑定 reportHash、planHash/subjectHash 与原意见 ID，逐项 `fixed`、`rebutted` 或 `unresolved`，要求非空依据／说明；unavailable 也有明确回应，不能凭空产生有效 Review。修复声明是 Researcher 声明，不能机械视为已验证；未决事项、严重性、证据、影响范围和升级说明进入交付。旧意见和回应为追加记录，不因换计划、候选或 round 消失。回复未知／重复／跨报告 finding 拒绝。一般 findings 不隐含扩权；明确需要原约定以外操作仍必须外部 revision。advisory 下 reviewer 的 scope=unclear/needs_principal_revision 同样是待回应意见，不能成为隐性模型否决；宿主硬门槛来自已冻结约定、显式越权请求及可机械验证的保护项。Researcher 自己声明需要越权的计划不能准入。

P1 严重级别只作为意见与升级记录，不能仅因模型写 P1 暂停全部工作。本轮不设自动 P1 暂停策略；校准用例 P1 是独立的用例名称。

feedback 命令在同一事务比较原 execution/context、当前 reportHash/planHash/subjectHash 与阶段，并写入 responseHash。宿主 admission receipt 绑定 policy、plan、outcome、response 和 context。submit 必须先经过当前 drain/工具清理屏障再 capture；身份变化撤销当前提交资格，不沿用旧意见授权新候选。v2 不带 planning 的 research-final 同样经过最终反馈。新阶段使用原 coordinator CAS/generation、取消和 deadline，恢复不自动重审；bundle 汇总全部历史意见、回应及未决项。

## 报告不可用与核心证据完整性

采用独立的 v2 ReviewOutcome schema，而非合成 Review{verdict:unavailable}。它记录 availability、可选的真实有效 review、捕获状态 complete/partial/absent、可选原始输出／消息／上下文引用、job 实际状态、失败原因与解析结果。原始输出或映射从未生成时如实记 absent；已归档对象损坏不能降格成 absent。报告 schema 错误、未知引用、无最终答复或 reviewer job 失败均记录 unavailable，保留能取得的原始消息／输出、job 状态、错误和解析结果。advisory 路径返回反馈，不自动重审至 accept；required 保持相应关闭状态，可原授权内修复，但不能无 accept 提交。单个未知执行仍须先确认停止／取消并保留完整计量，不能忽略存活进程或 deadline。

候选、正式实验、受保护输入、job 身份或核心 blob 损坏继续阻断依赖这些材料的执行／提交／认可。不能用 broad catch 把这些失败吞成普通 reviewer unavailable。reviewer 原始输出或映射丢失也不得伪造通过；该项无法验真的明确状态和真实存档必须保留。归档读取发生 hash 破坏时 fail closed，不能用 advisory 绕过证据完整性。

## 新引用协议

v2 reviewer 可以选择宿主提供的 `{jobID, id}` 结构化证据引用。每个 job 创建不可变映射，绑定 jobID、context、candidate/plan、materialsHash；本 job 的 prompt 明示可用 id 与完整目标 hash。短 ID 仅在该映射内有意义。宿主严格校验唯一性、job 身份、材料版本与 allowlist，并解析为完整 SHA-256。归档 raw、映射和解析结果，认可时重放解析并核对原 job。拒绝未知、歧义、跨 job、跨候选、过期和 hash 长度错误；不修复历史报告。v1 仍采用原完整 hash 协议。

## 验证与记录

生产路径验证 advisory finding → 回应／修复 → 实验／提交，malformed/unavailable → 真实反馈与可提交候选，required 和 legacy 门槛，以及权限、deadline、候选变化、损坏核心证据、反馈完整性和跨 job 引用。独立设计阻断关闭后实施，完成测试和独立代码审查。

P1 语义回归使用实际选参／评估关系：validation 选参后 held-out test 评估；test 选参后同一 test 评估；覆盖“独立诊断”“独立于选参”“held-out evaluation”等措辞。机械测试核验数据关系和提示规则，不能硬编码 reviewer 必须接受好计划或将确定性 fixture 当模型判断能力证据。保留旧真值和误拒。新增评测输出分别展示 reviewer 判断质量、Researcher 反馈处理、最终候选质量，不用 gate 成功抵销评审误判。

更新中英文总设计、交接及本次实施／独立审查记录，明确仅 legacy 和显式 required 阶段继续承诺“评审批准才能实验／提交”。本轮不启动第四轮真实校准或 66 例资格评测；六小时每实例墙钟、原 deadline、完整计量和单次操作限制不变，无累计 turns/actions/requests/实验次数/费用上限。
