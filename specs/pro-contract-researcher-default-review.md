# Advisory v3：独立审查记录

2026-09-21。审查对象是[默认流程设计](pro-contract-researcher-default-flow.md)的本轮实现，基线与测试见[实施记录](pro-contract-researcher-default-implementation.md)。没有真实模型、校准或历史评分。实现者负责修改与回归；下面的 agents 只读审查，S3 审查者另行独立复跑明确列出的确定性测试。

## 1. 调用身份与 Core 边界

审查者 `/root/v3_call_review` 核对 canonical tool 到 handler 的两处转交。`assistantMessageID` 由 provider-turn publisher 生成并持久化；`toolCallID` 来自执行器处理的 provider event，同 turn 重复 ID 被 publisher 拒绝。可信性指来自 runner／registry，而不是把 ID 当权限凭证。执行、view 和调用身份分别校验。

结论：无剩余阻断；没有增加 Core 研究语义或改变 reducer。建议的真实工具边界测试由实现者执行并通过，覆盖两工具转交、payload 不能覆盖外层元数据、过期执行不能到 handler。该审查者未独立运行测试。

最终文件 SHA-256：

| 文件                                              | SHA-256                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| `packages/core/src/pro-contract/delivery.ts`      | `9a8e33fe2b113a2d92e06d07e475fb8c067d703e232e7d443ef017d4d4f89d92` |
| `packages/core/src/tool/contract-control.ts`      | `b1575179203f957349ea10fdacc01e340f3a426a1676bf52e09aa9ac0c61b99f` |
| `packages/core/test/pro-contract-control.test.ts` | `92dd4886e4b44dce9b34f2d954cf9b8a33620d3196369ea3ef054e9e433a68d2` |

## 2. S1/S2 宿主审查

审查者 `/root/v3_host_review` 首轮发现四项 P2，实施者修改后再次复核，另两项增量问题也在最终复核前关闭：

| 发现                                             | 关闭方式                                                                                                |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| 先前已写简述、提交未重复说明却显示 not_provided  | treatment 回收当前适用的 response 简述；逐条 unaddressed 独立保留。                                     |
| 多版本意见缺原计划版本／适用性                   | view 展示原 planVersion、round、reviewVersion；current 按 exact outcome 判定。                          |
| 文件 I/O 被包在写事务内，可能阻塞续租／取消      | observe 移出 writer；最终重新授权、核对 view 后原子写状态与 receipt。新增慢读期间独立 writer 撤权回归。 |
| call_conflict 独立表未进入交付                   | bundle 增加 commandConflicts，认可前全量重建检查覆盖。                                                  |
| 新精确重试 fast path 在读取 receipt 后未重授权   | prior 只用于跳过观察；重试统一进入事务重新授权后返回。                                                  |
| 同代码的新一轮材料误把旧 delivery 意见标 current | 按当前 plan.reportHash／reviewHash 精确匹配，不只比候选代码 hash。                                      |

最终窄增量还核对 mechanical failure、candidate change、external challenge 的 v3 恢复提示，引导当前 `research_view`／合法动作；旧分支保留。最终结论：S1/S2 范围内无剩余阻断。该审查者未重跑测试，结论不代替实现者回归。

最终读取 SHA-256：

| 文件                                                  | SHA-256                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------ |
| `packages/sdk-next/src/research/index.ts`             | `8ba773ba35221dc0382a47e6f66acd1334c2f02df1b634614b6801d259d23ed1` |
| `packages/sdk-next/src/research/advisory-control.ts`  | `384e5ad266a5ce5ff6d219e8d059ecc439904676ef7bcf4f4d321bda01e10e83` |
| `packages/sdk-next/src/research/feedback-evidence.ts` | `9f191c015f2d98fb3ecbd16d1261c0df7b939797ccdad977d2af68c04fca6853` |

## 3. S3 独立测量审查

审查者 `/root/v3_measurement_review` 独立定位、复现并复核关闭以下问题：

- evidence 的字符串包含匹配改为精确 digest allowlist；空引用不能通过。
- 冻结配置深冻结；一例独有材料损坏在报告中保留缺口，其他实例仍可封存／揭盲。
- candidate／terminal 与预登记 Contract、agreement fingerprint、原 deadline 和 file allowlist 绑定。
- rubric 必有必要维度，调度预检唯一实例和全部原期限，不能对重复 ID 追加机会。
- 候选从已校验归档恢复；反馈专用材料包含最终及历史源码、会话、reviewer jobs 与 source，避免全新反馈评分者只看到声明却没有实际变化证据。
- source provenance 持久化；文本提取拒绝 symlink、目录、重复条目、二进制，保留真实空文件。

独立最终复跑：新测量／归档两文件 **8 pass、51 assertions**；实际宿主选例 `planning=false, unavailable=false` **1 pass、32 assertions**（其余 7 例过滤）。审查者另将 `launch.ts`、`evaluate.ts`、`lifecycle-blind.ts`、`terminal.ts`、`lifecycle-evaluate.ts` 与修改前 baseline 逐字节比较，均未变。

最终结论仅覆盖**新增离线测量、单例封存 API 和确定性宿主接线**，该范围无剩余阻断。尚未接入真实批次 launcher；真实 Session 隔离、期限中止与配置来源验证仍须 future adapter 接线和单独冻结。脚本判断仅验证材料与机制，不是模型能力评分。审查者没有运行真实模型、重评历史结果或复核全部历史归档。

| 文件（均位于 research-eval，末项为 server test） | SHA-256                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| `advisory-archive.ts`                            | `cbc23a13cb3da6e3f2c169035ae9e6cfcad0e381c7e3ee9ec85293413cc5c39a` |
| `advisory-measurement.ts`                        | `625fef094a4ad8bdfc88e28809971fe5561db642976bd9982e46389fd325d254` |
| `instance-scoring.ts`                            | `231279d014f45be7460b3cc060b053efa8e96519e7d6a74317af8978a4d5e8e9` |
| `instance-scoring.test.ts`                       | `78aa8b13673722effaf66594207cbc9134730570458e6505cf2925049d747fdb` |
| `advisory-archive.test.ts`                       | `44ba0a682940da056e45c5d9e6e86758d66b0d0e524236b54a29d55783e2fadf` |
| `pro-contract-advisory-process.test.ts`          | `00c49c86d69f4ddd0408364c8d76b7f1234e343f2ef6c07808bd4623d7ca924a` |

## 4. 审查不提供的保证

没有证明真实 Researcher 会利用简化流程可靠处理意见；没有修复实时计量竞态或认定历史发行超时根因。所有 required／历史任务保证仍由对应版本决定，第七轮保持原未完成结果。Constitution、历史冻结、原 deadline 和无新增累计上限均由最终保全核验另行记录。
