# S4：Researcher 最终交付实施与验收

日期：2026-09-19。状态：已实现，接受测试与独立代码审查通过。

本切片实现可选 `research-final:1` 宿主流程。外部调用方提供已批准的任务及验收清单；Researcher 执行、提交候选，宿主进行机械验证和独立评审，发布证据包，最后等待外部精确认定。没有实现 Principal Agent、S5 计划／方法审批，也没有启动真实研究或 ProgramBench 实验。

依据为 [冻结设计](pro-contract-researcher-s4.md)及[设计审查](pro-contract-researcher-s4-review.md)。设计 SHA-256 为 `f94a1f624ae0d01040705ef127f1cd522060149b2c2914e681baceb5d9253926`。本切片增量以 `/tmp/opencode-s4-baseline/manifest.json` 为基准，保留 S1–S3b 的既有未提交实现；不能把相对 HEAD 的全部差异都算作 S4。

## 实现及接入

可信宿主通过 `OpenCode.create({ research: true })` 装载流程，使用返回的 `research.issue/get/advance/recover/cancel/history/bundle/object`。`issue` 接收完整 `ResearchModel.Input`：原 Spec、来源 Git 根目录、worker model、固定清单和 reviewer 配置。清单绑定固定 Node 可执行文件、harness 字节、预期显式测试名、规定产物和依赖披露；第一版仅支持 deadline-only root。

需要调用认证后的 Principal HTTP 入口时，可信嵌入宿主显式提供 `principalPassword`。默认嵌入宿主仍拒绝这些入口。研究协调器本身不调用 `principalAttest`、`challenge` 或 `release` 作验收决策。安装 profile 及通过内部 review 均不等于 Contract 已 discharged。

职责分配如下：

| 位置                     | 本切片职责                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------- |
| `sdk-next/src/research/` | 清单、SDK 自有持久表、协调租约、冻结、TAP 解释、独立评审、bundle 和 profile validator |
| Core delivery adapter    | canonical ready leaf 按 profile 路由；native 保持已有行为，缺适配器拒绝               |
| Core binding／scheduler  | 持久保存明确的 admission 输入；原 Session loop 执行工作及同 attempt 机械修复          |
| Core replay／blob        | 保存原始输出及产物字节、执行前 receipt、保护文件前后状态；内容寻址写入且读取核验      |
| Core recognition         | 各认定入口使用宿主注入的同一 validator；材料 I/O 后仍作最终事务 CAS                   |

研究表使用 Core `Database.Service` 的同一事务域，但不加入 kernel schema。启动检查 schema version、列／主键／非空约束及目录唯一归属；不兼容即拒绝开放研究执行。公共 Protocol／Server HttpApi 在本切片没有改变，无需再次生成客户端。

## 执行、验证及证据

任务在专属 worker worktree 中运行。ready leaf 原子保存声明并关闭 worker admission；协调器在 drain 外等待退租、Activity 和进程清理，再冻结保留 snapshot。耗时 I/O 在事务外进行，实际开始工作及提交结果都检查原 context、owner、generation、round、reviewVersion 和 deadline。

机械验证使用独立固定 verifier job 和 scratch。必须本轮生成的文件先在 scratch 中清除；执行前存在性、原字节可归档性和执行后字节分别保存。缺失 receipt、过大、越界、不可归档或被篡改的规定证据均不能支持认定。检查 runner／harness，解析实际 Node TAP 13 输出，要求预先批准的非空显式用例集合；退出零、文件包装条目、旧报告或 worker 自报 passed 都不能代替此证据。

机械缺陷在 handoff 前交回同一语义 attempt 的 worker 修复，不延长原 deadline。通过后才提交 handoff，随后建立独立只读 reviewer Session。reviewer 使用宿主管理的父目录，`candidate/` 仅为材料；其 `AGENTS.md`、配置和 worker 自评不成为 reviewer 的系统指导。

宿主保存 reviewer 的真实 job、Session、完成 assistant message、原始 JSON、model／agent、实际 System Context epoch 和材料身份。`accept` 要求证据引用及无 blocking findings；格式错误、未知引用或缺有效完成来源均无法通过。诚实且有证据的负结果可以接受。

