# S6c 接线独立审查

状态：独立接线审查通过。2026-09-20，审查者为独立 agent `s6b_verify`。W1–W9 均已关闭；最终绑定版本未发现未解决的 P1／P2。本审查只评价不调用真实模型的运行接线；S6c 真实校准与资格评测未执行，实际模型请求数为 0，`qualification: not_run`。不修改 [S6b 历史审查](pro-contract-researcher-s6b-code-review.md)的源码绑定或结论。

依据为[冻结 S6 设计](pro-contract-researcher-s6.md)、[设计审查](pro-contract-researcher-s6-review.md)及 [S6c 准备](pro-contract-researcher-s6c.md)。初轮范围为 provider 与宿主隔离；后续扩大到 supervisor、实例／探针驱动、部署冻结、盲评、exact 认可、资格报告及对应 CLI。最终源码清单、共同运行身份及独立验证列于本文末尾；此前各轮反例与修订记录保留，不能把本次签字套用于其他代码版本。

## W1 · P1：宿主退出清理漏掉快速孤儿化的子进程

初版 [`host.start()`](../packages/opencode/script/research-eval/host.ts)每 25 毫秒从活 broker 根进程轮询 `/proc` 后代，并在 `stop()` 时只终止 broker 和已发现的后代。真实宿主允许生产验证进程使用 `setsid()`；短命父进程可以在两次轮询之间退出，使其子进程重挂 PID 1 并逃离原 process group。此后该进程既不在 broker 后代树中，也不在已知 PID 清单内，`stop()` 会在它仍活着时返回成功。

独立反例 `/tmp/s6c-review-host-orphan.ts` 使用实际 `host.start()`、`hostBoundary()` 及编译后的 seccomp／Landlock launcher，只将应用入口替换成审查者的轻量临时 IPC 程序。C helper fork 后父进程立即退出，子进程 `setsid()` 并睡眠四秒。宿主停止前独立 `/proc` 查询证明该进程的 `parent` 已为 1；`stop()` 约 1.15 毫秒返回后，相同 PID／start／boot 身份仍为存活的 `S` 状态，`escaped: true`。原始日志为 `/tmp/s6c-review-host-orphan.log`。反例有固定短期限，审查者在 finally 中手动清理，未遗留执行、调用模型或访问真实凭据。

关闭条件：进程归属和收尾不能依赖抽样发现后代；普通结束、取消及宿主异常退出均须清理实际后代并核验完成，不能只缩短轮询周期或 kill 原进程组。实施方随后改为 evaluation 专用受信 subreaper，允许生产进程 `setsid()` 并在收尾时 kill／reap 后代；复核结果如下。

### W1 修订复核

稳定候选将 `--supervise` 限于 evaluation 宿主。受信 broker 先成为 subreaper；退出或 SIGTERM 时终止其实际子进程，反复接收并清理重新归属的后代，直到 `waitpid` 返回 `ECHILD`。`atexit` 覆盖 broker 自身可正常执行 finalizer 的失败路径；固定五秒清理宽限耗尽返回 126。`host.stop()` 等待 supervisor 并拒绝 126 或任何非空 `signalCode`，不再把 supervisor 本身被杀当作清理完成。IPC ready 中的实际宿主 PID 也通过 `/proc` 的 PPID 归属核验；故障注入杀实际宿主，保留负责回收的受信 supervisor。

审查者只适配新 ready PID 协议后重跑原反例，日志 `/tmp/s6c-review-host-orphan-v2.log` 为 `escaped: false`，约 10.7 毫秒完成。另用 `/tmp/s6c-review-supervisor.ts` 覆盖取消、宿主正常退出、实际宿主 SIGKILL 及 supervisor SIGKILL 四条路径；日志 `/tmp/s6c-review-supervisor-v2.log` 保留全部进程身份。前三条分别约 10.7、20.4、20.8 毫秒返回，setsid 孤儿均已不存在；supervisor 自身 SIGKILL 时明确拒绝清理成功，剩余短命孤儿由审查者 finally 手动杀掉。最后一项只证明故障守卫会拒绝，不能解释为已自动回收。初次补充脚本在 finally 再次调用已被信号终止的 supervisor 的 `stop()`，按设计收到异常；该审查脚本问题已修正，初次日志 `/tmp/s6c-review-supervisor-initial.log` 保留。

