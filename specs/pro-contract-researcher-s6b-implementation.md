# S6b：评测工具、确定性语料与生产路径自检

2026-09-19。S6b 实施、自检、独立审查及修复复核已完成。没有启动 S6c 真实模型资格评测、付费运行或真实研究试点。所有 provider 响应来自本地确定性 HTTP fixture，`qualification` 始终为 `not_run`。

依据为[执行交接](pro-contract-researcher-handoff.md)、[冻结 S6 设计](pro-contract-researcher-s6.md)、[设计审查](pro-contract-researcher-s6-review.md)及 [S5 实施](pro-contract-researcher-s5-implementation.md)／[代码审查](pro-contract-researcher-s5-code-review.md)。S6a 两份历史文件未改，原 SHA-256 分别为 `737da740b22843d4259dbf6570177067ed2d5259b57834570cc6bb3c128700e3`、`afe66d2b7eda522fdb7a97ed4e473d61f544efb20ba1ba32f116a265c635684d`。S6b 的独立发现、反例、修复与最终签字见[代码审查](pro-contract-researcher-s6b-code-review.md)。

## 范围与顺序

按约定先实现独立评分、实例账本与失败分类；随后用开发变体的一组好坏计划、一组好坏交付物及一个完整负结果任务贯通实际 research 路径；再补齐 48 个 reviewer 探针、18 个完整任务、隔离和故障观察；最后进行独立审查、修复及复核。没有给 Researcher 增加 Principal 选题或改约定的权限。

新增实现位于 [`script/research-eval`](../packages/opencode/script/research-eval/)，生产自检入口为 [`pro-contract-eval-process.test.ts`](../packages/opencode/test/server/pro-contract-eval-process.test.ts)。使用现有 `research.issue({ planning: true })`、canonical `contract_request`／`contract_report_ready`、独立 reviewer Session、正式 Node TAP verification、持久 research history 和 exact attestation／challenge 接口，不直接写审批状态。

- `corpus.ts` 提供开发／资格两组独立数据变体、opaque ID 与固定顺序。P1–P4、F1–F4 各好坏三次，R1–R6 各三次。公开规范允许正确负结果和有据不确定结论；私有 oracle、rubric、缺陷标签及固定 worker 准备答案不经 `publish()` 暴露。
- `score.ts` 分开保存 raw verdict／scope／finding、结构与证据有效性、protocol error、机械阻断和 actual gate。坏材料上可解析 raw accept 的错误优先级不被宿主拦截抵销。`oracle.ts` 独立复算数值与边界；自由文本仍要求盲评，不冒充模型质量成绩。
- `ledger.ts` 预登记实例，追加 hash-chain JSONL，保留未开始、失败、超时、unknown、所有错误 ready 和修复机会。矩阵门槛检查全部 14 个任务族、轨道、好坏及 repeat 1–3；各族缺失不能因总体数目足够而通过。完整任务同样可记录不变量破坏。
- `accounting.ts` 依据全部持久 run 的 job 身份归属用量，保留崩溃前旧 reviewer 的 unknown 记录。首次 ready、外部评分完成及 exact 认可完成分别记时；历史批次只生成绑定原行／证据／源码 hash 的派生校正报告，不改原账本。
- `blind.ts` 先封存无 reviewer／模型标识的候选材料，再接收两个不可覆盖的独立标注；冻结 rubric 缺项不能通过。冲突交第三方裁决，未解决保留 `indeterminate`，之后才解封 reviewer。
- `controller.ts` 无 oracle 输入，从持久版本选第一份目标报告；探针停止并显式取消，完整任务在 ready 后等待外部评分。challenge 只转发原 blocking findings，操作身份由原 handoff 确定，不反馈隐藏答案。
- `archive.ts` 保留全部历史 run、job、worker／reviewer Session、operations、对象图、原始 provider 响应和候选 git tree archive。外部候选执行输入／输出、评分、取消或 exact receipt 与每实例根归档相连。
- `freeze.ts` 复制 tracked 与 untracked 的完整源码，不以 HEAD 代替 dirty 工作树；配置 schema 要求模型、变体、采样、运行时、锁文件、prompt／工具、矩阵顺序、oracle／scorer 和隔离证据身份。preflight 检查保留字节与实际 runtime。S6c 的确切模型和部署清单仍须另行确定。

## 预算兼容修复

原 `Resolution.maxAttempts` 必填，会把连续 exact challenge／修复变成隐含累计次数上限。因此将它改为可选，Core 在字段存在时才检查；显式有限历史配置保持原语义。canonical 与旧 `contract-propose` 的描述同步。S6b 发行只设原始六小时 deadline，省略 provider turns、tool actions、request、费用和 attempts 累计上限，不用大整数代替无限。

