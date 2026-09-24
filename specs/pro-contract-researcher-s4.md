# S4：Researcher 可验收交付

日期：2026-09-19。状态：独立设计审查通过，实施基准冻结；结论与被审 hash 见 [S4 设计审查](pro-contract-researcher-s4-review.md)。用户已批准继续 S4；本次包括设计、独立审查、实现、真实进程验证及独立代码审查，不包含 S5、真实研究实验或对外发布。

基线为 S3b 已验收工作树，快照位于 `/tmp/opencode-s4-baseline`。不覆盖此前未提交改动。[总方案](pro-contract-researcher.md)、[Constitution](pro-contract-constitution.md)及 [S3b 验收](pro-contract-researcher-s3b-implementation.md)继续约束本次。

## 1. 交付范围

在 `sdk-next/src/research/` 实现可选的 `research-final:1` profile。可信宿主接收外部已批准的 Spec 和不可变验收清单，发行研究任务，使用已有 worker Session 执行，自动贯通：

```text
执行 → 收到 ready 请求 → 关闭执行准入并确认清理 → 冻结候选
     → 机械验证 → handoff → 独立 reviewer → 发布证据包 → 等待外部认定
```

机械失败发生在 handoff 前，在同一语义 attempt 内将检查结果交回 worker 修复。handoff 后的 reviewer 缺陷只产生精确绑定的缺陷报告；外部有权调用方提交 challenge 后才进入修复。协调器不调用 `principalAttest`、`challenge`、`release` 或 `decideRevision` 来替外部 Principal 作决定。

本 profile 不实现计划审批、研究方法事前准入、统计正确性证明或 Principal Agent。仅接受 deadline-only root；所有阶段保持原绝对期限。它提供最终交付审查流程，不能据此宣称完整研究质量已通过资格验证。

## 2. 清单、目录和报告

清单至少绑定：版本、交付要求、必须纳入 snapshot 的输入路径、机械验证 ReplayPolicy、每项检查的解释规则与最低测试数／允许跳过数、reviewer model／agent、评审要求以及需要披露的不可冻结依赖。正文不包含发行后才生成的 `specHash`；清单 hash 作为明确引用写入获批 Spec brief，发行记录再保存 root revision／specHash。

第一版机械适配器为 `node-test-tap:1`：宿主固定使用 Node test runner，清单绑定宿主认可的 executable 绝对路径／hash、固定 runner 参数、准确的 test harness 路径／hash和最低测试数／跳过约束。拒绝任意 shell／命令替代、通配测试入口或由 worker 修改 runner／harness。宿主在发行时保留获批 harness 字节，在冻结后检查候选中的对应内容，验证时使用这一明确的协议并核对执行前后保护文件；不能把任意 `printf TAP` 或读取旧报告的命令注册成可信计数来源。

stdout 必须为完整、可解析的平面 TAP 13 报告；检查测试计划、连续且不重复的编号、报告的测试数量、失败／跳过／TODO、bailout，以及进程和输出捕获状态。清单还绑定外部预先批准的非空、无重复 `expectedTests` 显式用例名称集，不能从本轮输出自动生成；必须观察到全部预期名称，拒绝 Node 以测试文件路径／文件名生成的自动包装条目。最低测试数按非 skip／TODO 显式用例计算且大于零，因而空文件被 Node 包装成 `ok 1` 也不能通过。未支持的嵌套结构、缺失输出或捕获不完整为 unavailable；明确失败、零显式用例或不满足清单为缺陷。退出零不能覆盖结构化失败。信任假设是宿主认可的 runner／harness 正确上报测试事件；测试是否覆盖任务仍由 reviewer 判断，不把 TAP 数量当作目标行为证明。后续适配器须单独验证。

第一版 source 必须为支持 snapshot 的 Git 仓库根目录，明确拒绝子目录 Location 和非 Git 来源。宿主从 source Location 的保留 snapshot 创建每任务独享 worker worktree。任务不会直接在 source 或另一个研究的目录中执行。必需输入显式纳入 capture，不能把默认 Git snapshot 宣称为全部依赖。工作目录、reviewer 材料目录与宿主证据目录分开；目录归属和准备身份持久化后才使用，不可被另一任务收养。

reviewer 的 Location 是宿主管理的独立父目录，内含冻结 `candidate/` 和宿主写入的 `evidence/`：清单、原始任务、worker 交付声明、机械报告、所有检查的原始输出及规定的验证产物。候选的 `AGENTS.md`、`opencode.json` 和 `.opencode` 留在子目录中，仅作为待审材料，不作为 reviewer 的项目配置或环境指令；记录实际 host 配置／协议身份并测试恶意候选配置不进入系统指导。它使用独立 Session，只读工具受 S3b 限制；不继承 worker 对话。worker 声明标为待核查材料，不能成为宿主意见。