该轮绑定 `host.ts` SHA-256 `1deacf0f69eed7b3c48769701215cacbfe8911ca9937fded5a525c679b318022`、`isolate.c` SHA-256 `923a19cffd02bbd9b78b313e18830b0aa88875d1e6918e84b92e23cd22d27fa3`、`isolation.ts` SHA-256 `b6cbbb03fa7abc975e119e163b629edaf9e61aa98d250a2395eb8faf6568cba4`。W1 的实现反例在该轮关闭；当时待核验的保留回归及 runner 失败保全已分别由下述测试和 W3 最终实测补齐。

实施方已将四条反例保留为 `host.test.ts`。审查者独立执行 4/4 tests、11 assertions 通过，日志 `/tmp/s6c-review-host-unit.log`；共享 C 边界的三项轻量隔离回归也独立通过，3/3 tests、25 assertions，日志 `/tmp/s6c-review-isolation.log`。W1 已关闭。

## Provider 修订与独立验证

初轮 provider 单测结果为 1 pass、2 fail，保留在 `/tmp/s6c-review-provider-unit.log`。一例依赖 Bun 在销毁上游后让 `response.text()` reject，实际可能正常返回已接收的部分文本；另一例未消费 raw TCP socket 的读端，测试等待不到 close。不能将这些初轮失败隐藏成未运行。

实施方修订后，取消逻辑先保存 `complete: false` transport 再销毁连接，测试直接核对部分流的 transport 证据；慢 header 用例消费 socket 并等待关闭。审查者从 `packages/opencode` 独立执行 `bun test --timeout 30000 script/research-eval/provider.test.ts`，3/3 tests、19 assertions 通过，日志 `/tmp/s6c-review-provider-v3.log`。核验覆盖固定 role／model／凭据、拒绝候选路由和授权头、原 deadline 后拒绝新准入、在途部分流与显式取消、慢请求头。均为真实本地 HTTP／TCP 服务，没有模型请求。

当前源码固定 HTTPS 模型上游的 origin、`/v1/chat/completions` 路径及受信 Authorization；candidate headers 不转发，上游重定向不跟随，响应只转发明确允许的请求身份／content-type 头。worker／reviewer alias 仅用于检查，实际角色来自 controller 的 operation 身份。最终已结合 runner 核对 `identify()` 的 operation 绑定、原 deadline／取消联动及归档完整性；实例级部分流故障实测见 W3，provider 单测不单独替代这些检查。

## W2 · P1：启动前检查接受不包含运行源码的冻结清单

新增 [`launch.check()`](../packages/opencode/script/research-eval/launch.ts)与既有 `preflight()` 只校验 manifest 声明的文件及关键对象的存在／hash，不要求声明集合包含完整执行源码。`runner` 由该 manifest 的子集计算；若 manifest 没有 runner 文件，这一子集就是 `{}`。`prompts`、`agents`、`tools`、`corpus`、`oracle`、`scorer` 与隔离对象也只校验调用者提供的对象字节，没有对应实际运行值。

独立反例 `/tmp/s6c-review-freeze-bypass.ts` 创建只含真实 `bun.lock` 的 source manifest，将 runner 及上述所有关键对象设为字符串 `{}` 的真实 SHA-256；配置中保留合法 runtime 身份、三个开发实例精确顺序、六小时 budget、固定 HTTPS endpoint 和显式凭据变量名。实际调用 `check()` 返回成功，日志 `/tmp/s6c-review-freeze-bypass.log` 保存 `accepted: true`、`sourcePaths: ["bun.lock"]`、`scheduled: 3`。凭据不存在且模型请求数为零；反例没有调用 `launch()` 或外部服务。该清单并未冻结任何正在执行的 TypeScript／C 源码，不能满足“完整冻结配置后才可启动”的条件。

