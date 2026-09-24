# S2：共享精确认定边界实施说明

状态：已完成。设计 F1–F3 与代码审查问题均已关闭；实际代码、兼容性及最终验证见 [实施与验证记录](pro-contract-researcher-s2-implementation.md)。范围来自 [Researcher 实施计划](pro-contract-researcher.md#92-切片依赖与接受条件)。S1 的 runtime diff 指纹为 `e08420fea228d524cae5a97f6c49a32de86cb3f6993061ba5e121a507f762a32`；本轮继续保留其执行授权与等待批准语义。

## 目标与反例

外部调用方必须明确它审查的那一次交付；服务端不能替旧请求补当前身份。候选 A 被 challenge 后，再交付相同 A，会得到不同交付身份。第一次交付的批准、缺陷反馈及操作重试均不得改变第二次交付。

S2 实现通用身份、当前上下文比较及操作幂等，不实现研究方向选择、Principal 策略、独立 reviewer 或研究 driver。research profile 仍不可发行，未知 profile／缺失校验器必须拒绝认定。

## 身份与读取

1. **Handoff 身份**使用成功产生 handoff 的 accepted `report-ready` 事件 hash，编码为 `pch_<hash>`。事件 hash 已包含唯一全局序号及前序 hash，同 subject、同时间再交付仍不复用。accepted 但 replay 失败的 `report-ready` 不产生 handoff。
2. **认定 target**包含 `revision`、`specHash`、`subjectHash`、`handoffID`、`contextHash`。`contextHash` 绑定上述交付坐标及当前 profile、上下文版本、不可变引用 hash、准入标记。每项都由调用方原样携带，不能只传 subject。
3. **修订 target**继续使用 S1 的 `{ revision, specHash, petition }`，其中 specHash 是 proposed Spec，petition 是 accepted petition 的全局序号。公开读取必须返回该身份，外部决定改为必填；工具保存的原申请身份保持不变。
4. `get/list/info` 增加认定视图：当前上下文、可识别的 handoff target、pending target，以及不可恢复时的原因。CLI show/list、HTTP 和两代 SDK 同步可读。另提供独立的只读 recognition 查询，避免调用方拼装身份。
5. export 返回它在开始物化时捕获的 target。物化结束后不刷新 target；核验期间发生变更时，后续提交按旧 target 冲突。

历史账本、旧 Spec hash、Contract kernel 投影保持原字节和语义。恢复按事件顺序辨别最后一次成功 handoff 及之后的清除事件，并逐字段核对当前投影；不能仅按 subject／毫秒时间搜索。缺事件、矛盾状态、不能唯一确定来源时返回 unavailable，拒绝精确认定。challenge 导致的下游 handoff 清除以当前权威投影为准，不能因下游自己的账本没有 challenge 而复活旧交付。

## 同库持久状态

新增两类存储：

- **不可变认定上下文版本**：每个 Contract 的递增 version，profile、referenceHash、admitted、revision／specHash、basis（不可复用 phaseID 及可选 handoffID）和创建时间。取最高版本作为当前值。新发行及可识别的历史原生 Contract 初始化为 native 上下文；重复 issue 不重置已有 profile 或版本。若当前记录缺失，不在普通读取时静默恢复为 native。
- **认定操作记录**：全局 `operationID` 主键，Contract、操作类别、规范请求指纹、历史 decision/frontier/hash、产生的 attestation ID 及精确支持坐标。保留成功和拒绝结果；不能保存整份全库 state 作为重试回执。

可信宿主可用 `setRecognitionContext` 在短事务中比较 调用方保存的完整 ContextTarget（revision/specHash/version/phaseID/可选 handoffID），追加新版本。该方法不进入模型工具或 HTTP，不解释研究方法；拒绝对 discharged/released 职责直接改上下文，已确认支持的撤销必须走 challenge。上下文是验收适配器数据，追加版本保留历史；不为它伪造 kernel 命令。失败的版本比较返回明确冲突。handoff 前允许配置 profile，但非原生上下文不得提前 admitted=true；准入引用必须发布给具体 handoff。

失效矩阵：新 handoff（包括失败 replay）、challenge 的全依赖闭包（包括仍为 dormant 的依赖者）、accepted revision、resume、release 都在 kernel 转换的同一事务追加上下文版本，以该事件 hash 推进 phaseID，清除旧 referenceHash 并保存新的 handoffID（若有）。native 自动准入新版本；非原生 profile 保持不变且 admitted=false，等待宿主重新发布。普通 activate 不推进 phaseID，因此核验前捕获的 evaluation 准入身份可跨激活使用；discharge 不改上下文。旧宿主发布绝不能被服务端补当前 basis。

Schema／migration／完整 schema snapshot 使用现有生成流程。旧库迁移显式初始化已存在职责的 native 上下文，操作表初始为空；旧 attestation 没有 operationID 时不伪造历史幂等记录。历史 handoff 身份由原账本恢复，不改写旧事件或 attestation。

## 统一提交与重试

`principalAttest`、`challenge`、`decideRevision` 必须提供 operationID 和相应 expected target。现有 ID-only payload 明确拒绝，不保留自动补当前身份的兼容路径。release/resume 保留既有职责级语义；它们不能重建旧 target，状态 gate 继续适用。

事务流程：

1. 先查询 operationID。相同指纹返回历史 receipt，再单独计算当前支持是否仍有效；不重新调用校验器、不执行 reducer、不追加第二次认定。内容不同则冲突，原操作不被覆盖。附属 attempt 表以 operationID + 请求指纹唯一记录该冲突请求自己的 rejected ledger receipt；同内容冲突重试返回该拒绝，既不返回原成功，也不追加重复拒绝。
2. 新操作需要验收校验时，在写事务外由已注册 profile 校验器检查调用方绑定的不可变证据／上下文。native 使用内建有限规则；未知或缺失校验器明确拒绝。validator/admitted gate 只用于建立支持；exact challenge 和原 petition 决定不依赖验收校验器或 admitted 标记。校验器接口在 Core 声明，宿主注入实现，依赖不反转。
3. 在 immediate 事务内再次查询 operationID，解决并发首次提交；随后重新比较当前 Contract、交付／申请、上下文版本、准入状态及校验器身份。校验后撤销或替换不能被忽略。
4. 同事务执行 kernel command、提交 accepted/rejected ledger receipt 和操作记录。拒绝 receipt 提交后才转成 HTTP/CLI 错误。私有 execute 对 discharge/challenge/decide-revision 强制要求这个通路的授权上下文；不依赖调用者可选传入 S1 CommandGuard。

请求指纹覆盖 Contract、操作类别、expected、证据、决定和可见反馈；服务端生成的 time 不参与指纹。attestation ID 从操作身份稳定生成，不能每次重试创建新 ID。相同 operationID 在不同 Contract／操作类别上复用也冲突。

返回的通用 mutation receipt 保留 decision/frontier/hash/operationID，标记 replayed，并对产生认定的操作返回独立的当前支持有效性。当前有效性至少核对 status、attestationID、handoffID、contextHash 及依赖支持，不能只比较 subject。历史成功被 challenge 后重试仍是历史成功，但当前支持为 false；不能再次 discharge。

HTTP 成功和 409 拒绝均携带可恢复的 receipt。未通过 payload schema／认证的请求不构造假的 kernel 命令。缺 validator 的首次有效请求也保存拒绝；安装 validator 后如需新认定，必须使用新 operationID。

## Challenge、修订与 evaluation

- 本轮公开 challenge 明确为**交付轮次绑定的反馈**，要求完整 handoff target；不新增跨轮次永久缺陷声明。kernel 仍负责同事务撤销下游支持。旧 target 不能影响重交后的同一 subject。
- public revision decision 绑定原 accepted petition。控制工具的 permission 完成使用稳定 operationID；等待超过 lease 仍可完成原申请，不能重新获得执行权。旧申请的 approve/reject 不影响同条款重提。
- `settleEvaluation` 正负分支都进入统一 gate，不保留私有裸 discharge/challenge。新 version 2 report 绑定 delivery target、其 attestationID，以及生成报告前捕获的 evaluation ContextTarget（含非复用 phaseID/version），不能由 helper 临时补齐；旧 version 1 report 明确拒绝，历史文件保持不变。
- `evaluationID(deliveryID, revision, evaluatorHash)` 继续表示该条款版本的一份评估职责，而非交付轮次；交付轮次由 version 2 report 显式绑定。已完成的同一评估职责不能靠新 report 静默重置；上游 challenge 后的职责恢复仍由既有显式流程负责。
- 正评估报告将 evaluation activation、handoff、discharge 与 operation receipt 放在一个事务中，并在最终提交处重新核对 delivery 的 exact target/attestation/support。新操作仅可从尚无 handoff 的 active/dormant evaluation 开始；原操作的重复请求先返回历史结果。多命令普通拒绝也必须回滚 activation/handoff，然后在外层事务独立记录本请求的 rejected receipt；不能把普通 rejected 返回误当作事务失败。负报告使用 exact challenge gate。S2 的该 convenience helper 只支持 native evaluation；遇到非原生 profile 拒绝，不能越过宿主校验。

## 调用方迁移

| 调用方                | 修改                                                                                                                                                                              |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Protocol / Server     | typed target、operationID、认定视图、带 receipt 的拒绝；全部 principal 路由继续要求认证。                                                                                         |
| CLI attest / revision | 要求调用方提供保存的 expected 身份及 operationID；不临时 refetch 补当前值。                                                                                                       |
| CLI evaluation        | 读取并校验 v2 report；传固定 operationID 与完整 report 坐标。                                                                                                                     |
| TUI                   | 使用用户看到的 Contract snapshot 中 target；一次决定使用稳定 operationID；历史成功但支持已失效时显示准确结果。                                                                    |
| 现代 Client / 旧 SDK  | 分别运行生成脚本，不手改 generated；检查原始及 Effect Client。                                                                                                                    |
| feedback-screen       | 核验前捕获 export target 和 operationID，随报告保存，提交同一份请求；依据当前支持有效性报告结果。只改后续执行源码，不改任何 frozen cohort、配置、运行中源码副本或历史 artifacts。 |
| sdk-next              | 保持同一 Server 路径及认证边界，不另建绕过入口。                                                                                                                                  |

## 验收与独立审查

Core change gate：维护 exact identity、historical integrity、auditable rejection 和责任闭包。边缘先检查后调用现有 discharge 仍有竞态，且 CLI/evaluation 可绕过 HTTP，必须由共享 store 权威事务保证。kernel 状态机与命令代数不增加研究语义；纯 kernel 现有性质测试继续通过，新纯身份恢复函数以真实历史反例覆盖，真实 store 测试证明事务性。

必须覆盖：

1. 同 subject 重交的旧 attest/challenge 被拒；同条款重提的旧 public revision decision 被拒。
2. 同 operationID 并发提交只执行一次；丢响应、进程重启后返回相同成功或拒绝 receipt；改变 payload 冲突。
3. 成功后被 challenge，再重试原操作不恢复支持；下游依赖同样失效。
4. 证据预校验期间撤销上下文／准入、替换 validator，最终 CAS 拒绝；未知 profile、缺校验器及重复 issue 不得降级；旧宿主发布晚于同 subject 新 handoff、下游恢复和 native 接受修订均覆盖自动失效矩阵。
5. 历史同 subject 多轮、失败 replay、缺失／矛盾账本、旧 attestation、新库和旧库 migration；历史 hash/事件字节不变。
6. evaluation 正负报告、v1 拒绝、delivery 在报告生成后变更、事务失败及普通最终拒绝均无部分交付、重复操作与跨依赖失效；D 不变而 E 自身被 challenge（含 sealed/resume）后，旧报告换新 operationID 仍拒绝，新报告可以完成。
7. 认证 HTTP、CLI、两代 SDK 的真实调用；S1 九项 E2E 迁移到显式身份后仍通过；新增 S2 并发及 SIGKILL 重启 E2E。

完成实现后再次独立代码 review，修复本切片的问题，记录实际检查结果与边界。S3a 的旧 drain 终止回调、S4 的真实研究报告验证／冻结、S5 计划门槛均未被本轮提前宣称完成。
