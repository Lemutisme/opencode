# ProContract Researcher 范围与实施计划独立评审

审查日期：2026-09-18。审查对象：[pro-contract-researcher.md](pro-contract-researcher.md)。被审 SHA-256：`bbc264d236745c3e2ae94e171dfb178d1d0c17f7847a37101b43b08ed4211b52`。源码 HEAD：`78bec19263814444ab008c58d54835b59b4a1c6b`。本文的方案行号仅对应这个被审版本。

**结论：Researcher 范围收敛通过；S1 需补齐两项 P1 约定，并修正一项 P2 验收措辞后实施。** 原架构分层没有新增阻断项。S1 的存储原子性可以在现有执行适配器与 Contract store 边界完成，不需要研究模块，也没有理由把 Session、lease 或研究阶段加入 kernel。当前 S1 范围遗漏了可信调用身份的传递接线，修订批准等待的例外规则也不足以指导实现。

本报告是本次范围与实施计划的专项审查，保留 [原架构评审](pro-contract-researcher-review.md)的全部历史结论，不将其“设计层无阻断项”套用于本次新版本。P1 表示 S1 实施前必须明确的授权或正确性边界；P2 表示必须在相应切片验收前解决的承诺矛盾。源码反例是静态推演，并非已运行的复现。

已读取根目录、工具目录及 SQLite 适配器目录适用的 `AGENTS.md`、[Constitution](pro-contract-constitution.md)，并核对控制工具、binding、Contract store、kernel、scheduler、Session 执行与工具上下文、Permission 服务及相关测试。未安装依赖、运行测试、启动实验或修改方案与运行时代码。

**范围与共享边界判断。**

