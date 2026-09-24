# S4 独立设计审查

审查对象为 [S4 实施设计](pro-contract-researcher-s4.md)，初版 SHA-256 为 `58894f3ce50253309d9479a3880cbf5d9276d9b666892a4dea8781891f5d4f2d`，并参照 [Researcher 总方案](pro-contract-researcher.md)及 [Core Constitution](pro-contract-constitution.md)。源码基线是已验收的 S3b 工作树，实施方快照位于 `/tmp/opencode-s4-baseline`。`HEAD` 为 `78bec19263814444ab008c58d54835b59b4a1c6b`，但本轮读取的实现包含未提交修改，不能仅凭 commit 重建。

最终结论：修订后的设计通过，初轮两项 P1 均在设计层关闭，没有遗留 P1／P2 设计阻断。最终复核通过并冻结的设计 SHA-256 为 `f94a1f624ae0d01040705ef127f1cd522060149b2c2914e681baceb5d9253926`。SDK 私有研究状态、独占 worker worktree、独立 reviewer、共享认定门禁和外部 challenge 修复方向可行。以下保留初版的反例及实施验收条件，修订关闭依据见文末；此结论不代表实现或研究质量已经通过验证。

## F1 · P1：拒绝旧协调器的阶段提交，仍不能阻止其启动新的 job

