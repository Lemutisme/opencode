# S3b 独立代码审查

审查基准为 [S3b 已批准设计](pro-contract-researcher-s3b.md)及[设计审查](pro-contract-researcher-s3b-review.md)，S3a 实现基线保存在 `/tmp/opencode-s3b-baseline/files`。范围包括 job 身份、原许可传递、实际工具与 leaf 边界、双向清理互斥、独立 verifier、会计和宿主构图。

最终结论：批准本报告所列 57 个冻结 package 文件对应的 S3b 实现。B1–B7 全部关闭，没有遗留 P1／P2 代码审查阻断；静态复核、独立针对性回归、完整 Core 回归及 S1–S3b 最终生产回归均通过。设计基准 SHA-256 为 `e88eafaa02aa84c90f13e586967b97c810ab0df08c0750c79aa98ab93378582e`。下列记录保留初版反例及关闭依据。评审方仅修改本报告，没有修改实现或测试。

## B1 · P1：mapping 缺失可使已知 job Session 降级为普通 Session

初版 `ProContractJob.forSession` 仅查询 `pro_contract_job_session`。mapping 丢失但 job 正文和 Session 仍在时，新的 `ExecutionPermit.capture` 返回普通许可，prompt、mutable 与 runner 随之失去受控身份。已经捕获的旧 job permit 会被拒绝，但不能保护后续重新 capture 的调用。

实施方已增加按 `ProContractJobTable.session_id` 的反查；发现正文仍预留该 Session 时拒绝，不修补 mapping、不收养为普通 Session。正文缺失、mapping 仍在的原有拒绝分支保留。

状态：已关闭。独立 Core 回归覆盖 marker 缺正文和正文缺 marker 两个方向，均返回 `ExecutionDenied`。

## B2 · P1：远端 cancel 提前退休另一 owner 的活 lease

初版 SDK `cancel` 持久撤销后，仅等待本进程的 Session coordinator／activity，然后用刚读到的 job 身份调用 `finish`。宿主 B 对宿主 A 的 job 取消时，B 没有本地执行，因此立即进入 `finish`；旧实现仅比较捕获 owner 与存储 owner，没有比较本地 binding owner。虽然 `authorize` 因 owner 不符失败，cleanup 分支仍清除了 A 的 owner／lease。

这样主 worker 或下一 job 可以在 A 的实际进程／leaf 清理结束前重入，破坏跨进程依赖的 lease 屏障。实施方已要求 `finish` 的 captured owner 属于当前服务图；SDK 远端取消等待旧 owner 退租或原 lease 到期，不能代办退租。

状态：已关闭。独立 Core 回归验证 foreign `finish` 不能退休旧 owner，活 lease 期间不能 audit，过期 audit 保留已知 usage；实施方最终生产进程回归也通过远端取消时旧 owner 的清理屏障用例。

## B3 · P1：直接 canonical Tool 调用未占用清理屏障

初版 activity 仅包围 runner／local drain 和 SDK verifier。设计允许携带可信服务与原 permit 的直接 `Tool.settle`，但它使用的 `ExecutionPermit.run` 未计入 activity。因此一个合法直接 leaf 尚在执行或 finalizer 尚未结束时，SDK cancel 会看到无 Session drain、无 activity，提前 finish 退租。

实施方已把受控 `permits.run` 的完整 acquire／use／release 包入共享 activity；嵌套计数保留外层 drain 和内层操作的生命周期，不通过开始清理就释放屏障。

状态：已关闭。独立 Core 回归让真实 canonical `Tool.settle` 的 finalizer 保持等待，取消并越过 lease 后 root 仍不能打开、job 不能 audit；finalizer 完成后才释放 Activity，原 operation 归档为 interrupted。

## B4 · P2：一般 process guard 错误阻断合法 reference delegation

新 `ExecutionContext.verification` 对所有 root executor 调用要求 `process.execute`，但现有 `reference_run` 同样使用 `ProContractExecutor`，它的独立授权是 `reference.run`，不等于任意进程权限。

评审方从 `packages/core` 独立执行 `bun test test/tool-reference.test.ts`，得到 0 pass、1 fail；合法 `authority: ["reference.run"]` 的 Contract 在 `reference.ts` 调用 executor 时被中断。日志为 `/tmp/opencode-s3b-review-reference.txt`。

