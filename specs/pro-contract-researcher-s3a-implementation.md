# S3a 实施与验证记录

状态：S3a 已完成，相关测试和独立代码审查通过。设计与首轮问题见 [S3a 实施说明](pro-contract-researcher-s3a.md) 和 [独立设计审查](pro-contract-researcher-s3a-review.md)。

## 已实现的边界

每份 OpenCode binding 保存唯一 driver 身份、版本化 admission 和 claim 时的制度上下文。缺少 driver、实现版本不符、准入关闭或上下文失效时不执行，也不回退 native。旧 JSON binding 默认 native；纯 kernel、Contract Spec、公共 HTTP 发行字段和认定 API 均未改变。

driver 是宿主构图时注册的完整同步策略：activation、claim/recovery、heartbeat、outcome 全部经过同一注册表。回调抛错或返回非法结果时持久关闭准入，禁止 lease 到期后偷偷重跑；独立期限扫描仍工作。宿主尚未实现的研究 driver 没有默认替代品。

`bindings.issue` 将 duty、context、binding 和历史 Session 映射置于同一 SQLite 事务。同 ID 重试同时比较条款及执行参数，冲突在制度 command guard 中留下 rejected event；数据库错误回滚整次发行。重试不重置计量、准入状态或期限。

等待与恢复使用两个边界：

- `setAdmission` 比较捕获的 binding 身份、admission version 和 S2 `ContextTarget`；自定义准入持续绑定获准的 target，不能跨 revision/challenge/resume 继承旧批准。
- 本地 dispatch/drain 共享在途计数。关闭立即拒绝新的 claim/provider 准入和受保护 Contract 命令，但 drain 和 dispatch 都结束之前不退租、不重新打开。等待后使用新的 Session/Prompt，保留同一语义 attempt、完整累计计量和原始 deadline。

claim 不能绕过有效 lease 或尚未结束的本地操作；heartbeat 不能续活过期 lease。每次 claim 递增 generation。正常结束、终止 provider 错误、中断和 dispatch 失败都携带最初捕获的完整身份，旧回调没有 Contract、binding、计量或账本副作用。native 同 revision 的制度 phase 变化也会撤销旧执行。

`contract_report_blocked` 在同一事务内记录 blocked 与 driver 的 pendingOutcome，然后停止新的准入并保留 lease。drain 清理后只消费原决策一次；进程崩溃则等待 lease 到期再消费。driver 指定的 `retry(same)` 与正常 wait 都不误增 attempt；真正的新 attempt 仍遵守批准的上限。

dispatch 根据 claim 后重新授权的精确 Contract 构造任务材料，检查身份与 durable prompt admission 同事务完成，wake 在提交之后执行。恢复时读取原 prompt 或当前 Session 的真实持久输入／历史；空 Session 不会因为旧 Session 的累计用量而只收到“继续”。wake 已启动 drain 后，调度 fiber 的取消不再提前释放该 drain 的 lease。

主动取消 replay 时，默认 executor 先停止子进程及输出采集，再交出有限缓冲。replay 在不可中断的归档段中保存已经完成的检查，以及中断检查的部分输出；后者使用 `unavailable` receipt、`complete: false` 和 `unobserved` predicate，保留原 interruption。完整报告发布前中断时，补发的汇总明确记录 `incomplete`、预期检查数与未完成的文件检查，`passed` 恒为 false，后续检查不执行。若取消发生在完整报告发布之后，该报告可以保留原来的 `passed: true`，但撤销的授权仍禁止 handoff。报告通过临时文件与原子 link 发布，已存在的同 hash 内容须一致，归档完成后才删除 scratch。

若 observation 归档失败，汇总额外标记 `observationArchiveFailed`，不合成缺失 receipt，并保留 scratch、传播原失败。报告归档本身失败时同样不清理 scratch。用量不退款，release 不会因清理转成 handoff 或 escalation。此保证覆盖正常取消；`SIGKILL` 前尚未落盘的输出不能通过 finalizer 挽救。

## 宿主接线

`sdk-next` 的 `OpenCode.create({ contractDrivers })` 和生产 `Server.listen({ contractDrivers })` 接受宿主实现。嵌入式宿主通过 `contractExecution.issue/get/setAdmission` 操作同一服务图中的 binding 服务；Server、scheduler、SessionExecution 和 Location runner 使用同一 registry、binding owner、memo map 与资源作用域。

公共 HTTP／CLI 继续只发行原生 Contract。未改变 Protocol 或 Server HttpApi 的线上契约，因此本切片没有重新生成客户端，也没有修改 Schema 或数据库表结构；S1/S2 的迁移与生成文件保持原样。

## 独立审查发现的反例

设计审查关闭了 dispatch 穿过关闭／重开屏障、旧 open 跨制度上下文、blocked 工具提前退租三项问题。

代码审查进一步检查并促成修复：blocked 的 same retry 误判为新 attempt；首次／新空 Session 恢复遗漏完整任务材料；driver 故障后自动重跑；native 旧 phase heartbeat；claim 前的旧 Contract 快照绑定到新执行；wake 后取消调度导致提前退租。每项均以真实存储或实际 coordinator 的定序测试复核，完整结论以独立代码审查报告为准。