bundle 汇集机械报告、评审报告、原始对象、job／operation 记录、已知用量及 unknown、依赖披露。只有通过 bundle 可原子设置本轮 recognition admission，外部调用方还须提交对应的 exact target 和 bundle hash。任何普通 Server／CLI 未安装本 profile validator 时都会拒绝研究认定。

## 恢复及撤销

持久 ready 和已完成 snapshot／材料 checkpoint 可以继续推进。prepared job 或 open 且零 operation 的工作需要显式 `recover`，兼容时保留原 job／Session／Prompt 身份；已开始而结果未知的 worker、provider 或 verifier 不由后台自动重放。可信调用方检查后使用 `recover(id, { retry: true })` 创建带 `previousJobID` 的新 lineage，保留原 deadline、历史报告及 operation 用量。

已完成 job 的原始结果可以继续归档和发布，不再次调用 provider。合法 `unavailable` JSON 也保留 `resumeStage`，因此既能提供不可用报告，又能明确重试；完成不合格报告不会永久困在同一 job 中。

reviewer 配置或指令与已冻结材料不一致时，精确恢复失败；显式新 lineage 重建材料。可见 challenge 开启新轮次，同 subject 也重新验证和评审。sealed challenge 保持停止，不泄露反馈。取消先在同一事务关闭 run、worker admission 与 recognition admission，再中断及清理工作；迟到回调不能恢复旧权限。原期限覆盖发行准备、冻结、验证和评审，不因恢复重新计时。

## 验证证据

全部 provider 为本地确定性 HTTP 服务；没有调用真实研究模型。主要 E2E 使用生产 SDK、独立 Bun 宿主、磁盘 SQLite、真实 Session／Tool／Permission、实际 Node 子进程和文件。

精确崩溃窗口使用 fixture 专用生产服务图：透明包装真实 `atomic`，仅在外层事务返回后暂停；或在真实 `put(Bundle)` 完成后暂停。独立 SQLite 连接确认 committed checkpoint，再 SIGKILL。没有替换协调器决定、模型循环或证据校验。validator 竞态测试在真实材料校验结束后暂停，调用真实取消，再允许认定进入最终事务。

源码及测试增量共 27 个文件，清单为 `/tmp/s4-source-freeze.json`，清单 SHA-256 为 `bceab5336b8254cde9bcc4d9268f5d9bc584c3b3c57b239b1139f3a984b8cf06`。独立 reviewer 已核对全部文件与基线差异；完整 hash 表见代码审查报告。Core kernel、既有 Schema／Protocol／Server 接口以及 S3a／S3b 历史审查报告保持基线字节。

| 检查                                                   | 结果                                                               | 日志                                                                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Core Contract 回归（11 文件）                          | 158 pass，0 fail，922 assertions                                   | `/tmp/s4-core-final.log`                                                                           |
| S4 生产进程 E2E（21 个不同场景）                       | 整组 19 pass／2 个夹具失败；修正后相关 4 项全部通过，30 assertions | `/tmp/s4-process-final.log`、`/tmp/s4-process-boundaries-accepted.log`                             |
| S1–S3b 生产进程回归（28 个不同场景）                   | 整组 27 pass／1 个启动超时；S2 五项串行复跑全部通过，55 assertions | `/tmp/s4-prior-e2e.log`、`/tmp/s4-recognition-accepted.log`                                        |
| HTTP Contract／SDK／OpenAPI／Schema／认证（5 文件）    | 53 pass，0 fail，290 assertions                                    | `/tmp/s4-http-serial-accepted.log`                                                                 |
| SDK 全部测试（6 文件）                                 | 25 pass，0 fail，87 assertions                                     | `/tmp/s4-sdk-final.log`                                                                            |
| 独立 reviewer：Store／schema／TAP                      | 17 pass，0 fail，47 assertions                                     | `/tmp/s4-review-sdk-focused.log`                                                                   |
| 独立 reviewer：真实 replay 产物前态                    | 4 pass，0 fail，28 assertions                                      | `/tmp/s4-review-artifacts.log`                                                                     |
| Core／SDK／opencode／Server／Client／Protocol 类型检查 | 六包通过                                                           | `/tmp/s4-core-check2.log`、`/tmp/s4-opencode-accepted-check.log`、其余 `/tmp/s4-*-final-check.log` |
| 源码格式及 diff whitespace                             | 通过                                                               | `/tmp/s4-format-accepted-final.log`、`/tmp/s4-diff-accepted-final.log`                             |