修正后，replay 入口检查捕获 context 的 `process` 能力；通用 executor 的会计包装保留原许可检查，不再把合法 reference delegation 改成任意 process delegation。reviewer 仍不能使用该 executor。

状态：已关闭。评审方独立复跑为 1 pass、0 fail、12 assertions；日志 `/tmp/opencode-s3b-review-reference-fixed.txt`。

## B5 · P2：部分崩溃路径的 running 会计没有 unknown 归档路径

初版仅在 `jobs.recover` 对 open job 执行 running→unknown。主 binding 在 SIGKILL 后被新 owner 接管时，没有同步审计旧 root provider／compaction 记录；远端 job 先取消、后等待旧 lease 到期，也因 cancelled 状态不能 recover，而永久遗留 running 记录。

设计要求硬杀遗留的运行记录在恢复审计时标为 unknown。修正须只针对已经确认失去原 owner 的精确执行身份，保留已有 usage 和 usageEvents；不能把另一个仍活跃 identity 的操作一并结束。

实施方已增加精确 `source.identity` 的审计 helper，并在 claim／job open 时保存原 `leaseIdentity`；close、cancel 或 context 变化后不再用当前 grant 反推旧 identity。job recovery 与取消后的 lease 过期审计已接入。复核要求补齐的 root inactive／unavailable sweep 退租分支也已接入，在 Activity 和 foreign live lease 检查之后审计。

状态：已关闭。独立 Core 回归验证 root takeover 只审计旧 identity、保留 usage 并不触碰其他 identity；撤销改变 admission version 后的 sweep 仍按原身份归档；取消 job 的过期审计也保留部分 usage。

## B6 · P1：旧 SDK／local 调用可重新捕获 recover 后的新许可

SDK verifier 初版在 `jobs.start` 返回 job generation 1 后，没有将该 execution 传到后续许可捕获；内部 prepare 后按 Session ID 重新 `capture`。可达交错是：旧 start 提交后暂停，在尚未进入 activity 且无 operation 时 lease 到期；同宿主显式 recover 得到 generation 2 并启动 verifier；旧调用恢复后也 capture generation 2。verifier 没有 Session coordinator，两个调用可借用同一新许可启动进程。

review 的 start→prompt／resume 也需保护原 job 身份。local drain 初版捕获 job permit 只用于最终 finish，而真正 runner 再次 capture；capture→activity 间发生零操作恢复时，旧 drain 可执行新 grant，最终却用旧 token finish，无法正确结束新 job。主 binding 分支已有 `bindings.dispatch(originalExecution)` 检查，job 分支同样需要原许可约束。

修正后，SDK review／verify 整段进入 activity 后先核对返回的原 job execution；verifier 的捕获 permit 还与原 execution 精确比较。local drain 将最初捕获的 `executionPermit` 传入 runner，runner 使用 `require` 比较而不替换为新许可。新增 SDK 定序测试暂停真实 start 的返回，越过 lease 后显式 recover，再放行旧调用，检查旧调用失败、没有新 Session／operation，且恢复后的 job 完全不变。

状态：已关闭。独立 SDK delayed-start 两例均通过；独立 runner 回归确认旧 permit 在 generation 恢复后失败，零 provider、零 operation，恢复后的 job 不变。

## B7 · P2：已开始工具取消后可能没有终态投影

最终 S1 真实进程回归中，replay 的子进程已经执行、随后 root 被撤销，旧测试等待该工具进入 completed／error 超时。仅把断言改成“不是 completed”会接受仍为 pending／running 的工具，不能证明 Session 投影清理完成。

复核区分了两种窗口：尚未送达的迟到 provider tool call 可以完全不入历史；已经由真实进程 marker 证明开始执行的工具，则必须在清理后留下终态。实施方进一步定位到工具 fiber 被中断时没有发布该 call 的 error，而 `FiberSet.awaitEmpty` 可能因集合已经清空返回成功，绕过统一失败投影分支。