Core 回归覆盖超过原 1,000 turns／4,000 actions 的继续执行、六次连续尝试，以及仍在原 deadline 停止；Schema 回归覆盖省略及旧有限值。已按仓库要求执行 `packages/client` 的 `bun run generate` 与 `./packages/sdk/js/script/build.ts`；相对 S6b 基线，只有两个生成类型文件因该字段发生变化。

## 隔离与真实故障观测

评测部署采用 Linux x64、Landlock ABI 至少 6 和 seccomp。当前环境不允许 network namespace；仅把 oracle 放在另一个目录、使用 Node permission 或仅限制 TCP 端口都不足以满足设计。

宿主只读生产依赖和系统运行时，只写自己的 storage／workspace。评分脚本、oracle、其他实例、父目录及外部进程内存不在授权范围。候选评分代码在独立进程运行，不能载入持有 oracle 的进程。候选进程组在正常退出、输出超限及超时后全部清理，禁止创建新会话或改变进程组逃逸。

网络通过独立 seccomp broker：它验证请求地址，自己只连接固定 `127.0.0.1` gateway，再置入连接后的 FD；不使用可产生指针竞态的 `CONTINUE`。基础过滤器拒绝 Fast Open 的三个发送入口及相关 TCP 选项。HTTP gateway 固定 origin，只允许两个精确 provider POST 路径，并约束 headers、body 和响应的单次持续时间。这个配置适用于当前 HTTP 部署代理，不是任意平台或任意 provider 网络拓扑的通用沙箱。

R5 在真实 gateway response 事件且请求尚未完成时终止宿主；R6 从独立 `/proc` 观察实际 Node test 子进程及其 PID／start ticks／boot／父子关系，在存活窗口终止宿主，清理旧执行后才恢复。每个实例只允许一次注入机会，错过窗口保留 miss。恢复保留 unknown operations、新 job lineage 和原 deadline，不自动重放旧 provider 工作。

## 验证与保留的失败

全部 provider 响应均为本地确定性 fixture。下表的通过数只验证工具行为；主动失败自检以非零退出作为预期证据，不列为普通通过测试。

| 验证                                                       | 结果                                                                 | 日志                                       |
| ---------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------ |
| 修复后的完整冻结矩阵                                       | 66/66，771 assertions，821.35 秒                                     | `/tmp/s6b-matrix-v2-final.log`             |
| 评分、矩阵、盲评、冻结、历史计量、恢复身份、网络及进程隔离 | 19/19，3,487 assertions                                              | `/tmp/s6b-unit-v2-final.log`               |
| Core Contract／driver 与 deadline-only                     | 74/74，434 assertions                                                | `/tmp/s6b-core-regression-final.log`       |
| Schema 省略预算与历史有限预算                              | 2/2，17 assertions                                                   | `/tmp/s6b-schema-regression-final.log`     |
| S5 全部生产流程与 S4 exact 认可／challenge                 | 14/14，184 assertions                                                | `/tmp/s6b-s5-s4-regression.log`            |
| 开发校准                                                   | 5/5，53 assertions                                                   | `/tmp/s6b-calibration-reviewed-v1.log`     |
| 两个观察之间推进到第二计划，仍取首次报告                   | 1/1，10 assertions                                                   | `/tmp/s6b-rapid-v1.log`                    |
| 矛盾 raw accept 被宿主拒绝，仍计 false_accept              | 2/2，19 assertions                                                   | `/tmp/s6b-raw-accept-v1.log`               |
| 单独真实 R5／R6 注入校准                                   | 2/2，43 assertions                                                   | `/tmp/s6b-fault-reviewed-v1.log`           |
| 七包类型检查                                               | Schema、Core、Protocol、Server、Client、sdk-next、opencode 均 exit 0 | `/tmp/s6b-{package}-typecheck-final.log`   |
| F7/F8 后 opencode 类型检查                                 | exit 0                                                               | `/tmp/s6b-opencode-typecheck-v2-final.log` |
| 历史报告校正实际回归                                       | 122 项校正逐项可复算，原文件 hash 不变                               | `/tmp/s6b-report-correction-v2-final.log`  |

