# 原生 ProContract 执行路径接入 advisory review：方案草案

日期：2026-09-23。状态：待讨论与独立审查，未实施。本文整理执行 session 的推荐及源码依据，不替代现行协议，也不授权自动接续实施、研究、评测或外部认可。

本次只核对源码并新增本文；没有运行测试。能力兼容性参照为 `78bec19263814444ab008c58d54835b59b4a1c6b`。当前工作树包含大量既有未提交成果，不能把该 HEAD 当作当前实现快照；本方案不以整体回滚为目标。历史设计、冻结配置、评分和原始结果保持原义。

## 1. 推荐与目标

推荐复用当前原生 ProContract 的执行、验证和提交路径，把已有 reviewer 能力接成可选的宿主能力。严格 Researcher 流程继续服务于明确选择它的任务，不自动成为普通研究的执行前提。

普通 Researcher 在任务授权内自主制定方法、使用原有工具、开展实验和决定如何处理意见。任务与部署决定权限，原任务决定验证和提交要求。启用 review 不自动增加语言限制、固定实验入口、结构化计划审批、回应或 completion 门槛。Principal 保留方向、授权和最终认可；reviewer 提供有依据的独立意见。

沿用 [ProContract constitution](pro-contract-constitution.md)：Core 负责身份、权限和最终性；研究判断、review 触发与意见呈现留在宿主／适配层。不给 Core 增加 reviewer 判词的决策语义，不建设第三套协调器、通用执行平台或资格评测体系。

## 2. 已核对的路径差异

| 项目 | 原生路径 | 当前带计划的 Researcher 路径 |
| --- | --- | --- |
| 执行 | 依任务授权使用工具与进程能力 | 执行阶段开放读、写、观察和控制，不开放通用 process；探索和反馈阶段只读 |
| 验证 | 使用原任务 `evidence.replay` 的通用命令；没有 replay 时不自行添加 | manifest 必选 `node-test-tap:1` 或 `python-script:1` |
| 计划 | 执行者自行管理，原任务另有要求时遵守 | 版本化结构计划与宿主准入关联 |
| 检查与提交 | `contract_check` 不交付，`contract_report_ready` 按原任务验证后交付 | 计划、实验、捕获、review、反馈、独立提交等阶段 |
| 意见处理 | 尚无本方案所述接线 | v3 已允许不采纳、零回应和无 completion；仍保留上述执行阶段 |

`78bec19` 的 `packages/opencode/script/pro-contract-feedback-tasks.ts` 已包含 `./compile.sh` 和 `python3 validate.py`。当前 Core replay 也仍执行 `check.argv`。SBNO 的失败发生在新增 Researcher 的 Node 验证适配路径：12 次正式尝试在 Python 启动前被拒。最新 Python 修补验证了一种目标环境下的执行方式，不等于覆盖原生通用执行的全部能力。

关键源码入口：

| 源码 | 本方案依赖的事实 |
| --- | --- |
| [原生工具](../packages/core/src/tool/contract-control.ts) | `contract_check` 使用任务 replay；`contract_report_ready` 的 native 分支直接捕获、验证和交付；`contract_request` 已传递可信执行与工具调用身份 |
| [原生 replay](../packages/core/src/pro-contract/replay.ts) | 将通用 `check.argv` 交给执行器，保留输出和候选关联 |
| [原生调度](../packages/core/src/pro-contract/scheduler.ts)、[driver](../packages/core/src/pro-contract/driver.ts) | 现有 Session 调度与 `native:1` 生命周期可以继续负责主执行 |
| [Researcher model](../packages/sdk-next/src/research/model.ts)、[权限接线](../packages/sdk-next/src/research/index.ts) | 固定验证适配器与研究阶段权限属于新增研究组合 |
| [受控 job](../packages/core/src/pro-contract/job.ts)、[SDK job 执行](../packages/sdk-next/src/contract-jobs.ts) | 已有独立 reviewer Session、授权、期限、取消和操作记录能力 |
| [reviewer](../packages/sdk-next/src/research/reviewer.ts)、[意见采集](../packages/sdk-next/src/research/review-feedback.ts) | 已有环境核验、原始输出、材料引用映射及 unavailable 处理，但依赖严格 `ResearchModel.Run` |

## 3. 推荐的最小接入方式

