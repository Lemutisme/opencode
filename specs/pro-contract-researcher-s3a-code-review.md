# S3a 独立代码审查

审查范围为 S3a 相对 `/tmp/opencode-s3a-baseline/files` 的 driver 注册表、binding、scheduler、Session drain／provider、blocked 工具，以及 Server／sdk-next 构图。设计基准见 [S3a 设计审查](pro-contract-researcher-s3a-review.md)。没有改动 runtime；实施方授权后，评审方在 `pro-contract-driver.test.ts` 增加了两项定序回归。

最终结论：批准下列文件身份所对应的 S3a 实现。C1–C7 七项已确认问题均已修正并复核，最终相关套件全部通过，本次审查未发现尚未处理的阻断问题。该结论仅覆盖 S3a 生命周期、宿主接线及其取消归档回归，保证范围见文末。

## C1 · P1：旧 Contract 材料被绑定到新 claim 身份

初版 [scheduler](../packages/core/src/pro-contract/scheduler.ts) 先读取 Contract，再单独 claim。两次读取之间若发生 revision／challenge／resume，并有调度或可信调用重新激活，claim 可以得到新 phase，而 prompt 仍使用旧 Contract 的 brief、blocked 和 challenge。最后 admission 检查的是新 `Execution`，因此不能发现材料来自旧视图。

修正后，scheduler 在 claim 后、dispatch 内通过 `bindings.authorize(execution)` 取得与原执行身份匹配的 Contract，再构造全部任务材料；durable admission 仍在事务内再次核对身份。永久回归在候选选择与 claim 之间执行真实 escalate／resume／activate，确认同 revision 的新 context 和新 blocked 原因进入 prompt。

状态：已关闭。

## C2 · P1：wake 后取消 dispatcher 可以提前释放仍在运行的 drain lease

初版 dispatch catch 无条件 `complete(dispatch-failed)`。wake 已将工作交给独立 Session coordinator 后，取消 dispatcher 并不表示 drain 结束。此时 complete 会清 dispatched／lease；本进程 operations 屏障虽挡住本地 claim，另一 owner 却可以在原 lease 到期前接管。

评审方用真实 `SessionRunCoordinator` 保持 drain 在途，在 wake 边界定序 interrupt，观察到另一真实 binding owner 在测试时钟 `20` 成功取得 generation 3，而原 lease 本应持续到 `30010`。修正后，uninterruptible dispatch catch 先读取 Session active 状态，已交给 drain 的工作仅由其 finalizer 完成处置。相同测试确认新 owner 在原 lease 内不能 claim；该测试已加入永久回归。

状态：已关闭。

## C3 · P2：blocked 的同 attempt 重试被重新算作新 attempt

初版 `settle` 对 `retry(same)` 保留旧 `attemptKey`，但 `reportBlocked` 已经改变 Contract 的 blocked 坐标。下次 claim 因 key 不同计入新 attempt，`maxAttempts: 1` 下错误 escalate，覆盖了 driver 的明确决定。

修正后，同 attempt 决定同步到当前 Contract 的 attempt key；只有 `retry(new)` 留下新 attempt 标记。新增回归验证 blocked 后的同 attempt 重试仍为 attempts 1，generation 前进、用量累积且 retry delay 生效。

状态：已关闭。

## C4 · P2：空 Session 恢复时丢失首次任务正文

初版把 Session 行存在等同于已有任务历史。进程在 `sessions.create` 之后、首次 prompt admission 之前退出，恢复时唯一 prompt 会变成“Continue the approved task…”，遗漏 goal／brief、executionPolicy 和依赖说明。

首次修正使用 binding 累计用量判断是否继续，仍不能处理旧工作已有用量、新 Session 尚为空、durable admission 暂时失败后执行同 attempt 重试的情况。评审方真实 store probe 再现了这项变体：唯一持久 prompt 仍是 Continue，没有原任务 brief。

最终修正仅根据该 Session 的持久队列／可见用户历史判断是否已有上下文，并在复用 prompt ID 时读取保存的原 prompt。永久回归分别覆盖首次零用量恢复，以及继承累计用量的空新 Session；两项独立 probe 也通过。

状态：已关闭。

