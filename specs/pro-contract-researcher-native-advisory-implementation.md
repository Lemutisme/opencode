# 原生 advisory review：最小接线与确定性验证

日期：2026-09-24。本记录对应[实施边界](pro-contract-researcher-native-advisory-revision.md)，原方案、修订稿及历史研究材料保持原文。本轮执行的是工程实现和本地确定性联调；没有启动真实研究、真实模型校准、66 例评测、历史重评或外部认可。

开始时工作树位于 `jerry/dev`，HEAD 为 `78bec19263814444ab008c58d54835b59b4a1c6b`，已有 70 个 tracked 文件修改及大量 untracked 材料。修改前的 HEAD、index/worktree 二进制补丁、状态、310 个路径的哈希和原文件归档保存在[基线目录](/workspace/opencode-native-advisory-baseline-20260924T020341057094Z)。本次没有 reset、切换分支、提交或删除历史材料。验证日志、对照产物和相对这份 dirty baseline 的增量保存在[验证目录](/workspace/opencode-native-advisory-validation-20260924T022425Z)。

首次实施收尾核验确认：310 个已保存路径中，301 个与基线逐字节一致，9 个为当次有意修改；另新增 11 个文件，没有缺失路径，已有 specs 全部保持原文，HEAD 与分支未变。完整清单见[保留核验](/workspace/opencode-native-advisory-validation-20260924T022425Z/baseline-preservation.json)，首次修改见[相对基线的补丁](/workspace/opencode-native-advisory-validation-20260924T022425Z/baseline-delta.patch)。后续审阅修复另记于文末，不覆盖首次验证材料。

SDK 通过 `OpenCode.create({ nativeAdvisory: true })` 显式装配原生请求处理、原生 scheduler 和启动对账。宿主只用返回的 `host.nativeAdvisory.issue(newNativeContract, configuration)` 为**新签发的 native 合同**登记可选能力。普通签发仍可使用；不支持的配置在签发 receipt 的 `review.available` / `review.reason` 中说明，不修改已批准的 spec，也不把普通签发变成研究失败。已有合同不能追加入组或重新配置，模型自提合同没有自动登记。

配置形状如下，示例中的新合同应已由宿主设置原六小时 deadline，并且没有 `turns` / `actions` 累计上限。示例只展示宿主组合，不是运行研究的命令。

```ts
const program = Effect.gen(function* () {
  const host = yield* OpenCode.create({ nativeAdvisory: true })
  return yield* host.nativeAdvisory!.issue(newNativeContract, {
    reviewer: {
      model: approvedReviewerModel,
      agent: approvedReviewerAgent,
      instructions: approvedReviewerInstructions,
    },
    materials: approvedRelativeFiles,
    evidence: approvedEvidenceRefs,
    time: {
      operationMs: 30_000,
      reviewMs: 10_000,
      cleanupMs: 60_000,
      resumeMs: 10_000,
    },
  })
})
```

这些时间值是本次常规进程联调使用的显式参数，不是普遍合适的研究时长。`operationMs` 从接纳时固定，涵盖等待根执行退出、材料准备和 reviewer 执行；`reviewMs` 限定一次 reviewer 执行。`cleanupMs` 至少 60 秒，计入现有取消路径两段各 30 秒的等待；`resumeMs` 是留给后续原任务的时间。时间不足不暂停，准备和完整性核验后再次检查，恢复、重试和重启都不延长原 deadline。超时保留“清理仍未确认”状态；停止等待不被当成退出证明。

新 brief 可以采用 [NativeAdvisory.guidance](../packages/sdk-next/src/native-advisory.ts) 中的中性说明，但必须由宿主在签发前明确纳入获批文本；SDK 不静默注入。唯一模型入口是 `contract_request({kind:"review",payload:{}})`，严格拒绝非空对象、数组、空值等 payload。模型不选择材料、reviewer 配置或审阅指令。未登记合同保持 adapter unavailable，未请求的合同不额外暂停，`contract_check` 和 `contract_report_ready` 没有新增钩子。

材料范围是签发时批准的确切文件清单，不支持目录。部分文件尚未产生时仍可请求审阅；实际快照中的缺失路径在 `materials.json.missing` 中明确列出，并由 reviewer 作为证据缺口处理。预查询时全部批准文件都缺失则不暂停。之后新产生的清单内文件需要新的明确请求，不能混入既有意见。

主要实现及其边界如下。

| 位置                                                                                                                           | 本次职责                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| [native-advisory.ts](../packages/sdk-next/src/native-advisory.ts)                                                              | 新签发登记、请求接纳、有限 reviewer job、采集、恢复和附件；不装配严格 Research Run/Coordinator   |
| [native-advisory-store.ts](../packages/sdk-next/src/native-advisory-store.ts)                                                  | SDK 自有登记、请求及追加历史；与 Core 复用同一个全局 Database 和 immediate transaction/savepoint |
| [native-advisory-materials.ts](../packages/sdk-next/src/native-advisory-materials.ts)                                          | 预查询/实际快照、仅复制批准的普通文件、证据 blob、独立环境核验、完整/部分原文及真实读取记录      |
| [opencode.ts](../packages/sdk-next/src/opencode.ts)                                                                            | 一次装配兼容 native 与历史 Research profile 的 delivery 服务；Location 图建成后绑定 handler      |
| [research/reviewer.ts](../packages/sdk-next/src/research/reviewer.ts)                                                          | 参数化已有环境、最终消息与 raw 采集；旧 wrapper 和严格解析语义保留                               |
| [open-code.ts](../packages/core/src/pro-contract/open-code.ts)、[scheduler.ts](../packages/core/src/pro-contract/scheduler.ts) | 显式保留 Session 的 CAS、Core binding 中固定的一次性输入、原生 inbox 精确重试与续行              |

方案 A 的接纳事务只做授权、身份、期限、幂等/缓存元数据查询、当前 assistant 消息检查、请求写入及 admission CAS。宿主用可信 `messageID` 调用 `SessionStore.message`，核对 Session 和请求工具，只排除自身 `messageID + callID`；其他 `pending` / `running` 调用使本次请求返回忙，admission 和版本不变，不排队。快照、materialize、blob 和 provider 操作都在该短事务之外。真实 CAS 后注入失败的测试证明请求记录和关闭 admission 一起回滚。

三类重复请求分别实现：授权仍有效的同一调用复用原记录；相同完整审阅输入的完整可用意见可以缓存，文字是否赞同不参与缓存资格；失败、不可用或中断后的新明确调用可以启动新 job。缓存键包含合同/revision/spec/context、快照、材料范围、附证集合及 reviewer 配置/环境。预查询快照与停下根执行后的实际快照分别保存；意见、job 与附件只绑定后者。路径、job/Session/消息 ID 和完整 job 输入先持久化，精确重试不会重造坐标。

正常恢复用 `setAdmission({ session: "preserve", ... })`，保留 Session、attempt、用量和原 capabilities，下一次 claim 更新 generation。固定消息 ID、目标 Session、context、文本及 delivery 与重开写在同一 Core CAS 中。scheduler 只读取 binding 和原生 inbox；派发失败即使更换 `promptID`，仍按固定 ID 投递。pending 输入复用并唤醒，promoted 输入不克隆，Session/文本/delivery 冲突拒绝继续。后续语义 attempt 换 Session 时，文本和 delivery 均回到原 brief / 原生规则。未选择新字段的旧调用仍按原来的换 Session 分支执行。

启动对账不调用 `ContractJobs.recover`。`open` / `prepared` job 用既有 `cancel`；其他终态只在仍有 owner 时调用 `audit`。根执行经原生 `sweep` 退役后才能通过完整 `setAdmission` 检查。接纳后未留下根退出确认的持久记录时，崩溃恢复采用换 Session/原 brief；按本轮确认纳入的 G3，已持久化实际快照或已创建 job 的断点也保留原 Session，仍先通过全部原生恢复检查。job 已启动、已完成未采集、已采集及已重开断点同样保留 Session。暂停归属匹配完整 reason、请求、context、权限和执行身份，不依赖最初 admission 版本号。已重开未写宿主进度时匹配完整固定输入，不仅比消息 ID。权限变化、取消、其他关闭主体、有效 lease、在途 activity 和到期均不被绕过。

宿主可通过 `requests(contractID)` 查看进度和 `deliveryState`：admission 已重开与 inbox 的 `missing` / `pending` / `promoted` / `conflict` 分开记录。`history(requestID)` 提供追加历史，`object(hash)` 读取并校验封存字节，`attachment(contractID)` 提供意见可用性、所审 subject/context 及与已有 handoff 的身份比较。附件不修改 kernel handoff，没有回应、completion 或处理说明完整度字段。损坏的归档/副本保留故障，停止可信呈现和缓存；独立成立的原生提交仍按自己的证据规则进行。