初版第 3 节要求阶段提交比较 run owner／generation、原 ContextTarget 和状态，并在耗时操作期间续租。但 S3b job 的执行许可有自己的 owner／generation／lease；run generation 不在其许可中。当前 [`jobs.start`](../packages/core/src/pro-contract/job.ts#L344) 只要求 prepared job，并通过 [`open`](../packages/core/src/pro-contract/job.ts#L247) 检查 root、Activity 和其他 job lease。[SDK start／verify](../packages/sdk-next/src/contract-jobs.ts#L76) 随后直接启动 Session 或 replay。

可达顺序：协调器 A 在 run generation 1 下记录 prepared job J，然后停在 `jobs.start` 前；run lease 到期，B 接管为 generation 2，保留 J 并等待显式恢复；A 恢复，调用 `jobs.start(J)`。此时 root ContextTarget 未变化，J 仍 prepared，S3b 检查全部成立，旧协调器因而启动新的 provider／验证进程。A 最后不能发布报告，并不能撤销已经发生的计算，也不能满足“崩溃后由显式恢复决定是否开始”的承诺。

相同问题适用于先校验 run、等待、再调用 `setAdmission(open)` 的路径，以及事务外开始的 capture／materialize。旧协调器只有在写 checkpoint 时才被 fence，仍可以重新打开主执行或消耗计算时间。仅检查 owner／generation 也不够：lease 已过期但尚未被另一 owner 接管时，两者仍未变化。

需要的修正：

- 所有新工作准入在同一个数据库事务中核对 run owner／generation、事务当前时间下仍有效的 lease、expected stage、原 ContextTarget、取消和原 deadline，再完成 job create／start、worker open 或相应持久操作准入。不能把事务前查询视为授权。
- 将启动准入与耗时执行分开。当前 `contractJobs.start` 会继续等待 Session 执行，不能把整个调用放进 SQLite 写事务。应在事务中准入一次，提交后复用原生 Session／replay 路径执行已准入的精确 Job Execution，不进行第二次隐式 start，也不复制 agent loop。
- capture／materialize 等宿主工作同样需要持久、可核对的操作身份和准入，并监控原 deadline、取消及所声明的 lease 条件。失效后只允许有界清理与保存已产生的记录。
- 明确已合法准入 job 与协调器接管的关系。保留其独立 job 身份可以核对历史结果；禁止的是旧协调器在失效后再发起新的工作。不得通过刷新 job 输入、owner 或 root target 来使旧调用继续成立。

验收应在“run 检查后、job start 前”和“run 检查后、worker open 前”设置 barrier，分别令 lease 单独过期及让 B 接管，然后释放 A。旧调用必须无新 provider／process 请求、无新 worker admission；还要覆盖旧 A 复用现有 prepared J 的情况。合法准入后的执行不得持有长事务，并须保留原计量及 deadline。

## F2 · P1：Node 会把零显式用例的文件报告为一个通过的测试

初版第 2 节冻结 Node executable、runner 参数和 harness hash，并要求完整平面 TAP、非零测试数和匹配的计划。这能限制任意命令替换，但 Node test runner 会在文件未注册显式测试时产生文件级通过条目。因此“报告的 tests 大于零”并不能排除该设计接受条件中的零测试。

本轮使用环境中的 Node `v24.21.0` 执行了一条只读、确定性边界探针，没有创建测试文件：

```sh
node --test --test-reporter=tap /dev/null
```

退出码为 0，输出包含：

```text
TAP version 13
# Subtest: /dev/null
ok 1 - /dev/null
  ---
  duration_ms: 19.797416
  type: 'test'
  ...
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

这不是 S4 harness 的合法路径示例，而是实际 runner 的计数语义反例。一个字节身份完全匹配、却因为前置条件而没有注册用例的获批 harness，可以触发同样结果。来源 hash 正确、进程完成、输出完整、plan 一致，都不能识别这类零显式用例执行。

需要的修正：

- 清单在本轮执行之前绑定宿主认可的预期显式用例身份或等价的可信声明；不能为空、重复或从本轮输出临时生成。
- 计数只包含符合预期的显式用例，排除 Node 自动生成的文件级包装条目；明确 skipped／TODO 不得填充最低有效用例数。必须存在的用例缺失或未按协议执行时，不能以其他任意条目补足数量。
- 若平面 TAP 本身不足以识别所需事件，应通过可信 reporter／harness 保留可核验事件，而不是根据输出中出现 `ok` 或 `# tests` 推断实际目标测试。

验收除正常通过、失败和 skip 外，必须包括空 harness、条件分支未注册任何用例、缺少一个必需用例而增加其他通过条目，以及文件包装名试图冒充预期用例。此修正仍只证明获准 runner 报告了指定事件；断言是否充分、测试是否覆盖目标继续由独立 reviewer 判断。

## 其他实施验收约束

以下属于已确认方案的实施风险和验证要求，未另列为设计阻断。

- **发行与私有表。** SDK 表与 Core 使用同一 `Database.Service` 和事务上下文，初始化及 schema 兼容校验先于 driver／协调器开放。真实 SQLite 故障注入应证明 duty、非 native profile、binding 和 run 一起回滚。清单 hash 必须属于外部获批 Spec，不能在发行后静默替换验收约定。
- **冻结与恢复。** ready 保存请求和关闭 admission 同事务，drain 外等待 Activity、退租和子进程清理。无法确认未知写入已停止时不能捕获并宣告冻结。研究 driver 必须拒绝原 scheduler 自动 claim 已 dispatched 的旧 binding；关闭时先保留原执行身份，才能准确审计旧 operation。
- **认定与 context。** handoff 前、handoff 后和 bundle 发布后的三个 target 保留明确转换关系。取消与研究评审失效同步推进／关闭 recognition context；外部 challenge／revision 以 Core target 变化同步撤销，run 随后对账。validator 的 I/O 校验之后，事务内 CAS 仍要拒绝过期材料。已 discharged 的支持遵守外部 challenge 边界。
- **报告及原始证据。** 从准确完成 job 的固定 Session／消息构造宿主报告，不能把 `job.completed` 或模型回显身份当作 accept。产物归档须保留真实字节和完整性；前后 hash 相同本身不能证明文件由本轮生成，适配器必须区分预存输入与要求本轮生成的输出。需要本轮生成的文件可使用新的输出位置或明确清除旧输出，不能接收残留结果替代本轮执行。
- **reviewer 环境。** 宿主管理的父 Location 与 candidate 子目录能避开向上搜索候选配置，但验收应检查最终 provider 请求中的有效 system context／agent 配置，不能只检查文件布局。候选 `AGENTS.md`、`.opencode`、`opencode.json` 的内容仍可作为待审文本，不得被提升为宿主评审协议。
- **challenge 修复。** handoff 前机械缺陷在同 attempt 内修复；handoff 后缺陷等待外部 exact challenge。sealed feedback 不自动打开 worker。同 subject 的新交付仍产生新 handoff、job 和报告；旧认定 operation 的历史 receipt 不能再次 discharge。
- **范围和期限。** 本轮只开放最终评审 profile。SDK 的阶段、TAP 解释和 verdict 留在适配器，kernel 不增加研究词汇。共享宿主进程和凭据的合作式限制保持披露。后台、显式 advance、恢复和清理均保留原 deadline，不把完整计量或单项大小／超时限制变成额外累计预算。

## 修订复核与验证范围

| 发现       | 状态       | 修订后的设计约束                                                                                                                                                                                                                                                                                               |
| ---------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1 · 原 P1 | 设计层关闭 | [工作准入条款](pro-contract-researcher-s4.md#L53)明确所有阶段提交及 `jobs.create/start`、worker open、capture／materialize 的开始均在事务内核对 owner／generation、有效 lease、原 context、预期状态和取消；I/O 不持有写事务，并监控原 deadline、取消及协调器 lease。旧协调器不能借已有 prepared job 启动工作。 |
| F2 · 原 P1 | 设计层关闭 | [机械协议](pro-contract-researcher-s4.md#L26)要求预先批准的非空、无重复 `expectedTests`，观察全部预期名称并拒绝文件包装条目；最低数只计算非 skip／TODO 显式用例。[接受测试](pro-contract-researcher-s4.md#L138)新增空 harness 及条件未注册预期用例。                                                           |

修订还将 [source 限定为 Git 仓库根目录](pro-contract-researcher-s4.md#L28)，并要求持久保存目录归属和准备身份，避免子目录 materialize 语义含混或目录被另一任务收养。其余来源、exact context、取消和外部 challenge 条件未被弱化。

F1／F2 首次关闭的版本为 `b1a933387d6a90ec1daeab20564a40c167e2d498e6489432e7d9fda036724fac`。最终冻结版仅更新首段的设计状态，并新增[本轮生成产物的来源约束](pro-contract-researcher-s4.md#L34)：清单区分输入与生成输出，生成集合固定在 verifier job 中且限于获准 artifact 子集；检查前只在独立 scratch 清除对应旧文件，禁止覆盖 harness／保护输入，并保留此前存在性、当前字节及完整性。该修订落实了本报告的产物来源验收要求，没有扩大角色、预算或 Principal 权限。复核时在内存中撤回这两处文本变化，所得 SHA-256 与此前通过版本完全一致；最终版本通过，设计保持冻结。

上述关闭只表示反例已有可实施的封闭方案。实现时仍须执行 F1 的两个准入 barrier、仅 lease 过期而未接管、旧 owner 复用 prepared job，以及 F2 的文件包装和缺失必需用例验证；阶段回调被拒绝和普通 TAP 正常通过不能代替这些用例。后续还须完成真实 SQLite／Session／进程测试和独立代码审查。

本轮只新增本评审文档。除上文记录的 Node runner 只读探针外，没有运行仓库测试或 typecheck，没有修改设计、实现、测试、迁移、实验配置或冻结 cohort，也没有启动真实研究实验。文档不含需定界的数学表达式；格式、源码链接及最终被审 hash 在交付前单独检查。