最终完整批次为 `/tmp/opencode-s6b-matrix-20260919-final-v2`。预登记 48 探针、18 完整任务，覆盖全部 14 族及每族三个重复。48/48 目标入口触达，24/24 缺陷脚本报告检出、24/24 有效对照接受，18/18 正确候选交付，R1 修复 3/3，注入与安全恢复均 6/6。所有工具自检门槛为 true；这些数值来自固定脚本，不是模型质量成绩。报告保持 `qualification: not_run`。

源码增量清单 `/tmp/s6b-source-v2-final.json` 共 31 个源码／测试／生成文件，SHA-256 为 `18bc7bc25d6ea317b02c97d61749407cdd808722ef1f799488fb92d9c07e8995`。批次完整源码镜像含 6,533 文件，`source/manifest.json` SHA-256 为 `403e439d9815bf2930edcd45462338d4235a66aff51b91dbbfbca15135a80acd`；运行期间未改源码。结束后仅更新实施／审查／交接／总方案文档，文档不套用运行镜像 hash。详细对象核验见 `/tmp/s6b-final-artifact-audit.json`：验证 1,690 个对象的内容 hash、66 个根归档、174 个快照引用、201 个 job、1,137 个 operation、582 次 wire 与对应原始 transport、18 个候选及 exact receipt。六个被中断操作的 status 为 unknown；其他未返回的 token／费用仍保留 unknown／null，不填零。账本重算与原报告一致，首次 ready／评分／认可的时间顺序和历史 job 用量归属均匹配。独立审计逐字段追踪通用 hash 扫描的 1,194 次 unavailable 引用（1,064 个唯一值）：它们是 spec／context／input／agent／配置／可执行文件／policy 等非 blob 身份，仍保留原始列表；所核验必需研究对象无缺失，672 次原始 evidence 引用均存在且字节长度匹配，见 `/tmp/s6b-review-final-audit.json`。这不等于所有身份 hash 都能作为 blob 解析。

最终 `events.jsonl` SHA-256 为 `083114068256d7917c7ca6f3a63b35843958e0bfc73f0925d0051b54ca42c1d6`，`report.json` 为 `adb12099962459e0ba1d14b49a3689327778a98e23a7f4770b9f1d30be74e89f`。本批次 R5 三次均为 `replan: false` 并核对新 job 的 `previousJobID`；R6 三次均为 `replan: true`。不宣称本批次覆盖 R6 的非重规划分支：该分支的已完成字段清空回归由新的 `driver` 单测及旧批次真实持久证据核验，S5 生产回归另覆盖 `replan: false` 的实验恢复。

当前工具链为 Bun 1.3.14、Node v24.21.0、Linux 6.17.0-14-generic、gcc 13.3；沙箱适用边界如上。所有测试和类型检查从对应包目录执行，重型进程套件串行。主要复现命令：

```sh
export PATH=/tmp/opencode-research-toolchain/bun-linux-x64:$PATH

# packages/opencode；每次使用不存在的新 artifact 目录
S6B_MATRIX=1 S6B_ARTIFACTS=/absolute/new/cohort bun test --timeout 30000 test/server/pro-contract-eval-process.test.ts
bun test --timeout 30000 script/research-eval
bun test --timeout 30000 test/server/pro-contract-planning-process.test.ts test/server/pro-contract-research-process.test.ts --test-name-pattern 'Planned Researcher|waits for external challenge|requires external exact recognition'
bun typecheck

# packages/core
bun test test/pro-contract.test.ts test/pro-contract-driver.test.ts

# packages/schema
bun test test/pro-contract-budget.test.ts
```

主动 provider 失败自检 `/tmp/s6b-early-failure-v2.log` 保留 `issued → observation → stopped(provider)`，其余四个预登记实例仍为 `not_started`。死宿主失败分支 `/tmp/s6b-dead-failure-v1.log` 保全 135 个文件，逐文件 hash 全匹配，含 4,096 字节 DB 与 543,872 字节 WAL；这些日志的退出码 1 是故意触发的失败，未冒充全绿结果。

保留中间失败及日志，不把成功重跑替换旧结果：