实施方已在已捕获工具调用的 interruption finalizer 中、实际 leaf 清理结束后发布该 call 的错误，保留原中断结果。它通过该 provider publisher 的固定 call ID／name 写入，不重新扫描整个 Session；publisher 对已结算工具的重复 error 幂等忽略。生产 replay 断言恢复为 error，并新增真实 runner 定序回归。

状态：已关闭。独立 runner 回归确认工具的持久状态为 error、operation 为 interrupted，且没有额外 provider 请求；最终真实进程的 success／failure／unavailable／timeout／interrupted 五种 replay 撤销场景恢复 error 强断言后全部通过。迟到 provider call 的 takeover 场景允许尚未收到的调用不入历史，但仍检查旧 drain 清理、原 operation 非 running、零控制 ledger／action 变动及新 owner 正常执行。

## 已核对的其他边界

- Session create 的首次创建、既存采用和竞争采用均在权威事务中核对固定坐标；actual permit 检查再次核对持久 Session 的 Location／model／agent。
- reviewer 的实际工具实现必须声明受控能力，仅允许 read capability 和固定 agent；leaf 权限仍由原 agent 规则限制。路径检查使用 canonical 路径，外部目录权限不能扩大 reviewer 的 Location。
- provider 和 compaction 使用同一 operation 入口；usage 到达即记录原始可选字段，缺失值没有折算为零，迟到会计写入不调用 job 完成或 root 控制命令。
- 实施方发现并修正了新通用撤销检查与既有 revision approval 的冲突。修正仅在 accepted petition 后创建 Location scope 所有的 issuer continuation，保存原 receipt 的精确 petition 坐标；这一小段清除 worker context，只等待 permission 并提交一次 `decideRevision` CAS。worker 监控不放宽，issuer continuation 仍受原 deadline、root release 和宿主 scope 约束。最终 S1 生产回归确认旧 once／reject 回复不能决定同内容替代 petition，SIGKILL 后的 pending revision 仅在显式决定后恢复。
- 宿主构图的 LocationServiceMap 保持单一实例，保证 Host jobs、HTTP permission 与 runner 使用同图服务；实施方修正了一次重复构图，最终生产进程回归中的真实 permission 交互、取消和 verifier 场景通过。
- reviewer 的 System Context 使用同一生命周期 Context Source 新增的 review mode，首次 baseline 与后续 prepare 都按捕获的 job 选择；不会因为选用 build agent 而注入普通 Session 的 Contract 发行指导。独立 runner 用例确认实际发往 provider 的系统指导为只读 reviewer，且不包含 `call contract_propose`，没有新增 S4 评审验收语义。

本报告不宣称 S4 研究产物冻结与验收、任意进程／网络／凭据强隔离或外部副作用 exactly-once。reviewer 的路径约束也不构成对外部恶意并发 symlink 改写的强隔离。

## 独立执行的验证

以下均从对应 package 目录使用 Bun 1.3.14 执行，不调用真实模型、不启动实验。各批存在重复用例，结果不累加为不同测试数量。

| 验证                                                                    | 结果                           | 日志                                           |
| ----------------------------------------------------------------------- | ------------------------------ | ---------------------------------------------- |
| Core job、reference 和 compaction 辅助逻辑                              | 22 pass／0 fail／96 assertions | `/tmp/opencode-s3b-review-core-final.log`      |
| SDK review／verify 延迟 start 与显式恢复交错                            | 2 pass／0 fail／12 assertions  | `/tmp/opencode-s3b-review-sdk-final.log`       |
| runner 原 deadline、reviewer 正常／overflow compaction、取消与旧 permit | 8 pass／0 fail／34 assertions  | `/tmp/opencode-s3b-review-runner-final.log`    |
| 补齐 completed-operation crash window 后的 Core job 全文件              | 18 pass／0 fail／75 assertions | `/tmp/opencode-s3b-review-jobs-frozen.log`     |
| B7 修正后的上述 runner 集合，加 reviewer guidance／工具终态             | 9 pass／0 fail／39 assertions  | `/tmp/opencode-s3b-review-runner-accepted.log` |

runner 回归同时核对 compaction 独立 operation、原 deadline、缺失 usage 保持 unknown，以及 reviewer 不改变主 binding 的 turns/actions。

