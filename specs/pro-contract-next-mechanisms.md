# ProContract：从 mini-swe-agent 与 SoL-Pi 继续吸收什么

2026-09-11。分析对象是 `contract-policy-split`、HEAD `3108ea519a59d79f2f18f740221331fe6f83a44d` 上的现有未提交增强，包括已获用户授权晋升的 ObservationPack。本轮核对上游源码、重算 15 条保留轨迹，并对上游摘要校验器做无模型复现；没有修改运行时、重新晋升策略或启动 ProgramBench 推理。

下一步最值得投入的是：**缩短修改到有效反馈的路径，并让关键反馈在压缩和恢复后继续参与决策。** ObservationPack 已有可用基础，但还不能代表整个反馈循环已经增强。

## 1. 从我们的轨迹出发

来源是先前 feedback 三臂的九条轨迹，以及 ObservationPack 实跑的六条完整历史。涉及 bartib、hush、cmatrix，共 19 个保留 Session、1,298 条 assistant 消息、2,847 次工具调用。所有 15 份输入均核对原有 SHA-256；实跑历史按 Session 分组、按 seq 排序，不把 Session 轮换拼成相邻动作。

| 本轮重算指标 | 结果 | 对优先级的含义 |
| --- | ---: | --- |
| 相邻 assistant 消息之间，前一条仅有成功的原生修改工具，后一条仅调用一次 Bash | 176 / 1,280，13.75% | 值得实测 Action Fusion；只是句法机会，尚未证明下一命令能提前确定 |
| 上述机会中的修改工具 | apply_patch 117，edit 39，write 20 | 66.48% 涉及 apply_patch；只复制上游 edit/write 扩展会漏掉多数观察到的机会 |
| 仅调用 todowrite 的 assistant 消息 | 77 / 1,298，5.93% | 可以测试与实质动作同轮发送；不等于规划没有价值或可省去 77 次物理请求 |
| 没有工具调用的 assistant 消息 | 2 / 1,298 | 当前样本几乎没有“强制每轮工具调用”可挽回的空间 |
| 专用 reference 调用 | 1,401 | 需要关注探测价值和行为覆盖 |
| reference 输入 JSON 与该轨迹先前输入相同 | 32 / 1,401，2.28% | 单纯请求去重不是首要目标；输入相同也不证明状态、时间和环境相同 |
| >10 KiB 的完成 Bash 输出 | 20，其中 9 份有诊断词 | 日志问题不只是长度；这 9 份外层均记录 exit=0 |
| 内容只在 structured 中、规范 JSON 大于 10 KiB 的 read 结果 | 12 | 当前只处理 content.text 的 packer 存在实际覆盖盲区 |

这些计数来自三道已经参与开发的任务，不估计整个 ProgramBench 的发生率。assistant 消息数不是独立审计的物理 provider 请求数。176 处机会也不是“已节省 13.75% 推理成本”：有些下一步依赖修改反馈，工具和提示变化会改变后续轨迹。

这组证据比直接复制工具更能指向研发目标。特别是 `reference` 来自实验宿主的接口，不能与当前根工作树可选的 `reference_run` 混为同一实现。当前 apply_patch/write 使用 `edit` 权限别名；不能只看 runner 的字符串白名单便断言它们不可见。

## 2. mini-swe-agent：压缩不必要的决策，保持可观察的执行