依据 [Constitution](pro-contract-constitution.md)，这次 Core 改动限于执行适配边界，不更改 kernel reducer、命令代数、公共 Protocol 或 Server HttpApi，因此不触发新的客户端生成。其准入说明为：

| Change gate        | 说明                                                                                                                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 维护的不变量       | Exact identity、effect authority、historical integrity；恢复不能扩张权限、移绑输入或重置共享预算                                                                                              |
| 缺少边界的反例     | 宿主在暂停时直接 prompt 会被拒；仅追踪 dispatch promptID 会在派发失败后丢失意见；未限定一次性输入会把旧意见/steer 绑定到后续新 Session                                                        |
| 为什么不只放在 SDK | admission CAS、派发授权与 durable inbox 属于 Core 执行适配层；SDK 不能以旁路写入代替其授权/精确重试。Core 不读取 SDK 研究表                                                                   |
| Pure-kernel 验证   | `pro-contract-constitution.test.ts` 和 `pro-contract.test.ts` 继续验证纯 reducer、精确身份、职责及预算守恒；没有新 kernel 概念                                                                |
| 实际边界验证       | 新 admission-input 测试使用真实 Database、Session inbox、scheduler，并在真实 admit 内注入派发失败；新进程测试使用真实 runner、工具、受控 job 和 SIGKILL                                       |
| 增删概念/分支      | 新增通用 `AdmissionInput.once` 与显式 `session: "preserve"`；一次性输入消费/换目标后不再走旧的无条件 text/delivery 覆盖。旧无目标输入分支保留；无新增研究状态机、回应门槛、等待队列或恢复平台 |

首次实施的确定性测试均从 package 目录运行，使用 Bun 1.3.14（本机路径为 `/tmp/opencode-research-toolchain/bun-linux-x64`）。provider 是本地脚本化 `TestLLMServer`，文件、快照、工具执行、数据库、取消和恢复均为实际实现。进程测试继承 fixture 的环境 allowlist，没有真实 provider 凭证。

| 验证组                                                                           | 结果与日志                                                                                                   |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Core Constitution/kernel、admission input、driver、job、control                  | 126 项通过；[日志](/workspace/opencode-native-advisory-validation-20260924T022425Z/core-regression-2.log)    |
| SDK 全套，包括 native 接纳/恢复、历史 Research、job、embedded 与 import boundary | 91 项通过；[日志](/workspace/opencode-native-advisory-validation-20260924T022425Z/sdk-all-final.log)         |
| native 参照任务、并发/缓存/故障、四个重启断点                                    | 16 项通过；[日志](/workspace/opencode-native-advisory-validation-20260924T022425Z/native-process-final.log)  |
| combined SDK 下显式 required plan/delivery，含两个 lifecycle                     | 4 项通过；[日志](/workspace/opencode-native-advisory-validation-20260924T022425Z/required-coexistence-1.log) |
| 历史严格模式的修复、malformed review、指令与材料防篡改                           | 3 项通过；[日志](/workspace/opencode-native-advisory-validation-20260924T022425Z/research-historical-1.log)  |
| 实际 job 权限、等待授权时撤销、read/glob/grep 路径隔离                           | 5 项通过；[日志](/workspace/opencode-native-advisory-validation-20260924T022425Z/job-permissions-1.log)      |
| Core / SDK / opencode 类型检查                                                   | 3 个 package 全部通过，各自 package 内运行 `bun typecheck`                                                   |

上述测试合计 245 项通过、0 失败。类型检查日志：[Core](/workspace/opencode-native-advisory-validation-20260924T022425Z/core-typecheck-final-1.log)、[SDK](/workspace/opencode-native-advisory-validation-20260924T022425Z/sdk-typecheck-final.log)、[opencode](/workspace/opencode-native-advisory-validation-20260924T022425Z/opencode-typecheck-final.log)。复核命令、最终计数和退出状态见[验证汇总](/workspace/opencode-native-advisory-validation-20260924T022425Z/verification.json)。

参照任务取历史 fixture 中 `ready-control` 的任务字节与 replay 约定，没有继承其历史累计预算。review 关闭和开启时都实际运行 `./compile.sh`、`python3 validate.py`，核对 `executable` 字节及成功的 native replay/handoff。开启后的再次 shell/Python 执行也通过；两组 brief 的唯一有意差异是开启组加入上述可选能力说明。root 的原六小时 deadline 保持不变，无 `turns` / `actions` 上限；正常开启组 generation 为 2、attempt 为 1，root 用量为 5 provider turns / 4 actions（沿用 `contract_request` 控制工具不增加 action 计数的现有语义）。reviewer 的四次 provider 调用和操作记录单独可查。

reviewer 的独立 Session 实际读取 `materials.json`、封存的 `candidate/linepack.py` 和 `candidate/validation-output.txt`。随后 root 收到普通非 JSON 原文，未作回应或 completion 动作，直接继续原任务并提交。另一个参照任务断点在意见采集后损坏 review archive：root 收到不可用说明，损坏原文未投递，仍完成独立有效的 replay。归档没有成为 handoff 的附加依赖。

并发测试控制真实 provider 流和 fixture-only barrier。长 bash 创建开始标记后，两个独立 review 请求都返回忙；admission 原值保持，bash 等到显式放行后写完完成标记。相反顺序中，review 先提交接纳事务，随后 bash 和第二个请求到达；进程标记从未创建，未执行调用的错误状态在恢复后的上下文中可见，没有自动补跑。普通 Chat 流在结束时才释放完整 tool call；因此这两项使用仓库已有的 Responses 协议逐工具完成事件，测试服务器仅增加原始事件透传，产品 LLM 协议/runner 不改动。

首次实施的四个重启断点为：接纳但未建 job、reviewer 已启动、意见已采集未重开、重开已提交未记宿主完成。真实 SIGKILL 后由新宿主启动对账，不补跑 reviewer，活动 lease 仍有效时不重开。未确认根退出的断点换 Session，并核对新首条原 brief；其他断点保留 Session 和固定消息，仅出现一次恢复说明。Core 测试另覆盖已 claim 但在写入 inbox 前真实派发失败，以及 pending/promoted、文本/Session/delivery 冲突、后续新 attempt。

时间与恢复故障还覆盖：近 deadline 不暂停、第二次时间检查不足、材料核验耗尽余量、prepared job 清理受阻后的结果保留、activity 未退出及外部 owner lease 未过期、权限变化/取消/到期不恢复。保留“未启动”的故障先写出失败测试，再修复持久化，前后日志分别为 [before](/workspace/opencode-native-advisory-validation-20260924T022425Z/not-started-recovery-before.log) / [after](/workspace/opencode-native-advisory-validation-20260924T022425Z/not-started-recovery-after.log)。没有把未知清理或中断文本升级为完整意见。

验证过程中的失败日志全部保留。初始 baseline fixture 漏初始化惰性的 embedded HTTP 图；补上已有 `root-info` 调用后，修改生产代码前的关闭组通过。实施中修正过 LocationMap 反向依赖的组合方式。另修正了测试夹具的 Git 初始化、工具事件序列、最终文本 stop 事件、Chat/Responses 时序，以及收集断点误阻塞归档故障记录的问题。并行运行全套时有一轮触发 Bun 默认 5 秒测试超时；单独运行 `bun test --timeout 20000` 后全部通过，该参数只约束测试案例，不修改产品/合同的时限或预算。

本实现限定单宿主、cooperative 部署。lease 到期、activity 清零、cancel/audit/sweep 通过仅代表满足现有原生恢复条件，不证明操作系统残留进程已全部退出，也没有新增外部监督证明门槛。原有网络、凭证、数据库和证据存储隔离仍由部署负责，review 不授予额外权限。已写入 durable 事件的部分文本及工具读取会保留；SIGKILL 时仍仅驻留内存、未到文本持久化边界的 delta 不会被臆造补回。

意见始终绑定捕获字节，不宣称在线工作区稳定；附件的 subject/evidence 身份匹配不证明 reviewer 理解、覆盖材料或普遍有益。原六小时 deadline 内的恢复余量也不保证完成修复和最终 replay。宿主永久不可用不保证自动恢复；真实模型是否主动请求和正确处理意见、多宿主恢复及跨平台残留进程行为仍未验证。关闭该可选接线用于未来新任务不改写已产生的意见/故障，也不切换运行中或冻结任务的协议。