completed-operation 窗口使用真实 SQLite 和 TestClock，模拟 provider operation 已完成而 job finish 未提交的持久状态：recover 将 job 留为 unknown，保留 completed operation 和已报告 usage，后续 capture 拒绝。生产 SIGKILL 覆盖的是 queued 零操作和 running provider 两种窗口，二者证据不混用。

## 实施方执行、评审方核读的验证

以下结果不是评审方再次独立执行的完整套件。评审方核读测试输出和对应场景，实施方确认命令退出状态。

| 验证                                         | 结果                              | 日志                                       |
| -------------------------------------------- | --------------------------------- | ------------------------------------------ |
| Core 扩展回归，45 个文件                     | 629 pass／0 fail／2487 assertions | `/tmp/s3b-core-accepted.log`               |
| S3b 11 项＋S1 10 项生产执行回归              | 21 pass／0 fail／239 assertions   | `/tmp/s3b-execution-accepted.log`          |
| S3a driver 2 项＋S2 recognition 5 项生产回归 | 7 pass／0 fail／75 assertions     | `/tmp/s3b-driver-recognition-accepted.log` |
| SDK 全包                                     | 8 pass／0 fail／40 assertions     | `/tmp/s3b-sdk-accepted.log`                |
| HTTP／生成客户端／授权                       | 53 pass／0 fail／290 assertions   | `/tmp/s3b-http-final.log`                  |

Core、OpenCode、Server、Client、Protocol、sdk-next 六个包的 `bun typecheck`，Core migration `--check` 和冻结文件的 Prettier 检查均通过。公共 Session 错误契约调整后，实施方执行 Client generate 与 legacy SDK build；没有手工编辑生成目录。

早期扩展 Core 回归有 11 个失败，修正的是测试中的有效许可、heartbeat、实际写入观察入口及历史 cassette 的中性 agent；加入 B7 回归后的 629 项最终回归全部通过。HTTP 的旧 5 秒框架超时在 15 秒框架上限下复跑通过，没有调整生产期限或预算。较早的生产整组进程缓存了尚未明确授权 `process.execute` 的 S1 helper；该整组后续的 S1 失败不计为通过，最终采用上述新进程执行的 21 项成功结果。B7 的终态要求没有放宽，使用“不是 completed”的过渡测试结果不作为该发现的关闭依据。

## 批准的冻结文件

实施方冻结清单 `/tmp/s3b-source-freeze.json` 含 57 个 package 文件。评审方已逐个计算 SHA-256，与清单完全一致；清单自身 SHA-256 为 `083ef75e86af122bff43d11e0f5f03930c918a939574302e9a676abd5ccaed3b`。源码不依赖未提交工作树的 HEAD 名称来识别。

