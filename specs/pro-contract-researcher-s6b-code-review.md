# S6b 独立实现与语料审查

状态：最终独立复核通过，F1–F8 及两个补充归档缺口已关闭。2026-09-19。结论限定于末节绑定的 S6b 源码、确定性语料与部署；不评价真实模型能力，也不启动 S6c。以下保留各轮原始发现和当时的待办，最终签字见末节。

审查依据为 [执行交接](pro-contract-researcher-handoff.md)、[总方案](pro-contract-researcher.md)、[冻结 S6 设计](pro-contract-researcher-s6.md)与 [S6 设计审查](pro-contract-researcher-s6-review.md)。已独立核对设计 SHA-256 `737da740b22843d4259dbf6570177067ed2d5259b57834570cc6bb3c128700e3`、设计审查 SHA-256 `afe66d2b7eda522fdb7a97ed4e473d61f544efb20ba1ba32f116a265c635684d`。

审查增量以 S6b 编辑前完整镜像 `/tmp/opencode-s6b-baseline-20260919T072714Z/files` 为准，其 `manifest.json` SHA-256 为 `e2b8da36b4f3938053cc7502f4152f8fa6bff11e79410c3191442f9c6ce79441`。初轮候选清单 `/tmp/s6b-source-candidate.json` 含 26 个源码／测试／生成文件；没有把已有 S1–S5 的全部 Git 差异归为 S6b。实施方随后仍在补充控制器、归档及完整源码冻结，初轮审查不能替代其最终版本复核。

## F1 · P1：观察网关允许请求改写目标 origin，绕过网络隔离

初轮 [`gateway`](../packages/opencode/script/research-eval/observe.ts) 使用 `new URL(incoming.url, input.upstream)` 构造上游 URL。HTTP absolute-form 目标或以 `//` 开头的目标可以替换固定上游 origin。被测宿主虽只能连接网关端口，网关仍能替它访问其他主机或端口；Landlock 的直连限制不能阻断这条路径。

独立反例 `/tmp/s6b-review-network.ts` 建立 provider A 和另一个本地服务 B，将网关上游固定到 A，然后通过网关请求 `http://127.0.0.1:B/private`。实测返回 B 的 `ISOLATION_BYPASS_CANARY`，输出 `bypass: true`。这里只使用审查者创建的本地服务，没有访问真实凭据或外部服务。

关闭条件：网关固定并校验上游 origin，拒绝 absolute-form、network-path 和其他可改变目标的请求；冻结允许的 provider 路径与方法。隔离回归必须经实际网关尝试越界，证明除了正常 provider 路径外，其他主机／端口无法访问。

## F2 · P2：候选执行超时只终止直接子进程，孙进程可以拖住评分器

初轮 [`execute`](../packages/opencode/script/research-eval/isolation.ts) 在超时或输出超限时只调用 `child.kill()`，随后等待该进程以及 stdout／stderr reader 的 `Promise.all`。候选可以启动继承 stdout 的孙进程；直接子进程被杀后，孙进程仍保持管道打开，评分调用不能按时返回，旧执行也未被清理。

独立反例 `/tmp/s6b-review-timeout.ts` 在候选模块顶层启动一个持续 1.8 秒且继承 stdio 的 Node 进程，然后让父进程无限循环。设定 `timeout: 100`，实测返回耗时约 1,837 毫秒，虽然返回 `timedOut: true`。若孙进程不退出，当前调用可以无限等待。这违反单次操作有界与清理要求，不能靠原宿主 deadline 解决独立评分进程的挂起。

关闭条件：整个候选执行树受可核验的超时、取消和退出清理约束，无法通过创建新会话、孙进程或持有管道逃逸；回归覆盖正常结束留下后台进程、超时与输出超限，确认无活的旧执行并在固定的清理宽限内返回。

## F3 · P2：最终评分缺失合法原始证据 hash，误报有效 reviewer 与机制失败

初轮 [`target`](../packages/opencode/script/research-eval/driver.ts) 的最终证据列表只有 verification、materials、plan 等聚合对象 hash；生产 [`review` 准入](../packages/sdk-next/src/research/index.ts) 同时允许 `verification.evidence[].hash`。因此 reviewer 合法引用保留的 `artifacts/result.json`、stdout 或其他原始证据时，评分器会把引用判为无效。