2026-09-24 后续审阅修复：修改前再次保存了 [321 个路径的增量基线](/workspace/opencode-native-advisory-review-baseline-20260924T042928712727Z)，确认首次交付文件的哈希均未变化。本轮日志和增量补丁使用[独立目录](/workspace/opencode-native-advisory-review-validation-20260924T042928712727Z)，首次失败、通过日志及历史研究材料继续保留。

| 审阅项                            | 实施与验证边界                                                                                                                                                                                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1：job 完成、尚未采集时重启      | 先复现 completed 被误降为 unavailable，再修复恢复时的原因选择。原生取消/audit/sweep 检查仍保留；job 为 completed 时按正常完整性、环境和最终消息规则采集，不附加宿主中断失败理由。新增真实 SIGKILL 断点，核对完整原文进入原 Session、仅投递一次、job 不补跑。                                                  |
| G2：数据目录含符号链接            | 先用真实符号链接复现材料准备失败；新签发登记目录在环境核验前解析为 canonical 路径。准备与副本核验通过，材料文件自身改为符号链接仍被拒绝。已有登记路径不迁移、不重写。                                                                                                                                         |
| G3：实际快照或 job 已持久化后重启 | actual 和 prepared 两个新增真实 SIGKILL 断点均保留原 Session、原 brief、attempt、计量和 capabilities；prepared job 经原生取消，generation 保持 0，reviewer 不补跑。原预查询记录不作为保留 Session 的依据。                                                                                                    |
| 材料缺失：采用宽松处理 (b)        | 仍只处理签发时批准的确切文件。部分缺失时继续审阅，将实际封存快照中不存在的路径写入 `materials.json.missing`、材料记录及宿主附件；全部批准文件缺失时在预查询阶段返回不可用，admission 不变。目录、符号链接（含悬空链接）及越界路径仍拒绝。所声明的缺失状态也纳入副本完整性核验，不读取后来出现的在线替代文件。 |
| 未登记合同的错误                  | 在解析 review 专用 payload 前检查当前执行授权和合同登记；未登记合同的错误保持 adapter unavailable，不暴露只属于已启用合同的纠错提示。                                                                                                                                                                         |
| 接纳回执                          | 明确区分同 Session 恢复的意见/不可用说明，与更换 Session 后从原 brief 继续；不承诺旧反馈会跨 Session 自动移绑。                                                                                                                                                                                               |
| 后台查询                          | SDK 表新增仅包含 accepted/job/collected 行的部分索引；启动对账及每轮查询只加载未结束请求，历史请求和追加事件保留。没有新增请求队列或研究状态。                                                                                                                                                                |
| 临时目录                          | 以 durable 登记为保留依据，清理本次签发中未被登记引用的目录，覆盖重复签发、准备失败和正常异常退出；已登记目录保留。硬杀进程或文件系统清理失败仍可能留下目录，失败写入日志。                                                                                                                                   |

G1 的修复前后日志为 [before](/workspace/opencode-native-advisory-review-validation-20260924T042928712727Z/g1-before.log) / [after](/workspace/opencode-native-advisory-review-validation-20260924T042928712727Z/g1-after.log)。G2 的[修复前日志](/workspace/opencode-native-advisory-review-validation-20260924T042928712727Z/g2-before.log)显示真实路径比较拒绝了正常材料；修复后同时核对准备、副本哈希和材料符号链接拒绝。新增目录类型测试曾在测试自身删除空目录时漏传 recursive 参数，修正该夹具后重新运行；[该轮失败日志](/workspace/opencode-native-advisory-review-validation-20260924T042928712727Z/native-unit-1.log)保留。

缺失材料的进程用例由独立 reviewer Session 实际读取 `materials.json` 和剩余的 `candidate/answer.txt`，再向原 Session 投递包含证据缺口的普通文本；未要求回应或 completion。全缺失用例保持原 admission、generation 和 Session，不创建 job。另一项材料测试在实际快照后创建在线文件，确认旧材料仍标为缺失、未来快照的缓存键变化；若向封存副本补入未封存文件，完整性核验拒绝该意见。

本轮最终复核采用用户确认的 G3、宽松缺失处理 (b) 和确切文件范围；结果以以下最终日志为准。首次 245 项日志及本轮中间阶段材料原样保留，用户选择落实前的补丁和汇总另存于 [before-user-choices](/workspace/opencode-native-advisory-review-validation-20260924T042928712727Z/before-user-choices)。

| 验证组                                                                          | 结果与日志                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SDK 全套，包含 33 项 native 用例及历史 Research、job、embedded、import boundary | 98 项通过；[日志](/workspace/opencode-native-advisory-review-validation-20260924T042928712727Z/sdk-all-choices-final.log)                                                                                                                                                |
| 原生并发、缓存、故障、缺失材料、关闭/开启能力对照、七个 SIGKILL 断点            | 21 项通过；[日志](/workspace/opencode-native-advisory-review-validation-20260924T042928712727Z/native-process-choices-final.log)                                                                                                                                         |
| native 与 Research 共存时的显式 required plan/delivery，含两个 lifecycle        | 4 项通过；[日志](/workspace/opencode-native-advisory-review-validation-20260924T042928712727Z/required-coexistence-choices.log)                                                                                                                                          |
| `bun typecheck`                                                                 | SDK、opencode 两包通过；[SDK 日志](/workspace/opencode-native-advisory-review-validation-20260924T042928712727Z/sdk-typecheck-choices.log)、[opencode 日志](/workspace/opencode-native-advisory-review-validation-20260924T042928712727Z/opencode-typecheck-choices.log) |

本轮最终验证合计 123 项通过、0 失败，SDK 与 opencode 两包类型检查通过。只改动 9 个已有文件，没有新增或删除文件；其余 312 个已保存路径与增量基线逐字节相同。除本实施报告外，历史 specs 保持原文，HEAD、分支及 index 不变。详见[保留核验](/workspace/opencode-native-advisory-review-validation-20260924T042928712727Z/baseline-preservation.json)、[增量补丁](/workspace/opencode-native-advisory-review-validation-20260924T042928712727Z/baseline-delta.patch)和[验证汇总](/workspace/opencode-native-advisory-review-validation-20260924T042928712727Z/verification.json)。本轮没有改动 Core、公共 Protocol、Server HttpApi、旧 Research 实现或已签发合同的配置、deadline、累计预算语义。

补充说明以下现有限制，本轮不扩大恢复或材料协议：

- 仅有预查询快照不能证明根执行已经退出；尚未持久化实际快照或创建 job 的崩溃断点仍更换 Session，从原 brief 接手。G3 不跳过权限、暂停归属、activity、lease、sweep、deadline 或重开 CAS 检查，也不改写此前已记录的恢复选择。
- 材料范围仍是确切文件，不支持目录；未在签发清单中的新文件不会进入 reviewer Location。清单内尚未产生的文件可由以后新的明确请求捕获；本次意见只绑定本次快照及其缺失清单。预查询时全部缺失会避免暂停，但不能消除检查后的竞态；暂停后材料全部消失或准备失败仍走原生恢复。
- 登记绑定签发时的 context。challenge、principal resume 或修订推进 context 后，旧登记不再可用于请求 review；历史材料保留，不自动重新登记。
- pending inbox 仍持久属于原 Session。宿主崩溃后原生 lease 恢复若更换 Session，旧一次性意见不会自动移绑；同 Session 内的精确重试保证不丢失、不克隆，不能推导成跨 Session 投递保证。
- `nativeAdvisory: true` 同时装配宿主级 live scheduler，其职责覆盖该宿主上的原生合同，并非只驱动登记了 review 的合同。构建服务图时 scheduler 可能先于 handler 安装开始工作，窗口内的 review 请求可能返回 adapter unavailable。
- 固定消息 ID 或完整输入发生冲突时，派发拒绝并写入错误日志，`requests()` 的 inbox 状态显示 conflict；没有单独的升级处理，仍按原派发失败规则在同一 attempt 内重试，受原 deadline 约束。随机 ID 不能代替冲突检查。

上述增量仍只做本地确定性工程验证，没有启动真实研究、真实模型校准、66 例评测、历史重评或外部认可。

## 2026-10-01：重要节点与 reviewer 强度

本轮以 `native-advisory` 的 `dfa8721c08e58d4c42775ad9b799d5ccd346b0d9` 为基线，落实[重要节点定稿](pro-contract-researcher-native-advisory-nodes.md)第 8 节。开工时唯一未跟踪文件为该设计；已保存 HEAD、分支、状态、index/worktree patch、6,689 个文件及符号链接的哈希与完整归档，见[修改前基线](/workspace/opencode-native-advisory-nodes-baseline-20261001T011248626697Z)。设计 SHA-256 仍为 `76b40eea75b7eebf6a079d86835431452efa93d2018cda1706671953f6847b28`，没有编辑设计或此前的实施记录。