关闭条件：核验清单与本次实际 tracked／untracked 源码集合相等，必需的执行模块不能缺失；关键运行对象必须由实际配置、任务／oracle、评分器、提示／agent／工具及隔离部署派生并逐项比对，不能用任意存在的内容 hash 充当其身份。缺文件、额外源码及伪关键对象应在发行任何实例之前失败。

修订后的 `freezeDeployment()` 从实际源码和运行值生成对象，`check()` 对完整源码集合、各项实际对象身份、精确任务顺序、固定模型／采样参数及超时／隔离／恢复 profile 逐项核验。原独立反例复跑在完整源码集合检查处被拒绝，日志 `/tmp/s6c-review-freeze-bypass-v2.log`。实施方 `launch.test.ts` 的完整配置正例、缺凭据拒绝、删减 manifest 及伪 scorer 对象拒绝均通过；v2 证据目录 `/tmp/opencode-s6c-launch-check-5a21fec4-5122-44e4-9463-02e0de69c18c`，最终 v4 目录为 `/tmp/opencode-s6c-launch-check-7f831779-967f-46d1-82d6-9726d983a2cc`。跨执行／评分阶段的源码身份已结合下面 W9 复核，不能用启动时一次检查代替。W2 已关闭。

## W3 · P2：清理失败发生在成功落盘之后，绕过实例失败归档

初版 [`runInstance()`](../packages/opencode/script/research-eval/instance.ts)先写 `result.json` 并准备返回，最后在 `finally` 调用 `host.stop()`。若 supervisor 的信号终止或清理超时使 `stop()` reject，该异常发生在 `catch` 之外，不会生成该实例的 `failure.json` 或保存 cleanup failure 的归档对象；此前写出的成功 result 仍在。cohort 外层会标 infrastructure failure，但单实例证据缺少其失败原因与明确收尾状态。

关闭条件：在发布成功结果之前完成并核验清理；失败路径保留工作失败与清理失败两个原因以及可定位的 archive root。实际 supervisor 清理未证实时必须停止 cohort，不准恢复旧实例或启动下一实例。最终回归须触发真实 supervisor 异常并核对落盘结果，不能只检查 Promise reject。

## W4 · P2：预定故障与在途 IPC 之间没有恢复同步边界

初版 `runInstance()` 的 provider／process 注入会直接 SIGKILL 实际宿主，恢复仅在进入 `port.command()` 且此刻 `supervisor.exitCode !== null` 时发生。monitor 可能已有 `research-get`／`research-history` 等 IPC 在途；也可能在 supervisor 清理完成前进入下一次调用。宿主死亡会使这些读取 reject，并直接进入外层 failure catch，跳过已预定的恢复。`exitCode` 的瞬时检查不能保证在途 IPC 与宿主退出／重启之间串行。

关闭条件：预定故障建立唯一的恢复状态或 promise，等待 supervisor 退出及完整清理，再启动、校验原 deadline、执行一次显式恢复。被该预定故障打断的只读 IPC 可以在这一边界后重取；有外部作用的命令不能盲重放。须覆盖注入落在已有 IPC 读取期间及 supervisor 尚未退出两种顺序，并核验既定一次注入、unknown 记录与 lineage。

初轮 runner 源码副本和 SHA-256 清单保存在 `/tmp/s6c-review-runner-initial/`。以上 W3／W4 是代码路径审查；W2 有实际轻量反例。没有把实施方两项生产接线测试通过当成这些异常路径已被覆盖。

### W3／W4 修订复核

成功结果已移至 proxy 关闭及 supervisor 清理通过之后落盘；失败路径先关闭 provider，采集可得的 operation／history，再保存清理结果、最终 partial transport 与可定位的失败 root。这样原始工作失败和清理未证实可以同时保留。最终成功和失败 root 均绑定完整 `transport.jsonl`；该日志包括单独的请求 body hash／bytes，不能仅以 response Observation 数组替代。