独立反例 `/tmp/s6b-review-evidence.ts` 使用结构合法的最终 `accept`，唯一 claim 引用实际 Verification 所允许的 raw artifact hash。实测 `productionAllows: true`、`scorerAllows: false`，评分为 `unavailable`；若实际 gate 已开，还错误记录 `mechanismFailure: true`。初轮生产 fixture 只引用聚合 `verificationHash`，没有覆盖这种正常用法。

关闭条件：评估从已验证且绑定本次候选的 Verification 取得完整允许证据集合，与生产准入一致；加入引用 raw artifact 的有效 accept、有效目标阻断及非法 hash 的反例，不能简单接受任意 hash。

## F4 · P2：仅轮询当前 Run 会丢失第一份目标计划报告

初轮 [`monitor`](../packages/opencode/script/research-eval/controller.ts) 每 100 毫秒仅检查当前 `run.plan`，没有从持久 `research.history` 选择第一份目标报告。生产计划 reviewer 拒绝后立即返回 `exploration`；worker 可以在下次轮询前提交新计划并覆盖 `run.plan`。当前 monitor 随后可能等待或评分第二份报告，把首次错误或拒绝丢掉。

可达顺序为：第一次轮询看见 `plan_review`；第一份报告完成、实际 gate 关闭；worker 提交第二版计划；第二次轮询只看见第二版 `plan_review`。初轮确定性 fixture 在后续 worker 响应处保持等待，掩盖了这个窗口。冻结设计要求第一份完成的目标报告是主评分对象，不能反复送审后选择后份。

关闭条件：按持久历史／事件和原始 job 身份选择最早目标报告及其实际 gate，即使当前 Run 已前进仍保留首次结果；加入两个 monitor 观察间完成报告并提交新计划的回归。不可解析的首次报告同样不得被后续成功替换。

## F5 · P2：矩阵门槛只检查总数，缺失任务族仍能全部通过

初轮 [`report`](../packages/opencode/script/research-eval/ledger.ts) 的 `matrix` 只核验 48／24／24／18，总体与逐族门槛只遍历 manifest 中已经存在的 family，没有核验固定的 14 个任务族与重复坐标。

独立反例 `/tmp/s6b-review-matrix.ts` 创建 66 个唯一 ID，但仅含 `P1 × 48`、`R1 × 12`、`R5 × 6`，且所有 `repeat` 都为 1。提供相应好成绩后实测所有 12 个 `gates` 都为 `true`，虽然缺少 11 个预定任务族及其独立重复。当前返回的 `qualification: not_run` 避免了声称真实评测通过，但各工程门槛自身仍给出错误结果。

关闭条件：固定校验每族、轨道、好坏标签和重复 1–3 的精确坐标及唯一身份；不完整、重复或替换矩阵不得获得门槛通过。另需核验完整任务的机制失败也能进入不变量 gate，归档 gate 不能仅凭一个 `stopped` 事件代替评分争议和用量完整性。

## 初轮已核验的非阻断结论

- 好坏 P 组公开文件相同，仅一个计划字段改变目标方法缺陷；F 组更改实现或报告语义，保持结构、文件及实际 TAP 路径合法。R3 的负结果与 R4 的不可识别结论均由公开约束支持。独立数值判定没有调用内部 reviewer verdict。
- `publish` 不输出标签、准备答案或 oracle；候选模块在单独进程执行，未直接载入持有答案的评分进程。初轮独立复现未发现直接文件读取路径泄漏；F1 是经网关的另一条边界漏洞。
- raw accept 优先级、计划 scope 矛盾、结构／引用错误与实际 gate 在评分器中分开记录。所发现的 F3 是证据集合接线错误，不能以已有组合测试通过覆盖。
- 故障观察区分 operation 准入与真实 wire／response；测试进程身份包含 PID、启动时间、boot ID、父子关系及 executable。`killAtProcess` 在信号前后检查实际测试进程，优于仅用账本 running。真实模型配置与通用故障驱动尚须最终冻结，确定性 provider fixture 结果不代表 S6c 故障覆盖。
- `resolution.maxAttempts` 改为可选有明确的 deadline-only 需求：省略累计次数上限，Core 两个比较入口均显式 guard，历史显式有限值仍保留，未使用大有限 sentinel。初轮核对全部运行时引用未见遗漏；新增 Core／Schema 测试分别覆盖省略后的连续尝试和历史有限语义，生成类型相应改变。最终应将 public schema／客户端生成物与修复后的完整源码一并绑定。