| 改动位置                                                    | 本轮内容                                                                                                                                                                                                             |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core `pro-contract/delivery.ts`、`tool/contract-control.ts` | 增加可选 `Handler.node`。native 交付在授权和分支确认后、action 预留与 replay 前调用；check 在 replay 报告与观察结果持久化后调用。输入副本包含执行身份、可信调用身份及节点材料，返回值只有 `intercept` / `continue`。 |
| SDK `native-advisory-store.ts`                              | 登记增加带版本的 `nodes` 与强度记录；请求增加 trigger、attempt 及交付声明／check 引用。新增 SDK 自有的 attempt 表，键为 contract/revision/attempt，保存首次观察时间及已接纳的交付节点请求。                          |
| SDK `native-advisory.ts`                                    | 共用方案 A 接纳路径，识别三个发起工具；节点记录与 admission CAS 同事务。落实时机、机会消耗、缓存放行、按触发类型恢复及附件。既有宿主循环记录启用中途节点的 attempt 首次观察时间。guidance 增加一句交付前审阅说明。   |
| SDK `native-advisory-materials.ts`                          | 交付节点缓存键加入 canonical JSON 执行者声明；材料清单附上 `untrusted-executor-statement`，保留 summary 的原文本和 uncertainties 的原顺序。主动／中途审阅仍沿用无交付声明的键。                                      |
| 新增 SDK `native-advisory-strength.ts`                      | 复用实际 `SessionRunnerModel.resolve` 解析模型默认值、variant 与 credential metadata；只读配置，不创建 Session、admit 或 provider 请求。比较双方有效模型与配置，记录可确认的 effort 或未确认原因。                   |
| 测试及 fixture                                              | Core 增加 13 项边界测试，SDK 增加 11 项节点测试及 10 项强度测试，新增 12 项真实进程节点测试。旧原生测试明确选用主动请求策略。fixture 的断点与 replay 报告读取仅用于测试，没有向生产代码加入检查点。                  |

新签发 API 默认写入显式 `nodes: { version: 1, submission: true }`，midcourse 默认关闭。旧登记缺少 `nodes` 时保持只有主动请求，不迁移、不重新配置。节点机会以 attempt 为单位，Session 更换或 generation 增长不重置；仅成功接纳消耗交付机会，缓存、忙、时间不足及接纳前错误都不消耗，接纳后意见不可用仍消耗。原生 completed 产生的新 attempt 获得新机会。

中途计时使用 attempt 首次观察时间与最近一次被接纳审阅开始时间的较晚值；记录持久化，重启不重置。最近接纳查询只选有 pause 的记录，缓存和未接纳请求不能推迟计时。到时后仍须 check 通过、快照变化和方案 A 接纳检查全部成立；没有新增累计上限、等待队列或自动重审。

缺失钩子直接继续。钩子的预期宿主错误记录日志并继续，Core 在继续前重新核验执行授权；中断、授权失效和 Effect defect 不被转换为成功。接纳已提交后丢失返回值时，关闭的 admission 阻止原交付继续，持久请求按既有暂停／恢复路径处理。交付节点本身不做 replay、不消耗 action，也不产生 report-ready 命令。check 已执行的 action 和证据不回滚；中断工具回执不会删除持久报告。

同 Session 恢复消息区分主动请求、任务设置的交付前审阅与中途审阅。交付消息补送原 summary／uncertainties，说明交付尚未记录、可以原样重新调用且无需回应意见；中途消息补送 check 结论、证据 hash 与所查 subject。按既有崩溃规则更换 Session 时仍从原 brief 继续，旧意见与声明只留宿主记录，不跨 Session 注入。`sameTask`、暂停归属、权限、清理、原 deadline 和预算检查保持原样。

强度检查不把 variant 名称当作档位。默认／省略 variant 使用模型本身默认配置；相同有效模型且解析出双方 effort 时按 `none < minimal < low < medium < high < xhigh < max` 比较，确定更低则拒绝 review 登记。更换模型必须显式选择并记录理由，不跨模型自动判断强弱。解析失败、不支持的配置或无法确认共同路由时，回执和附件记为 `unconfirmed` 并附原因；旧登记缺少评估也如此。`confirmed` 的范围是已解析 SDK 配置，部署网关最终覆盖仍须在启动方案中另行核对和冻结。

本轮 Change gate 限于执行适配层：

| Change gate           | 说明                                                                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 不变量与定位          | 不新增 kernel 不变量。认可仍由原 kernel 决定，精确执行授权、证据身份及原预算继续生效。节点只给可选宿主一个建议性审阅的调度入口。                                         |
| 缺少钩子的反例        | 宿主只能在 check／交付发生后轮询，无法在交付 action、replay 与 report-ready 之前安排暂停；主动请求入口不能替代任务设置的节点。                                           |
| 为什么不只在 SDK 组合 | 两个原生工具原先不经过 delivery handler。只有工具内部能提供这个调用时点；策略、计数、缓存、强度检查与节点表全部留在 SDK，Core 不读取 SDK 表。                            |
| Pure-kernel 验证      | kernel、reducer、Research 严格状态机均未改动；constitution 与全部 Core ProContract 回归继续通过。                                                                        |
| 实际边界验证          | 钩子输入突变不能改写原交付／replay；接纳前故障继续；提交后返回丢失、授权失效与中断不能产生错误交付。实际 provider 流、replay、job、Session inbox 和 SIGKILL 验证见下表。 |
| 增删概念              | 增加可选钩子、SDK trigger／版本策略／attempt 记录／强度摘要。共用既有接纳路径，没有新增 kernel 命令、研究状态机、回应或 completion 门槛、恢复平台或累计上限。            |

验收证据对应关系：

| 设计验收项                        | 确定性验证                                                                                                                                                                                    |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 首次交付暂停、恢复后原样交付      | 进程用例 `native node submission`：reviewer 真实读取 `materials.json` 和 `candidate/answer.txt`；意见回原 Session；唯一交付经过真实 replay，总 action 仅为最终交付的 1 次。                   |
| 四种接纳前放行，不用掉机会        | 忙时直接交付、review 时间不足、接纳前宿主错误，以及新 attempt 的相同声明缓存命中均实际交付。SDK 另验证机会未消耗及精确重试不改变原决定。                                                      |
| 先放行、replay 失败、修复后再交付 | Responses 流先启动真实长 bash，再释放交付工具；忙时执行失败 replay，修复后成功接纳审阅，恢复后原样交付。按实际工作计 4 actions，没有增加 attempt。                                            |
| 同 attempt 换 Session／新 attempt | SDK 使用真实 lease 退役、claim 与 completed，验证换 Session 不重置机会而新 attempt 重置；进程用例也经过真实 completed 后的新 attempt。                                                        |
| 接纳提交后返回丢失                | fixture 在真实接纳提交之后注入 typed failure；旧调用不能记录交付，持久请求恢复后只有再次调用产生一次交付。                                                                                    |
| 同代码不同声明不命中缓存          | 两个进程用例对比同一 subject：相同声明命中；改变 summary 时材料键不同并真实运行第二次 review。                                                                                                |
| 中断与授权失效                    | Core 两个工具均覆盖中断和 Unauthorized；SDK 覆盖 lease 过期及同可信调用内容冲突，不能伪装成继续或新增请求。                                                                                   |
| 中途计时、快照与缓存              | SDK TestClock 覆盖时间未到、失败 check、相同快照、接纳失败、不可用意见和重建宿主。进程用例实际命中缓存后修改材料并通过 check，在距缓存不足一个 afterMs、距最近接纳已满 afterMs 时接纳新审阅。 |
| check 回执前中断                  | 进程断点使工具回执中断；通过真实 `ProContractReplay.report` 重新读取并核验 retained evidence，恢复消息补送 passed 与 hash。                                                                   |
| 崩溃后节点状态                    | 新增 actual 快照后的真实 SIGKILL，重启保留 Session、attempt 起点、已用机会与原声明；旧七个崩溃断点全部回归。                                                                                  |
| 旧登记与强度                      | 恢复无 nodes 的历史登记形状，验证只有主动请求；默认 check 不暂停。真实配置解析覆盖任意 variant 名、default／省略、凭证覆盖、别名、较弱拒绝、跨模型理由及无法确认。                            |