恢复已采用唯一 promise，并只对被本次预定故障打断的只读 IPC 重取。重启后不仅等待 Run `unavailable`，还等待真实 execution 的 `dispatched` 清空与旧 job lease 过期；随后显式 cancel／audit，要求旧 operation 已记为 unknown，最后调用一次生产 `research-recover`。取消和原 deadline 在最后一次恢复调用前重新检查。审查者核对了这些边界，没有绕过生产清理／审计守卫。

中间集成 `/tmp/s6c-instance-test-v6.log` 保留 R6 因 `Cannot audit an execution whose cleanup may still be active` 的失败；它揭示单看 Run 状态不够，不能删掉后只报成功。修订后单项 `/tmp/s6c-r6-test-v7.log` 通过；v2 全套中的 R5／R6 分别约 40.4／45.4 秒完成，保留一次注入、unknown、原 deadline 及新 job lineage。最终 v4 中 R5／R6 也通过，分别约 47.1／50.3 秒。审查者只读核对实际回归、日志及恢复边界；W4 已关闭。

### W3 最终独立故障实测与认可收尾

审查者在最终源码上执行 `/tmp/s6c-review-instance-cleanup.ts`：真实 `runInstance(mode: "local-fixture")` 对本地 HTTP fixture 发出 R3 worker 请求，收到仍在途的部分 SSE 后，通过独立 `/proc` 父子身份定位实际 supervisor 并 SIGKILL。实例 reject 且没有 `result.json`；失败 root 的 `attempted`／`admitted` 均为 true，`cleanup.complete: false`，原错误和清理失败同时保留。failure root 和完整 transport 内容 hash 均通过核验；部分流同时存在于 records 和 transport 尾部，失败 root／transport 中未出现 fixture 凭据。日志 `/tmp/s6c-review-instance-cleanup.log`，保全目录 `/tmp/s6c-review-cleanup-instance-a86a2cd6-1fb4-4d7e-9b36-28b8b5134522`。

末轮另发现 `recognize()` 也曾在 `finally` 清理前发布 `recognition.json`。最终修订先归档实际 accepted receipt，等待 `host.stop()` 成功后才发布认可文件；失败以追加式 `recognition-failures.jsonl` 指向包含 `receiptHash`／cleanup 的内容寻址 root，保留已经发生的认可而不宣称收尾完成。

审查者执行 `/tmp/s6c-review-recognition-cleanup.ts`，使用真实本地 R3 runner、独立 oracle 和明确标记的两份 fixture 评分生成正确 ready 候选。`fs.watch` 观察实际 receipt 对象归档，在看到 accepted 后杀已独立定位的认可 supervisor；没有生产注入钩子或 mock。实测 `injected: true`，`recognize()` reject，没有 `recognition.json`；追加账本的一项 failure root hash 有效，指向的 accepted receipt 保留且 hash 有效，`cleanup.complete: false`。同一实例通过实际 `qualification()` 生成的报告为 `recognitionComplete: false`、`qualification: not_run`。日志 `/tmp/s6c-review-recognition-cleanup.log`，保全目录 `/tmp/s6c-review-recognition-f508a85d-530b-4af7-9916-1003583e5ead`；该目录仅是本地审查 fixture。

这两项测试均由独立外层 subreaper `/tmp/s6c-review-outer-reaper` 包裹；外层在脚本结束后回收测试故意杀内层 supervisor 造成的后代，均退出 0。它只承担测试自身的清理，不修改应用隔离，也不证明应用在 supervisor 被 SIGKILL 后能够自行回收。应用在此路径证明的是“清理未证实”守卫及完整失败保全。两项测试均无真实模型调用；证据索引为 `/tmp/s6c-review-cleanup-evidence.json`。W3 已关闭。

## W5 · P2：最终探针在前置计划被拒绝后空等原 deadline

初版脚本 worker 在前置计划未 approved 时只返回完成消息；生产计划 `changes_requested` 回到 `exploration`，最终探针 monitor 却只等待最终报告、terminal 或 deadline。脚本已经没有后续动作，仍可能空等六小时。这不是新的目标评审机会，应该保留 `not_exposed` 并结束。

