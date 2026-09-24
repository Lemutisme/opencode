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
