# S3b 实施与验证记录

日期：2026-09-19。范围：受控 job、实际执行许可、取消／恢复和操作会计。实现及最终回归已完成，独立代码审查结论在本报告末尾记录。

设计基准为 [S3b 设计](pro-contract-researcher-s3b.md)，设计 SHA-256 为 `e88eafaa02aa84c90f13e586967b97c810ab0df08c0750c79aa98ab93378582e`。该设计与 [设计审查](pro-contract-researcher-s3b-review.md) 保持冻结。S3a 工作树基线保存在 `/tmp/opencode-s3b-baseline`；S1–S3a 的既有改动没有被覆盖或提交。

## 实现结果

宿主现在可以为同一 root Contract 发行独立 reviewer 或机械 verifier job。它们不占用主 worker 的 binding Session，不继承 worker 对话，也不创建新的模型循环。reviewer 通过已有持久 Session inbox 和串行 runner 执行；verifier 通过既有 replay／进程执行器处理冻结输入。

`sdk-next` 的 `contractJobs` 提供 `create/get/start/verify/recover/cancel/audit/operations`。这些是可信宿主接口，公共 HTTP 没有新增 job 发行接口。现有 HTTP Session 路由与宿主调用使用同一服务图、同一个 LocationServiceMap；权限请求与执行者属于相同 Location 实例。

`ProContractJob` 保存不可变的 root／ContextTarget／driver／角色／材料 hash／Location／model／agent／Session／Prompt，以及原 deadline、owner、generation、版本、租约和结果。job 与独立 Session 标记在一个 SQLite 事务中预留。普通 Session 不能被事后认领；预留 ID 的 create／adopt 也必须匹配坐标。缺正文或缺标记均拒绝受控执行。会话切换 model／agent 及 revert 同样拒绝。

`ExecutionPermit` 贯通主 worker、job 和普通 Session。runner、provider、自动／overflow compaction、canonical Tool、权限等待及真实文件／进程边界都核对最初捕获的身份。local drain 显式传递原许可；SDK 延迟返回的旧 start 也不能借用 recover 后的新 generation。Registry 仍只负责 canonical 工具查找、环境传递、原有计数和输出结算，没有增加授权回调或第二种可执行工具。

reviewer 使用独立的 review 系统上下文，明确只读评审角色，不注入普通 worker 的 Contract admission 指导。reviewer 只可使用已声明支持受控执行的 read／glob／grep 实现，同时受原 agent 权限与 root 的读取授权限制。实际路径须留在固定 Location；外部目录批准不能放宽该限制。越界路径返回工具失败，许可撤销则中断执行。未声明的同名应用工具、写入、任意 shell、Contract 控制和网络工具均不能通过受控工具边界。

verifier 的 subjectHash 和 replay policy 绑定固定输入；只能通过冻结的机械验证入口执行。每个实际进程受原 deadline 和单项 timeout 共同约束，取消后清理进程并保留已捕获的部分证据。合法的 `reference.run` 保持其独立授权，不被错误改成必须拥有任意 `process.execute`。

## 生命周期与会计

主 worker 与 job 的执行互斥是双向的。job start 检查主 binding 已停止；worker open／claim 检查活跃 job。进程内共享 Activity 覆盖完整操作及其 finalizer，包括直接 canonical Tool 调用。取消先持久撤销，再等待清理；另一宿主不能替原 owner 提前清掉活租约。

恢复是显式操作。原租约到期且本地执行停止后，只有从未开始任何 operation 的 job 可获得新 generation，仍使用原 Session／Prompt／deadline。只要存在已开始的 operation，即使它已完成而 job finish 尚未提交，也不能自动重放；job 标为 unknown，由宿主检查后决定是否另建带 lineage 的任务。已完成或已取消的 job 不能重新打开。

新增 provider／compaction／tool／verification operation 记录，分别保存原执行身份、起止时间、状态和原始可选 usage。usage 到达立即入库，不等待工具结束；没有上报的字段不推断为零。晚到会计只能补原 operation，不能完成已取消或新 generation 的 job。