进程回归进一步暴露主动取消时的 replay 证据丢失，独立复核补充了 observation 写入失败不能清理 scratch 的要求。新增真实子进程、真实文件系统故障和 HTTP 撤销测试覆盖这些路径。S1 旧断言同步更新：执行已取消时不强求额外 rejected command；待审批任务的过期 lease 可以退休，但 pending、generation、attempt、用量和账本不能变化，也不能在审批前重跑。

## 验证

验证日志位于 `/tmp/opencode-s3a-*.txt`。新测试使用有限测试 driver 和本地 HTTP 模型服务，不调用付费模型，不启动真实研究或 ProgramBench cohort。

| 检查                                                | 结果                               | 证据                                        |
| --------------------------------------------------- | ---------------------------------- | ------------------------------------------- |
| Core 最终相关回归，12 个文件                        | 290 pass，0 fail，1,401 assertions | `/tmp/opencode-s3a-core-suite.txt`          |
| sdk-next 构图、嵌入式 HTTP 与导入边界               | 6 pass，0 fail，28 assertions      | `/tmp/opencode-s3a-sdk-next-tests.txt`      |
| HTTP Contract、SDK、OpenAPI、Schema、认证，5 个文件 | 53 pass，0 fail，290 assertions    | `/tmp/opencode-s3a-http.txt`                |
| S1／S2／S3a 生产进程 E2E                            | 17 pass，0 fail，214 assertions    | `/tmp/opencode-s3a-process-suite.txt`       |
| Core／Server／sdk-next／opencode 类型检查           | 全部通过                           | `/tmp/opencode-s3a-<package>-typecheck.txt` |
| 独立 reviewer 复跑 replay／observation              | 9 pass，0 fail，72 assertions      | `/tmp/opencode-s3a-review-replay.txt`       |

独立代码审查的 C1–C7 均已修正并复核，详细反例、独立测试与最终源文件 SHA-256 见 [S3a 代码审查](pro-contract-researcher-s3a-code-review.md)。设计审查所针对的文档和报告保持原始 hash，未将后续状态更新覆盖到冻结设计版本。

基线对比确认纯 kernel 无变更；S2 已修改的 Schema、迁移、Protocol、生成客户端等 15 个受保护文件与 `/tmp/opencode-s3a-baseline/manifest.json` 完全一致。

Core 集成验证从 `packages/core` 执行：

```sh
bun test --timeout 15000 test/pro-contract-driver.test.ts test/pro-contract.test.ts \
  test/pro-contract-control.test.ts test/pro-contract-export.test.ts \
  test/pro-contract-recognition.test.ts test/pro-contract-constitution.test.ts \
  test/pro-contract-replay.test.ts test/pro-contract-observation.test.ts \
  test/session-runner.test.ts test/session-runner-tool-registry.test.ts \
  test/location-layer.test.ts test/database-migration.test.ts
```

生产进程验证从 `packages/opencode` 执行，包含 S3a 两项、S2 五项及扩充后的 S1 十项：

```sh
bun test test/server/pro-contract-driver-process.test.ts \
  test/server/pro-contract-process.test.ts \
  test/server/pro-contract-recognition-process.test.ts
```

S3a 新增场景覆盖 `maxAttempts: 1` 多轮等待、`SIGKILL` 后保留计量及原 deadline、driver 缺失时关闭执行、有效 driver 恢复，以及 `SIGSTOP` 后自然 lease 到期接管，再放行旧进程终止 HTTP 错误，确认新 binding／Contract／账本不受旧回调影响。S1 新增取消场景还验证部分报告跨进程重启保留。

SDK 从 `packages/sdk-next` 执行 `bun test --timeout 15000`。各受影响包分别执行 `bun typecheck`。首次并行运行时，Core 的既有 replay 综合测试和 SDK bundle 测试触发默认 5 秒超时；复跑仅提高测试框架等待上限，没有改变生产任务预算、lease、取消规则或测试断言。

## 保证范围

S3a 完成执行 driver 的生命周期与通用等待基础设施。它不构成研究质量验证，也没有开放生产 research profile。

S3b 的受控 job、完整 prompt/resume 准入、权限等待后的许可复核、Reviewer 授权与共享计量仍未实现。S4 的真实研究产物、冻结／检查／独立评审 pipeline，以及 S5 的计划与方法门槛仍待实施。任意 shell 的强隔离和外部副作用 exactly-once 不在本切片保证内。

等待后换 Session 会丢失自动沿用同一对话的便利；恢复材料由宿主显式提供，已持久的 Session 历史和产物继续保留。driver 是受信宿主代码，有限同步回调不能用于执行 I/O 或研究计算。当前协调与停止屏障仍是单进程机制，跨进程恢复靠 lease/generation fencing，不宣称实现了分布式 Session drain。

既有 S1/S2 未提交改动已保留；本切片同样未提交 commit、发布服务或启动实验。