## C5 · P2：driver 决策故障后仍能自动恢复执行

初版 outcome 抛错或返回无效结果时，complete 事务回滚，但 binding 仍保持 open。lease 到期后 sweep 看不到不可用或待处理意图，claim 可重新启动 provider，使丢失处置决定的工作持续自动恢复。

修正后，统一的有限 `invoke` 边界处理 activation、claim、heartbeat 和 outcome 的异常／非法返回，持久关闭 admission 并保存原因；lease 仍服从清理屏障，不能借异常提前回收。四类 callback 的永久回归验证故障关闭、lease 过期后不能再 claim，以及原 deadline 仍会 escalation。独立 probe 对 outcome 故障后的过期恢复也通过。

状态：已关闭。审查期间一处 `Effect.try(callback)` 的 Effect 4 API 不兼容也已改为对象参数形式，并重新通过测试／类型检查。

## C6 · P2：native 同 revision 恢复后可给旧 phase 续租

初版 heartbeat 检查了 revision、owner、Session 和 custom admission，但 native 的有效准入不比较 S2 context。issuer 在同 revision escalate／resume 后重新激活，旧 phase 的 lease 仍可被 heartbeat 延长；虽然下一次 sweep 会清理，heartbeat 本身已经越过身份边界。

修正后，heartbeat 同时比较 claim 时保存的 `binding.context` 与当前 S2 context。独立 probe 验证 native 的同 revision resume 后，旧 lease 到期时间保持不变。

状态：已关闭。

## C7 · P2：主动取消 replay 会丢失已经捕获但尚未归档的证据

完整 S1 进程回归显示，S3a sweep 现在会在 release 后及时中断 drain，因此工具可能在提交旧命令前已经被取消；此时没有额外 rejected command 是正确行为。原 executor 的 stdout／stderr 缓冲仅在 `run` 内，外部 interruption 不返回 Result，replay 因而跳过 observation 归档；汇总报告又只在所有 checks 完成后写入。最后 scratch 被清除，已发生的检查可能只留下 action 计量，没有可发现的部分证据。

评审已核对 `replay.ts`、`executor.ts`、`observation.ts` 及子进程 scope 清理。必要约束是：停止子进程与采集器后，保留有限的捕获 bytes，在有限不可中断段中归档完整 receipt；部分 stream 的 `complete` 为 false，predicate 为 unobserved。原 interruption 必须继续传播，不能变成正常成功或提交 handoff。完整汇总报告尚未发布时，补发报告须明确 incomplete、未执行项目和原 policy／subject／executor 身份，`passed` 恒 false；先原子发布报告，再清 scratch，既有内容寻址产物不覆盖。

实现现在通过 executor 的可选同步取消回调交付有限缓冲，Observation 的 unavailable 结果承载部分输出，replay 的 `onExit` 补发 incomplete 汇总，并采用临时文件加 hard link 原子发布。静态复核确认 callback 位于 process scope 清理之后，receipt 归档位于有限不可中断段，随后重新抛出原失败 Exit；后续 checks 不会运行。已完成 checks 保持完整，正在执行的 check 的有限 bytes 标为不完整，partial hash 即使匹配也不能满足 predicate。新增真实子进程回归覆盖双流各 1 MiB 上限、原 interruption、receipt／report 读取完整性、后续 check 未执行、scratch 删除与子进程终止。

静态复核另发现了 observation 归档失败后仍删除 scratch 的边界，现已一并修正：`record` 的任何失败 Cause 都设置 `observationFailed`，incomplete report 明确标记 `observationArchiveFailed`，不合成缺失 check，保留此前成功 receipts；最终清理跳过 scratch 删除，并传播归档失败。汇总报告本身发布失败也不会继续删除 scratch。新增回归用真实文件阻断 observation 目录、保持 report 目录可写，检查归档错误、缺失证据标记和 scratch 留存；同输入重复运行还验证了零 receipt 的相同 hash 报告可重复原子发布。

强制 SIGKILL 时尚未落盘的 bytes 不在此 finalizer 保证内。S1 断言已允许在完整报告发布后、旧 control command 提交前取消；任何实际进入 release 后 ledger 的旧命令仍须 rejected。pending revision 恢复断言允许过期 lease 退租，但仍核对 pending、generation、用量和 ledger 不变，且不得重新调度原 provider。

