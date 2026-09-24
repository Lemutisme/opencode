# S5：Researcher 的计划、阶段许可与受控实验

状态：独立设计审查通过，冻结用于实施。2026-09-19。

前置条件：S1–S4 已实施。S5 编辑前基线为 `/tmp/opencode-s5-baseline/manifest.json`，SHA256 `a9fcae0c4c85fd1e599d918136ae24c913d0714f84962d8e37162d1a449b4446`。历史 S4 设计和签字审查保持原样。

## 1. 责任边界和交付范围

Principal 授予不可由内部流程改写的任务约定：目标、范围、硬性约束、明确指定的方法和数据、验收要求、权限与绝对截止时间。Researcher 在约定内自主制定和版本化执行计划。内部 reviewer 只判断是否符合约定、方法是否足以回答问题；宿主按固定规则准入，不承担 Principal 的研究战略和修订决策。

新增显式选择的 `research:1` profile，使用 `research.issue({ planning: true, ... })`；省略 `planning` 继续使用 S4 的 `research-final:1`。两者不得共享认可身份。S5 延用当前有限的 Node TAP 验证适配器；完整研究流程开放于这一适配器的能力范围。任意命令、其他测试框架、分布式训练、恶意代码沙箱和 S6 科学质量资格验证不属于本切片。

本版正式实验沿用发行时清单固定的 Node 测试协议与输出声明。Researcher 版本化研究子问题、假设、基线、实现路线、实验方法、对照、数据划分、判定标准、不确定性以及额外受保护输入。需要另一实验适配器或替换发行清单的固定测试协议时停止准入，不能伪称当前适配器覆盖了它。固定验收协议不等于 Principal 必须设计所有方法；研究方法和实现细节仍由 Researcher 制定。

## 2. 数据与身份

计划使用严格结构 `Plan`：

- `version`：从 1 递增，替换必须为当前版本加 1；旧版本及报告保存在事件和内容对象中。
- `agreement`：exact Contract `revision`、`specHash`、`manifestHash`，宿主逐项比较。
- `question`、`hypothesis`、`baseline`、`implementation`、`method`、`controls`、`data`、`evaluation`、`uncertainties`：非空说明；内部判据须解释其与外部要求的关系。
- `protected`：额外需要事前批准的普通文件路径和 SHA256，例如方法配置、划分或数据清单；发行清单的 harness 始终自动加入，不可覆盖。
- `scope`：`within_task` 或 `needs_principal_revision`。后者只能保留未决项并停止相关实验，不能经内部 accept 变为授权。

拒绝多余字段，尤其 `authority`、`deadline`、新 `spec` 等伪装成内部计划的授权覆盖。自然语言是否违反外部约定仍需独立评审，不能声称结构校验解决了语义越权。

计划批准记录绑定计划对象 hash、版本、原任务坐标、清单、独立 review job 的不可变输入、独立 Session 最终消息、原始输出、system context 与材料 hash。批准不依赖 worker 自报状态。报告另含 `scope: within_task | needs_principal_revision | unclear`；只有 `accept + within_task + 无阻断 finding + 有效证据引用` 可准入。未知范围一律停止。

正式实验记录绑定上述批准、固定 replay policy、冻结 `subjectHash`、job、实际命令和原始证据。最终交付包增加计划批准与正式实验引用；外部认可验证器重新检查它们，不只信任包中的字符串。

## 3. 工具与真实执行权限

Core 仅新增通用宿主请求入口和有限能力集合，不认识研究阶段：

1. `Binding.admission.capabilities` 可选；缺省保持 native/S4 行为。每次修改仍递增 admission version，旧 permit 失效。
2. `ExecutionPermit.tool` 同时要求原 Spec authority 和当前 admission 能力；`ExecutionContext` 传递真实进程/只读限制到叶子服务，隐藏工具不作为授权机制。
3. canonical `Tool.make` 工具 `contract_request({kind, payload})`，使用原 worker execution 身份，路由当前 profile 的可选 handler。无 handler 拒绝。请求回执只说明已持久化，不等于已批准。

S5 能力：

| 阶段 | worker 能力 | 下一步 |
| --- | --- | --- |
| exploration | read、observe、control；不允许写入或进程 | 提交 `kind: plan` 的严格 Plan |
| plan_review / freezing / verification / final review | worker admission 关闭 | 独立 job 或宿主协调 |
| execution | read、write、observe、control；不允许任意进程、reference、compose | 实现；更新计划；`kind: experiment` |
| unavailable / ready / cancelled | admission 关闭 | 显式恢复、外部反馈或认可 |

`contract_report_ready` 在 S5 还要求当前计划批准和当前正式实验记录。`contract_check`、bash、组合工具、reference 不能绕过进程许可。应用工具若没有 controlled execution 能力声明继续被拒绝。

每次 plan/experiment/ready 请求原子关闭 admission，然后等 worker drain、已准入操作和子进程清理结束才冻结或启动 review。不会在请求工具内等待其自身 drain。新 admission 使用已有新 Session 机制，不修改旧 Session 的身份。

## 4. 协调流程

`exploration → plan_review → execution → experiment freezing → experiment verification → execution → final freezing → final verification → final review → ready`。

计划材料在独立目录中冻结原始任务、发行清单、计划和必要源码背景；reviewer 延用 S3b 的只读独立 Session、固定模型和 agent、真实 provider/tool accounting。输出无效或执行未知进入 unavailable，不自动重跑。`changes_requested` 返回只读 exploration，携带阻断 finding，由 Researcher 提交新版本。`needs_principal_revision / unclear` 停止相关准入；可通过既有 ProContract 修订请求呈交外部主体，不自动修改 spec。

