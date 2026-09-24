# ProContract 独立 Researcher 方案的独立设计评审

阅读说明：下文保留初评，最终设计结论见文末的修订复核记录。初评中的设计文档行号对应初稿 hash `1dfc39d888a4da181c336906aeca6e76819b82bbb2bff384456f94ff8dda0682`，并非同路径现稿的行号；源码行号仍对应未变化的基线 HEAD。文件链接已整理为仓库相对路径。

审查日期：2026-09-18。审查对象：[pro-contract-researcher.md](pro-contract-researcher.md)。Reviewed SHA-256：`1dfc39d888a4da181c336906aeca6e76819b82bbb2bff384456f94ff8dda0682`。源码 HEAD：`78bec19263814444ab008c58d54835b59b4a1c6b`。

**结论：需修订后实施。** 宿主编排、独立 Session、冻结候选和 Principal 认定的总体分层可行；没有发现必须把研究阶段放入 kernel 的理由。当前方案遗漏了原生执行层的重试处置，以及验收上下文的完整并发身份；这两项会破坏正常阶段等待或允许过期意见支持认定。中途方法变更的强制性还需要收窄为可实际检查的规则。

严重程度约定：P1 表示实施前必须补齐的正确性或授权边界；P2 表示影响明确承诺、应在相关切片开始前解决的问题。下列 F 项是设计文本中的遗漏或不充分约定；R 项是方案已经承认需要新增能力、但尚未获得实现证明的风险。没有把“当前代码尚未实现提案”本身列为缺陷。

本次读取了根目录及适用的 `AGENTS.md`，进行了只读源码核对，没有安装依赖、修改运行时代码、修改待审设计或启动实验。环境没有 Bun，未运行测试或类型检查；反例来自设计与当前调用路径的静态分析，不是动态复现记录。

**F1 · P1：`driver` 必须接管执行结束和重试处置，不能仅分流 scheduler dispatch。**