Core 全量主运行是 1,362 pass、2 fail（`/tmp/s4-core-all.log`），两项未改动的 unwritable-lock 测试在 root 下不能依靠 chmod 拒绝写入。使用独立、无凭据的非 root 环境复跑两个锁测试文件，21 pass、0 fail、47 assertions（`/tmp/s4-nonroot-lock-tests.log`）。不将有这两项失败的主运行写成全量零失败。

S4 整组初跑的两个失败来自新 checkpoint 夹具把 UUID job ID 当作 Contract ID 解码，尚未进入恢复断言；修正后 prepared 和归档未发布窗口均通过。随后只修改两个测试／夹具文件：修正 ID 路由、补上证据删除场景并使篡改测试兼容非 root。生产实现字节未变。最后四项复跑覆盖这两个窗口、真实 validator I/O 后取消及缺失／损坏证据，21 个不同 S4 用例均有通过记录；这不是单次 21／0 的运行。

S1–S3b 整组有一项 S2 重启监听地址超时；不改生产代码或期限，串行复跑 S2 五项全部通过。因此 28 个不同旧进程场景均有通过证据，仍保留整组原始 27／1 的事实。HTTP 先前两次运行各有一个不同的超时（Git 初始化／实例读取），最后在相同生产实现上串行复跑，53 项全部通过。期间宿主出现较高 I/O 等待；HTTP 测试框架超时使用 30 秒，生产 deadline／lease／预算未调整。早期失败日志 `/tmp/s4-http-final.log`、`/tmp/s4-http-accepted.log` 保留，不视为通过。

测试分层必须区分：S4 新增完整交付、双宿主、取消／期限、配置漂移、证据损坏和恢复；S1–S3b 回归继续验证公共入口拒绝、工具／权限等待撤销、只读 reviewer、跨目录访问和 operation 审计。不能把 parser 单元测试称为真实科学任务，也不能把一次成功运行称为穷尽并发证明。

可复现命令（在所标包目录分别执行）：

```sh
# packages/core
bun test --timeout 15000 test/pro-contract*.test.ts
bun typecheck

# packages/sdk-next
OPENCODE_DB=:memory: bun test --timeout 15000
bun typecheck

# packages/opencode
bun test test/server/pro-contract-research-process.test.ts
bun test test/server/pro-contract-research-process.test.ts \
  -t 'archived bundle|prepared zero-operation|actual validator I/O|missing or tampered'
bun test test/server/pro-contract-process.test.ts \
  test/server/pro-contract-recognition-process.test.ts \
  test/server/pro-contract-driver-process.test.ts \
  test/server/pro-contract-job-process.test.ts
bun test --timeout 30000 test/server/httpapi-pro-contract.test.ts \
  test/server/httpapi-sdk.test.ts test/server/httpapi-public-openapi.test.ts \
  test/server/httpapi-schema-error-body.test.ts test/server/httpapi-authorization.test.ts
bun typecheck

# packages/server, packages/client, packages/protocol：分别执行
bun typecheck
```

## 独立审查与适用边界

[独立代码审查](pro-contract-researcher-s4-code-review.md)已批准本次冻结实现，A1–A7 全部闭合，没有遗留 P1／P2 阻断。报告记录发现与复核，涉及 prepared 恢复、跨轮迟到回调、取消原子撤权、reviewer 环境漂移、执行前产物归档、发行重试准备竞态和完成不合格评审后的显式重试。

本切片提供最终交付的可靠执行和可审计证据机制。它没有证明研究方法正确、实验覆盖充分或 reviewer 判断可靠；计划与方法的事前门槛仍属于 S5。当前目录、进程和权限边界是合作式隔离，不是 OS sandbox，不能抵御恶意逃逸进程、宿主私有目录写入或外部并发篡改。未知副作用不承诺 exactly-once。