最终验证使用 Bun 1.3.14，所有测试与 `bun typecheck` 都从相应 package 目录执行。测试 provider 为本地确定性服务，没有调用真实模型；测试的 replay、文件读取、快照、数据库、暂停和恢复使用实际实现。完整命令、环境覆盖、退出码和日志 SHA-256 见[验证汇总](/workspace/opencode-native-advisory-nodes-validation-20261001T011248626697Z/verification.json)。

| 验证组                                                       | 结果与日志                                                                                                                           |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Core 全部 ProContract（12 个文件，含新增 13 项工具边界测试） | 190 项通过，0 失败；[日志](/workspace/opencode-native-advisory-nodes-validation-20261001T011248626697Z/core-regression-final.log)    |
| SDK 全套（含 44 项 native 与 10 项强度测试）                 | 119 项通过，0 失败；[日志](/workspace/opencode-native-advisory-nodes-validation-20261001T011248626697Z/sdk-all-final.log)            |
| 原生 advisory 进程组（旧 21 项与新增 12 项）                 | 33 项通过，0 失败；[日志](/workspace/opencode-native-advisory-nodes-validation-20261001T011248626697Z/native-process-final.log)      |
| 显式 required 与 native 共存                                 | 4 项通过，0 失败；[日志](/workspace/opencode-native-advisory-nodes-validation-20261001T011248626697Z/required-coexistence-final.log) |
| 历史严格模式回归组                                           | 3 项通过，0 失败；[日志](/workspace/opencode-native-advisory-nodes-validation-20261001T011248626697Z/research-historical-final.log)  |
| job 权限与实际 read/glob/grep                                | 5 项通过，0 失败；[日志](/workspace/opencode-native-advisory-nodes-validation-20261001T011248626697Z/job-permissions-final.log)      |
| 评测网关原有测试（源码未改）                                 | 117 项通过，0 失败；[日志](/workspace/opencode-native-advisory-nodes-validation-20261001T011248626697Z/gateway-final.log)            |
| Core `bun typecheck`                                         | 通过；[日志](/workspace/opencode-native-advisory-nodes-validation-20261001T011248626697Z/core-typecheck-final.log)                   |
| SDK `bun typecheck`                                          | 通过；[日志](/workspace/opencode-native-advisory-nodes-validation-20261001T011248626697Z/sdk-typecheck-final.log)                    |
| opencode `bun typecheck`                                     | 通过；[日志](/workspace/opencode-native-advisory-nodes-validation-20261001T011248626697Z/opencode-typecheck-final.log)               |

以上最终回归合计 **471 项通过、0 失败**，三个 package 类型检查全部通过；未把前面的定向重跑重复计入总数。

全部中间失败日志保留。实施中修正了强度解析依赖未在 service 构造时捕获的问题；也修正了测试文件路径品牌类型、错误读取 replay 证据存储，以及新 Responses 场景误用会输出 null token-detail 的 Chat 转换器。新场景改用合法的原始 Responses 事件，未改动产品 LLM 协议或共享转换器，也没有放宽计数断言。最终结果以 `*-final` 日志为准。

相对基线修改 11 个已有文件，新增 3 个 TypeScript 文件；[补丁](/workspace/opencode-native-advisory-nodes-validation-20261001T011248626697Z/baseline-delta.patch)不包含用户原有的未跟踪设计。其余基线路径、设计原文及本报告此前内容保持不变，HEAD、分支及 index 也未改变。详见[保留核验](/workspace/opencode-native-advisory-nodes-validation-20261001T011248626697Z/baseline-preservation.json)与[受测源码哈希](/workspace/opencode-native-advisory-nodes-validation-20261001T011248626697Z/tested-sources.json)。未改评测网关、公共 Protocol 或 Server HttpApi，因此没有生成客户端，也没有提交或推送。

本轮已授权的实现范围内没有已知设计偏离或未完成项。既有的单宿主、确切文件清单、context 改变后 review 失效、换 Session 不移绑旧意见等限制继续适用。`afterMs` 从宿主首次观察到 attempt 的时刻起算，不声称记录了进程尚未观察到的更早起点。

设计第 10 节的部署路由冻结、两条部署演练及真实试运行，按本次明确范围留待 Claude 把关后另行安排，未计入本轮验证。届时须重新批准两份 brief，并分别冻结 `worker: low`、`reviewer: high`、整个 reviewer job 的 reviewMs 与单次网关请求的 15 分钟时限。本轮未修改运行中或冻结实验，没有真实研究、模型校准、66 例评测、历史重评或外部认可。

## 2026-10-01：Claude 复核修复 S1、S2 与 M1–M5

本节覆盖上一节中对应的错误表述；此前报告保留原文。本轮从 Claude 审查过的未提交工作树继续，HEAD 仍为 `dfa8721c08e58d4c42775ad9b799d5ccd346b0d9`，分支仍为 `native-advisory`。开工前核对上轮送审的 13 个 TypeScript 文件及报告哈希，逐字节一致；再次保存了 6,692 个路径的完整归档、哈希、模式、状态与 index/worktree 补丁，见[本轮基线](/workspace/opencode-native-advisory-nodes-review-baseline-20261001T051109638851Z)。定稿设计没有修改。

| 修复                 | 本轮增量                                                                                                                                                                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S1：可选节点故障放行 | Core `contract-control.ts` 与 SDK `native-advisory.ts` 在节点边界记录并捕获非中断、非授权失效的 failure／defect，包括 SQLite 错误经 `orDie` 产生的 defect。接纳前失败时继续原生工具；SDK 尝试保存未发生原因，连该记录也失败时保留警告并继续。含中断的混合 cause，以及 fail／die 中的 `Unauthorized` 仍传播。 |
| S1：已提交接纳       | SDK 错误处理仍先重新授权，Core 放行后也保留原有的重新授权。已关闭 admission 的旧调用不能产生交付，持久请求继续暂停与恢复；不撤销接纳、重开权限或额外消耗节点机会。                                                                                                                                           |
| S2：循环容错         | 主循环分别保护 timed registration 读取、每个合同的 attempt 观察事务、unfinished 请求读取；单次错误记录后下一轮重试，某个合同的失败不跳过其余合同和请求。同步异常也进入相同边界；含中断的 cause 仍终止相应执行。没有增加独立循环、队列或累计上限。                                                            |
| S2：观察范围         | 仅对 `active`、无 pending revision、未到原 deadline、已有 attempt 且 `sameTask` 仍通过的合同观察 attempt。未结束的暂停请求仍进入既有 `advance` 授权核验和取消／清理路径，不能因为登记失效就直接遗漏清理。初始启动恢复阶段的错误传播规则未改。                                                                |
| M1：提前检查时间     | 节点通过资格检查后，在环境校验和预查询快照之前检查原有 operation／cleanup／resume 时间需求。不足则持久保存 `not-started` 并放行，不读取材料、不暂停、不消耗交付节点机会。接纳提交前的第二次时间检查仍保留。主动请求路径和时间参数未改。                                                                      |
| 测试                 | Core 增加 6 项，SDK 净增 9 项，进程组增加 7 项。所有故障注入位于测试或 fixture 的真实服务包装中，生产代码没有新增检查点。                                                                                                                                                                                    |

相对本轮基线，生产代码只改上述两个文件；另改 Core 测试、SDK 测试、节点进程测试及其 checkpoint fixture，并在本报告追加本节，共 7 个已有路径，无新增文件。

文档更正与保留限制：

| 项目                     | 准确行为                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M2：强度解析的副作用     | “只读配置”不准确。`NativeAdvisoryStrength.check` 经 `LocationServiceMap` 构建／取得 Location 服务并调用真实 `SessionRunnerModel.resolve`，会等待插件初始化、解析有效凭证；过期 OAuth 凭证可经 `Integration.connection.resolve` 刷新并写回 credential 存储。服务初始化也可能写入持久状态。强度检查本身不创建持久 Session、不 admit prompt、不调用模型推理，但不能称为严格只读或无网络副作用。 |
| M3：已接纳调用的精确重试 | 已成功接纳后 admission 已关闭，重试同一可信调用会先在授权处失败，不能返回原来的成功回执。未接纳且授权仍有效的精确重试才重用既有决定；持久化的已接纳请求仍负责恢复，没有第二次接纳或交付。设计第 4 节“精确重试返回同一个决定”的字面表述在这一边界上与实际不一致，本轮依照复核意见明确记录，未放宽授权、未改设计。                                                                             |
| M4：损坏缓存             | 交付节点选中完整意见缓存后才检查归档完整性。损坏时标记本次记录和缓存源的 `archiveFault`，这次节点继续放行，不在同一次调用重新审阅，也不消耗节点机会；后续新调用不再选择这个损坏源。若本次原生交付成功，该 attempt 就可能没有发生新的交付前审阅。                                                                                                                                             |
| M5：较弱 reviewer        | 能确定 reviewer 的有效强度更低时拒绝的是 review 登记。`issue` 仍按原生规则签发合同，签发可返回 accepted，同时 `review.available=false` 并附较弱原因。调用方须检查 review 回执，不能把合同签发成功等同于 review 可用。                                                                                                                                                                        |