主执行继续使用原生 scheduler、Session runner、工具、任务 replay 和提交动作。宿主在选定的提交前检查点保存材料、运行独立 review，把意见交回原研究会话。Researcher 可继续修改、保留分歧或按原条件交付。

首片建议接入既有 `contract_check` 完成处；只有任务宿主启用了 review 并选择该检查点时才触发，不把所有检查都改成评审阶段。没有 replay 的任务可以使用可选 review 请求，不为获得 review 新增验证命令或必填计划。普通任务没有触发 review 时如实记录“未发生”，不能因此拒绝提交。

具体触发选择属于宿主配置，尚未冻结 API。不能根据 `accept` 与否自动反复审阅；确切调用重试按可信调用身份去重，不靠内容相同推断重试。该选择不引入累计请求、实验或费用上限。

首片复用现有受控 job 的互斥边界，接受有期限的串行审阅：

1. 保存检查结果及其准确快照身份，记录审阅请求。
2. 在安全执行边界停止主执行，并确认清理完成，再启动只读 reviewer。
3. 保存原始意见、解析结果或 unavailable 状态，按原授权恢复研究会话并呈现意见。
4. Researcher 使用原工具继续工作，最后仍由原 `contract_report_ready` 执行原任务的提交规则。无需确认已读、逐条回应或 completion。

这是拟实现的顺序，不是现有入口已经具备的保证。实现时必须避免在尚未结束的工具调用中同步等待“主执行已结束”，也不能因为关闭 admission 而丢掉已经完成的 `contract_check` 返回和证据。使用现有 durable inbox 与执行边界衔接，不建立新的模型执行循环。

审阅副本只包含经授权选定的任务、代码、已有计划／报告及证据；不要求模型为审阅新增计划字段。交付附件保留意见、所针对的材料、可用性和已有处理说明；缺少说明如实标记，不能把审计上的未回应等同于科学缺陷未解决。

## 4. 不能零改动复用的障碍及最小替代

| 障碍 | 源码事实 | 推荐的有限改动 |
| --- | --- | --- |
| 意见采集绑定严格研究状态 | `ResearchFeedback.capture` 核对 `ResearchModel.Run`、plan／delivery、manifest 和研究 profile | 拆出按不可变材料、review job 与环境绑定的采集／引用解析能力；旧调用继续使用原规则，不伪造严格 run |
| job 与主执行互斥 | `ProContractJob.requireRoot` 拒绝 `binding.dispatched`；`open` 还检查清理及其他 job | 首片使用安全暂停和恢复，保留互斥；暂不修改为并行后台 review |
| 重新开放 admission 总会换 Session | `ProContractOpenCode.setAdmission` 的 open 分支创建新 Session 和 prompt | 增加仅在原授权上下文、主执行与 job 均已结束时保留原 Session 的显式恢复分支；新执行身份仍拒绝旧调用，旧调用方默认行为不变 |
| 原生工具没有审阅检查点接线 | native `contract_report_ready` 不经过研究 delivery handler；`contract_check` 也没有本方案的回调 | 在原检查动作旁增加可选宿主接线；Core 只传递真实执行／调用／快照身份，不处理评审结论 |

建议复用现有 SDK 宿主的 job 调度与归档能力，仅保存有限的请求、材料和结果关联，不复制严格研究阶段状态。如何在现有宿主循环中容纳该请求、避免强制创建完整 `ResearchModel.Run`，仍须在独立审查中核对；“复用宿主”不等于当前 API 已能直接完成。

不建议仅在 `report_ready` 后追加 review 并自动恢复研究：原生交付会进入 verification，重新修改候选涉及执行和交付边界，不能借 reviewer 意见暗中调用 Principal 的 challenge 权限。本方案保持原生提交含义，优先在提交前提供意见。

## 5. 保留的边界与退出普通默认流程的机制

保留宿主绑定的 Contract、revision、执行与调用身份、材料快照、review job 和证据归属。旧意见永远关联原材料；后续候选变化只改变其适用性，不把旧意见静默算成新候选已获审阅。未知、跨 job 或错版本引用不能猜补。

权限、任务范围、受保护输入、候选与真实输出、原 deadline、取消和进程清理继续由现有边界执行。reviewer 只读范围由任务与部署落实；独立上下文不冒充 OS 隔离。复用原生执行不表示开放未授权网络、凭据、依赖安装或系统文件。

review 超时、格式错误或模型不可用保存真实状态，清理确认后恢复原授权工作；不会伪造成评审通过。清理无法确认仍是执行安全故障。核心实验证据损坏不能被改记为普通 reviewer unavailable，也不能继续支持依赖该证据的提交。