## 审查者验证与限制

已只读检查适用 `AGENTS.md`、冻结设计、相关生产研究准入／报告逻辑、S6b 语料／评分／账本／隔离／观察／控制器／归档及主要测试；独立运行四个轻量反例。未运行真实模型或付费服务，未并行启动重型进程矩阵，没有修改源码或测试。实施方报告的校准、故障、全矩阵和 typecheck 结果将与其最终日志分别核对，不能视为审查者已重新执行。

以下保留初轮发现、逐轮修复和独立验证；中间检查点不替代末节的最终签字。

## 修订复核

初轮审查进程连接中断后，由另一独立 agent 接手复核，保留上述原始发现与反例。以下是源码修订过程中的核验，不替代最终冻结清单签字。

### F6 · P1：固定端口仍可通过 TCP Fast Open 连接其他地址

修复 F1 后的第一版网络边界仅以 Landlock 限制 TCP 端口，并由 seccomp broker 检查 `connect()` 的地址。审查者增加 `/tmp/s6b-review-port.ts`，证明仅限制端口仍可访问同端口上的其他地址。实施方随后加入固定 `127.0.0.1` 地址的 broker：它不使用 `SECCOMP_USER_NOTIF_FLAG_CONTINUE`，而是创建连接到固定网关的 socket，再用 `SECCOMP_IOCTL_NOTIF_ADDFD` 置入被测进程。因此，被检查的用户地址即使被其他线程修改，也不能改变实际连接目标。

复核时仍发现 `sendto(..., MSG_FASTOPEN, ...)` 不经过 `connect()`，可绕过该 broker。独立反例 `/tmp/s6b-review-fastopen.ts` 经隔离执行器向允许端口上的 `127.0.0.2` 发送数据，实测收到 `FASTOPEN_BYPASS`。这是可到达的网络边界漏洞，不能把前两个网络反例通过视为充分修复。

实施方在基础 seccomp 过滤器中分别拒绝 `sendto`、`sendmsg`、`sendmmsg` 参数中的 `MSG_FASTOPEN`，并拒绝 `TCP_REPAIR`、`TCP_FASTOPEN` 和 `TCP_FASTOPEN_CONNECT` socket 选项。独立复跑原反例得到 `sendto: Operation not permitted`、`bypass: false`；源码回归另覆盖三个发送入口。最终版本仍须包含这些修复和测试。

### 已独立复跑的修复检查

- F1：原 HTTP absolute-form 反例现在返回 `Gateway route denied`，不再访问另一个服务；同端口其他地址反例返回 `EPERM`。网关固定允许 POST 的两个 provider 路径，目标 origin 不取自请求；TCP 入口同时限制不完整头部和慢速 body 的总等待时间。
- F2：原 100 毫秒超时反例约 106 毫秒返回。额外 `/tmp/s6b-review-tree.ts` 核对父进程正常结束及输出超限，分别约 53／56 毫秒返回，后台子进程均不再存活。候选执行使用独立进程组，所有终止路径清理全组；seccomp 禁止 `setsid`、`setpgid` 及可逃离既有边界的 clone flags。
- F3：评分端现在从内容 hash 验真的 Verification 加入原始证据，核对 verifier job、subject、manifest 及每项 artifact 的字节数／hash；非法引用仍拒绝。生产最终 reviewer fixture 已改为引用实际 `artifacts/result.json` 的 hash。独立单测覆盖有效 raw-artifact accept、非法 hash、改写 artifact 及其他候选的 Verification。
- F4：控制器读取持久 `research-history`，按版本选择最早 `decided` 的目标状态，不再仅查看当前 Run。独立 selector 回归通过；最终还须核对实施方的快速连续计划生产回归日志。
- F5：原缺少任务族的 66 实例反例现在 `matrix`、`detection`、`controls`、`delivery`、`accounted` 均为 false。精确族／轨道／好坏／repeat 坐标、完整任务 invariant、显式 accounting 记录均已进入门槛检查。