修订后 monitor 识别第一份已决定且未开放的前置计划，终止探针并保留其报告及未暴露结果。`instance.test.ts` 的 final probe 负分支经真实生产计划 reviewer 路径约 3.5 秒结束，v2 日志记录在 `/tmp/s6c-wiring-suite-v2.log`。另为计划阶段采用方法、控制、数据／范围、评估与可行性 rubric，不再要求尚未实施的正式实验输出。此项修订已核对。

## W6 · P2：完整任务错误候选被标为有效 reviewer 同意

初版 `finalizeScoring()` 总以 `oracle.instance.defective` 作为最终候选真值；所有 R 实例的这个字段固定为 false，它只表示任务不属于配对缺陷探针。worker 实际交付错误候选时，结果可能同时为 `verdict: incorrect` 和 `measured.label: valid_accept`。

修订后完整任务以本次独立候选判断和隔离 oracle 结果决定缺陷状态；未确定的研究候选不能计为有效同意，已确定的 objective 错误不会被其他未决项抹掉。新增 R1 fixture 留下公开 TAP 可过、独立边界 oracle 失败的候选，核对 `incorrect`／`false_accept`；v2 实际保全目录 `/tmp/opencode-s6c-full-a4b36b0d-e811-4364-9629-06cea3aad6bf`。此项修订已核对。

## W7 · P1：资格汇总遗漏评分争议和完整任务机制失败

初版 `qualification()` 仅用“score 文件是否存在”判断评分完成，忽略 candidate／reviewer annotation 的 `indeterminate`；完整任务也没有把 `measured.mechanismFailure` 转成 invariant 事件。因此，争议未决或研究任务 gate 违反 reviewer 协议时，`accounted`／`invariants` 仍可能通过。

修订后任何未决独立评分保持 `unresolvedScoring`，完整任务和探针的机制失败均进入 invariant。针对实际汇总入口的回归确认资格为 pending、`accounted: false`、`invariants: false`。此项代码与 v2 日志已核对，不能把临时 gate 的通过等同资格通过。

## W8 · P2：失败实例被汇总为未启动，丢失部分计量

初版资格汇总对 infrastructure failure／cancelled 一律写 `failure: not_started` 并跳过其 admission 和 usage。若第一实例已发 provider 请求后失败、其余尚未开始，报告甚至可能给出 `qualification: not_run`，遗漏真正发生过的 wire 和 unknown usage。

修订后失败 root 保存 attempted／admitted、原预算、可得 operation／history、最终 transport 与清理状态；cohort 链接该 root，汇总保留真实失败分类、已知用量及 `unaccountedTransport`，不把缺失值填零。针对已发行失败的回归确认 `qualification: failed`、`failure: infrastructure`，并保留 `wireRequests: 1`、unknown 和 null tokens。回归中的模式／事件是明确标记的测试数据，不代表真的调用过模型。

## W9 · P2：评分文件和评分器版本未完整绑定到原运行

初版 exact 认可只读取可变 `score.json` 中的声明，未核对封存副本或重算独立 annotations；独立调用 rating CLI 时也未核对当前评分／认可代码仍属于原 cohort。启动时源码相同不能证明几天后使用的评分器仍相同。

修订已为评分准备与最终评分保存内容寻址副本，读取时同时核对 JSON、reference 和原对象；认可前重算封存 candidate／reviewer annotations、检查 exact subject／bundle，并比对实际 provider operation 集合，拒绝启动新的模型工作。篡改 score 的回归在真实 attestation 前失败。

跨阶段 `codeHash` 最初只包含评估包装脚本，仍会遗漏其导入的 SDK schema、Core 等生产依赖。最终 `provenance.runtimeFiles()` 包含评估运行模块、各包 `src`（含 prompt Markdown）、`bun.lock`、`patches`、根及包的 `package.json`、`tsconfig*.json` 和 `bunfig.toml`；freeze 与执行／准备评分／封存／评分完成／认可／报告共用同一筛选规则。身份保留文件 mode、内容或 symlink 身份，并对有序 inventory 的读取使用 `Promise.all`。文档与测试不进入运行身份。