root 和 job 在 claim／start 时保存原始 `leaseIdentity`。租约过期接管、失效 root 的 sweep 退租、job 显式恢复及取消后的 `audit`，只将该原身份遗留的 running operation 改为 unknown，保留已知 usage 和全部 usageEvents。close／cancel 改变许可版本后仍能审计原执行。正常清理结束的操作保留 completed／failed／interrupted。

S3a 已有修订审批继续存在：worker 提交 accepted petition 后即失去执行许可，但用户仍可处理这一 exact petition。Location scope 中的有限 issuer continuation 只等待原 permission，并按原 petition frontier／revision／specHash 作 CAS 决定；不获得 provider、工具或文件能力。宿主消失则保留 pending；这没有实现新的 Principal Agent 策略。

## 数据与兼容性

新增 `pro_contract_job`、`pro_contract_job_session`、`pro_contract_operation_usage` 三张表，迁移为 `20260919001200_contract_jobs.ts`。旧迁移和历史记录保留。纯 kernel 的状态和命令没有改变。

Session create／prompt／switch／revert 的公共拒绝结果使用 ForbiddenError。已通过 `packages/client` 的 `bun run generate` 和 legacy `packages/sdk/js/script/build.ts` 更新客户端；生成目录未手工修改。

受控调用现在必须有明确的实际能力：root 的 replay／shell 需要 `process.execute`，读写需要相应 filesystem authority；以前只依赖目录过滤的直接调用会被拒绝。自定义 canonical 工具没有受控声明时仍可用于普通 Session，但不能替代受控工具。首版 job 只支持 deadline-only root；含 turns／actions ceiling 的 root 在发行 job 前拒绝，不使用巨大有限值模拟无限。

## 验证证据

全部 provider 为确定性的本地 HTTP 测试服务；没有调用真实研究模型或运行 ProgramBench。Core 测试使用真实 SQLite、实际 Session／Tool／Permission 边界，并仅在需要定序时包装真实方法。生产 E2E 使用独立 Bun 宿主进程、磁盘数据库、真实文件和验证子进程。

| 检查                                                        | 结果                               | 日志                                                        |
| ----------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------- |
| Core：Session、工具、权限、进程及 S1–S3b，45 个文件         | 629 pass，0 fail，2,487 assertions | `/tmp/s3b-core-accepted.log`                                |
| SDK 构图、HTTP、导入边界与延迟 start                        | 8 pass，0 fail，40 assertions      | `/tmp/s3b-sdk-accepted.log`                                 |
| HTTP Contract、SDK、OpenAPI、Schema、认证                   | 53 pass，0 fail，290 assertions    | `/tmp/s3b-http-final.log`                                   |
| S3b／S1 生产进程 E2E                                        | 21 pass，0 fail，239 assertions    | `/tmp/s3b-execution-accepted.log`                           |
| S3a／S2 生产进程 E2E                                        | 7 pass，0 fail，75 assertions      | `/tmp/s3b-driver-recognition-accepted.log`                  |
| Core／Server／sdk-next／opencode／Client／Protocol 类型检查 | 六包全部通过                       | `/tmp/s3b-*-typecheck*.log`                                 |
| 生成迁移检查、格式与 diff whitespace                        | 通过                               | `/tmp/s3b-migration-check.log`、`/tmp/s3b-format-check.log` |

较早的组合进程运行在 S3a／S2 通过后遇到旧 S1 夹具失败，不计为整组通过。修正夹具与工具中断终态后，上述两组共 28 项进程测试均在最终冻结源码上完整复跑，两个命令退出码均为 0；五种已开始 replay 的撤销用例均严格要求工具为 error。

最终 package 源文件清单为 `/tmp/s3b-source-freeze.json`，包含 57 个文件，完整 hash 表由独立代码审查报告归档。设计、设计审查、既有 Contract Schema／Protocol／store／S2 迁移及此前审查文档均通过基线 hash 比较；纯 kernel 无改动。

可复现命令（分别在对应包目录运行）：