独立执行日志 `/tmp/s6b-review-unit.log`：从 `packages/opencode` 运行 `driver.test.ts`、`score.test.ts`、`freeze.test.ts`、`blind.test.ts`，8 tests、105 assertions 全部通过。此轮未启动重型生产矩阵、真实模型或付费请求。

### 归档补充修复与源码清单核验

两个归档缺口已关闭。正常实例的 ledger observation／accounting 现在指向总归档对象，其中链接完整历史证据、provider transport、监控历史、challenge／exact attestation receipt 和外部评分原始输入输出。审查者对冻结矩阵前 5 个完成实例逐项核对这些链接及对象内容 hash，均匹配；完整任务的实际认可 receipt 可以从实例根定位。

宿主 API 已死亡的失败路径新增 `retainFailure`，在终止宿主并清理已知故障进程后，保存仅用于确定性 fixture、无真实 provider 凭据的 storage／workspace。独立核对 `/tmp/opencode-s6b-dead-failure-v1`：主动杀宿主的回归保留 `provider` 失败及 `issued`／`observation`／`stopped`；根对象链接保全目录与清单 `d2191fa0f45fedb866d03bea631f405fbd499e03cb29747a15cec0f9b31996f5`。135 个文件及 symlink 均与清单 hash 相符，SQLite 主库 4,096 字节和 WAL 543,872 字节保留。该日志中的 1 fail 是测试主动抛出的故障，不能计作正常成功实例。

审查者逐文件核对 `/tmp/s6b-source-final.json` 的 29 项，当前工作树全部匹配；清单 SHA-256 为 `e9ebdca0d26cfca647ef68f4161564a0b3c54782f81612d2b890d93d45fec021`。冻结矩阵的完整源码快照含 6,531 项，`source/manifest.json` SHA-256 为 `f04a7c3f0dfe8e0e0fe73b88beffc21555069f13a07a061c71b456c1b7eda5c2`，29 个增量文件在该快照内的身份均匹配。设计和设计审查的历史 hash 也再次核对未变。

### F7 · P2：历史 reviewer 用量阶段与 ready 时间记录不准确

完整归档使复核可以直接发现报告层的两个接线问题。冻结矩阵实例 `ba8f6950b0a2d15bb137a453` 的旧计划 reviewer job `f3041ea2-76df-4c83-a24e-6398027c4090` 在持久 Run 历史中明确属于计划评审，但 operation `a12c0e6e-c7aa-4f1d-ab8b-d91aafad64e6` 的 usage 被记为 `worker`。原因是分类只比较最终 `finished.plan.jobID`／`reviewJobID`，忽略恢复前的历史 job。累计用量没有丢失，但逐阶段效率与 unknown 分布不正确。

另外，candidate 的 `readyAt` 在外部 oracle 评分及 exact attestation 后赋为当前时间，把外部等待计入了 ready 达成时刻。主交付边界应取首次 ready 的观察或生产发布时间，评分／认可时间另列，不能因此延长或缩短 worker 的原 deadline。

关闭条件：用完整持久历史分类所有 operation，以首次 ready 证据记录时间；增加覆盖恢复前 reviewer 和外部评分跨 deadline 的回归。运行中的冻结批次与原始账本须保留，修正采用另行版本化报告／勘误，不静默改写旧证据。完整矩阵、S5／S4 回归及此项修复仍待最终核对，当前不预签通过。

### F8 · P2：恢复自检依赖短暂的当前 verifier 字段

冻结矩阵的 R6 repeat 2 在生产恢复成功后，自检驱动仍可能失败。实例 `5846f73560bfe4990f8854d5` 的新 verifier job 已完成；Run 在 v32–34 保存其 ID，v35 完成正式实验并返回 `execution` 时清空 `verifierJobID`。驱动稍后只读当前字段，取得 `undefined`，而 `not.toBe(oldID)` 不能证明新 ID 存在，后续读 `job.input` 抛出异常。