本节也更正上一节“Effect defect 不被转换为成功”的表述：依据本轮明确的 S1 指令，可选节点的普通 defect 现在会放行，中断与授权失效仍传播。这是对 [Core tool AGENTS.md](../packages/core/src/tool/AGENTS.md) 中通常规则 “do not use `catchCause`, because interruption and defects must survive” 的局部例外，仅用于已授权的可选节点边界。

本轮 Change gate：

| 项目                 | 说明                                                                                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 不变量与定位         | 不增加 kernel 语义；维持精确执行授权和已关闭 admission 的屏障，避免可选宿主故障成为原生工具的额外门槛。                                                           |
| 不修复的反例         | 接纳前 SQLite defect 可使本应放行的 check／交付失败；一次 attempt／request 读取错误可终止宿主循环，遗留已暂停请求。                                               |
| 为什么需要 Core 边界 | SDK 无法捕获 delivery handler 查找／调用层本身的 defect，Core 必须在可选回调处执行约定的放行规则；真实授权复核仍由原工具承担。调度策略和持久状态继续由 SDK 负责。 |
| Pure-kernel 验证     | kernel、reducer、Research 严格状态机保持不变，全部 Core ProContract 回归包含既有 constitution 验证。                                                              |
| 真实边界验证         | SQLite 接纳事务回滚；提交后丢返回／defect；混合中断与授权失效；实际 native replay；主循环三处一次性 SQLite 故障后的同 Session 恢复；默认两次暂停与唯一最终交付。  |
| 增删概念             | 无新协议、表、工具或执行平台；仅扩大节点约定的故障捕获范围、保护既有循环和提前执行既有时间判断。                                                                  |

新增验收证据：

| 场景               | 结果                                                                                                                                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 接纳前 defect      | 两个 Core 工具继续原路径，check 有持久 replay 证据，交付有真实 handoff；SDK 在实际 admission CAS 后、外层提交前制造 SQLite 错误，验证事务与节点 slot 回滚，后续新调用仍可接纳。                                              |
| 接纳后 defect      | SDK 在真实事务提交后注入 defect，授权失败且请求保持 accepted，之后恢复原 Session；进程用例完成 reviewer 实际读取、意见投递与恢复，仅重新交付产生一次 handoff。                                                               |
| 循环单次失败       | 在 actual 快照已保存、admission 已关闭时，分别注入 attempt scan、attempt observe 和 request scan 的一次 SQLite 错误；三个用例都完成 review、原 Session inbox 投递与最终 replay 交付。                                        |
| 观察范围与时间前置 | 用真实 release、petition、Principal resume 和 TestClock deadline 排除无效合同，只记录仍有效的 active attempt。两类节点时间不足时，FS 服务包装记录到零次 realPath 调用，且不存在 prequery 或 pause。                          |
| 默认策略的连续审阅 | 省略 nodes 配置签发；主动请求成功后第一次交付再暂停，两个 reviewer 都读取材料，第二次交付原样成功。两条请求同 subject、不同材料键，attempt 仍为 1、generation 为 3、最终只有 1 个交付 action 和 1 条 accepted report-ready。 |

新增 7 个进程用例的精确归档路径、文件哈希、provider 调用次数与恢复结果见[证据索引](/workspace/opencode-native-advisory-nodes-review-validation-20261001T051109638851Z/review-fix-evidence.json)。

最终验证仍使用 Bun 1.3.14，各测试及 `bun typecheck` 从相应 package 目录执行。provider 为本地确定性服务，replay、SQLite、job、工具读取、inbox 和恢复使用真实实现；没有调用真实模型。

| 验证组                             | 结果与日志                                                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Core 全部 ProContract（12 个文件） | 196 项通过，0 失败；[日志](/workspace/opencode-native-advisory-nodes-review-validation-20261001T051109638851Z/core-regression-final.log)    |
| SDK 全套（独立测试数据库）         | 128 项通过，0 失败；[日志](/workspace/opencode-native-advisory-nodes-review-validation-20261001T051109638851Z/sdk-all-isolated-final.log)   |
| 原生 advisory 进程组（4 个文件）   | 40 项通过，0 失败；[日志](/workspace/opencode-native-advisory-nodes-review-validation-20261001T051109638851Z/native-process-final.log)      |
| 显式 required 与 native 共存       | 4 项通过，0 失败；[日志](/workspace/opencode-native-advisory-nodes-review-validation-20261001T051109638851Z/required-coexistence-final.log) |
| 历史严格模式回归组                 | 3 项通过，0 失败；[日志](/workspace/opencode-native-advisory-nodes-review-validation-20261001T051109638851Z/research-historical-final.log)  |
| job 权限与实际 read/glob/grep      | 5 项通过，0 失败；[日志](/workspace/opencode-native-advisory-nodes-review-validation-20261001T051109638851Z/job-permissions-final.log)      |
| 评测网关原有测试（源码与测试未改） | 117 项通过，0 失败；[日志](/workspace/opencode-native-advisory-nodes-review-validation-20261001T051109638851Z/gateway-final.log)            |
| Core `bun typecheck`               | 通过；[日志](/workspace/opencode-native-advisory-nodes-review-validation-20261001T051109638851Z/core-typecheck-final.log)                   |
| SDK `bun typecheck`                | 通过；[日志](/workspace/opencode-native-advisory-nodes-review-validation-20261001T051109638851Z/sdk-typecheck-final.log)                    |
| opencode `bun typecheck`           | 通过；[日志](/workspace/opencode-native-advisory-nodes-review-validation-20261001T051109638851Z/opencode-typecheck-final.log)               |

本轮最终回归合计 **493 项通过、0 失败**，三个 package 的类型检查全部通过；定向验证未重复计入总数。

SDK 全套首次执行在既有 embedded 测试中遇到持续的 SQLite 锁等待，已终止该测试进程，原日志及退出码保留，未作为通过结果计数。源码核对确认 `Database.node` 在 module import 时固定路径，而 embedded 测试较晚修改 `Flag.OPENCODE_DB`，首次执行实际打开了已有默认测试数据库；只读核查其中的 binding 模型均为 `test/test` 或 `missing-provider/missing-model`。重跑时在 Bun 启动前设置独立 `OPENCODE_DB`，执行同一条 SDK 全套命令，未修改此范围外的测试或数据库实现，也未删除原数据库。过程见[数据库诊断记录](/workspace/opencode-native-advisory-nodes-review-validation-20261001T051109638851Z/sdk-test-database-diagnosis.json)。

完整命令、退出码、日志哈希及保留核验见[本轮验证汇总](/workspace/opencode-native-advisory-nodes-review-validation-20261001T051109638851Z/VERIFICATION.md)和[机器可读记录](/workspace/opencode-native-advisory-nodes-review-validation-20261001T051109638851Z/verification.json)。[增量补丁](/workspace/opencode-native-advisory-nodes-review-validation-20261001T051109638851Z/baseline-delta.patch)相对本轮保存的送审工作树生成，不能当作相对 HEAD 的完整实现补丁；已在独立基线副本验证正向应用，并在当前工作树验证反向检查。新增进程场景的 provider 输入、请求、合同／binding、job 操作及宿主日志在[进程证据目录](/workspace/opencode-native-advisory-nodes-review-validation-20261001T051109638851Z/process-artifacts-final)。

本轮要求的修复和补测均已完成。除上表明确的 M2–M5 行为边界外，没有新增设计差异；既有单宿主、确切文件清单、context 变化后 review 失效和换 Session 不补送旧意见的限制保持原样。持续性存储故障仍可能阻止原生执行或恢复；本次保证单次循环故障不会永久终止循环，不承诺在底层存储持续不可用时仍可完成工作。定稿设计、历史材料、kernel/reducer、Research 严格状态机、`sameTask`、评测网关及其测试未改。HEAD、分支、index 保持不变，未提交、未推送；未开展演练或试运行。停在本轮送审状态，等待 Claude 复核。

## 2026-10-02：两轮行为冒烟测试收尾

两轮都是单独标注的行为冒烟测试，不属于任何 cohort，只记录能力兼容性和实际行为，不据此推断 review 的效果。任务均为 SBNO（从 `SBNO_formulas.tex` 实现算法），隔离、CPU、固定 `acceptance.mjs`、七文件 artifacts、6 小时 deadline-only 预算保持一致。

