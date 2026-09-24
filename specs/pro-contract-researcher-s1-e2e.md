# S1 应用端到端验证

日期：2026-09-18。对应 [S1 实施记录](pro-contract-researcher.md#95-s1-实施记录2026-09-18)。本报告由实施方记录测试执行，不是新增的独立代码评审。

## 测试边界

[测试入口](../packages/opencode/test/server/pro-contract-process.test.ts)在测试进程外启动生产 `Server.listen()`；使用实际 HTTP 路由、认证、服务图、ProContract scheduler、Session admission、runner、模型协议适配器、工具、权限和 SQLite migration。生产子进程不注入测试 layer，不直接调用 Core service，也不替换时钟。

本地 [HTTP 模型 fixture](../packages/opencode/test/lib/llm-server.ts)提供确定性的 OpenAI-compatible SSE 响应。真实 runner 通过生产适配器请求该服务，由响应驱动工具调用；它不是脚本化 `LLMClient`，也不使用付费模型。配置、数据库、Git 工作区、XDG 目录和认证全部使用测试专属资源；子进程环境使用允许列表，不继承提供商凭据。

正常写入通过模型发出的 `write` 调用完成。replay 从真实 Git 快照物化候选，再运行真实子进程。接管使用 `SIGSTOP` 暂停旧服务器，让 30 秒租约自然过期，由第二个生产 scheduler 领取；随后恢复旧进程并释放旧响应或旧审批。不修改 binding、generation、lease 或 Contract 数据来伪造接管。

公共接口没有 ledger 和 generation 查询，因此测试仅以只读 SQLite 连接检查这些内部持久记录。状态变更与批准、拒绝、撤销都经过 HTTP。等待依赖服务器就绪文件、上游 HTTP 请求、Session 活跃状态、权限请求、replay 就绪文件及有期限的条件轮询。

## 场景与断言

| 场景                         | 用例数 | 验证内容                                                                                                                                                                                                            |
| ---------------------------- | -----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 正常交付与重启               |      1 | 模型写 `answer.ts`；快照运行代码检查；ready 进入 verification；拒绝使用 replay 本身作为外部验收证据；外部确认后 discharged；`SIGKILL` 后读取相同状态、账本和对话。                                                  |
| 租约过期后旧响应晚到         |      1 | 新 owner、generation 和 Session 已生效后，旧响应的 ready、blocked、revision 三个调用均持久记录错误；不提交 handoff、blocked 或 petition，不消耗 action；新执行仍能正常 ready。                                      |
| replay 中通过 HTTP 撤销授权  |      4 | 分别让回放成功、检查退出非零、命令无法启动、命令超时；旧结果均不得交付或升级职责。合法启动的一次 action 保留，真实回放报告保留；存在状态命令的拒绝保留 ledger receipt。强杀重启后状态、计量、账本和报告不变。       |
| 同条款修订被替换后旧审批晚到 |      2 | 外部先拒绝原申请；新执行重提相同 revision 和 specHash；旧 permission 的 approve、无说明 reject 均被拒绝，不得批准或清除新 pending。新申请的权限等待仍存在，账本保存拒绝决定。                                       |
| pending 修订中进程崩溃       |      1 | 强杀等待批准的服务器；重启后 pending 和历史仍在，原内存 permission 不被伪造恢复。另一个定时 Contract 证明 scheduler 已运行越过原租约期限，原申请仍未被重试。显式 HTTP 接受后，新的 revision 和 Session 才继续执行。 |

接管用例也等待旧 Session 的生产 drain 退出，再检查结果，避免只在工具返回前读取瞬时状态。replay 用例检查报告内实际的 `completed`、`unavailable`、`timed-out` 和退出码，防止把其他失败误当成预期分支。

## 执行记录

环境：Linux，Bun `1.3.14`，当前分支工作树。运行命令均位于 `packages/opencode`：

```sh
bun test test/server/pro-contract-process.test.ts --timeout 90000
bun typecheck
```

| 检查                                                            | 最终结果                                                                                                                                                            |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pro-contract-process.test.ts`                                  | 9 项通过，0 失败，121 个断言，180.99 秒。                                                                                                                           |
| pending 崩溃用例专项复验                                        | 1 项通过，15 个断言。完整套件运行期间，将 binding 读取移至 permission 就绪之后，消除捕获租约时与 heartbeat 的潜在竞态；此项按最终源码重新运行，不累计为第十个用例。 |
| 既有 `httpapi-pro-contract.test.ts`                             | 3 项通过，21 个断言。                                                                                                                                               |
| `bun typecheck`                                                 | 退出码 0。                                                                                                                                                          |
| 新增 TypeScript 与修改 Markdown 的 Prettier、`git diff --check` | 通过。                                                                                                                                                              |

本组测试未发现需要修改 S1 运行时代码的新问题。测试证明所列控制路径在这些进程级故障下的行为，不构成整个 Researcher 已可靠的结论。测试结束后清理临时工作区、数据库和子进程；报告持久化的断言发生在清理之前，包含强杀重启后的重新读取。

运行时代码保持此前独立评审的版本；`git diff --binary -- packages/core/src | sha256sum` 为 `e08420fea228d524cae5a97f6c49a32de86cb3f6993061ba5e121a507f762a32`。本次新增进程测试及 fixture，不修改公共 Protocol、HttpApi 或生成文件。

测试开发中修正了两个 fixture 问题：复用不存在文件的 `BunFile` 会缓存负查询；以及绑定已领取不代表 Session 已创建，必须等待对应的模型 HTTP 请求再查询权限。这些是测试同步问题，不计作 S1 运行时漏洞。

## 结论的适用范围

- 这是生产服务组成的应用 E2E，尚未覆盖 CLI 参数解析、打包产物、其他提供商协议或真实模型的研究判断质量。
- 真实 scheduler 在已消耗 turn 的租约过期后会换 Session。本组验证这种生产接管；“同一 Session 再 claim 后旧 generation 无效”仍由 Core 集成测试覆盖，不把两者混同。
- 两进程接管是制造旧执行的故障场景，不代表已经支持集群 Session 执行。旧 drain 的终止 provider error 等完整生命周期 fencing 仍属于 S3a。
- public revision decision 仍是决定当前 pending 的兼容接口；本组 ABA 证明的是控制工具等待 permission 后的 exact petition 绑定，不能据此宣称 S2 的公共精确接口已实现。
- 冻结写入屏障、独立研究 reviewer、计划门槛和强进程隔离尚未实现。正常用例中的外部验收由测试程序扮演调用方，没有在 OpenCode 中新增 Principal Agent。
- 使用 `SIGSTOP` 的三项接管测试在 Windows 跳过；本轮 Linux 执行不跳过。这些故障测试不接触已有研究实验或 frozen cohort。

此前 `session-runner.test.ts` 的延迟响应测试使用脚本化 `LLMEvent`；Core 的持久化测试仅重开数据库。它们属于集成测试。本组另外建立 HTTP 模型边界与真实进程强杀／重启边界，不追溯性地把原测试改称 E2E。