verifier 通过 S3b 的固定验证 job 执行 replay。replay 在清理 scratch 前保留清单指定产物的原始字节、hash、完整性及与检查前内容的关系；文件过大、越界、不可读或不能完整归档时，S4 不生成通过证据。保留现有输出观察和中断证据。只声称保存清单规定的产物／变化，不声称穷尽任意外部副作用。

清单区分保留的输入产物与要求本轮生成的输出。后者作为不可变 verifier job 输入的一部分，在独立 scratch 内执行检查前清除旧文件；该集合须为获准 artifact 路径的子集且不得覆盖 harness／保护输入。归档记录此前存在性、当前字节及完整性，不能仅凭前后 hash 相同认定文件由本轮生成。此选项只属于宿主固定的 replay job，不让模型在运行时临时指定删除路径。

内容寻址对象先完整写入临时文件，再以不可覆盖的方式发布；读取时重新验证 hash。宿主状态指向这些不可变对象；文件存在本身不表示 job 已完成或报告通过。产物大小上限用于有界单项归档，不引入累计执行次数或金额预算。

## 3. 状态归属与原子性

研究状态和事件表由 SDK research 模块定义并初始化，使用已有 `Database.Service` 的同一个 SQLite 连接／事务域。SDK 自有 v1 表采用幂等建表、明确 schema version 并检查兼容性，初始化完成前不开放 driver／协调器；版本或字段不兼容拒绝启动。不把研究阶段加入 Core kernel 或 Core schema。发行、冻结请求、取消和证据准入需要与 binding／recognition context 原子更新，不能使用另一个数据库来近似这一事务。

主要状态为 `execution`、`freezing`、`verification`、`review`、`ready`、`changes_requested`、`unavailable`、`cancelled`、`accepted` 和 `released`。状态保存：

- root、原 Spec／清单和工作目录坐标；原 deadline。
- stage、round、单独的 review validity version；取消原因。
- 协调器 owner／generation／lease，区别于 binding claim 和评审有效性。
- exact ready 请求、冻结 subject、verifier/reviewer job ID、报告和 bundle hash。
- handoff 前 ContextTarget、handoff 后 ContextTarget、发布后 ContextTarget 的关联。
- 前一轮材料与重试 lineage；阶段变更事件不可变保留。

发行在一个事务中完成 duty、关闭的非 native binding、非 native recognition profile、初始未准入 context 与研究状态。准备目录或归档失败不得留下能以普通模式运行的研究 duty。发行重试核对同一输入；不同内容复用身份拒绝。

协调器每次工作获取 run lease，在耗时操作期间续租。所有阶段提交和实际工作准入均在写事务中比较 owner／generation、有效 lease、原 ContextTarget、预期状态和取消条件。实际准入包括 `jobs.create/start`、worker `setAdmission(open)` 及 capture／materialize 的开始，不能只在最后写 checkpoint 时检查；S3b 的 start 自身不认识研究 generation，研究调用必须通过这个宿主事务 guard。I/O 本体不持有写事务，并持续监控原 deadline／取消／协调器 lease。迟到协调器既不能继续发布，也不能启动已经准备好的旧 job。当前阶段没有工作时不循环创建新 Session 或消耗 attempt。

S4 不更改 S3b job 的原始上下文，亦不把协调器身份当作 worker 执行许可。背景协调器自动推进正常的新工作；崩溃后的已开始计算须按第 7 节显式处理。研究 driver 的 claim 拒绝仍标记 dispatched 的旧 binding，因而原 scheduler 不能仅因 lease 过期自动更换 Session 重放未知 worker 工作；后台先关闭准入、保存旧执行身份并标明待审计，显式 recover 才能准许绑定新输入的执行。

## 4. ready 与冻结

在 Core 的 Contract 控制 leaf 接入通用交付适配器，按 recognition profile 选择处理器。native 继续已有同步路径；非 native profile 缺处理器则拒绝。该接口不属于 ToolRegistry，不新增工具表示、registry 授权回调或模型循环。

研究 ready 在同一事务中：

1. 核对原 worker Execution、当前清单／Spec／ContextTarget 和研究阶段。
2. 保存带原调用身份、summary 与 uncertainties 的冻结请求。
3. 关闭 binding admission，阻止新的受控修改。

工具返回请求已记录；它不等待自己的 drain／Activity 结束。即使回复在取消或断连中丢失，持久请求仍可核对，不重复创建 handoff。

协调器在 drain 外等待 binding 已退租、Activity 清空以及进程清理完成；远端 owner 的活 lease 不能提前清除。无法确认清理时保持 freezing／unavailable。仅在这些条件满足且原期限尚未到达时 capture。此前已合法启动的副作用保留，会计不退款；取消或失效的等待权限不能重新获得修改许可。