审查者逐项核对该映射及 `provenance.test.ts`：临时 Git 仓库中上述运行依赖的逐项改动会改变身份，文档／测试不会；实际 freeze manifest 推导的 runner 身份与 runtime 相等。此项保留回归在最终 v4 套件通过，最终全工作树运行身份也由审查者独立重算匹配。W9 已关闭；W5–W8 的上述修订及最终回归同样已关闭。

## 已核对的中间测试记录

实施方 v1 全工具套件为 35/35、3,608 assertions、153.81 秒，日志 `/tmp/s6c-wiring-suite-v1.log`；补齐资格汇总后 v2 为 37/37、3,615 assertions、155.98 秒，日志 `/tmp/s6c-wiring-suite-v2.log`。审查者已只读核对完整日志、相应用例及保全目录，没有声称自己重跑了这些生产集成。

审查者独立执行的 provider、host、三项隔离回归及两个初轮反例分别在上文列明。中间失败与修订后通过均保留；这些测试全部使用本地 fixture。v2 之后尚有源码身份扩展、成功 transport 归档和认可收尾修订，因此 v2 全套不单独充当最终版本签字。

v3 在扩大运行身份后，三项报告测试触及 Bun 默认五秒测试限时，日志 `/tmp/s6c-wiring-suite-v3.log` 保留；实施方在进入宿主集成前主动结束该轮，退出 143。随后保持身份排序而并行读取文件；运行原 deadline、生产和单操作限时均未借此放宽。最终工具套件使用 `bun test --timeout 30000 script/research-eval`，长集成用例保留各自显式测试限时。

## 最终源码绑定与验证

审查者独立读取并核对 `/tmp/opencode-s6c-wiring-final-fscayis2/code-manifest-v5.json` 全部 38 个代码／测试文件：内容 SHA-256 与文件 mode 逐项一致，没有差异。清单 SHA-256 为 `e42806ab539bd11f5947341f9c66e6dfad32dcad9c7ac66bd39307066b5e98c2`；另独立执行 `codeIdentity()`，共同运行 hash 为 `cd20f9d45309d9570293a19cdeef240cd12506a93e71095c9e27246571611390`。独立绑定日志 `/tmp/s6c-review-final-binding.log`。

实施方最终测试由审查者只读核对日志和相关用例；未声称独立重复整套重型回归：

| 验证 | 结果 | 保留日志 |
| --- | --- | --- |
| v4 完整工具套件 | 38/38，3,638 assertions，204.01 秒 | `/tmp/s6c-wiring-suite-v4.log` |
| 最后认可收尾修订后的 R3 端到端 | 1/1，13 assertions，20.97 秒 | `/tmp/s6c-recognition-final.log` |
| 默认 S6b 五例生产回归 | 5/5，53 assertions，45.58 秒 | `/tmp/s6c-s6b-regression-final.log` |
| 包内 `bun typecheck` | 通过 | `/tmp/s6c-typecheck-v11.log` |

v4 之后的运行改动仅为 `recognize.ts` 收尾修订，该路径有实施方 R3 成功回归及审查者实际清理失败反例两侧验证；最终 38 文件清单绑定的是这项修订之后的版本。审查者独立运行的 provider 3/3、host 4/4、隔离 3/3、冻结反例复跑及两项最终组合故障实测分别在前文列出。

## 审查范围限制

审查者只读实施源码，只修改本报告及 `/tmp` 中独立审查脚本／证据；没有运行完整重型生产进程矩阵或真实模型，没有修改实施源码、历史 artifacts、S6b 审查或冻结 cohort。验证限定于当前 Linux x64 环境和本地 HTTP／TCP fixture，未验证外部 HTTPS 部署、真实账户模型能力或研究质量。独立签字表示上述固定版本的离线接线问题已关闭；真实模型、受信部署、凭据引用、双人评分及裁决安排仍需填入完整配置，再按既定开发校准、最终冻结、资格评测顺序执行。本报告不声明真实校准或资格评测通过。