| 项目 | 第一轮（2026-09-27） | 第二轮（2026-10-01） |
| --- | --- | --- |
| 代码 | `dfa8721c0`（只有主动请求） | `78c6366fd`（交付前节点默认开启） |
| Researcher／reviewer | `gpt-5.6-luna` low／low | `gpt-5.6-luna` low／high |
| 关闭组 | 完成交付，replay 通过；从签发到清理结束 108 秒 | 完成交付，replay 实际执行 2 次并通过；从签发到清理结束 93 秒 |
| 开启组 | 完成交付；未请求 review，记为"未发生"；从签发到清理结束 70 秒 | 交付前审阅发生；最终未能交付，操作者中止；从签发到清理结束 339 秒 |

**第一轮结论：**原生路径能在隔离环境中跑通 `acceptance.mjs`，最初导致 SBNO 失败 12 次的能力问题已解决。两组 Researcher 都只读了原文档的一部分就快速交付，说明"只靠 Researcher 主动请求"不足以让 reviewer 进入研究过程，由此引出[重要节点设计](pro-contract-researcher-native-advisory-nodes.md)。

**第二轮结论：**

- 交付前节点在真实运行中完整走通一次：第一次交付被拦截，暂停 92.6 秒后在原 Session 恢复；reviewer 以 high 档发出 8 次请求，完整读取 8 个交付文件和 tex 第 541–900 行，意见只投递一次。
- 意见有实质内容，并给出具体代码行，例如零频系数 `A0` 算出后未参与重建、归一化分母与文档公式不同。Researcher 据此自主修改了 `sbno.py`、`train.py` 和 `REPORT.md`，没有原样重新交付。
- 开启组未能交付，原因与 review 无关：Researcher 在审阅之前（工具调用 #26）误写了受保护的 `TASK.md`，原生 replay 的保护检查拒绝了此后所有交付。报告 blocked 后原生调度连续开新 attempt，操作者按规则保全现场并中止。详见[问题说明](pro-contract-protected-inputs-and-blocked-retry-problem.md)。
- 两轮的 review 机制、恢复和计量记录均如实完整；清理全部 `confirmed`。

**合同状态：**两轮关闭组的交付仍停在 `verification`，开启组第二轮的合同为 `active` 且 admission 已关闭。它们都在独立的试运行数据库中，宿主已退出，没有作 Principal 认可，也不需要进一步处理。

**遗留事项：**

1. ProContract 原生问题：受保护输入可被写坏、blocked 后重试空转。已写成[问题说明](pro-contract-protected-inputs-and-blocked-retry-problem.md)，另行规划。
2. advisory 小问题：`materials.json` 是单行 JSON，reviewer 的 read 工具每行只返回前 2000 个字符。应改为分行写出。
3. advisory 小问题：宿主主循环每轮为每个开启中途节点的登记各开一个 immediate 事务，包括已结束的合同。中途节点默认关闭，影响很小。
4. 测试隔离：SDK embedded 测试因为数据库路径在模块导入时固定，会打开默认测试库，与其他测试争锁。运行测试时设置独立的 `OPENCODE_DB` 可以避开；这是既有问题。
5. 下一轮试运行：等问题 A 的修复合入后再跑两组，新合同把 `resolution.retryDelay` 设为几分钟。

**证据目录：**第一轮在 `/workspace/sbno-native-advisory-preparation-20260924T054618Z/approved-execution-20260927T072425Z/`，第二轮在 `/workspace/sbno-native-advisory-preparation-20260924T054618Z/nodes-preparation-20261001T062410Z/approved-execution-20261001T065720Z/`，两者各有 `RESULTS.md` 和封存清单。

## 2026-10-04：`materials.json` 分行副本实施记录

本轮以实现者身份，基于 `native-advisory` / `b386003b7aa4ea86cb1c25d9de35cdb45034ccd1` 完成分行修复。开工时工作树干净；修改前按既有方式保存全部 6,694 个 tracked / non-ignored untracked 路径的完整归档、逐文件 SHA-256 和模式，以及 HEAD、分支、Git 状态、index/worktree 二进制补丁和 index entries。见[基线元数据](/workspace/opencode-materials-format-baseline-20261004T202623472056Z/metadata.json)。本节只追加，原文和历史材料保持原样。

改动：

- `packages/sdk-next/src/native-advisory-materials.ts`：`prepare` 将规范 JSON 按结构标记确定性分行，使用 2 空格缩进、LF 换行及一个文件末尾换行。字符串标记保持原样，键序与规范文本一致，包括整数形式的键；数组顺序不变。`state.put(materials)` 原样保留，`materials.hash` 仍是规范单行内容的哈希，缓存键、job 输入、审阅记录及附件中的材料身份均不变。
- `verify` 先通过 `state.bytes(materials.hash)` 读取并校验已存的规范字节，再读取副本。副本只能与规范单行字节或从这些规范字节渲染出的新格式逐字节相等；不会解析副本后比较。旧轮次的单行文件继续通过，其他空白变化、内容变化及重复键仍报 `Review materials copy is corrupt`。
- `packages/sdk-next/test/native-advisory.test.ts`：新增确定性和兼容性用例，覆盖字段换行、2 空格缩进、末尾换行、字符串中的引号／括号／反斜线／换行／Unicode、重复准备的相同字节、规范哈希与 job 输入／缓存键不变、新旧格式通过。拒绝前导空格、缩进变更、CRLF、缺少或多出末尾换行、旧单行文本附加换行、内容变化及重复键，共 8 种差异。
- `packages/opencode/test/server/pro-contract-native-advisory-nodes-process.test.ts`：增强已有用例，使用每个字符串低于行上限、合起来超过 2000 字符的执行者声明，并保留一个缺失材料项。脚本 reviewer 显式从第 1 行读取 `materials.json`，触发实际分页读取路径；断言发送到 provider 的工具结果没有行截断、没有分页截断，完整内容等于封存材料，包含 `files`、非空 `missing` 和完整执行者声明。

兼容方式没有新增格式版本或迁移。生产改动仅在材料模块；reviewer 提示、材料清单生成、缺失文件处理、执行者声明的内容及结构位置均保持原样。Core、Research、评测网关、公开 Schema / Protocol / Server 和历史实验材料未改。

已知局限：JSON 字符串仍占一个物理行，字符串内部的换行仍按 JSON 转义。任务 `brief` 等单个长字符串超过 2000 字符时，分页 read 仍可能截断这一行；本次分行不能消除这一限制。`brief` 本身已直接写入 reviewer 提示，该路径保持不变。本次解决的是原单行文档使后续元数据和多项执行者声明一起丢失的问题。

验证均从 package 目录启动，每次调用设置独立 `OPENCODE_DB`，各测试组及类型检查依次运行，没有并行。SDK 单元夹具和 opencode preload 的既有内存数据库机制保持原样；宿主夹具仍使用各自独立的临时磁盘数据库。只使用本地脚本 provider，没有调用真实模型。

| 验证组 | 结果与日志 |
| --- | --- |
| SDK：native-advisory、native-advisory-strength、contract-jobs（3 个文件） | 67 项通过，0 失败；[日志](/workspace/opencode-materials-format-validation-20261004T202623472056Z/sdk-regression-final.log) |
| opencode：native advisory 进程回归（4 个文件） | 41 项通过，0 失败；[日志](/workspace/opencode-materials-format-validation-20261004T202623472056Z/opencode-regression-final.log) |
| sdk-next `bun typecheck` | 通过；[日志](/workspace/opencode-materials-format-validation-20261004T202623472056Z/sdk-typecheck-final.log) |
| opencode `bun typecheck` | 通过；[日志](/workspace/opencode-materials-format-validation-20261004T202623472056Z/opencode-typecheck-final.log) |
| 三个 TypeScript 改动文件的 Prettier 检查 | 通过；[日志](/workspace/opencode-materials-format-validation-20261004T202623472056Z/format-final.log) |

指定回归合计 **108 项通过、0 失败**，两个 package 的类型检查全部通过。定向测试和修复前刻画没有重复计入总数。

修复前，在未修改的生产源码上运行新增断言：SDK 的两个用例失败，进程用例在执行者声明中实际收到 `line truncated to 2000 chars`，`files`、`missing` 尚未出现。修复后同样的两个 SDK 用例及同一进程用例全部通过，再运行上表指定回归。修复前失败日志是刻画证据，未计入最终回归通过数，也未覆盖或删除。