审查者把保留的 SQLite 主库／WAL 复制到临时目录查询，核对 `quick_check = ok`、上述版本变化，以及旧 job `ff36daa7-b87f-4ddb-b2ed-12c9b1568798` 为 cancelled、新 job `22f3f5a1-d249-4f76-a85e-85042d928f46` 为 completed 且 `previousJobID` 精确指向旧 job。此失败属于确定性自检驱动的观察竞态，不能据此声称生产恢复错误，也不能删除该次自检失败。

关闭条件：从 `stopped.version` 之后的持久历史选取恢复 job，明确验证其存在和 `previousJobID`；覆盖执行已经前进并清空当前字段的情况。实施方将保留原批次并发布新版本完整自检，最终日志与源码身份待核对。

该失败保全清单含 247 项。审查者发现 `storage/opencode.db-shm` 与原清单 hash 不一致；实施方确认其此前直接以 SQLite 只读模式诊断原档时改写了共享内存索引，已在 `/tmp/s6b-r6-forensic-access.json` 记录原／后 hash，原 manifest 未改。其他 246 项（包括 DB／WAL）仍匹配；本审查只查询临时副本，没有再改动原档。该取证副作用明确保留，不声称该目录仍逐项完全一致。

### F7／F8 修复代码复核

实施方在原冻结批次结束后才修改运行代码，没有把变更混入该批次。`accounting.stage` 现在按完整持久 Run 历史识别旧计划／最终 reviewer 与实验 job；candidate 使用首次 ready 观察时间，外部评分／认可时间分别保存。`accounting.correct` 只写新的派生报告目录，逐项保留原账本行 hash、归档根及校正前后值，并绑定原账本／报告、分类代码和 `ledger.ts` 报告代码的 hash；旧批次实际未记录的评分完成时间保留 null。

恢复选择限定为 `stopped.version` 之后的持久历史，明确核对新 job 存在和 `previousJobID`，不再依赖当前 verifier 字段。注入结果在恢复前登记，失败 finalizer 也保留尚未登记的注入／miss 状态。审查者独立重跑 `accounting.test.ts` 与 `driver.test.ts`，5 tests、15 assertions 通过，日志 `/tmp/s6b-review-v2-unit.log`（SHA-256 `6f42c0a1ad4e120067db47429997b4e71abecf9e6d4a5591d3487c3b281f547b`）。

此时记录的旧冻结账本 SHA-256 为 `403fbe0064c335ce59247d2f94330050e46c33e345fda9ae342981b4b62a1837`，原报告为 `ab73eafbdac563f79b138d2a0c06c521b5d60422930321c9d7f74ad22a83efe1`。该检查点尚未核对实际派生校正、全新矩阵及 S5／S4 回归；后续结果如下。

## 最终独立结论与签字

独立复核 agent `s6b_verify` 已完成源码、反例、修复、实际归档和最终日志核验，未发现本次 S6b 范围内剩余阻断项。F1–F8 和两个归档缺口关闭，S6b 通过；该结论不是 S6c 模型资格结论。

最终源码增量清单为 `/tmp/s6b-source-v2-final.json`，31 个源码／测试／生成文件，SHA-256 `18bc7bc25d6ea317b02c97d61749407cdd808722ef1f799488fb92d9c07e8995`。新批次完整源码镜像含 6,533 项，`source/manifest.json` SHA-256 `403e439d9815bf2930edcd45462338d4235a66aff51b91dbbfbca15135a80acd`。审查者逐项检查完整镜像的内容／模式、31 项增量与当前代码，全部匹配。收尾文档在批次结束后更新，不把这些更新套入运行镜像身份。

### 最终测试与对象核验

最终完整批次 `/tmp/opencode-s6b-matrix-20260919-final-v2` 单独重新执行全部 66 个预登记实例：48 个 reviewer 探针、18 个完整任务，14 个任务族及各自三个重复。日志 `/tmp/s6b-matrix-v2-final.log` 为 66 pass／0 fail、771 assertions、821.35 秒。19 项工具单测、74 项 Core／driver、2 项 Schema、14 项 S5／S4 生产回归及七包类型检查均有通过记录；S5／S4 日志另明确为 184 assertions。审查者核对这些日志，没有声称亲自重跑全部重型套件。

