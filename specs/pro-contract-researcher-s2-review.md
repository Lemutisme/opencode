# S2 共享精确认定边界独立设计评审

审查日期：2026-09-18。审查对象：[S2 实施说明](pro-contract-researcher-s2.md)，被审 SHA-256 为 `7d7f661eb21fe7e3d480e082a169839ae92f6c2292e3ccaf17e63e9e71a54c77`。源码基线 HEAD 为 `78bec19263814444ab008c58d54835b59b4a1c6b`；工作树保留已完成的 S1 变更。本报告的方案行号只对应上述被审版本。

**结论：store-only 分层方向可接受，但实施前需关闭 F1、F2 两项 P1，并明确 F3 的拒绝审计约定。** 唯一交付身份、幂等操作记录和强制提交 gate 放在 institution store 符合 [Constitution](pro-contract-constitution.md)。当前缺口在上下文及 evaluation 报告本身的轮次身份；只修复外部 attest 请求不能覆盖这两条路径。

本次核对方案、Constitution、主计划 §7.4／§9.2、Core store／kernel／evaluation helper、控制工具、Protocol／Server、CLI、TUI、两代 Client／SDK、export 和活跃脚本调用路径。只新增本报告，未修改方案或 runtime，未运行测试、启动实验、改变冻结 cohort 或历史 artifacts。下述反例是静态推演，未冒充已运行的失败用例。P1 表示授权或身份边界必须先明确；P2 表示本切片接受前必须解决的协议与审计缺口。

**F1 · P1：上下文发布没有绑定交付轮次，也没有定义支持变化时的版本失效。**

