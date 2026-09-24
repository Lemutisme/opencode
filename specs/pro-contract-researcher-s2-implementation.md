# S2 实施与验证记录

日期：2026-09-18。分支与 HEAD 保持原状，前置 S1 未提交变更完整保留。本轮实施依据 [S2 设计](pro-contract-researcher-s2.md)；独立审查分别见 [设计评审](pro-contract-researcher-s2-review.md)和 [代码评审](pro-contract-researcher-s2-code-review.md)。状态：已完成；独立代码评审通过，已发现问题全部关闭，最终检查通过。

## 实现边界

不变量是“只有调用方明确审查的那一轮交付、那份上下文和那次修订申请，才能被当前操作改变”。没有这层约束时，相同文件再次交付会复用 subject，旧批准或旧缺陷反馈可能作用于新交付；重复请求也可能重新建立已被撤销的支持。HTTP 预检查无法覆盖事务竞态、直接 Core／CLI 调用及 evaluation helper，因此约束位于共享 store 的权威事务入口。

纯 kernel 的命令代数、旧 Spec hash、Contract 投影和历史事件格式不变。新增的通用概念为交付／上下文身份、全局 operation ID、不可变操作回执、可注入验收校验器；没有新增研究决策或 Principal 策略。

- 成功产生 handoff 的 accepted `report-ready` 事件 hash 构成唯一 `handoffID`。完整账本重放与当前投影一致才返回身份；失败 replay、缺事件、错误 hash 或矛盾投影均不能被认作有效交付。
- 上下文按版本追加，绑定 revision、specHash、不可复用 phaseID 及可选 handoffID。新交付、challenge 全依赖闭包、接受修订、resume 和 release 同事务使旧上下文失效；未知 profile 保留，不能因 issue 重试或缺少记录回退为 native。
- `principalAttest`、`challenge`、`decideRevision`、`settleEvaluation` 统一检查非空 operationID。缺身份属于准入错误，不伪造回执；完整但过期的请求提交 rejected ledger 与 operation receipt。private execute 对三类权威命令要求内部授权上下文。
- operation 主记录保存首次请求指纹；附属 attempt 记录保存不同内容复用 ID 的独立拒绝。完全相同的请求返回原 decision/frontier/hash，并另算当前 `support.valid`。已被 challenge 的历史成功不会重新 discharge。
- profile validator 在事务外检查保存的候选与证据快照；提交时重新比较 target、admitted、validator 实例与 identity。空字符串是拒绝，不能按 falsy 值解释为通过。撤销支持和处理原修订申请不依赖成功验收校验器。
- evaluation v2 report 同时绑定 delivery target／attestation 和 evaluation 自身 ContextTarget。正分支的 activation、handoff、discharge 原子提交；普通拒绝也回滚 savepoint 内的全部状态和事件，再单独保存拒绝。负分支经过同一身份检查后挑战确切 delivery。helper 仅支持 native，v1 report 拒绝。

新增 migration 创建 context、operation、attempt 三张表，并为历史原生职责初始化上下文。迁移不改写历史事件、attestation 或其 hash，不为旧认定补造 operationID。get/list/recognition/export 都提供同一数据库快照捕获的身份；export 完成后不刷新核验坐标。

## 调用方式与兼容性

HTTP 的 attest/challenge payload 必须包含 `operationID` 和完整 `expected`，后者来自之前保存的 `recognition.handoff` 或 export 的 `target`。revision decision 使用之前保存的 `recognition.pending`。旧的 identity-free payload 返回输入错误，不自动补最新身份。

```json
{
  "operationID": "a-stable-id-saved-before-submission",
  "expected": {
    "revision": 1,
    "specHash": "reviewed-spec-hash",
    "subjectHash": "reviewed-candidate-hash",
    "handoffID": "pch_accepted-event-hash",
    "contextHash": "reviewed-context-hash"
  },
  "evidenceHash": "independent-report-hash"
}
```

成功响应是完整 OperationReceipt；409 的 `ProContractRecognitionError.receipt` 保留同样可重试的历史回执。调用方必须分清历史 `decision` 与观察时的 `support.valid`。

CLI 用保存的 JSON 文件提供 target：

```sh
opencode contract attest pct_example --expected target.json --operation-id saved-id --evidence-hash report-hash
opencode contract revision pct_example --expected petition.json --operation-id saved-decision-id --accept=false
opencode contract evaluation settle pct_eval_example --report report-v2.json --operation-id saved-evaluation-id
```