状态：已关闭。最终冻结 runtime 的独立 replay／observation 回归为 9 pass、0 fail、72 assertions；下列源文件身份已包含此后续改动。

## 其他核对结果

- driver 注册表固定于构图，原生身份不可覆盖，重复／不完整注册拒绝。宿主 callback 得到 clone，失败不退回 native。
- issue 将 duty、context、binding 和 Session 历史映射放入同一事务；metadata 冲突在 command guard 中拒绝。真实 SQLite trigger 故障回归确认没有半发行或 accepted ledger 残留。
- custom admission 保存获准的完整 `ContextTarget`；每次 claim 还为所有 driver 保存 phase target 到 Binding／Execution。旧回调比较原 Session、prompt、owner、generation、driver、revision、context 和有效 lease，不借当前查询更新旧身份。
- durable prompt admission 与 execution 检查同事务，wake 在提交后。正常等待再开换新 Session／prompt，保留语义 attempt、累计用量和 deadline；退休 Session 映射继续拒绝执行。
- blocked 的 `pendingOutcome` 与 Contract 记录同事务，保留 lease；内部待处理意图与外部 close 区分。cleanup／过期恢复只消费原决定一次。pending revision、已交付、release 和旧 context 的 cleanup 不重排新 phase。
- Session runner 保持可中断；有限 finalizer 由 `uninterruptibleMask` 保护。结束时读取 projected context 的错误也转入统一 complete，不跳过 cleanup。deadline 扫描独立于 driver 和 `due`，覆盖关闭／缺 driver／pending revision。
- Server 的两套构图入口、LocationServiceMap 和 sdk-next 使用同一 driver replacements；sdk-next 的共享 memo map 和受 scope 管理的 HTTP disposal 保留同图实例及资源释放路径。实际跨图请求仍以集成测试为准。

## 独立验证

从 `packages/core` 执行的相关检查：

- 中间候选的 `pro-contract-driver.test.ts`、`pro-contract.test.ts`、`pro-contract-control.test.ts`：86 pass、0 fail、477 assertions。
- 新增最终两项定序回归后的 `pro-contract-driver.test.ts`：21 pass、0 fail、146 assertions。
- C7 最终冻结候选的 `pro-contract-replay.test.ts` 和 `pro-contract-observation.test.ts`：9 pass、0 fail、72 assertions，包含真实取消和真实 observation 目录故障；日志 `/tmp/opencode-s3a-review-replay.txt`。
- `/tmp/opencode-s3a-review-probes.test.ts` 的六项补充检查：6 pass、0 fail、13 assertions。它们使用真实 store／scheduler／coordinator，有限服务包装只用于控制发生顺序；两项关键排序用例已经成为永久回归，其余由现有新增测试覆盖。
- 两个新增测试块及整份 driver 测试文件经 Prettier 检查；新增回归后的 `bun typecheck` 通过。

实施方执行、评审方已读取日志的检查如下；这些结果与上述独立运行分开记录：

| 检查                                                         | 结果                              | 证据                                                              |
| ------------------------------------------------------------ | --------------------------------- | ----------------------------------------------------------------- |
| Core 12 个测试文件，包含 C7 最终取消、归档失败与重复发布回归 | 290 pass、0 fail、1401 assertions | `/tmp/opencode-s3a-core-suite.txt`                                |
| sdk-next 两个测试文件，`--timeout 15000`                     | 6 pass、0 fail、28 assertions     | `/tmp/opencode-s3a-sdk-next-tests.txt`                            |
| HTTP 五个测试文件，C7 之前的宿主接线验证                     | 53 pass、0 fail、290 assertions   | `/tmp/opencode-s3a-http.txt`                                      |
| Core、Server、opencode、sdk-next 各包的 `bun typecheck`      | 均通过；实施方确认 exit 0         | `/tmp/opencode-s3a-{core,server,opencode,sdk-next}-typecheck.txt` |
| S1／S2／S3a 真实进程 E2E                                     | 17 pass、0 fail、214 assertions   | `/tmp/opencode-s3a-process-suite.txt`                             |