capture、机械检查均在事务外。snapshot 身份先持久化；之后只使用该 retained subject。handoff 提交使用协调器独立权限条件和 exact context guard，在同一事务中写 Contract handoff 与研究 checkpoint，不复活已经关闭的 worker Execution。

研究目录由本任务独占，避免另一普通 Session 在原共享仓库的写入混入冻结。无 OS sandbox 的外部进程、故意指定宿主私有目录的调用或逃逸子进程仍属于合作式部署限制；本轮不把路径和 Activity 检查解释为强隔离。

## 5. 机械检查、独立评审与证据包

冻结后先建立 verifier job，持久化其精确输入再启动。宿主仅从该完成 job 的 replay result 和原始观察解释机械结果。不能接受 worker 提供的结果路径、旧文件或自报 passed 代替本轮实际执行。显式机械失败归档后重新打开 worker 同一 attempt，原 scheduler 接收宿主冻结的修复输入；未知结果保持 unavailable，不自动轮换直到通过。

机械通过后才提交 handoff。不得向 kernel 的 `report-ready` 传入失败 replay 来暗中代替外部 challenge。新 handoff 推进 ContextTarget，随后发行绑定这一新 target 的 reviewer job。

reviewer 输出严格 JSON：版本、`accept`／`changes_requested`／`unavailable`、摘要、可定位 findings 和结论对应的证据引用。accept 不能包含 blocking findings；changes_requested 必须有明确阻断原因和解除条件。格式错误、未知证据引用、无有效完成消息或未完成 job 均不可接受。

报告来源由宿主从 job 固定的 Session 中读取：记录准确完成的 assistant message ID、原始输出 hash、model／agent、job 输入 hash、subject／清单／协议身份及证据引用。模型回显的 job ID 不作为身份来源。job `completed` 不等于 accept。负研究结果可以接受，只要交付陈述、方法限制和证据与清单一致。

机械报告、reviewer 报告、原始材料目录、执行记录、已知用量／unknown、未决项和依赖披露组成不可变 bundle。接收方可读取 bundle 和其对象；仅有哈希、缺失字节的包不能获得准入。缺陷 bundle 可供外部提交 exact challenge，但不会设置 admitted。

通过 bundle 的发布在同一事务中比较原 handoff/context、run generation／review version、job 完成来源和未取消状态，然后设置 `RecognitionContext(profile, referenceHash=bundleHash, admitted=true)` 并保存新的 target。报告仍保留创建时的坐标，通过已记录的本轮转换关联发布上下文，绝不刷新旧报告使其匹配新一轮。

## 6. 所有认定入口与外部反馈

给现有 recognition 边界增加可从宿主同一服务图注入的默认 validator registry；保留 S2 测试／可信调用的显式 Reference override。Core 默认不注册研究 validator。SDK 研究 validator 读取底层状态／不可变材料及 job 来源，不反向依赖其自身所在的 Contract 服务图。

validator 要求 `evidenceHash` 等于已准入 bundle hash，核对清单绑定、机械条件、reviewer 来源、全部规定的原始证据及本轮转换。现有 `principalAttest` 在材料校验后仍在权威事务中比较当前 RecognitionTarget、admitted 和 validator 身份。HTTP、两代客户端和本地 Core 认定继续走这一入口；未装载研究宿主的 Server／CLI 必须拒绝研究认定。SDK、Server、Core 不倒置依赖。

SDK 发起的取消、评审失效和任何影响通过性的研究状态修改，必须与关闭／推进 recognition context 同事务提交，不能仅写 research cancelled 标志。外部 HTTP／CLI 的 challenge、release、revision 已由 Core 在权威事务中同步推进 context；S4 所有提交、worker admission 和 job 校验均比较这一 target，因此撤销立即生效，研究状态随后幂等对账。不能依赖 SDK 包装才能观察外部决定。已 discharged 的支持必须由外部 challenge 撤回；历史认定 operation 重试只返回原 receipt 和当前 support 状态。

外部 executor-visible challenge 使旧 context 无效。协调器核对新的 root 状态和 exact challenge 后，将反馈交回同一 root 的 worker；新轮次重新冻结、检查、评审。同 subject 也不能复用旧 handoff／报告。实际 challenge 的语义 attempt 遵守原 resolution；普通机械失败或等待不增加 attempt。sealed challenge 不泄露材料、不自动恢复。外部 revision 后清单绑定不再匹配时停止，等待新的明确配置，不继承旧批准。

## 7. 中断、恢复与期限