[方案第 11 行](pro-contract-researcher.md#L11)、[第 66 行](pro-contract-researcher.md#L66)与 [S4 最小流程](pro-contract-researcher.md#L314)已明确：OpenCode 接收授权任务，内部执行与审查，发布候选、证据及精确反馈，等待外部 Principal 认定。没有要求内部实现任务组合、研究方向选择、资源配置或接受负结果的决策策略。使用确定性调用方发出批准、取消、修订与 challenge 请求，足以验证 Researcher 协议，不需要开发 Principal Agent。

唯一 handoff 身份、精确认定输入、幂等 receipt、缺失校验器时拒绝认定，属于双方共享的身份和授权边界。它们防止外部 Principal 的旧决定落到另一个交付轮次，不是在 OpenCode 中制定 Principal 策略。研究模块校验获批清单要求的报告，也不等于自行拥有 discharge 权限。当前将报告语义留给宿主、把不透明身份比较放在权威事务域的分工合理。

有一处应继续坚持：控制工具内收到 permission 答复后调用 `decideRevision`，应被描述为提交已经授权的外部决定。它不能退化成执行者自行选择 `accept`，也不能为了统一执行守卫而让 Principal 的既有决定依赖被暂停的普通执行权。这正是下述 F2 的边界。

**F1 · P1：旧 prompt 的拒绝需要来自 provider admission 的身份，不能从工具开始时读取的 binding 反推。**

方案依据：[S1 第 306 行](pro-contract-researcher.md#L306)要求旧 prompt／owner 不能提交；[第 320 行](pro-contract-researcher.md#L320)要求从真实调用上下文与可信 binding 捕获身份，但列出的最小改动范围只有工具、binding、store，没有明确当前上下文缺失身份时如何接线。

源码事实：

- [Tool.Context](../packages/core/src/tool/tool.ts#L9)只有 `sessionID`、`agent`、`assistantMessageID` 和 `toolCallID`，没有调用所依据的 binding prompt、revision、owner 或 claim 身份。
- [runner 发起工具结算](../packages/core/src/session/runner/llm.ts#L407)与 [registry 传递上下文](../packages/core/src/tool/registry.ts#L85)也仅传递这些字段。
- [reschedule](../packages/core/src/pro-contract/open-code.ts#L430)允许保留同一个 Session、更换 `promptID`；[现有测试](../packages/core/test/pro-contract.test.ts#L1693)明确覆盖了这项行为。因此 Session ID 不是一次执行授权的完整身份。

具体反例：Session S 的旧 provider response 属于 prompt P1；同一 Session 已被重排并 claim 到 P2。旧 response 随后到达工具入口。若工具这时调用 `forSession(S)` 捕获“当前”身份，它会得到 P2；之后即使在同一事务内检查这个身份，也是在给 P1 的调用套用 P2 的授权。只测不同 Session 的退休映射不能发现这个问题。

最小修正：把 S1 的改动范围明确扩展到 `session/runner/llm.ts`、`Tool.Context` 与 `ToolRegistry.ExecuteInput` 的身份传递。在 provider admission 时捕获不可变的执行身份，随后工具开始、耗时操作结束和提交检查都使用这一份预期身份；不得重新读取当前 binding 来替换它。身份至少区分 Session、prompt、revision、owner 和实际 claim；若加入 claim generation，它属于执行适配器，不属于 kernel。缺少受信身份的绑定 Session 控制调用应失败关闭。registry 只传递上下文，不增加授权回调或第二套工具表示。普通无绑定 Session 的 `contract_propose` 仍走其已有独立批准入口。

验收必须增加“同 Session、更换 prompt 后，旧 response 才开始调用工具”和“同 owner 重新 claim 后旧身份仍无效”，而不只是在 replay 中途换成另一个 Session。至少一项用真实 runner 到 leaf 的路径证明身份源自原 turn；仅给新 helper 人工传入旧 token 不能证明传递接线。正常当前 token、缺失 token、过期 token 都应有相应结果。

**F2 · P1：修订批准必须有独立的完成条件、唯一申请身份和等待中断规则。**

方案依据：[第 306 行](pro-contract-researcher.md#L306)将“权限等待后失去授权不能提交”与普通 lease 拒绝并列；[第 322 行](pro-contract-researcher.md#L322)承认 pending 会暂停执行、要求绑定原申请，但未定义批准完成时到底要求哪些授权仍有效，也没有定义等待被中断后 pending 的处置。

源码事实：

- [contract_propose_revision](../packages/core/src/tool/contract-control.ts#L359)先保存 petition，再等待 `permissions.assert`，最后仅用 Contract ID 调用 `decideRevision`。
- binding lease 为 [30 秒](../packages/core/src/pro-contract/open-code.ts#L71)；[heartbeat](../packages/core/src/pro-contract/open-code.ts#L360)、[claim](../packages/core/src/pro-contract/open-code.ts#L269)及普通计量准入都排除 `pendingRevision`。[现有测试](../packages/core/test/pro-contract.test.ts#L1914)也明确期待 pending 不再续租。
- [pendingRevision](../packages/core/src/pro-contract/kernel.ts#L344)目前只有 Spec、hash 和 reason；[decide-revision](../packages/core/src/pro-contract/kernel.ts#L350)不比较申请身份。
- [Permission.assert](../packages/core/src/permission.ts#L214)把无说明的拒绝转为 defect；[reply](../packages/core/src/permission.ts#L237)在有说明和无说明的拒绝间使用不同错误。控制工具只捕获 `BlockedError` 与 `CorrectedError`。因此无说明拒绝、显式 interruption 或 deadline 中止，都可能使 `decideRevision` 不执行，而 pending 留存。Permission 的等待集合又是进程内状态。

有三个必须区分的反例：

1. 用户合法考虑批准超过 30 秒。若新守卫要求普通 lease 有效，或要求没有 pending，原申请自己的等待就使批准不可能提交。若单纯对整个 revision 工具免除守卫，又会保留旧执行发起新申请的漏洞。
2. 申请 A 被外部拒绝，之后提交内容完全相同的申请 B。A 的迟到批准不能批准 B；仅比较 `specHash`、revision 或 reason 仍不能区分两次申请。
3. 用户无说明拒绝，或在等待时取消／重启。原 Permission 请求已消失，但 pending 仍暂停普通执行。实现若未明确保留的外部处置入口，会把普通拒绝表现为无法继续的挂起；若自动清除“当前 pending”，又可能误清除后来申请。

最小修正：把一次修订操作拆成“当前执行提交申请”和“外部授权完成原申请”。前者在当前执行授权的短事务内创建唯一申请身份；可复用 accepted petition 的唯一账本事件，不要求引入研究状态。后者在同一提交事务中比较该身份、预期条款、尚未决议及适用的撤销条件，才提交已经收到的 permission 决定。**后者不能照搬要求没有 pending 且 lease 未过期的普通执行守卫。** 这种有限例外只允许完成已记录申请，不能新增申请、handoff、重排或恢复执行。

还应明确普通拒绝、带反馈拒绝、显式中断、deadline 和重启的语义。允许中断后保留 pending 等待外部显式处置，但必须记录并可见；不得自动批准，也不能依赖已经丢失的 Permission deferred 恢复。若选择清理，只能清理仍匹配原申请身份的记录。批准后是否重新调度由当前权威状态决定，不能沿用旧工具身份取得新 revision 的执行权。

验收至少包括：等待超过 lease 后对原申请作出合法决定；等待期间普通 provider／工具仍被拒绝；A 被拒后重新提出相同 A，旧批准与旧拒绝均不能作用于第二次申请；无说明拒绝、有说明拒绝、中断、deadline、重启后 pending 均符合选定语义。外部已经 release 或完成另一个修订时，旧响应只得到明确过期结果。

**F3 · P2：S1 的“拒绝不改变用量”需要区分未准入调用与已经执行的 replay。**

[第 326 行](pro-contract-researcher.md#L326)把所有拒绝概括为“不改变职责、候选或用量”，而 [第 324 行](pro-contract-researcher.md#L324)又要求保留计数豁免。当前 [registry](../packages/core/src/tool/registry.ts#L70)只免除 ready、blocked 和 revision 的普通 action charge；`contract_check` 仍按普通 action 计数。[ready](../packages/core/src/tool/contract-control.ts#L241)若有 replay 则显式计一次 action。

具体反例：合法 ready 准入并运行 replay，期间 lease 被接管，最后 handoff 被拒绝。该 replay 已消耗资源，不能为了满足“拒绝不改变用量”而退款、覆盖新 binding 的累计计数或删除观察。反过来，只读授权查询不应额外消耗一次 action。`contract_check` 在 leaf 之前已有 registry 计数，也不能未经说明把已有失败调用会计改成完全零成本。

最小修正：在 S1 中列出各工具的原有 action 规则；规定授权检查本身不收费，未开始工作即拒绝的控制提交不新增用量，已合法准入的 replay／动作保留真实消耗。最终提交被拒绝不会新增一次收费，也不会退还已发生的费用。对 `contract_check` 的准入和计数顺序作明确选择并测试，不能同时承诺保留原规则与所有失败都完全不计数。

验收分别比较“最初身份无效”与“合法 replay 后提交身份失效”的计数变化，检查后者保留原始观察与已知用量、但没有新的 handoff／escalation／重排。这个修订不需要新增累计预算，也不能触碰冻结 cohort。

**S1 原子实现可行性与边界。**

[Contract store](../packages/core/src/pro-contract.ts#L184)已经在事务中完成状态与账本投影。[SQLite 适配器](../packages/effect-drizzle-sqlite/src/effect-sqlite/session.ts#L118)经 Effect context 复用事务连接，并为嵌套事务建立 savepoint。因此 binding 层在短事务内读当前授权、调用现有 Contract service，并完成必要 binding 更新，是可行的最小方向。它避免将执行适配器身份加入 reducer。是否确实共用同一 `Database.Service`／SqlClient，仍须以真实集成测试证明。

提交边界应覆盖 ready 成功、snapshot unavailable、replay unavailable／timeout 的 escalation，以及 blocked 记录与重排；不能只保护成功路径。时间与授权应在提交事务内重新检查。capture、replay 和等待 permission 都在事务外执行，避免长时间持有写锁。

授权拒绝需要复用不可变账本，记录被拒绝的操作和原因；返回错误必须发生在拒绝 receipt 已提交之后，不能因为在事务中抛出 `ToolFailure` 而回滚拒绝事件。不要伪造一个错误 revision 来迫使 kernel 拒绝，也不要增加可由模型指定的“已授权”标记。无需为了通用审计扩展研究命令代数。

S1 可在一个切片内分为两组聚焦变更：先完成可信执行身份、普通控制效果的原子 guard 与审计，再完成 exact petition 的批准与中断语义；两组均验收才算 S1 完成。没有必要在本轮引入 research 模块、最终 reviewer、driver 平台或冻结屏障。

**S1–S6 依赖与中间版本判断。**

| 切片 | 审查判断 | 中间版本必须保留的限制 |
| --- | --- | --- |
| S1 | 经 F1–F3 修订后可独立实施；无 S2 或 research 依赖。 | 只承诺列明的控制工具效果授权。旧 drain／调度回调的全生命周期 fencing 仍属于 S3a，不能称为整个执行链已完成 fencing。 |
| S2 | 共享通用身份与事务入口先于 research 组装合理；不属于 Principal 策略。 | S2 只能证明通用 CAS 和确定性校验器的行为。实际研究报告来源与语义校验须待 S4；不能先开放 research 认定并默认通过缺失校验器。 |
| S3a | 原子发行、driver 归属、正常等待与旧回调一起交付，避免原历史 F1 的中间不一致。 | 不允许先写 `driver` 标记、但让 activation、heartbeat 或 drain outcome 继续走原生处置。生产 research driver 仍关闭。 |
| S3b | 依赖 S3a 的完整生命周期正确；reviewer 独立 job 身份不能借用主 binding。 | 宿主许可未加载时拒绝 resume/prompt，deadline、取消、计量覆盖真实入口后才进入 S4。 |
| S4 | 外部批准任务到可验收交付包，再处理外部 challenge 的最小闭环符合 Researcher 定位。 | 仅开放最终评审 profile，不宣称具有计划与正式实验前门槛。合作式部署继续披露隔离限制。 |
| S5 | 计划和方法门槛后置合理，避免第一版同时建设所有研究语义。 | 受保护输入与受控执行入口全部贯通后，才开放完整研究 profile。 |
| S6 | 将流程正确性与 LLM 判断质量分开验收正确。 | 真实任务另行确定；本轮 S1 不自动扩大为研究实验授权。 |

S3a 依赖 S2 是保守的交付顺序，并非技术上不可拆的硬耦合；它不构成阻断，也无需本轮优化路线图。

这里有一项需要明确留在限制中的已知源码风险：[SessionExecutionLocal](../packages/core/src/session/execution/local.ts#L53)仍能在旧 drain 的终止性 provider 错误后只凭 revision 直接 escalate；[reschedule](../packages/core/src/pro-contract/open-code.ts#L397)虽有 prompt／owner 检查，其耗尽后的 escalation 也位于内部事务之后。S1 修好工具 guard 不自动修好这些路径。方案已将完整回调 fencing 放入 S3a，因此这不是要求本轮建设 driver；但 S1 的变更说明不能把“控制工具过期调用已拒绝”扩大成“任何旧 Session 都不再影响新执行”。若 S1 复用这些路径，应只补齐该控制效果所需的同事务检查。

**后续切片应核对的风险，不阻断 S1。**

- S2 应明确哪些外部反馈绑定某次 handoff，哪些是对相同 subject 持续有效的缺陷声明。当前 [challenge API](../packages/protocol/src/groups/pro-contract.ts#L112)只有 revision／subject 等字段。如果宣称迟到的 round-bound 反馈也受保护，就需比较 handoff 身份；不能把 attestation 的新身份保证自动推广给仍使用旧输入的 challenge。
- 如果 F2 通过新增公开 pending 身份或修改公共决定输入实现，相关 Schema／Protocol／Server／CLI／SDK 与生成结果必须同切片迁移；若只在私有执行完成入口绑定唯一 petition 事件，则明确公共接口兼容范围。不能在 S1 先要求一个调用方无法取得的身份，到 S2 才补输出。
- 研究 profile 的持久标记与缺失服务时拒绝应在 S2／S3 的通用接口中保留，而真正可发行门槛保持在 S4。升级／恢复不应把“当前代码不认识的受控身份”解释为普通未绑定 Session。

**建议的最小复核材料。**

先提交明确 F1 身份来源与 F2 批准状态规则的方案修订，记录新 hash，并澄清 F3。S1 实现复核应同时提供真实工具调用测试与真实事务测试：同 Session 旧 prompt、退休 Session、owner／claim 更换、有效与过期 lease、replay 成功和异常期间接管、blocked 与重排竞争、原申请批准的等待／ABA／中断，以及拒绝账本没有被错误回滚。用可控 Deferred／测试时钟暂停在实际边界，不依赖任意 sleep；包含普通未绑定提案和原生有效控制调用的兼容性。

本次结论只评价被审文本的范围、可实施性及切片保证。F1–F3 的设计关闭仍需新版本复核；S1 代码、包级测试和类型检查完成后，才可以声明控制边界已修复。

**修订复核记录 · 2026-09-18。**

复核对象：[方案修订稿](pro-contract-researcher.md)。被审 SHA-256：`09bd167cbb63c9cdbcc5c7e74ca9c89f00aec45965674ab59d3a93dcc7a73f55`。源码 HEAD 仍为 `78bec19263814444ab008c58d54835b59b4a1c6b`。以下方案行号对应这个新版本；上文初评及其被审 hash 保留。

**复核结论：F1–F3 均在设计层关闭，未发现新的 S1 设计阻断项，可以按修订范围实施 S1。** Researcher 与外部 Principal 的边界、后续切片的关闭条件没有改变。此结论不代表 S1 代码已通过审查或测试，也不扩大本轮授权。

| 初评项 | 复核结论 | 修订依据与判断 |
| --- | --- | --- |
| F1 · 原 P1 | 设计层关闭 | [第 306 行](pro-contract-researcher.md#L306)把 provider admission 和可信上下文纳入 S1；[第 320 行](pro-contract-researcher.md#L320)明确在 admission 捕获 Session、prompt、owner、revision 及每次 claim 不复用的 generation。原 turn 身份沿 `Tool.Context` 和组合工具子动作传递，不进入模型 schema，不允许工具开始时刷新为当前 binding；缺失身份失败关闭，并要求明确历史兼容规则。[第 327 行](pro-contract-researcher.md#L327)增加真实 provider-to-tool、同 Session 旧 turn／prompt 和缺失身份的回归。 |
| F2 · 原 P1 | 设计层关闭 | [第 322 行](pro-contract-researcher.md#L322)区分执行者申请与已获外部 permission 的有限完成操作；完成操作绑定原 accepted petition 的唯一事件、revision 和 specHash，明确不依赖等待期间过期的执行 lease，也不重新授予执行权。同条款重提仍有不同身份。[第 323 行](pro-contract-researcher.md#L323)规定无说明 reject 也完成原申请的拒绝；批准未知的中断／重启保留可见 pending，由外部显式处置，不再声称丢失的等待仍存活。 |
| F3 · 原 P2 | 设计层关闭 | [第 325 行](pro-contract-researcher.md#L325)保留控制动作豁免与授权查询不收费；[第 327 行](pro-contract-researcher.md#L327)将拒绝限定为“不额外消费 action”，并明确保留合法准入 replay 的真实消耗、失败与产物，不回滚或退款。实施时仍需逐工具核对原有收费位置，特别是 registry 计数的 `contract_check` 与 ready 内部的 replay。 |

另外两项初评要求也得到明确回答：

- [第 321 行](pro-contract-researcher.md#L321)要求在权威事务内检查原身份并提交状态命令与审计；拒绝 receipt 先提交，再在事务外转为 `ToolFailure`。capture、replay 与 permission 等待不进入写事务。准入阶段尚未形成状态命令的拒绝由持久工具事件记录，不伪造 kernel 命令；实现需用真实 runner 路径验证该事件确实落盘。
- [第 329 行](pro-contract-researcher.md#L329)明确 S1 保证只覆盖列出的工具控制路径，旧 drain 结束回调及调度接管仍在 S3a。这消除了把工具修复误报为整个执行生命周期 fencing 完成的风险。

实施仍须证明以下细节；它们是修订方案内的实现验收点，不是新的设计阻断：

1. 执行身份由受信 admission 捕获，检查使用事务内的当前时间和当前 binding；同 owner 的后续 claim 也不能重新启用旧 generation。历史缺失 generation 的处理不能生成可重复借用的默认 token。
2. accepted petition 的身份必须是实际被接受的申请事件，不能因无关 rejected 事件而被替换；当前 pending、原 revision 和预期条款一并比较。旧批准与旧拒绝均须通过同条款重提的 ABA 测试。
3. 无说明 `DeclinedError` 的修复应限定于修订决定的完成路径，不改变其他普通权限拒绝原有的中断语义；未知 defect 与 interruption 继续传播。中断后的 pending 可见性需通过实际查询路径验证。
4. 如果采用 store 内部事务 guard，它只提供可信内部 admission 检查，不成为模型可填的授权标记，也不新增 registry 授权回调。拒绝结果应作为已提交的事务结果返回，防止后续错误处理回滚审计。
5. 若 exact petition 仅作为内部完成入口的可选预期值，普通公共 `decideRevision` 的兼容路径仍维持原语义；不能宣称该公共入口也在本轮获得 exact 请求保证。公开身份或输入若改变，调用方与生成结果须同切片交付。

本次复核只追加本报告，没有修改方案、运行时代码或历史报告，没有安装依赖、执行测试或启动实验。后续 S1 代码应继续独立审查，并提交包级测试与类型检查结果。