设计依据：[设计第 165 行](pro-contract-researcher.md#L165)提出每份 binding 只有一个调度责任方，第 171–175 行具体要求原生 scheduler 过滤 dispatch，并复用 claim、admission、drain；第 252–254 行列出的修改范围未明确现有 drain 结束后的 Contract 处置。

源码中，这些处置并不只在 scheduler：

- [session/execution/local.ts:45](../packages/core/src/session/execution/local.ts#L45)的第 45–68 行将正常结束、未出现 provider error 的 drain 转为 `reschedule({ attempt: "new" })`，终止性 provider error 则直接调用 `contracts.escalate`。
- [open-code.ts:425](../packages/core/src/pro-contract/open-code.ts#L425)的第 425–440 行会因此检查 `maxAttempts`，或清空 `attemptKey`；后续 [claim:271](../packages/core/src/pro-contract/open-code.ts#L271)把它解释为新语义 attempt，并可能替换 Session。
- [contract-control.ts:320](../packages/core/src/tool/contract-control.ts#L320)的第 320–335 行在 `contract_report_blocked` 内直接记账并 `reschedule(new)`。
- [scheduler.ts:24](../packages/core/src/pro-contract/scheduler.ts#L24)的第 24–55 行还处理 activation、期限和全部 active Session 的 heartbeat。[open-code.ts:360](../packages/core/src/pro-contract/open-code.ts#L360)的 heartbeat 只检查同一全局 binding owner 等条件，没有另一个协调器的 ownership 概念。

具体反例：研究 Contract 的 `maxAttempts` 为 1，执行者成功提交计划后正常结束，等待独立 review。研究阶段是 `plan_review`，root 仍然 `active`。即使原生 scheduler 已经完全跳过该 driver，`SessionExecutionLocal` 仍立即将它解释为“未 settlement 的正常结束”，并因 attempt 已用尽而 escalate。若上限更大，几轮正常计划修改也会消耗它。阶段许可仅阻止后续模型或工具调用，不能阻止这条记账路径。

最小修正：把 driver 的责任明确覆盖到 activation、claim、heartbeat、drain outcome、blocked/retry 和恢复；原生分支仅处理原生 binding。研究 driver 接收通用执行结束通知，由宿主决定正常阶段等待、同 attempt 继续还是实际失败。所有结束回调和状态变更还须核对当前 Session、owner、generation，避免旧 drain 的失败影响接管后的工作。不要增加研究专用 kernel 状态，也不需要创建 durable drain 身份。实施清单须增加 `session/execution/local.ts`，并规定暂停期间 lease 的释放或续租行为。

验收反例：用 `maxAttempts: 1` 让执行者提交计划、正常结束、等待并完成两轮计划 review；不能因阶段切换增加 attempt 或 escalate。另测原生与研究调度器共存，以及旧 drain 在接管之后返回正常结果或终止错误。

**F2 · P1：认定只绑定 revision、spec 和 subject，仍缺少当前 handoff 轮次及验收清单的原子检查。**

设计依据：[设计第 202 行](pro-contract-researcher.md#L202)要求事务内检查 `revision`、`specHash`、`subjectHash`；第 204 行则先由宿主验证当前清单与 bundle，再调用普通 kernel discharge。[第 141 行](pro-contract-researcher.md#L141)允许 Principal 批准新清单或条款版本，但未规定清单变更必然提升 root revision。研究状态中的 generation 被描述为协调器 generation，没有定义交付或证据失效的独立轮次。

源码核对：[kernel.ts:223](../packages/core/src/pro-contract/kernel.ts#L223)的 challenge 清除当前 handoff，但不提高 revision；[第 295 行](../packages/core/src/pro-contract/kernel.ts#L295)允许再次提交相同 subject，生成新的 handoff。[discharge:453](../packages/core/src/pro-contract/kernel.ts#L453)检查当前 revision、spec 和 subject，不检查 handoff 的具体发生轮次。store 的事务在 [pro-contract.ts:195](../packages/core/src/pro-contract.ts#L195)之后读取 Contract 并调用 reducer，没有宿主研究状态的事务检查。

有两个不同反例：

1. Principal 审阅第一轮候选 A 并发起认定，请求延迟。A 随后被 challenge；执行者在相同 revision 下重新提交相同源码树 A，例如缺陷涉及外部实验记录而源码未变。旧请求的三个坐标仍完全匹配，旧报告也仍绑定 A；当前设计未规定它必须因上一轮 challenge 而失效。仅增加 exact subject 不能排除这种先变化、再恢复相同值的竞态。
2. 宿主按清单 M1 验证 bundle 完成后，Principal 批准了要求更多检查的 M2，root revision/spec/subject 均未变化。随后普通 discharge 事务仍可提交 M1 的认定。即使报告字节与来源完全可信，也没有证明提交时仍满足当前验收约定。

最小修正：定义不可变的验收上下文，至少绑定清单 hash、当前 handoff 的唯一事件或轮次、相关评审失效版本，以及认定操作 ID。权威提交入口必须对这个上下文做原子的当前值比较；不能只在宿主检查完后无条件进入普通 discharge。可使用宿主受控的同一事务/CAS 边界，或强制所有改变验收条件的操作推进一个由权威入口检查的版本；Core 只比较不透明身份，不解释研究内容。challenge、新 handoff、清单替换和相关批准撤销须明确改变哪一个版本。协调器接管的 fencing 与证据有效性的版本也应明确区分。

认定响应丢失的恢复还须区分“返回已提交操作的历史结果”和“当前仍有有效支持”。[pro-contract.ts:270](../packages/core/src/pro-contract.ts#L270)目前每次创建新 attestation ID，重试不能直接复用该行为；如果旧认定已被 challenge，返回历史成功不得再次 discharge 当前候选。

验收反例：在宿主验证完成与 store 提交之间插入清单变更；在延迟认定请求期间完成 `A -> challenge -> 再次 handoff A`；在成功认定后 challenge，再重试原操作。三个场景都不能产生过期支持。

**F3 · P2：方法变更的强制复审缺少可观测触发条件。**

设计依据：[设计第 90 行](pro-contract-researcher.md#L90)要求目标、协议、数据划分或关键方法变化时重新审查，第 100 行要求评测脚本、关键算法或研究方法变化触发独立审查；第 158 行主要规定计划 hash 或候选变化后的失效。第 181–183 行的有限能力许可没有说明如何识别“计划文本未修改，但实际实验方法已变化”。

当前 Contract 的 `filesystem.write` 和 `process.execute` 被转换为工具可用性，见 [llm.ts:291](../packages/core/src/session/runner/llm.ts#L291)。[bash.ts:138](../packages/core/src/tool/bash.ts#L138)明确说明 shell 使用宿主用户权限，路径扫描仅供提示；它无法凭命令名识别研究方法。

具体反例：P1 计划已批准并打开实现/实验权限。执行者不修改计划文件，而是在同一个 shell 调用中修改数据划分或评测脚本并启动正式实验。`planHash` 和许可保持不变，文件写入与运行也都在原有工具权限内。最终 reviewer 可能发现问题，但这不构成实验前的强制复审。

最小修正：第一版明确区分机械门槛与方法判断。对必须事先批准的评测配置、数据清单和受保护评测文件，记录具体 hash，并让正式实验经宿主入口对冻结输入核对；变化时关闭实验许可。对无法机械识别的“关键方法变化”，保留执行者申报及独立审查责任，明确其遗漏仍属需要测量的质量风险。不要承诺通过通用 shell 过滤或语义 diff 自动保证全部方法合规，也不需要开发通用语义判定器。

验收反例：不改计划文本，修改受保护评测配置后直接运行实验；以及同一命令中先改配置再运行。应由执行入口拒绝，或明确这些调用只能产生未经准入、不能支持验收的结果，并如实收窄前置阻断承诺。

**其余关键事项：属于实现待证风险。**

| 编号 | 核对结论与源码依据 | 实施所需证据 |
| --- | --- | --- |
| R1 · 高 | Reviewer 的独立 job 路线合理，但当前无法直接复用 executor lease。[open-code.ts:130](../packages/core/src/pro-contract/open-code.ts#L130)对无 binding Session 默认放行，有 binding 则要求 root `active`；[llm.ts:361](../packages/core/src/session/runner/llm.ts#L361)从主 Contract 取得 deadline，普通 Session 没有该值。设计第 194–198 行已经承认这是新增接线。 | 明确两种授权依据：执行者使用 active binding lease，reviewer 使用独立宿主 job 授权，并验证冻结 root 身份及其当前有效性。第 183 行“与 Contract lease 取交集”不能被实现成 reviewer 必须持有 inactive root 的 executor lease。Reviewer Session 必须有持久的受控身份；重启后缺失 job/driver/许可时拒绝执行，不能退化为普通 Session。 |
| R2 · 高 | 权限目录过滤不是执行授权。[registry.ts:142](../packages/core/src/tool/registry.ts#L142)过滤 definitions；[permission.ts:143](../packages/core/src/permission.ts#L143)的 leaf 权限来自 agent 与 saved rules。工具目录 [AGENTS.md](../packages/core/src/tool/AGENTS.md)还明确禁止在 registry 添加第二套授权回调。 | 为通用执行许可选定符合现有工具架构的权威检查位置；覆盖 provider admission、等待权限答复之后、控制工具及所有有副作用的执行入口。宿主许可与 agent/Contract 权限取交集。真实隔离证明须另外覆盖 shell 和候选代码访问主目录、凭据、账本与报告库；设计第 139 行已正确限制合作式部署的保证。 |
| R3 · 高 | “冻结”需要一个真正停止写入的边界。[llm.ts:397](../packages/core/src/session/runner/llm.ts#L397)的第 397–429 行随 provider 流并发启动工具；[contract-control.ts:245](../packages/core/src/tool/contract-control.ts#L245)直接 capture 并 replay，没有等待其他写工具的屏障。设计第 190 行要求安全边界，但尚未给出 handoff 顺序。 | 明确 `request-ready -> 关闭新写入 -> 终止或等待已准入写入并确认清理 -> capture -> replay -> fenced handoff` 的顺序；不能让 ready 工具等待自己的 drain 完成。并发 shell 写入与 ready、取消发生于 capture/replay 期间均应有测试。 |
| R4 · 中 | 完整期限须传播到 reviewer 的自动 compaction、工具结算和后台任务。[llm.ts:266](../packages/core/src/session/runner/llm.ts#L266)只为 deadline-only Contract 跳过 agent step ceiling；compaction 在 [第 361 行](../packages/core/src/session/runner/llm.ts#L361)发生于 `reserveTurn` 之前。简单为 reviewer 添加外部 timer 不足以说明完整计量或重启后的期限仍有效。 | 验证 review 期间 deadline、compaction、超时工具、重启与取消；没有新 deadline，也不意外继承 generic agent steps 等累计上限。严格停止计算与持久化已有结果应分别定义。保留本来明确授权的语义 attempt 约定，但阶段等待不能消耗它。 |
| R5 · 中 | 原始证据保留和验证 scratch 变化需要新实现。[replay.ts:261](../packages/core/src/pro-contract/replay.ts#L261)无条件删除 replay 工作目录；[snapshot.ts:158](../packages/core/src/snapshot.ts#L158)有忽略规则和未跟踪文件大小限制，强制包括项来自显式列表。设计已正确声明 Git tree 不覆盖所有研究依赖。 | 在清理前保存所需验证产物、差异、原始输出及完整性；不可把任意 live 文件标为已冻结证据。无法捕获的数据、环境或服务要进入 bundle 的明确限制，是否阻断由批准的协议决定。 |
| R6 · 中 | 恢复方向与现有 durable inbox 相容。[session.ts:360](../packages/core/src/session.ts#L360)先准入再 wake；[run-coordinator.ts:94](../packages/core/src/session/run-coordinator.ts#L94)只中止本地当前执行。设计不把这种中止等同于持久取消，也不声称任意 shell exactly-once，这两点正确。 | 恢复必须区分未准入、已准入未执行、已 promoted、执行结果未知。对已 promoted 但无完成证据的工作，不能只重发 wake 就声称恢复成功。新 reviewer 尝试保留原失败记录与成本，取消标记在任何新执行之前检查。 |
| R7 · 中 | `sdk-next` 可以组合 Core、Server、Client，包方向选择合理；但它目前经固定的 Server 图创建宿主，见 [opencode.ts:10](../packages/sdk-next/src/opencode.ts#L10)和 [routes.ts:29](../packages/server/src/routes.ts#L29)。HTTP attest 直接调用 Core，见 [handler:116](../packages/server/src/handlers/pro-contract.ts#L116)；CLI 也是直接 Core 路径，见 [contract.ts:295](../packages/opencode/src/cli/cmd/contract.ts#L295)。 | 明确宿主如何注入同一 research gate/状态服务，使网络、嵌入式、CLI 使用相同权威检查；没有适配器的普通 Server 对研究任务应拒绝认定。不要让 Core/Server 反向 import `sdk-next`；通用接口与宿主实现分离即可。公共 wire 数据放 Schema/Protocol，私有研究运行态留宿主。 |

**建议补入验收矩阵的场景。**

除设计已有的检查外，增加以下相互独立的场景即可覆盖主要遗漏，无需建立通用多 agent 测试平台：

- 正常提交计划、暂停、复审均不触发原生 `reschedule(new)`；原生 Contract 行为保持兼容。
- 原生 heartbeat 不能掩盖研究协调器失去 ownership；接管后的旧 drain 不能 escalate、重排或提交。
- 清单变更与最终认定并发，以及相同 subject 被 challenge 后重新交付。
- 取消发生在报告已写入、bundle 尚未提交之间；按明确规则保留材料并处理后续 Principal 认定，不让旧协调器继续执行。
- Reviewer Session 留存而宿主 job、driver 或许可未装载时，通过 Session resume/prompt 路径也不能执行。
- 正式实验的受保护方法输入变更；并发修改型工具与 `report_ready` 的冻结屏障。
- Reviewer 的 compaction 和工具结算跨越原始 deadline；完整用量保留，缺失项为 unknown。

**规模判断与可选改进。**

五类逻辑对象、单宿主串行阶段和复用现有 Session，不构成明显过度设计；文档也没有要求每个对象单独建服务。应避免把具体研究术语放进 Core，避免另建工具表示、第二个 agent loop 或通用工作流引擎。F1 所需的执行结束处置、F2 所需的验收身份，都是现有正确性边界的补齐。

可先实现并独立验收通用控制工具 fencing、认定操作身份和 driver 生命周期归属，再接确定性的 reviewer。计划门槛部分优先支持一套具体可检查的实验协议；对统计判断和方法偏离保留独立评审及实际漏检测量。无需为了设计完整性一次性加入多模型投票、分布式 lease 或通用语义 diff。

本报告仅对上述 hash 的设计和指定 HEAD 的静态接线成立。修订设计应记录新 hash，并明确哪些 F 项已解决；通过文档复审不代表实现、隔离边界或真实研究质量已通过验收。

**修订复核记录 · 2026-09-18。**

复核对象：[修订稿](pro-contract-researcher.md)。Reviewed SHA-256：`e5523c9b9472c04a33f7838d67b93b996ee01bf4bc0ec3de89db75567d6e9a21`。源码 HEAD 仍为 `78bec19263814444ab008c58d54835b59b4a1c6b`。本段的设计行号针对这个修订版本；初评的反例与结论保留为历史记录。

**最终设计结论：F1–F3 均已在设计层解决，可作为后续分片实施的依据。复核未发现新的重大矛盾或未解决的设计阻断项。** 这不表示已有实现满足方案，也不扩大本轮仅限文档与审查的授权。

| 初评项 | 复核结论 | 修订依据与判断 |
| --- | --- | --- |
| F1 · 原 P1 | 设计层关闭 | [第 182 行](pro-contract-researcher.md#L182)将 driver 责任扩展到 activation、claim、heartbeat、结束回调、blocked/retry 和恢复；[第 190 行](pro-contract-researcher.md#L190)明确修改 `session/execution/local.ts`，将结束结果交给当前 driver 并拒绝旧 generation；第 192 行定义正常阶段等待释放 lease、保留语义 attempt。它直接替换了初评指出的原生 `reschedule(new)` 路径，且[验收第 308 行](pro-contract-researcher.md#L308)保留了 `maxAttempts: 1` 反例。 |
| F2 · 原 P1 | 设计层关闭 | [第 71 行](pro-contract-researcher.md#L71)使清单不可变并由 Spec 身份绑定，清单变更必须推进 root revision；[第 170 行](pro-contract-researcher.md#L170)避免清单与 Spec 哈希循环；[第 172 行](pro-contract-researcher.md#L172)区分协调器、评审有效性和 handoff 三类版本。[第 219–227 行](pro-contract-researcher.md#L219)定义唯一交付身份、同事务 CAS、操作 receipt 及历史重试语义。相同 subject 再交付、清单或批准并发更新、challenge 后重试都已有明确的拒绝或历史返回规则。 |
| F3 · 原 P2 | 设计层关闭 | [第 100–105 行](pro-contract-researcher.md#L100)将受保护输入与语义方法偏离分开；宿主为正式实验 materialize 冻结输入并保护运行期间的输入，不依赖 live 文件检查后继续执行任意 shell。合作式 profile 明确只拒绝未准入结果参与验收，不声称已阻止这类计算。不能机械识别的方法偏离保留为独立评审的漏检风险，没有引入通用语义检测器。 |

补充接线在设计上也相互一致：

- [第 109–115 行](pro-contract-researcher.md#L109)将 ready 改为持久请求，再于 drain 外完成写入停止、快照、replay 和 handoff，避免工具等待自身结束；保留协议要求的验证产物后才清理。
- [第 198–215 行](pro-contract-researcher.md#L198)区分执行者 active lease 和 reviewer 独立 job 许可，保持 leaf 权限架构，并要求受控 Reviewer Session 在 job、driver 或许可缺失时失败关闭。它没有借用 root 的 inactive lease，也没有把 reviewer 退化为普通 Session。
- [第 245 行](pro-contract-researcher.md#L245)明确处理 promoted 但完成未知的工作；[第 257 行](pro-contract-researcher.md#L257)使取消与自动认定在当前准入状态上排序，同时允许 Principal 后续显式处理已存在材料。[第 263–265 行](pro-contract-researcher.md#L263)覆盖 compaction、工具结算和有界清理，保持原始 deadline。
- [第 225 行](pro-contract-researcher.md#L225)将参与 CAS 的最小投影放入 Contract store 的事务域；[第 231 行](pro-contract-researcher.md#L231)要求缺少研究校验器时拒绝认定；[第 286 行](pro-contract-researcher.md#L286)定义同一服务图、memo map 和资源作用域的注入。Core 比较身份与版本，宿主解释研究语义，包依赖方向没有反转。

仍须在实现验收中证明以下边界；它们不是本轮新发现的设计阻断项：

1. **暂停与重新执行的实际顺序。** 当前 `claim` 会根据 dispatched、lease 和 attempt key 决定是否替换 Session，见 [open-code.ts:278](../packages/core/src/pro-contract/open-code.ts#L278)。暂停应显式解除 dispatched/lease 并保留 attempt key；新 prompt 若先准入，应使用 `resume: false`，在有效 claim 和许可安装之后再 wake，避免把一次被拒绝的提前 wake 当作成功调度。每个中断位置都需恢复测试。
2. **认定事务的闭合。** 新 handoff、challenge、批准撤销和取消必须更新同一事务域内的当前引用，不能仅靠异步事件最终同步。报告字节保持不可变，所有可达认定入口都执行同一检查；对失败检查的审计记录继续遵守 Constitution。唯一 handoff 的历史迁移仍需真实数据验证。
3. **实际执行覆盖和隔离。** 通用许可必须覆盖所有启用的 leaf、组合工具子动作、宿主验证进程、compaction 及恢复路径。受保护输入和 scratch 的限制需由真实文件、进程、网络与凭据边界证明；单独修改工具目录或提示词不足。合作式 profile 继续使用其较弱的明确保证。
4. **并发与期限证据。** 用真实 store/Session 边界跑完第 10 节的旧回调、同 subject 再交付、取消与认定、ready 与写入并发，以及 reviewer 超过旧计数边界但在原 deadline 停止的场景；脚本 reviewer 通过只证明控制流程，不证明实际研究判断的漏检率。

上述实现要求可在现有切片内完成，没有必要增加研究专用 reducer 状态、独立工具注册体系或通用工作流平台。本轮继续仅做静态源码复核和文档检查，没有执行测试、安装依赖或启动研究实验；R1–R7 的运行证明仍待相应实现提供。

复核完成后，经任务授权，仅更新方案顶部第 3 行的状态说明，记录“已完成复核、设计层无未解决阻断项”。**仅状态元数据变化，方案正文未改。** 最终文件 SHA-256：`ea7f970aaee12d3e95e70cec28250fe01c543f90b1b32a5e8cf70e2b2f8d38bd`；本次实际 reviewed hash 仍为前述 `e5523c9b9472c04a33f7838d67b93b996ee01bf4bc0ec3de89db75567d6e9a21`。