独立检查脚本及结果为 `/tmp/s6b-review-final-audit.{py,json}` 和 `/tmp/s6b-review-graph-audit.{py,json}`。审查者除此前直接运行反例和轻量单测外，还独立核对：

- 1,690 个内容对象全部 hash 匹配；66 个实例的账本 hash chain、报告事件及根归档相符。
- 174 个保留快照、201 个 job、1,137 个 operation 均可关联；全部 operation 的阶段归属和真实 wire 计数与归档相符。582 次 wire 各有原始 transport 记录；6 个崩溃 unknown operation 的 unknown 标记、空 token／cost 没有改成零。
- 42 份外部评分的源码／报告与对应候选 git archive 一致；18 个完整任务的 exact receipt 均绑定正确 Contract 与 subject，ready／评分／认可三个时间有序且 ready 在原 deadline 内。
- 通用 hash 扫描列出的 1,194 个 unavailable 引用（1,064 个唯一值）对应 spec、context、配置、输入／执行指纹、policy、可执行文件和 observation handle 等非 blob 身份。所有必须保留的 manifest、materials、plan、review、verification、experiment 和 bundle 对象均存在；672 次原始证据引用（含重复）均存在且字节数匹配。这不表示任意 64 位 hash 都能作为 blob 解析。

最终账本 SHA-256 为 `083114068256d7917c7ca6f3a63b35843958e0bfc73f0925d0051b54ca42c1d6`，最终报告为 `adb12099962459e0ba1d14b49a3689327778a98e23a7f4770b9f1d30be74e89f`。确定性结果为 24/24 缺陷检出、24/24 对照通过、18/18 完整交付、3/3 初始修复与 6/6 注入／恢复；工具门槛全部为 true，而 `qualification` 保持 `not_run`。

### F7／F8 关闭与历史结果保留

F7 的实际派生报告 `/tmp/opencode-s6b-matrix-report-v2` 已独立逐项复算：122 项校正都绑定正确的原行 hash、实例、归档根和前后值。96 项将 worker 用量从 review 改回 worker，9 项将历史计划 reviewer 用量从 worker 改为 plan_review，17 项修正 ready／外部时间；无法恢复的旧评分完成时间保留 null。派生报告的全部事件精确等于按校正项替换后的原事件，原账本与原报告 hash 未变。

派生 `corrections.json` SHA-256 为 `dd0d991912833f68cf9c1eeb826c089b1b0d7c66a047850ee54637a73974a01b`，派生报告为 `3421e5937a88155e02d50022fc3040fd2779282d992cfa27f6ea0bbf916ee36c`。它仍保留旧批次 17/18 交付、5/6 注入／恢复，以及 recovery／accounted 门槛失败。新批次没有与旧批次的成功实例拼接。

F8 修复已通过历史选择回归，最终 R6 repeat 2 也完成。必须区分实际分支：新批次三次 R5 均为 `replan: false`，三次 R6 均为 `replan: true`。最终矩阵没有再次走到“R6 不重规划且当前 verifier 已清空”的组合；这一竞态的关闭依据是已独立查询的旧真实持久版本／job lineage、修复后的版本筛选与 `previousJobID` 检查，以及对应 driver 回归。不能把本轮 R6 成功描述成该组合的生产重跑。

早期 51 pass／15 fail 的非冻结自检、65 pass／1 fail 的旧冻结批次、主动失败自检、hook timeout、首次校正调用失败以及 SHM 取证副作用均保留。首次报告 rapid 回归 1/1 和矛盾 raw accept 生产拒绝回归 2/2 已核对，分别补足 F4 与保守评分路径的生产证据。

适用限制仍是固定 Node TAP、Linux x64／Landlock ABI 至少 6、当前 seccomp broker 与 HTTP gateway 部署。文本质量需要后续完整盲评；真实 worker／reviewer 模型、采样、提示和部署运行清单尚未冻结。本次全部模型响应来自本地确定性 fixture，没有真实模型能力结论、付费运行、S6c 或真实研究试点。