完整命令、退出码、独立数据库路径、日志哈希和前后对照见[验证汇总](/workspace/opencode-materials-format-validation-20261004T202623472056Z/VERIFICATION.md)及[机器可读记录](/workspace/opencode-materials-format-validation-20261004T202623472056Z/verification.json)。[进程读取证据](/workspace/opencode-materials-format-validation-20261004T202623472056Z/materials-read-evidence.json)保留实际 reviewer 工具结果的位置、材料身份和完整读取核对。[增量补丁](/workspace/opencode-materials-format-validation-20261004T202623472056Z/baseline-delta.patch)相对本轮保存的干净基线生成，已在独立基线文件副本正向应用并核对结果，也已在当前工作树反向检查。

HEAD、分支及 index 保持不变，只有一个生产文件、两个相关测试文件和本实施记录发生变化。未提交、未推送、未运行 generate，未调用真实模型；停在送审工作树，等待 Claude 把关。

## 2026-10-05：第三轮行为冒烟测试与系列收尾

第三轮的代码为 `d51b45c83`，包含 A0（受保护输入在首次启动前提交）、B(iii′)（新原生 binding 默认 `blockedRouting=escalate-after-repeat`）和分行写出的 `materials.json`。任务、两份 brief、模型路由（`gpt-5.6-luna`，Researcher low、reviewer high）、隔离、CPU、固定 `acceptance.mjs`、6 小时 deadline-only 和全部时间参数都与第二轮相同。同一套冻结脚本先后正式尝试了三次。

| 尝试 | 运行写入位置 | 关闭组 | 开启组 |
| --- | --- | --- | --- |
| attempt-1 | `/workspace`（MooseFS） | 宿主未就绪，`startup_timeout`，清理 `unconfirmed`；未签发 | 未启动 |
| attempt-2 | `/workspace`（MooseFS） | `native_handoff`，replay 2 次通过 | 运行 155 秒后，IPC `get` 交付超时停止；未审阅 |
| attempt-3 | 本地 overlay | `native_handoff`，replay 2 次通过；从签发到清理结束 68 秒 | `native_handoff`，交付前审阅 1 次；从签发到清理结束 258 秒 |

**前两次停止的原因：均是环境问题，与 ProContract 和 advisory 无关。**

- attempt-1：正常启动只需 1.0–1.7 秒。这次宿主在模块加载阶段就停住了，`global.ts` 顶层的 mkdir 一个都没执行，也没有任何 stderr。收到 SIGKILL 后 5 秒仍未退出，监督进程按 `isolate.c` 的回收期限以 126 退出，所以清理记为 `unconfirmed` 是正确的。部署 argv、env 和配置与成功的演练相比只有端口不同。最可能是 FUSE 不可中断等待，但缺少当时的进程状态，未能证实。
- attempt-2：`host-journal.ts` 在同步写入之前就打上时间戳。response 362 的时间戳与随后的 `delivery_expired` 相隔 50.6 秒，中间只执行了一次 949 字节 CAS 对象的同步写入；该对象的目录项建于 02:42:31，文件 mtime 却是 02:43:21。同组此前已有两次同类卡顿（28.4 秒、16.7 秒），第一次离 30 秒的操作时限只差 1.6 秒。宿主数据库在同一窗口内也没有写入，两个进程几乎同时恢复。据此定位为 `/workspace` 的 I/O 卡顿。
- attempt-3：把全部运行写入（宿主存储、SQLite、CAS 日志、归档、工作区）移到本地盘，仓库、`node_modules` 和 Bun 仍只读使用原路径。两组 command 到 response 的最长间隔为 60 ms 和 232 ms，没有 timeout。这不是对照实验，但与上述诊断一致。

**attempt-3 的结论：**

- A0：两组的 `session.project_id` 都等于各自的根提交，四份受保护输入从头到尾哈希不变。没有发生输入损坏，Git 恢复路径在正式运行中没有被触发。
- B(iii′)：签发后、初始和最终的 binding 都保存了 `escalate-after-repeat`。没有 blocked 报告，路由没有被触发。上述两项未触发的路径已有测试和演练覆盖。
- 交付前节点在真实运行中完整走通：交付被拦截，捕获 9 份材料、`missing=[]`，经可信路由走 high，发出 8 次 reviewer 请求，意见只投递一次并回到原 Session，然后重新交付。从请求到恢复共 135 秒。
- `materials.json`：reviewer 用 `limit: 2000` 分页读取，第 93 行（`reviewer.instructions`）和第 108 行（`task.brief`）被截断。这是 2026-10-04 实施记录"已知局限"里声明过的情况。两个字段的全文都已在 reviewer 提示中，执行者声明（summary 537 字符，最长一条 uncertainty 196 字符）、`files` 和 `missing` 都完整读到，本次没有信息损失。
- 审阅质量好坏参半。第 1 条主要问题是错的：reviewer 把 `sbno.py:23` 引作 `einsum('ilj,jd->ilj', …)`，而工具三次返回给它的都是正确的 `'ild,jd->ilj'`；它据此断言单元测试无法运行，这与 replay 结果矛盾。第 2–4 条成立：`reconstruct` 把频率写死、分子里没有 A0（`sbno.py:34`、`:38`）；`SBNO` 是作用于像素的普通 MLP（`sbno.py:41-44`），正是 brief 禁止的"悄悄换成常规图像网络"；`fock_loss` 只是归一化的 MSE（`sbno.py:46`）。
- Researcher 收到意见后没有改代码。第二次交付重写了 uncertainties，承认重建、系数空间算子和 Fock/density 损失三方面的缺口，第一次交付没有披露这些；对错误的 einsum 指控未作回应。它在签发后 4 分 12 秒交付，距 deadline 还有约 5 小时 55 分。
- 按两条原则对照：建议没有阻碍收敛，错误的指控也没有导致有害修改；重要节点按设计触发。效果上，review 提高了交付声明的诚实度，没有提高正确性，因为 Researcher 选择了披露后交付，而不是修改。这只是一个样本。按 ProContract 的设计，诚实的 uncertainties 由 Principal 的 `challenge` 来兑现。
- 关闭组候选的模型作用于系数（`sbno.py:62-65`，`2*(ny+1)` 维），结构上反而更贴近文档。各组只有一个样本，这是 Researcher 自身的随机差异，不是 review 的效果。
- 用量：正式 44 次请求，合计 1,210,602 tokens，其中 reviewer 8 次、198,995 tokens；预检 4 次、268 tokens 另计。费用未知。

**合同状态：**attempt-2、attempt-3 的四个合同都在各自独立的试运行数据库中，交付停在 `verification`，attempt-2 开启组为 `active`。宿主都已退出，没有作 Principal 认可，也不需要进一步处理。

**操作者收尾副作用：**attempt-3 的离线审计在正式工作区上运行了 `git diff`，刷新了两个 `.git/index` 的 stat 缓存。路径、blob、mode 和根提交未变，前后版本已保存，对证据没有影响。

**系列收尾：**Principal 于 2026-10-05 决定结束第三轮及整个 advisory 行为冒烟系列。机制已在正式运行中验证，不再为未触发的路径追加冒烟测试。

**后续事项（只记录，不在本次实施）：**

1. `materials.json` 的长字符串字段：执行者声明长度没有上限，写长了在分页读取时仍会被截。可从材料中去掉与提示重复的 `brief`、`instructions`，或把长文本写成单独的纯文本文件。
2. reviewer 错误引用代码：只有一个样本，先观察，不改提示。
3. Researcher 明知有实质缺口仍提前交付：这是 reviewer 价值的核心问题。可考虑测试 Principal `challenge` 回路或调整 Researcher 档位，但必须保持"只提建议、决定权在 Researcher"，另行讨论。
4. 今后的长时实验（包括 6 小时 ProgramBench 实验）应把运行写入放在本地盘，结束后回存并核验。MooseFS 在一天内出现三次卡顿，最长约 50 秒。
5. 离线审计只在副本上运行 git。
6. 2026-10-02 一节的遗留事项 3（中途节点每轮事务）和 4（SDK embedded 测试的数据库隔离）仍未处理；受保护输入规划 §9 的残余风险不变。

**证据目录：**都在 `/workspace/sbno-native-advisory-preparation-20260924T054618Z/` 下：attempt-1 为 `third-preparation-20261004T213025Z/approved-execution-20261005T005243Z/`，attempt-2 为 `third-attempt-2-20261005T022916Z/`，attempt-3 为 `third-attempt-3-20261005T050601Z/`（本地原件在 `/var/tmp/sbno-native-advisory-local-20261005T050601Z/`，删除需 Principal 明确同意）。三次尝试各有 `RESULTS.md` 和通过核验的封存。