```sh
# packages/core
bun test --timeout 15000 test/pro-contract*.test.ts test/session*.test.ts \
  test/tool-*.test.ts test/permission.test.ts test/file-mutation.test.ts \
  test/process/process.test.ts test/location-layer.test.ts test/database-migration.test.ts
bun script/migration.ts --check
bun typecheck

# packages/opencode
bun test test/server/pro-contract-job-process.test.ts \
  test/server/pro-contract-process.test.ts
bun test test/server/pro-contract-driver-process.test.ts \
  test/server/pro-contract-recognition-process.test.ts
bun test --timeout 15000 test/server/httpapi-pro-contract.test.ts \
  test/server/httpapi-sdk.test.ts test/server/httpapi-public-openapi.test.ts \
  test/server/httpapi-schema-error-body.test.ts test/server/httpapi-authorization.test.ts
bun typecheck

# packages/sdk-next
bun test --timeout 15000
bun typecheck

# packages/server, packages/client, packages/protocol，各自目录
bun typecheck
```

新增生产场景包括：独立 reviewer 与公共入口拒绝；权限等待期间 usage 持久化；两个宿主的取消／清理屏障；write／bash／组合工具第二阶段等待批准时撤销；外部路径与 symlink；SIGKILL 前后零操作 job 的显式恢复和已发请求 job 的禁止重放；root verification 下运行 verifier；取消／原 deadline 杀停验证进程并归档部分证据。completed operation 但未提交 job finish 的崩溃窗口由真实 SQLite 定序测试覆盖，不宣称该窗口也经过 SIGKILL 测试。

扩大回归发现的旧测试夹具已按新授权条件更新：长时间直接工具调用维持真实 heartbeat，测试 canonical read／write 显式声明能力，机械 replay 的测试 Contract 明确授权进程。FileMutation 测试观察 guard 后的实际写入入口。历史 HTTP cassette 使用显式无额外系统指导的 fixture agent，原录制字节未改。HTTP 的 5 秒框架超时以 15 秒复跑；生产 deadline、lease 和预算未调整。S1 进程夹具对带 replay 的 Contract 补齐显式进程授权；旧 takeover 用例改为检查旧 Session 已 idle、原 operation 全部结束、无成功旧工具及控制账本效果、新执行仍可继续。撤销可能在 provider 发出工具前生效，不要求被取消的响应一定产生工具错误。原审批的迟到回复以 issuer continuation 的持久拒绝 receipt 检查，保留新 pending 与权限请求不变的断言。

## 独立审查与限制

[独立代码审查](pro-contract-researcher-s3b-code-review.md) 记录 B1–B7 的反例、修复与复核：缺 mapping 降级、远端取消提前退租、直接工具清理屏障、reference 授权回归、崩溃 unknown 会计和旧许可重捕获，以及已中断工具的终态投影。独立 reviewer 已关闭全部七项发现，批准冻结源码对应的 S3b 实现，没有遗留 P1／P2 审查阻断。报告区分 reviewer 独立执行的测试与核读的实施方回归记录；reviewer 没有修改实现或测试。

S3b 保证执行机制和审计边界，不保证 reviewer 的研究判断正确。当前 `completed` 仅表示执行结束；它不是 review accept、研究通过或 Contract discharged。已开始的受控工具在 leaf 清理后的 interruption finalizer 中发布该 exact call 的 error 终态；该回调不扫描整个 Session，也不接触新 generation 的工具。尚未到达的 provider 工具调用不会被伪造为已执行记录。

候选工作区仍是合作式隔离。文件路径检查不能对抗外部恶意并发改写 symlink，跨宿主的停止依赖租约与合作式检查，不是内核级进程／网络／凭据隔离。verifier 执行宿主已授权的冻结命令，其强隔离适配器尚未建设。

S4 才贯通候选冻结、机械检查、独立评审解析、证据 bundle 与交付／challenge；S5 才实施计划及方法门槛。生产研究 profile 仍未开放，本轮没有新增 Principal 策略，也没有启动真实研究任务。