批准前检查计划保护路径规范、唯一、不是输出目标或祖先，并与固定 harness 无冲突。实验冻结后，固定 harness 和计划保护文件都必须匹配批准 hash；缺失或变化撤销计划批准和实验记录，回到 exploration 重新提交版本。原约定明确固定的文件不能通过追加计划 hash 覆盖。是否属于语义上的外部固定方法/数据仍由 reviewer 对照完整任务判断。

正式实验调用既有 verify job，沿用原 deadline、operation accounting、输出捕获和清理。测试失败保留真实记录，返回当前执行阶段修复，不消耗新的语义 attempt。不能解析或执行中断则 unavailable。普通失败不自动判定研究假设为真或假。

最终冻结 subject 必须与当前成功正式实验 subject 一致；不一致返回 execution，要求重新实验。最终验证仍按发行清单执行，并检查计划保护文件。最终 reviewer 同时获得计划、计划审查、正式实验和交付验证证据。只在最终 review 通过后打开 S4 的 exact 认可边界。

## 5. 运行期间保护与隔离边界

S5 使用宿主固定的独立 `runner.mjs`，位于候选不可写的宿主目录，源码作为内容对象留存，启动前核对 runner 与 Node executable hash。宿主 runner 只通过 Node `run({files, concurrency: 1, isolation: "process", execArgv: [...]})` 启动测试子进程，自身不加载候选模块。子进程启用 `--permission`、只读冻结目录、只允许写明确声明的 generated artifact 文件，不授予 child_process、worker 或 native addon 权限。父进程负责 TAP reporter；子进程普通 stdout 被记录为注释，不能冒充父进程测试结果。不能使用 `--test-isolation=none` 或 `-e` runner（Node 可能把父进程 eval 参数传给测试子进程）。不支持这些参数的 Node 失败关闭，不降级普通执行。保护路径不进入写白名单，输出只允许普通、规范的字面文件路径，禁止通配符与路径重叠。

这样既限制 worker 的任意 shell，也阻止受控 Node 实验通过正常文件 API 执行“改保护文件、运行、再恢复”的低级绕过。before/after hash 是补充证据，不被描述为运行期不可变性的证明。Node permission 不是针对恶意程序的 OS 沙箱，仍标记 `cooperative`；不保证任意 native 漏洞、宿主同用户进程或网络依赖被隔离。沿用已有凭据不转发、取消、超时和原始用量审计机制。不得将此 profile 描述成安全执行不可信恶意代码的环境。

## 6. 变更、崩溃、取消与期限

提交新 plan 时立即清除当前批准和实验引用，递增版本并关闭 admission；旧报告保留。重复旧请求因原 execution/admission version 失效而不能重新开放。原 Contract revision、specHash、pending revision 或外部 context 改变后旧批准不得继续使用。唯一允许沿用的 context 变化是同一协调器原子提交的最终 `reportReady`（执行 context 变为 handoff）和 `setRecognitionContext`（handoff 变为 published）；plan review、experiment、final verification 的原 job context 必须完全一致，final review context 版本必须为该执行版本加 1，published 为加 2，revision/specHash 均相同。bundle 验证器核对完整链，不能改写旧 job context 或任意放宽为只比较 revision。外部 challenge 也撤销计划和实验批准，重新开始只读规划。

沿用 SDK 事务、协调器 owner/generation/lease、Core job context 和 admission version。计划 review 也纳入取消、恢复和活跃 job 清理：仅已完成报告可重用；有未知 provider 工作需要显式恢复，新的尝试用新 job 并审计旧 operation。不重写旧 job 输入、不重置 deadline、不新增累计计数上限。过期的 callback 不能提交批准或交付包。

已发布的 S4/S5 run 使用各自 profile 校验。新进程恢复原 profile 和状态，不按当前默认配置升级历史 run。

## 7. 接受测试

真实生产 host / Session runner / canonical tools / HTTP provider fixture / Node 子进程和数据库：

1. 只读规划 → plan 请求 → 独立 review → 写实现 → 受控实验 → 最终验证/审查 → exact 外部认可。证明 reviewer Session 与 worker 不同、完整记账、原 deadline 不变。
2. 规划期写、bash、`contract_check` 被拒；实现期同一 shell 改输入再运行被拒；正式 Node job 对保护文件写入（含写后恢复）和 child_process 被实际拒绝；候选提前输出假 TAP 再 `process.exit(0)` 时，固定 harness 的测试不能被冒认成已经运行。
3. 计划替换后旧批准/实验失效，范围内新版本重新评审后恢复；保护文件变化不能沿用旧批准；发行固定 harness hash 不能被 plan 覆盖。
4. 伪造 authority/deadline/acceptance 字段、错误 agreement、`needs_principal_revision`、reviewer 的 unknown/out-of-scope verdict 均不准入。内部 accept 不能扩权。
5. 无实验直接 ready、伪造输出、实验后修改源码、缺失/篡改计划或实验 blob，均不能认可。
6. 计划 review 和实验中的取消、进程重启、显式恢复、迟到完成、原 deadline；未知工作不自动重跑。
7. S4 交付 profile、native control 和核心 permit/job 回归；相关包 typecheck、格式与 diff 检查。

流程测试使用可控 provider 响应，只证明强制机制与数据流。真实 reviewer 漏检率、方法有效性和科学可靠性留给 S6，不以本次通过替代。