核对版本：[`04d809ce`](https://github.com/SWE-agent/mini-swe-agent/tree/04d809ceab9df28f9adaed044884180159172930)。

`DefaultAgent.step` 的主线是 query → execute_actions → observations，多个动作在一次模型响应后依次执行。环境把 command/cwd/timeout 和输出/returncode 明确分开；普通动作使用独立进程。模型、环境、循环和轨迹保存之间边界清楚。这些属性便于对照实验、定位运行故障，也减少宿主要求模型处理的额外状态。

对 ProContract 的吸收应落在三个地方：

1. **下一步已知时，允许一次表达完整意图。** 修改后编译、生成探测脚本后运行、读取若干互不依赖的文档，能够用短序列或批量动作完成。依赖关系保留在序列中；独立探测才适合并行。
2. **精简模型必须维护的宿主流程。** 已知的候选哈希、检查结果、预算、有效观测入口由宿主提供。少让模型反复登记“我刚刚做了什么”；不因此删除有用推理或强制每轮套用固定模板。77 次 todo-only 消息提供了一个可测的合并目标。
3. **普通 CLI 执行尽量显式、独立；持久进程按实际需求引入。** bartib 的文件状态应在指定目录和环境中可复现；cmatrix 则需要明确的 PTY、窗口尺寸、按键、超时和进程生命周期。不能为了模仿无状态 shell，抹去任务本身的交互状态。

mini 的 ProgramBench 配置还提供截止前的交付提醒、针对输出上限的格式修复、原始输出与展示截断分离。ProContract 已有 settlement window 和原生 runner，不必建立第二套循环。可以补测“剩余时间是否足够完成编译与导出”，避免固定剩余轮数提醒漏掉耗时较长的交付尾部。

也要保留差异：mini 的完成哨兵只是结束执行循环，不能替代 ProContract 的独立验收。它的简洁不是隐藏丢失数据、重置预算或忽略已付费格式错误的理由。

## 3. Action Fusion：最有直接证据的新候选

核对版本：SoL-Pi [`d7ecfc08`](https://github.com/NVlabs/SoL-Pi/tree/d7ecfc089944f0d04b80122a0a9a6ca0d786f3d0)。上游为 edit/write 增加可选 `then_run`，成功修改后调用 Bash；修改失败则不运行后续命令，命令失败保留修改。同一规范文件路径的融合调用串行化，并在运行命令前做单文件哈希复核。

我们的重点应是 **apply_patch / edit / write → 可选的已知命令**，特别是补丁可能覆盖源文件、构建脚本和回归脚本。目标是把下一次模型决策放在“已经看到验证结果”之后。它可能把节省的等待和轮次用于更多有效修复，但也可能促使模型提前选择错误验证，因此必须实跑。

实现边界应清楚：

- 返回修改阶段和命令阶段各自的状态。部分 patch 失败不运行后续命令，并准确报告已修改的文件；命令失败不自动回滚。
- 复用现有授权与动作计数，按两个实际子动作计费。不要把两个动作算成一个，也不要由外层加内层意外算成三个。
- 当前 ToolRegistry 对 edit/write/apply_patch 有一分钟限制。直接把长验证塞进去会继承错误的整体超时；应分别约束修改阶段、命令阶段和剩余 Contract deadline。
- 通过现有原生工具执行与事件记录路径保留两段结果，不在工具内部调用模型，也不建立第二个 provider 循环。
- 单文件队列不能证明多文件候选和依赖没有变化。普通本地测试可以保留“工作区观察”的含义；需要支撑交付的检查仍使用既有冻结候选与 replay。没有必要为每一次普通探测都重复打包整个仓库。
- 不要求所有探索性修改立刻通过全套回归。由执行者选择有意义的后续命令，保持探索空间；融合结果不直接改变 settlement。

还应设置一个便宜且公平的对照：使用现有 Bash 顺序组合表达修改和运行。只有原生 Fusion 比这种 mini 风格组合更易触发、更少出错或更有质量收益，新增接口才有额外价值。

## 4. 从“可回读”推进到“关键事实持续可用”

此前晋升实跑只有 cmatrix 实际 packing：45 个请求复用同一份 28,199 字节输出；六条轨迹均没有模型回读。bartib 和 hush 未触发正文压缩，其分数变化不能归因于 packing。此前深入审计已经复现：工具目录可见但静态权限拒绝回读；原生 compaction 未传入 messageID/callID/hash；常规 structured read 未进入投影。

本轮源码核对仍能看到这些路径。应先修复使用条件，再扩展压缩覆盖：

1. **有效权限交集一致。** 目录、投影和实际读取对同一资源使用一致的可用性判断；不能靠调换 allow/deny 拼接顺序意外放大委派权限。
2. **宿主持久维护小型观测索引。** Context Epoch 保留可枚举、可查询的入口，摘要模型不承担记住所有句柄的唯一责任。raw archive、索引和当前重点分别承担原文保存、发现、决策支持。
3. **保持少量关键内容直接可见。** 当前未修复的反例、失败输入、expected/actual 差异、未完成检查、候选身份，优先于重复成功日志。不能因为“过去两轮已经发送过”就推定模型已经理解并保留了它。
4. **合法 Session 轮换可续接。** 同一 Contract 当前执行者通过授权读取历史观察；来源 Session 和候选版本明确。reference 事实不因候选被编辑而消失；旧候选上的通过结果不能自动成为新候选的证据。
5. **投影覆盖实际模型可见内容。** 与 structured lowering、媒体和通用输出截断保持一致，不能任意 JSON 转字符串改变工具语义。剩余 action 不足以回读时，继续保留决策所需内容。

这是在 SoL-Pi 的稳定句柄思路上继续发展，不是声称上游已经实现了我们的跨 Contract 授权、反例索引或交付语义。它对长程行为表现的潜在价值，是避免已经发现的约束在压缩、恢复或换 Session 后退出决策过程。

## 5. Reducer：先提取可操作差分，再考虑廉价模型

SoL-Pi 的 reducer 会归档日志，让另一个模型输出引文，并校验 schema、来源哈希、状态和引文确实存在。发生失败且日志有失败信号时，回执至少要有一个 failure/fatal 类型的条目。失败时保留原输出，是可吸收的实现模式。

本轮直接调用上游 `validateReceipt` 做了四个合成检查：

| 合成输入 | 实际校验结果 |
| --- | --- |
| 日志有两个不同错误，只引用其中一个真实错误 | 接受 |
| 外层状态成功，日志中有 expected=2 actual=3，只引用 setup complete | 接受 |
| 引文不在原文中 | 拒绝 |
| 状态失败且有 error，但只有 summary 条目 | 拒绝 |

这些结果说明其边界符合“引文可核验”，没有建立“选择的引文足以支持下一步决定”。这不是对 reducer 模型实际遗漏率的测量，也不是完整上游端到端评测。

性能优先的第一版应从确定性反馈开始：保留测试 ID、输入、reference 与 candidate 的 exit/stdout/stderr 差异、首个不同行/字节、独立错误签名，以及可回读来源。对不能完整解析的日志明确保留 unknown/unparsed，不把解析器没有提取出错误当作通过。

当前 `ProContractObservation.Receipt` 已有来源、捕获完整性以及 matched/mismatched/unobserved 等字段。后续工作应复用这些坐标，把实际 reference/candidate 差分接入可操作反馈和重点保留；只增加一套状态字段本身不会增强解题能力。

尤其在 hush，先确认最小程序确实到达要测试的语言语义，再测试边界和组合。可以通过文档允许的正常交互输出唯一标记来验证探测路径；外层 Bash 的零退出不能充当执行见证。给错误架构补充更多重复短探测，也可能只是更快地耗尽预算。

模型 reducer 适合后续处理仍然过大的非结构化日志。它负责挑选与组织，主执行模型负责修复，受信任观察器保留完整分歧集合，结算仍由既有证据边界决定。额外模型调用、等待和回读都进入相同实验会计。

## 6. Context Compact：吸收经济判断，避免只搬触发器

SoL-Pi 在计划步骤完成后考虑原生 compaction，计算预计后续请求能否偿还上下文改写的缓存成本；还考虑窗口压力和尚未偿还的前次压缩成本。源码的核心盈亏平衡项为 `writeTokens * (cacheWriteReadRatio - 1) / (archiveTokens - memoTokens)`。

对 ProContract，应把质量与经济两层分开：先保证未决反例、授权、当前候选和检索入口存在，再考虑已完成工作是否值得压缩。计划完成只能提示一个候选边界，不能证明工作已经成立或触发交付。

收益需结合实际缓存 usage、后续剩余工作、摘要费用、额外回读和前缀重写计算；不要只比较字符数，也不要把上游默认缓存比例写死为我们所有模型的事实。稳定模型请求前缀、按 Context Epoch 批量切换展示，比每轮任意重排工具和历史更容易核算。

当前“首次两个后续完成 assistant 消息、10 KiB、1 KiB 首尾预览”是固定策略，不是已经由 ProContract 数据证明的最佳参数。博客中的某个研究候选使用 2,048 字节 head 加 1,536 字节 tail，而当前公开源码的总 excerpt 是 1,024 字节；研究配置、发布代码和效果数字必须分别绑定。

主动 compaction 的优先级应在权限、索引和失败显著性之后。复用 Session 的安全边界与原生 continuation；不能把 Pi 的 abort/自动续跑流程直接移植，造成取消后恢复、预算重置或重复 provider 调用。

## 7. 最值得继承的研究方法

[SoL-Pi 博客](https://nvlabs.github.io/SoL-Pi/)把 152 个方向先做轨迹机会分析，再进入实现、检查、轨迹内验证和隔离确认，最后留下四个机制。应该吸收这个筛选过程，而不把 proposal pool 中所有方向都当成验证过的功能。

其目标和我们的取舍也需区分：博客报告组合方案保留约 94% 的 Pi 平均分；另一个 63 题 Terminal-Bench 4 CPU 子集上，Pi 完成 18 题、SoL-Pi 完成 15 题，记录 API 等价成本从 $286.45 降到 $211.12。成本下降伴随能力损失，不能作为我们性能优先的自动晋升依据。

建议形成可重复的窄循环：发现一个具体浪费或信息损失 → 从现有轨迹计量发生率 → 冻结单一机制 → 无模型检查接线与边界 → 在首次触发点继续生成新轨迹 → 固定任务对照 → 独立确认。纯历史回放可度量展示变化，无法度量被改变上下文后的模型决策。

实验脚本可以按次实例化，避免一个长寿协调器不断膨胀；但协议、源码、候选、usage、失败与原始结果必须归档。保留 negative results，机制组合后重新验证，不能将几个局部允许的回归累加成一个性能冠军。

## 8. 下一组 ProgramBench 验证

建议先完成权限、索引可发现性和 structured 内容的无模型修复验证；它们与 Fusion 的质量试验分开记录。随后在同一个固定基础上进行如下开发对照：

| 因素 | 设计 |
| --- | --- |
| 三个任务 | bartib：状态与命令组合；hush：语言语义和失败反馈；cmatrix：PTY 和正确性控制 |
| 三个执行臂 | 当前固定基线；只鼓励已有 Bash 顺序组合；原生 apply_patch/edit/write Fusion |
| 重复 | 每题每臂 3 次，共 27 条新轨迹；顺序或启动时段平衡 |
| 固定项 | 模型与 effort、二进制/补丁哈希、工具权限、reference、无外网环境、CPU/内存、总 turns/actions/deadline、评测规则 |
| 主指标 | 全任务宏平均行为分数、原始与合格满分数、完整交付、逐题/类别回归 |
| 机制指标 | 可融合机会、实际触发、提前错误选择验证、失败后继续修复、每单位时间完成的有效修改—验证循环 |
| 会计 | 所有调用、缓存、摘要/回读、恢复和未返回 usage；不得用动作少计或额外预算制造优势 |

cmatrix 已接近满分，主要用于 PTY 与回归控制；行为提升空间更多在 hush、bartib。它们都是开发任务。通过后扩大到状态管理、流式聚合等不同任务，再用未参与机制设计的冻结任务/程序版本检验迁移；已经读过并用于改进的全部 200 题不能重新包装成未见确认集。

观测索引另做“恢复后确实需要旧观测”的对照，包含原生 compaction、授权 Session 轮换、权限拒绝以及旧候选通过记录已过时等情形。比较能否找到并使用反例，而不只检查数据库还能按已知 ID 读到字节。

**建议顺序：权限与检索连续性修复 → 覆盖 apply_patch 的 Fusion → 结构化差分及关键反例保留 → 受质量约束的主动压缩 → 按需模型 reducer。** 并行构思可以很多，进入默认运行时的机制应保持少量、可解释、可关闭。

## 9. 本轮产物与来源

本轮目录：`/home/duozhou/run-artifacts/procontract-next-mechanisms-20260911/`。

- `audit.py` / `HEADROOM.json`：15 条输入的原始哈希、逐轨迹计数、176 对消息坐标。
- `reducer-boundary.ts` / `REDUCER-BOUNDARY.json`：调用上游纯校验器的四个合成边界检查。
- `SOURCE-MANIFEST.json`：上游提交、博客快照、当前所读运行时文件及审计产物指纹。

核心源码定位：

- mini：`agents/default.py`、`environments/local.py`、`config/benchmarks/programbench.yaml`、`models/utils/actions_toolcall.py`。
- SoL-Pi：`extensions/action-fusion/then-run.ts`、`file-queue.ts`；`evidence-preserving-reducer/receipt.ts`；`online-context-compact/economics.ts`；`observation-pack/observation.ts`。
- ProContract：`packages/core/src/session/observation-pack.ts`、`session/runner/llm.ts`、`session/compaction.ts`、`tool/observation.ts`、`tool/registry.ts`、`tool/apply-patch.ts`、`pro-contract/observation.ts`。

此前已复现缺口和晋升依据分别见 `procontract-observation-deep-analysis-20260911-v1/REPORT.md`、`specs/pro-contract-observation-promotion.md`。本轮不把旧复现写成新修复，也不把研究候选写成已获得的 ProgramBench 提升。