| 文件                                                                   | SHA-256                                                            |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `packages/client/src/generated/client.ts`                              | `c4150b5fa43ea32f9dcbe28dec2b2bfec28c203820d3822d1b89e2ba059ac04a` |
| `packages/client/src/generated/types.ts`                               | `0b35a941203654563760c0d5a7d8eb13e7dabbe1c647ce680c340eb058b2f58b` |
| `packages/core/schema.json`                                            | `1b57bf8fa8d42fbf3981ee86f5931f9adfecb6c94eb3986f02b16171462d429a` |
| `packages/core/src/database/migration.gen.ts`                          | `afff0a260f0332e86f5f82f6d3dc6ae2618f83f2b5c703f463518ac7669ec99a` |
| `packages/core/src/database/migration/20260919001200_contract_jobs.ts` | `b281b8c7bbe0242fcd9b3283469fe6c394c8a02e3cf8bac89896333c291a4cf1` |
| `packages/core/src/database/schema.gen.ts`                             | `ca1049089f8b56173e52546692e8835487e169e4341775c1f7d994ad7e68f5ff` |
| `packages/core/src/file-mutation.ts`                                   | `ecaec178ae524a78f84a6d7597a5cc7c9783871b7717b5d1ecae5c7fadb17379` |
| `packages/core/src/permission.ts`                                      | `a18a40635d3f074638a199e45c84b4878bb2a6cafe7549428b9825ec3d438023` |
| `packages/core/src/pro-contract/activity.ts`                           | `4222dbe6da84219da2a575bc9b85e4715930da3ba10c306695f5b5c5da8b9eb7` |
| `packages/core/src/pro-contract/context.ts`                            | `732a439a2ea973548958c1db810b42605ca875ef506addaece412bb8f9a4300d` |
| `packages/core/src/pro-contract/executor.ts`                           | `130550111195fd068affe59fd453f47c158f9088764ea57aeb7fd89a6183951e` |
| `packages/core/src/pro-contract/job.ts`                                | `b4dbdeef9fe9235a1af81b28268de0f83d55dcf10e7198c16e4c2f88842d2ff0` |
| `packages/core/src/pro-contract/open-code.ts`                          | `f91510ac36945a3aeeb1874620ce1d37d8c9051f5190fb07929bd8bbd249f697` |
| `packages/core/src/pro-contract/operation-audit.ts`                    | `06f993f8aa4e9e7821286b32c21c459f6c268c1d09f42d3274f0f3eff7069571` |
| `packages/core/src/pro-contract/replay.ts`                             | `bb3e4ace9a73b8a5a15f5e73c5247d0b93ee636847d1f48a99b09fc49a2e41c4` |
| `packages/core/src/pro-contract/sql.ts`                                | `5b976291b13d531718f529383e0ba17c86fab5c4e24a8a0eaf14846c7ec9fb87` |
| `packages/core/src/process.ts`                                         | `b0987c559e9e58d95977ace28399372a9ea7d6e3eeac6ed50e57abb6ed81c080` |
| `packages/core/src/session.ts`                                         | `7670ef8cf395e8f6ebf7d7099f890925876e3a1548c412f41a408197620e3a0b` |
| `packages/core/src/session/compaction.ts`                              | `2510051bb02106866cee8bdf4c8d95da0361492104015a4fbd30c2a9cc15a41e` |
| `packages/core/src/session/execution-context.ts`                       | `996e34a1bc9d9629d5eea876276e31211b32340d05702e3714a57930481559bd` |
| `packages/core/src/session/execution-permit.ts`                        | `f2bfb37946eee0d014d1ca11c816e8b1d95337baffa4e96a9395426682d95b81` |
| `packages/core/src/session/execution/local.ts`                         | `e6690841d57dc573dad196f7644d41e92f51b8d904b03d973a6bba52b73e70f4` |
| `packages/core/src/session/runner/index.ts`                            | `677b1eb701f8816862478e346c538a022efc23b2cb750ec5df2ca7dcddd7fdbe` |
| `packages/core/src/session/runner/llm.ts`                              | `db3f20222ccb1c3ad5abed1bd69821312a56d7396de79bd12229f2d004ab7575` |
| `packages/core/src/tool/action-fusion.ts`                              | `f87d85ff2d27514c808c2e2c55ad4254bb89c39d463015148fbde9b9bdcf06df` |
| `packages/core/src/tool/apply-patch.ts`                                | `d3d2711af43ce2a769c3d8e818011df9ff896612f76a067d7bb2fbdd8e4f36a2` |
| `packages/core/src/tool/bash.ts`                                       | `437d1ec2c963104a7d86fe2392546fb8958440943e59222ffc59efe79f5d66b2` |
| `packages/core/src/tool/contract-control.ts`                           | `0ecf70b2d8cba52e50be3159916125276a78242e6f74a942c6120ead9dd2d1e9` |
| `packages/core/src/tool/edit.ts`                                       | `197a8800557de5c432f33c3c507fc691e265992215672acd9cd40f69fae3aeeb` |
| `packages/core/src/tool/glob.ts`                                       | `60cc3aa4621712f3a195de14c631096b902f1dbbdc486780614b44cac6f65d11` |
| `packages/core/src/tool/grep.ts`                                       | `a7c4dc6b47ab6340b1e50c1abea2967e199428c8144c13a5989505fc7f1df4d7` |
| `packages/core/src/tool/observation.ts`                                | `673388d2c83551679e882e84e61de31e589c780bc36f9a15cc74b77530d029ff` |
| `packages/core/src/tool/read.ts`                                       | `a05950997f246e78b44c726146d2c4b4554ba54de42a7afeabc3e6b3535b0409` |
| `packages/core/src/tool/reference.ts`                                  | `755b461d9590f389741e4c4119a01ef0609a87d300d4a315a39985f61fbc1cbc` |
| `packages/core/src/tool/registry.ts`                                   | `ffc062eee49d3321617753ef69715d8bd99deabb780d91f6e2e8ace040a3d3ed` |
| `packages/core/src/tool/todowrite.ts`                                  | `96b08a9ddec5be7e8ef854099f63126b87218f56ca6224638ce23cf0dbfa7ca1` |
| `packages/core/src/tool/tool.ts`                                       | `66f74f92ce95b04840f98b5aecfbaba012b55ac5465b71cb7da20da9057aabce` |
| `packages/core/src/tool/write.ts`                                      | `9518e1659c4f4774a5bd50df1df311fa32f122ea4d36cd04012b7f1e54195767` |
| `packages/core/test/location-layer.test.ts`                            | `f0aa42743df6560b0bfc0db7f753dfaa9f9cf635e491f44a50ec8b67e8341897` |
| `packages/core/test/pro-contract-control.test.ts`                      | `12191cfb825c0fefda6a991e368250ae44d6c54c4007804817c259092932d1fa` |
| `packages/core/test/pro-contract-job.test.ts`                          | `d0eef0d842c1aab49fdb2dddf612bdca881857c96f356051906a55f085659e16` |
| `packages/core/test/session-observation-policy.test.ts`                | `d2fa05831f826e241d11d6c671e5c0637632c39f2e8fdbb6117483b3479480d4` |
| `packages/core/test/session-runner-recorded.test.ts`                   | `7ffc8b4ff0ccedcd9a3645c2c18d37487fe5cdf2b5327c398802035021a0f6f2` |
| `packages/core/test/session-runner-tool-registry.test.ts`              | `1f468ee25460db84246f0967ccbf1c0856420ee981a7794927ea3b0bcda327ad` |
| `packages/core/test/session-runner.test.ts`                            | `d5752b38644378a328d7527fb3ae206780e1d7e052164670aeb4eb2ffa4519e4` |
| `packages/core/test/tool-action-fusion.test.ts`                        | `428238435294f35c64315d7a2e2c76f05cb62631bd54f8a6c7ebdd1bad0a5ff1` |
| `packages/core/test/tool-write.test.ts`                                | `23844c3cd2b61325a5a3ebbf6f098a23dc701993b84648b20eb95033accaa3a3` |
| `packages/opencode/test/fixture/contract-driver-process.ts`            | `2ebe0320f3c86d9722f82a844729f61135825cf730e94d6aa5979e5b7badace6` |
| `packages/opencode/test/fixture/contract-process.ts`                   | `19020a9641f5e73b2a75bba557bf667799c617ce6c7bb92eebc76ded032e5425` |
| `packages/opencode/test/server/pro-contract-job-process.test.ts`       | `e7e26f26042ba3c285b9e912fcc1e31d14e898385f06d4373739c4615c4f4902` |
| `packages/opencode/test/server/pro-contract-process.test.ts`           | `482a57c4fcd6afb06cf7fed94d59fbd0218f1917a8a536489e0a06d71cf9ff85` |
| `packages/protocol/src/groups/session.ts`                              | `19dfd63a8bc5112bf26b720faa9f42bc99bff471a69a8a7a50ba61a9365ebadf` |
| `packages/sdk-next/src/contract-jobs.ts`                               | `dd568fd370f36fb9a08d8e7646094217089b25af572714067aeadc02c15e9da0` |
| `packages/sdk-next/src/opencode.ts`                                    | `d9d83597bb40bccfa92b08bdbefd0e6f2716272783d3bb6c2f6b981a32f0dcf3` |
| `packages/sdk-next/test/contract-jobs.test.ts`                         | `011f38b814464a296546f13562fa0fd928c4fe232a35b13e56678a4080868dee` |
| `packages/sdk/js/src/v2/gen/types.gen.ts`                              | `62b4da2e895741e83d5509ac8833dd863b29a1df060d942a29e71ac020ccfcfc` |
| `packages/server/src/handlers/session.ts`                              | `bda861d3348d92aaef987e11fd090bf519d075ac8fa648f01619a994b6d32cbe` |