| 窗口                                   | 处理                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| ready 已持久化、worker 未退            | 继续检查清理屏障，不重复发 ready、不 capture 混合状态                                            |
| snapshot 已保存、job 尚未创建          | 使用原 subject 和固定 job 身份继续准入                                                           |
| job 已准备、从未开始 operation         | 显式恢复相同 job／Session／Prompt，保留 deadline                                                 |
| 主 worker SIGKILL、旧 binding 租约到期 | driver 阻止原 scheduler 自动接管计算；关闭 admission、审计原 operation，显式恢复才建立新工作准入 |
| provider／verifier 已开始、结果未知    | 标明 unavailable／unknown，禁止后台自动重放；可信调用方显式恢复审计或另建带 lineage 的重试       |
| job 完成、报告或阶段未提交             | 读取该 job 的持久来源和已有原始证据，幂等生成／使用报告，不重启成功 job                          |
| handoff 提交                           | 与宿主 checkpoint 同事务，不存在一边成功另一边仍可重新提交的窗口                                 |
| 报告已归档、bundle 未准入              | 原材料可核验并幂等推进，取消／challenge 后旧材料不能变为当前准入                                 |
| 认定响应丢失                           | 使用 S2 原 operation ID／exact target 查回原 receipt                                             |
| 协调器被接管                           | 旧 generation 的提交失败；原 job 身份不随之刷新                                                  |

宿主 API 提供 `issue/get/advance/recover/cancel` 及 bundle／对象读取；必要的显式 job 重试保留 previousJobID。后台推进与显式 advance 共享同一 lease／CAS。恢复不是为任意 Session 开启重启后自动 provider 重试。

取消先原子关闭 run、worker admission 和 recognition admission，再中断 Session／job，等待有界清理；重启不恢复 cancelled。到期停止新计算和在途计算，保留已产生的证据和用量。已完成且合法发布的材料可供外部事后认定；不延长工作期限。未知副作用不宣称 exactly-once。

## 8. Core change gate

纯 kernel 的状态和命令不变。以下改动属于已有通用边界接线：

| 边界                  | invariant／反例                                                  | 为什么需要此处                                                                          | 验证                                              |
| --------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------- |
| ready profile adapter | 当前执行授权及 exact identity；同步 capture 可与写入并发         | canonical leaf 必须选择本 profile 的唯一交付入口                                        | native 兼容、缺适配器拒绝、并发写／权限等待／取消 |
| admission 输入        | 保留已批准工作与同 attempt 修复；新 Session 丢失实际失败材料     | 正文、delivery、Session／Prompt ID 随 admission 持久化；原 scheduler 精确重试复用原输入 | 陈旧输入拒绝、同 attempt／deadline／累计计量保持  |
| validator 构图        | no self-certification；某入口未安装检查而降级                    | 共享认定边界必须在所有宿主路径使用相同注册                                              | HTTP／SDK／本地调用和未装载 CLI 拒绝、取消 CAS    |
| replay 产物保留       | exact evidence／historical integrity；scratch 清理后只剩文件hash | 验证适配器必须在清理前捕获真实字节                                                      | 篡改／缺失／越界／过大／中断证据及 native 回归    |

SDK 研究表不加入 kernel；S4 清单、TAP、review verdict 和阶段只由宿主解释。Core Constitution／kernel 原有测试继续运行。

## 9. 实施顺序与接受测试

先审查本设计，修正阻断项并冻结 hash；再实现通用接线、宿主状态／流程、证据准入及测试。之后独立审查代码，修正并复核后才能记为 S4 完成。

必须验证：

- 一个真实 worker 写代码、ready、冻结、实际测试进程、独立 reviewer Session、bundle 发布、外部 exact 认定的完整流程；正确负结果也可交付。
- 零测试、空 harness 被 Node 包装为通过、条件未注册预期用例、结构化失败但退出零、非法／不完整输出、缺失或篡改原始产物、worker 伪造 reviewer 报告均不能通过。
- 并发写与 ready、权限等待后撤销、迟到 provider／工具、源工作目录变化、reviewer 修改／越界尝试不污染候选。
- 缺少 driver／ready adapter／validator 的进程拒绝研究执行或认定；所有认定入口使用相同证据要求。
- 机械失败同 attempt 修复；reviewer 缺陷等待外部 challenge；同 subject 再交付新身份、旧报告／认定请求失效；sealed feedback 不泄露。
- 真实 SIGKILL 覆盖冻结请求、正在验证／review、成功报告与发布之间的代表性窗口；其余原子窗口以真实 SQLite 定序验证，并准确区分证据。
- 两宿主竞争、旧协调器回调、取消发生在 validator I/O 后／discharge 前、原 deadline 在 review／verification 中到达。
- S1–S3b 相关回归、包类型检查、宿主表初始化／恢复、格式检查。公共 Protocol／HttpApi 如实际变化，按仓库要求生成客户端。

测试 provider 为本地确定性 HTTP 服务；机械测试使用实际进程和文件。不开真实研究任务，不修改任何冻结 cohort。