- 初始宿主隔离缺少 Bun 的 `/proc/self/maps`、系统账户文件、SSL 配置及必要目录列举权限；逐项缩小授权后修复。gateway 接线曾丢 `/v1`；正式 artifact 路径修为 `artifacts/result.json`。
- 早期 R5 仅等待 fixture 收到请求，尚不足以证明响应窗口；改为真正 transport observer。R6 全 `/proc` 扫描错过窗口，改为遍历已知宿主子孙。
- 独立审查发现 HTTP origin 逃逸、同端口其他地址、Fast Open、候选孙进程拖延、原始证据 allowlist、首报告竞态及不完整矩阵假通过，保留全部反例和关闭依据。
- 早期未冻结完整确定性自检 `/tmp/s6b-matrix-first.log` 为 51 pass／15 fail，执行期间隔离 C 源码修订使后续 launcher 采用新实现，不能当作冻结版本的矩阵证据。新实现从模块加载时固定 C 字节，最终矩阵在发行前保存完整源码且运行期间不再改动运行源码。
- `/tmp/s6b-fastopen-regression.log` 的四个测试断言通过，但测试框架全局清理 hook 超时，整体为失败；最终 19 项单测使用 30 秒 test timeout 全部通过。
- 首次完整源码复制超过默认 5 秒 beforeAll timeout，保留 `/tmp/s6b-early-failure-v1.log`；复制阶段改为明确 60 秒单次上限后，主动失败分支才真正执行。

### F7/F8：计量校正、持久恢复身份与旧批次

第一次完整冻结批次 `/tmp/opencode-s6b-matrix-20260919-final` 为 65 pass／1 fail、752 assertions（日志 `/tmp/s6b-matrix-final.log`），其完整 source hash 为 `f04a7c3f0dfe8e0e0fe73b88beffc21555069f13a07a061c71b456c1b7eda5c2`。唯一失败是 R6 repeat 2 的驱动竞态：恢复实验已经完成，当前 run 的 `verifierJobID` 被正常清空，驱动随后读到不存在的 job。修复在保留上下文的恢复分支中，从停止版本之后的持久 history 找候选新 job，再核对真实 `previousJobID`，不靠瞬时当前字段。新回归覆盖“已完成且字段清空”；注入在恢复开始时立即记账，失败 finalizer 也保留真实窗口结果。

F7 发现旧用量归属使用当前 job，遗漏历史 reviewer，且两个缺失 ID 相等会把 worker 误归 review；旧 ready 时间又混入外部评分和认可。`accounting.correct` 对该旧批次生成 `/tmp/opencode-s6b-matrix-report-v2`：96 项 review → worker、9 项 worker → plan_review、17 项候选时间校正。三次 R5 旧 unknown reviewer 现在正确归属；旧评分完成时间不可恢复，明确保留 `null`，不猜测。派生报告仍是 17/18 交付、5/6 账面恢复，recovery／accounted 为 false；事后取证不把原失败改成通过。

校正前后原 `events.jsonl` SHA-256 均为 `403fbe0064c335ce59247d2f94330050e46c33e345fda9ae342981b4b62a1837`，原 `report.json` 均为 `ab73eafbdac563f79b138d2a0c06c521b5d60422930321c9d7f74ad22a83efe1`。派生 `corrections.json` SHA-256 为 `dd0d991912833f68cf9c1eeb826c089b1b0d7c66a047850ee54637a73974a01b`，派生 report 为 `3421e5937a88155e02d50022fc3040fd2779282d992cfa27f6ea0bbf916ee36c`；校正依据另绑定原行、归档对象、原完整源码、`accounting.ts` 与 `ledger.ts` hash。首次人工校正调用因把 ArrayBuffer 传入 Node hash API 而在调用 `correct` 前失败，日志 `/tmp/s6b-report-correction-v2.log` 保留；修正调用后完成上述实际回归。

诊断旧 R6 现场时，曾以 SQLite `mode=ro` 打开保全 DB，SQLite 仍更新了 WAL-index 的 read marks。247 个保全文件中只有 `storage/opencode.db-shm` hash 改变，包括 DB、WAL 在内的其余 246 项不变，原 manifest 未改写。事件单 `/tmp/s6b-r6-forensic-access.json` 保留捕获／读取后 hash；独立审查已核对。后续 SQLite 查询先复制 DB/WAL，仅访问副本；不能宣称这个旧失败现场所有字节仍完全未变。

## 工作树保全与后续

S6b 编辑前完整基线为 `/tmp/opencode-s6b-baseline-20260919T072714Z/`，含 6,509 个文件，manifest SHA-256 `e2b8da36b4f3938053cc7502f4152f8fa6bff11e79410c3191442f9c6ce79441`。最终核验未发现已有文件丢失；相对基线仅 10 个原源码／测试／生成文件为 S6b 必要增量，另更新交接和总方案，新增评测层及实施／审查文档。已有大量 S1–S5 未提交改动继续保留。没有提交、合并或发布。

工具自检通过只说明评测工具能够执行当前确定性语料。S6c 仍未启动，不能从 scripted worker／reviewer 推断任何真实模型的检错率、研究能力或跨任务可靠性。