TUI 提交用户看到的 Contract snapshot，并准确显示历史成功但当前支持失效的情况。现代 Promise／Effect Client 与旧 JS SDK 已按项目生成流程更新；sdk-next 继续复用同一个 Server 认证边界。feedback-screen 在 oracle 执行前保存 export target 和 operationID，报告全部坐标来自该 target，认定结果同时检查当前支持。未启动实验，未修改冻结 cohort 或历史 artifacts；未重建历史实验镜像，旧 export 缺少 target 时脚本明确失败。

## 验证证据

测试均从相应包目录运行，Bun 1.3.14。进程 E2E 使用生产 Server、真实 CLI／HTTP／SDK、磁盘 SQLite、本地脚本化模型 HTTP 服务和真实 SIGKILL；模型行为可控，LLMClient、工具、调度器及存储未被替换。

| 检查                                                                                   | 结果                                                                                                         |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Core 九个相关测试文件，包含 kernel、执行授权、runner、export、recognition 和 migration | 260 pass、1,178 assertions，约 43 秒。                                                                       |
| S2 focused recognition 回归                                                            | 21 pass、178 assertions；包含在 Core 总组内，不重复相加。                                                    |
| S1 生产进程 E2E                                                                        | 9 pass、121 assertions，约 180 秒。                                                                          |
| S2 生产进程 E2E                                                                        | 5 pass、55 assertions，约 77 秒。                                                                            |
| ProContract 认证／HTTP 集成                                                            | 3 pass、21 assertions。                                                                                      |
| OpenAPI／Schema 错误／旧 SDK 集成                                                      | 41 pass、252 assertions。                                                                                    |
| Schema 边界与 hygiene                                                                  | 12 pass、44 assertions。                                                                                     |
| 现代 Client                                                                            | 16 pass、75 assertions。                                                                                     |
| sdk-next                                                                               | 5 pass、19 assertions；包含真实 embedded router 和通知隔离。                                                 |
| 包级 typecheck                                                                         | Core、Schema、Protocol、Server、Client、opencode、TUI、sdk-next 全部通过。                                   |
| 生成与格式                                                                             | 现代 Client 与旧 SDK 生成脚本已完成；migration 漂移检查包含在 Core 组；Prettier 与 `git diff --check` 通过。 |

S2 进程场景覆盖同内容重交、并发首次提交、旧请求格式拒绝、两代 SDK／Effect Client、接受和拒绝响应丢弃后杀进程重试、冲突回执再次重启恢复，以及真实 CLI 的 attest、正负 evaluation、旧报告／空 ID 拒绝和保存的修订申请决定。新增 CLI revision 用例初次暴露测试同步过早：binding 已 dispatched 时 Session 尚未创建；已改为等待真实 provider 请求，再查询 permission。

sdk-next 全套测试初次出现 3 项 `SQLITE_CANTOPEN`：`Database.node` 首次导入时捕获的路径已被第一个测试删除。测试夹具改为由 suite 保持数据库目录到 `afterAll`，每项 workspace 仍独立；未改变 SDK runtime，独立复核与完整重跑均通过。

独立代码审查发现并关闭了空拒绝理由、evaluation 空证据、共享依赖指数遍历、空 operationID 和脚本坐标混用五项问题；对应回归已加入。评审方的独立执行范围和最终代码指纹以其报告为准。

## 剩余范围与性能限制

S2 建立精确认定与审计边界，不证明研究结论正确，也没有实现真实研究 reviewer、冻结屏障或研究 driver。S3a 的旧 drain 结束回调与完整 driver 生命周期仍是下一切片；S4／S5 才接入研究报告验收与计划门槛。当前部署仍依赖可信宿主和既有隔离条件。

历史读取仍扫描并校验全局账本。相同 ledger／head／projection 内容指纹会复用重放结果，上下文始终重新读取；内容改变、损坏或 savepoint 回滚不会误用缓存。独立评审在 3,000 个职责／issue 事件的合成内存库中观察到首次 get 约 411 ms、缓存后约 30–32 ms。此处尚无增量 checkpoint，不把这组数据解释为大型长期数据库的性能保证。依赖支持检查已按职责 memoize，保留独立递归栈检测环。