方案 [第 25 行](pro-contract-researcher-s2.md#L25)的上下文版本只保存 Contract `revision`／`specHash`；[第 28 行](pro-contract-researcher-s2.md#L28)的 `setRecognitionContext` 也只比较这两个坐标与 `expectedVersion`。文档没有规定成功 handoff、challenge 及其依赖闭包、`revision` acceptance、resume 等转换如何使该版本失效。第 14 行把当前 handoff 加进派生 `contextHash`，不能证明版本中的 `referenceHash` 属于这次 handoff。

具体反例：宿主为 handoff A1 检查报告并准备发布上下文，捕获 `revision`、`specHash` 和 `version` V；请求延迟期间 A1 被 challenge，并在同一 `revision` 下重新交付 A2。若版本未变化，旧发布仍满足所列 CAS 条件，服务端便把 A1 的报告引用加入 A2 的当前上下文。之后读取的新 target 含 A2 的 `handoffID`，因此外部请求表面上满足完整 target 比较；真正缺失的是上下文发布自己的候选身份。

这也影响依赖闭包：[kernel challenge](../packages/core/src/pro-contract/kernel.ts#L188)在同一转换中清除受影响下游的 handoff／attestation，但这些变化没有各自的 Contract-local challenge 事件。只让读取视图看见暂时没有 handoff，不足以防止下游恢复后继续使用旧的 `admitted` 和报告引用。另一个较简单的后果是 [accepted `revision`](../packages/core/src/pro-contract/kernel.ts#L350)改变 `revision`／`specHash`，而文档没有说明 native 上下文怎样进入新条款版本；既不能静默借用旧版本，也不能让正常公共调用永久缺少可用上下文。

最小修正及接受条件：

- 给上下文发布增加调用方保存的交付身份；允许在 handoff 前发布的配置与在 handoff 后发布的验收准入应明确区分。后者必须 CAS 原 handoff，前者不能自动成为随后任意 handoff 的证据准入。
- 明确 store 内的失效规则：每次新 handoff、challenge 及受影响依赖者、条款接受、清除 handoff 的恢复／释放如何使旧准入失效；保持 profile，不回退为 native。可以追加版本，也可以使用不可复用的准入代次，但必须与权威状态转换同事务，旧引用不得被自动重新绑定。
- 写清 native 的新条款／新交付初始化与非原生 profile 重新发布的区别，使普通工作可以继续，非原生验收不能跳过宿主。
- 增加“旧宿主上下文发布晚于同 subject 新 handoff”“下游恢复后旧上下文仍不可用”“native 接受修订后能够重新交付”的 store 测试。预校验期间主动调用 `setRecognitionContext` 提升版本的现有拟定测试不能替代这些自动失效路径。

**F2 · P1：evaluation v2 仍可用旧报告重新确认被挑战的 evaluation 自身。**

方案 [第 53 行](pro-contract-researcher-s2.md#L53)给报告加入 delivery target／`attestationID`，但 evaluation 一侧只有 `revision`／`specHash`；[第 55 行](pro-contract-researcher-s2.md#L55)允许新操作从没有 handoff 的 dormant／active evaluation 合成交付并 discharge。这两项不能区分 evaluation 自身的两次准入。

具体反例：delivery D 的 handoff 和 attestation 始终不变。evaluation E 用报告 R1 通过，随后 Principal challenge E 的认定，E 回到 dormant，或从 sealed challenge 经显式 resume 回到 dormant。E 的 `revision`／`specHash` 没变，D 的 exact target／attestation 也没变。此时另一个迟到请求或使用新 `operationID` 的旧 R1 满足方案列出的全部条件，helper 又生成一个新 handoff 并 discharge E。仅对原 `operationID` 返回历史 receipt 无法阻止这条新操作路径。

修正可以保留现有条款版本及 `evaluationID` 的职责级含义，只扩展报告绑定的 evaluation 准入身份。现有 [helper](../packages/core/src/pro-contract.ts#L381)会自行激活、交付、认定；把这些步骤放入同一事务解决部分提交，却不能补出调用方原来没有审查的轮次。

最小修正及接受条件：

- v2 report 同时携带生成报告前读取的 evaluation 准入／上下文身份；该身份必须在 evaluation 自身 challenge、支持失效及重新准入后不可复用。可以复用 F1 的上下文代次，不必增加研究语义或修改 kernel 命令代数。
- helper 对这份预期身份做最终 CAS，不能在提交时查询当前 evaluation 并替旧报告补齐。delivery 身份和 evaluation 身份都进入规范请求指纹。
- 增加“D 完全不变，E 自身被 challenge，旧报告换新 `operationID` 仍被拒绝”的回归，并覆盖从 sealed challenge 显式 resume 的路径；新的报告应能绑定新的准入后完成。
- 多命令事务的拒绝路径也需明确：最终 discharge 被 gate 或 reducer 拒绝时，不能提交此前 activation／handoff 的部分成功。当前 store 把拒绝作为普通 receipt 返回，单纯加外层事务不会自动回滚；接受测试需覆盖正常拒绝和 SQL／进程故障两类路径，同时保留可恢复的拒绝审计。

**F3 · P2：相同 `operationID` 的不同内容冲突缺少自己的可恢复拒绝审计。**

方案 [第 38 行](pro-contract-researcher-s2.md#L38)在首次 operation lookup 中直接返回内容冲突，[第 41 行](pro-contract-researcher-s2.md#L41)才规定 ledger 和操作记录提交，[第 47 行](pro-contract-researcher-s2.md#L47)又承诺所有有效 409 拒绝携带可恢复 receipt。全局 `operationID` 主键已被原操作占用时，文档没有定义冲突请求记录在哪里，也没有说明返回哪个 `decision`／`frontier`／hash。

若直接抛普通 Conflict，已认证且通过 schema 的 authority-changing 请求没有不可变拒绝记录；若返回原操作的 receipt，又会把另一份 payload 的成功或失败归给当前请求。两者均不满足本轮的审计与恢复承诺。

最小修正：明确将冲突请求记为独立 rejected attempt，保存请求指纹、原 operation 引用及它自己的 ledger／receipt 身份，保持原 operation 不变。若使用独立 envelope／附属表，应说明与账本的事务关联及重复冲突请求的查询方式；不要求伪造新的 kernel 命令种类。测试先提交成功或拒绝的操作，再用同 ID 改变 Contract／类别／内容，检查原 receipt 不变、当前请求不会得到原成功、冲突记录可在重启后核查。

**其余设计判断与实施验收点。**

- accepted 且真正生成 handoff 的 `report-ready` 事件 hash 是合适的唯一身份；排除失败 replay、保留旧账本字节、历史不可恢复时拒绝的方向正确。实现需用同一读取快照核对 ledger head、hash chain／缺口及投影，不能只验证最后一个匹配事件。`get/list` 展示的 Contract 和 target、export 实际使用的 subject 和捕获的 target 也必须来自一致快照，防止用户看到旧候选却提交了新 target。
- 强制 gate 覆盖私有 `execute` 的 discharge／challenge／`revision` `decision`，且 evaluation 正负分支也进入它，关闭了预审发现的 HTTP 之外绕过路径。pure kernel 可继续维持旧代数；trusted Core 服务及数据库隔离仍不是 S2 新建的安全沙箱。
- 缺 validator 时首次认定保存拒绝、重试不再调用 validator、相同操作内容稳定生成 `attestationID`、请求指纹排除服务端时间，均合理。应明确动作矩阵：认证 Principal 的 exact challenge 和原 petition 决定不应因成功验收 validator 未装载或 `admitted` 已撤销而失去处置能力；验收准入 gate 用于建立支持，撤销支持与完成原申请各有自己的条件。
- validator 替换的身份比较必须检查当前可信 registry 的版本或实例身份，不能仅比较请求中的 profile 字符串。重复 operation 的历史 receipt 与当前支持有效性需在一致读快照中计算；后者是观察时有效，不是永久保证。
- Protocol／Server、CLI evaluation、TUI、两代生成 SDK 和 feedback-screen 都已被列入迁移；TUI 不临时 refetch target、export 不刷新核验坐标、feedback-screen 保留 frozen artifacts 的要求正确。SDK 生成和真实调用验收应执行根 `AGENTS.md` 指定的两套生成流程。缺身份的旧客户端明确拒绝是有意兼容变化，不能由 Server 自动补齐。
- S1 的 permission 完成仍绑定原 petition，保留超 lease 完成与 interruption 后 pending 可见性；release／resume 保留职责级语义这一范围选择可以接受，但其引发的上下文失效仍受 F1 约束。

本轮不要求提前实现 Principal 策略、真实研究 profile、research driver、冻结屏障或强隔离。关闭上述设计问题后，可进入 S2 实现和调用方迁移；文档复核通过不替代后续代码独立审查、包级类型检查、真实 store／HTTP／CLI 调用及重启 E2E。

## 2026-09-18 修订复核

本次仅复核修订后的 [S2 实施说明](pro-contract-researcher-s2.md)，SHA-256 为 `3734fd6889dd9e39018ff4cae3bbd1258b6386be58b94067faf0420b7387470e`。本节行号对应这一版本；上文保留初评对象及发现，不覆盖历史结论。

**结论：F1、F2、F3 均在设计层关闭，可进入 S2 实现与调用方迁移。** 没有新增设计阻断项。研究 profile 继续保持不可发行；本结论不表示 runtime 已满足这些保证。

| 初评项     | 复核结论   | 修订依据与判断                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1 · 原 P1 | 设计层关闭 | [第 25 行](pro-contract-researcher-s2.md#L25)增加含不可复用 `phaseID` 和可选 `handoffID` 的 `basis`；[第 28 行](pro-contract-researcher-s2.md#L28)要求宿主携带原 `ContextTarget`，禁止临时补当前身份，并区分 handoff 前配置与具体 handoff 的准入。[第 30 行](pro-contract-researcher-s2.md#L30)把新 handoff、失败 replay、challenge 全依赖闭包、条款接受、resume 和 release 的上下文失效接入同一权威事务；包括 kernel 投影仍为 dormant 的下游。native 可以初始化新版本，非原生 profile 保持且撤销旧准入／引用。旧宿主发布无法跨这些转换继续满足原 CAS。 |
| F2 · 原 P1 | 设计层关闭 | [第 55 行](pro-contract-researcher-s2.md#L55)使 v2 report 同时绑定 delivery 与生成报告前捕获的 evaluation `ContextTarget`，约束适用于正负两个分支；普通 activate 不改变 `phaseID`，原报告可用于其计划中的激活。[第 57 行](pro-contract-researcher-s2.md#L57)明确普通最终拒绝也回滚 activation／handoff，并在外层事务保存拒绝 receipt。[第 82 行](pro-contract-researcher-s2.md#L82)加入 D 不变、E 自身被 challenge／sealed-resume 后旧报告换新 `operationID` 仍拒绝的用例。                                                                             |
| F3 · 原 P2 | 设计层关闭 | [第 40 行](pro-contract-researcher-s2.md#L40)为冲突请求设置按 `operationID` 与请求指纹唯一的 attempt 记录，保存该请求自己的 rejected ledger receipt。原操作不覆盖，同内容冲突重试复用对应拒绝，从而区分原操作和冲突请求的历史结果。                                                                                                                                                                                                                                                                                                                     |

[第 41 行](pro-contract-researcher-s2.md#L41)还明确验收 validator／`admitted` gate 只用于建立支持，exact challenge 与原 petition 决定保留各自的处置条件。缺少研究验收实现不会意外阻止 Principal 撤销支持。其后事务步骤中的准入／validator 比较应按这项动作区分执行。

实施和代码复核仍需证明以下细节；它们是已接受设计的落实条件：

- 只在对应 kernel 转换 accepted 后推进上下文，拒绝命令、幂等重试和重复 issue 不产生新准入代次；challenge 的下游失效与 Contract 投影、账本、操作 receipt 同事务提交。`setRecognitionContext` 自身的版本 CAS 也须用写事务中的当前值。
- evaluation 请求先比较报告保存的两侧身份，再选择正负分支。正分支只在已验证的原 evaluation `ContextTarget` 下执行计划；内部新建 handoff 后的目标由该计划确定，不能把查询当前目标作为旧报告的授权来源。负分支同样不能跳过 evaluation 身份检查。
- 多命令普通拒绝及异常回滚都不留下部分 accepted activation／handoff、上下文版本或幂等记录；拒绝的审计在成功提交后才转换为外部错误。并发同指纹／不同指纹操作分别只有一个可恢复结果，不借用另一请求的成功 receipt。
- 历史身份恢复检查账本连续性和权威投影；读取展示、export 捕获及历史 receipt 的当前支持计算使用一致快照。缺历史身份与缺 validator 的拒绝不能在重启或普通读取时降级为 native 成功。
- 保留 S1 原 petition 完成及超 lease 语义；迁移全部已列出的真实调用方，并按根 `AGENTS.md` 生成两代 SDK。包级类型检查、store 并发／回滚回归、真实 HTTP／CLI／SDK 调用及 SIGKILL 重启 E2E 后，再做独立代码 review。

本次只追加评审结果，未修改方案、runtime 或历史 artifacts，未执行测试或启动实验。报告没有将拟定测试列为已通过结果。