完整进程套件包含 S3a 两项、S2 五项和 S1 十项，耗时 332.08 秒；实施方确认所有受 C7 影响的 S1 子进程均在最终 replay runtime 冻结后启动。评审方已读取最终通过日志，并静态读取真实 HTTP 模型、SIGKILL／缺 driver 恢复，以及 SIGSTOP 等待自然 lease 到期后放行旧 provider 错误的进程测试，没有将未独立运行的项目写成独立测试通过。

## 最终审查文件身份

以下路径均相对于 `packages/`；评审方逐个重新计算并核对 19 个 SHA-256，源码及测试均与已审查候选一致。

| 文件                                                       | SHA-256                                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------------ |
| `core/src/pro-contract/executor.ts`                        | `774fa6ab85e837e8b89c1f9cc97f92a03e3c2c7229d3f3e99d5f1eca2f165714` |
| `core/src/pro-contract/observation.ts`                     | `8c02cba7d5bf086b799a7e135a95bfedd977e4a53fadfc64cbf81391c70d56f3` |
| `core/src/pro-contract/replay.ts`                          | `93b85047a4e0b1bd9015e882f3cdfeb796990a91cf2f58b28d44f0d6da05cb31` |
| `core/test/pro-contract-replay.test.ts`                    | `6bfdc419a9069f13c5924851e79c5037faef16b5b153f5d4cf1dcd43266f8f78` |
| `opencode/test/server/pro-contract-process.test.ts`        | `084a72cec8b84bb59feb44c54286a0006f22006060d6f0da26848c4ef50752f2` |
| `opencode/test/fixture/contract-driver-process.ts`         | `389132dbabfae1fbada8a03edb756ed25c0d31bcd904d49df0629128bb42fe6d` |
| `core/src/pro-contract/driver.ts`                          | `ea83ee9235b85ae91444fd2289d93d78ec735d4216555c38f89d6a3b04dd44d3` |
| `core/src/pro-contract/open-code.ts`                       | `108e34e3c7479dd9d51cfc6157f815fdce29eae0878ed84eaab7b1529c71ef01` |
| `core/src/pro-contract/scheduler.ts`                       | `381c16779d0fdeba5ca5d2a87d4148ea313760fbd7e027d0125f946642886782` |
| `core/src/session/execution/local.ts`                      | `fb6ac01190bee7fb0f9af95655a7045924b57ca66285a2f70790754cc0eb4664` |
| `core/src/session/runner/llm.ts`                           | `11b7b249cdadd07ed9ce661cbbce0b352e13ca77bc47e353f3cddb4dee32031c` |
| `core/src/tool/contract-control.ts`                        | `297df2ac8c03c5a44367f270db8b97e9673da4329c3eec52e7796647d521a568` |
| `server/src/routes.ts`                                     | `0b483e0371714fafeaf9d7dd04fa20e9453c8d9925ca153fbf18645cc3ac9877` |
| `opencode/src/server/server.ts`                            | `d4d17a9f760ce7330d9e54e1c3ec282c279d7ef7b7f1c5f3ba6cea174f253a15` |
| `opencode/src/server/routes/instance/httpapi/server.ts`    | `51bcb584fa2e57cea551b5bd9a07307416253ffc297992a67cfb677c558c09ff` |
| `sdk-next/src/opencode.ts`                                 | `5e3494fca45b1413dddffbbb13d17b30c0ec41ef47bd607578a3194464743030` |
| `core/test/pro-contract-driver.test.ts`                    | `524b32e5557d524f04797f8d5523de96ce092bade9a794b0ef4eedc69c5aada7` |
| `opencode/test/server/pro-contract-driver-process.test.ts` | `06755dbce6ada010723e960d7f924405bec5d77cd68ebcb8ebfa8a9955ff3b66` |
| `sdk-next/test/embedded.test.ts`                           | `3a8ad00f0cad5bf75726bd4bf86efec33860cbcbfd0bf3329a59ca530811389f` |

本报告的范围仅是 S3a 通用生命周期与宿主接线。它不证明 S3b 的所有 leaf 执行许可、S4 的研究冻结／评审流程、强进程隔离或真实研究质量已经完成。