普通任务不自动承担结构化计划审批、固定实验适配器、专用候选准备／提交协议、逐条回应、修复意图和完成声明。双评、裁决、隐藏答案及揭盲规则属于特定评测配置，不进入普通交付条件。实际修复由代码和实验支持，声明存在与否不能替代事实。

新接线只对明确启用的新任务生效。历史 v1／v2／v3、显式 required、冻结实例和原评分不迁移、不重解释。严格模式继续保留其原保证。原六小时绝对 deadline 不重置，不新增累计次数或费用上限；用量未知项保留，不能把派生已知用量称为完整计量。

## 6. 最小实施范围与拟议验收

范围限定为 reviewer 依赖拆分、原生检查点接线、安全恢复、意见附件和针对性回归。不纳入评分平台、材料摘要系统、长历史优化、计量竞态修复或更多语言适配器。以下是未来工程验收建议，本次没有执行。

| 验收 | 应观察到的行为 |
| --- | --- |
| 合法执行兼容 | 同一任务、权限和部署下，对比原生关闭／开启 review；实际 shell、编译、直接 Python、获准子进程和文件输出仍可执行。用 `78bec19` 的任务能力作参照，不要求恢复其全部旧源码 |
| 验证与提交不变 | 任务 replay 命令、通过／失败含义及提交条件保持；没有 replay 的任务不被新增固定验证器 |
| reviewer 实际读材料 | 用确定性 provider 驱动真实独立 Session 和读取工具访问封存文件、引用具体内容并返回意见，核验意见到达研究会话；不能只注入预制最终 JSON |
| advisory 行为 | 有依据地不采纳、零回应、无 completion、reviewer unavailable 均不单独阻断原生提交；未触发 review 也不被伪装成通过 |
| 会话与证据连续 | 暂停不丢失检查结果、历史和预算；意见绑定原快照；修改后旧意见仍保留，但不证明新候选已审阅；调用重试不重复启动 job |
| 必要硬边界 | 越权、受保护输入变化、旧执行身份、错误证据归属、deadline 和取消继续有效；清理未完成不能恢复主执行 |
| 历史兼容 | 未启用的新任务走原生路径；旧研究协议和显式 required 的准入／交付语义保持 |

兼容性检查应包含正常执行、失败、超时和取消，不能只比较允许列表。确定性联调能证明读取、传递和边界接线，不证明真实模型能正确理解材料或 reviewer 普遍提高研究质量。无需为完成这一工程切片启动真实校准、派生评分或 66 例。

## 7. 代价、未覆盖能力与撤回边界

首片仍增加审阅延迟、快照／日志保存和少量宿主状态。串行审阅是为了复用现有互斥与取消保障的明确取舍，不应被包装为没有流程成本。一次检查后继续研究与意见处理保持自主，不能把等待审阅扩展为逐项结案。

暂不覆盖并行 review、崩溃后自动续审、多 reviewer 裁决，以及带历史累计预算任务的 review 接入。当前受控 job 明确仅支持 deadline-only；不能为接入 review 偷改历史任务预算。GPU、网络及其他工具链的实际可用性仍取决于授权和部署，所列回归也不证明所有环境都兼容。

对未来任务可以关闭新接线，继续使用原生路径；已经产生的意见、失败和身份记录保留。运行中／冻结任务不通过切换模式绕过原条件。同 Session 恢复应是显式的新调用分支，不改变历史 `setAdmission` 调用的默认行为。

如果实现需要再复制一套研究阶段协调器、强制所有任务采用新实验接口，或要求模型补填审计字段，已经超出本方案，应重新讨论取舍。

## 8. 请独立审查者重点判断

- 原生执行加可选 review 是否真正保留原任务能力，还是仍隐含新增执行／交付门槛？
- 检查点停止、job 启动及同 Session 恢复能否利用现有机制完成，尤其是工具返回、清理、取消和旧调用拒绝的顺序？
- 拆出 reviewer 能力与复用现有宿主循环的范围是否足够小；是否存在更直接的现有接入点？
- 未触发、不可用、针对旧快照的意见能否如实保留，而不影响原任务独立成立的交付？

审查可以建议缩减或否定本方案，不以补齐更多机制为默认结论。本文完成后等待用户讨论取舍，不自动接续实施。
