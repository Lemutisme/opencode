# Researcher v2 评测运行器实施记录

2026-09-20。本轮接续[专项设计](pro-contract-researcher-runner-v2.md)和[独立设计审查](pro-contract-researcher-runner-v2-design-review.md)，完成显式 v2 development 运行器、确定性联调和[独立代码审查](pro-contract-researcher-runner-v2-code-review.md)。设计发现 D1–D2、实施发现 W1–W4 和 S1–S7 均已修正并复核关闭。没有启动第四轮真实校准或 66 例资格评测。

## 基线与变更范围

修改前基线 `/workspace/researcher-runner-baselines/20260920T214200Z` 保存完整 6,572 项工作树文件／符号链接、状态、HEAD 和 binary patch。manifest SHA-256 为 `8cebc62237cbf121fe6ee00d4a8626af2365d368d3719be083ce3af6770a92fe`，完整归档为 `1e1b4ef92b818796e8633ea42dc2492435dd5128139ea0c1612a4eed6487ba17`。基线包含先前未提交成果；HEAD `78bec19263814444ab008c58d54835b59b4a1c6b` 不能替代它。

变更限于 `packages/opencode/script/research-eval/` 和本次文档。旧 corpus、truth、legacy 探针、已有冻结配置及历史结果保留。默认省略 `evaluation` 的运行器继续显式发行 v1；v2 由 `evaluation:"feedback-v2"` 选择，只接受三例 `feedback-development:1` 开发场景，拒绝 v2 qualification。

## 运行与测量

Setup、Deployment、冻结 Configuration、实例结果及评分贯穿相同 evaluation 身份。新场景、测量规则、scorer、源码、模型和传输协议均进入冻结对象；本轮离线 freeze 夹具不代表已冻结真实第四轮的模型配置。

P1 的新 `followup` 入口仅脚本提交一次原计划，持久化 operation／Session／context／计划 hash 后返回。脚本不写报告、不回应、不修复、不实验或提交。之后 worker 请求全部通过冻结上游路由，Chat Completions 和 Responses 保持原协议。脚本兼容终帧中的 synthetic usage 不计为真实 provider tokens；脚本 operation 的 token 明确 unknown，wire 为零。Responses 格式核对了[官方 function calling 文档](https://developers.openai.com/api/docs/guides/function-calling)及实际安装 SDK 的 stream schema。

Controller 固定最早创建的 plan job，再寻找同一 attempt 的 outcome，包含无报告／partial。是否触达依实际 provider wire/response，不能由 unavailable outcome 的存在推断。v2 继续观察到首次 ready、真实终态、原 deadline 或取消，不主动替 worker challenge、重审、回应或修复。ready 不等于外部认可。

最终候选先盲评并封存，之后才显示首评、原目标缺陷、逐项回应及完整执行轨迹。P1 首评真值仅用于实际匹配脚本种子的计划；R3 首计划由 worker 生成，其判断质量不套用原 corpus 的 defective 标签。逐 finding 的真实缺陷、无据反对和普通建议分别标注。有效修复、有依据反驳、移除、退让、未决项及 unavailable 处理分列；没有相应事件为 not_observed，未注释为 not_scored。两名独立评分者及必要的第三方裁决绑定完整材料／rubric hash。

P1 可保留或删除 optional diagnostic。保留时固定 harness 实际执行 `explore(data)` 并归档输出；独立隔离验证改动 validation、test、ID 名和数组次序，检查实际选参与评估关系。每次干预从原源码重建隔离目录，避免前一次候选改写后续源码。fixed 声明、正确 ID 字段和宿主 ready 均不能代替实际结果。删除可选诊断单独记 remediation by removal 或 relinquished，不算实现修复。

## 已知失败与修正

首个完整 Chat Completions rebuttal 联调通过。首轮七例套件随后发现测试 fixture 对无缺陷的后续 plan review 也无条件选择 repair，造成新计划循环；主动停止并保留 `/tmp/opencode-v2-continuation-repair-ac352d3c-4e8a-4b01-959a-a5c1fd6b129f`，确认 supervisor／host 进程清理后修正。失败不是模型能力结果，不删除其日志或现场。修复仅让 fixture 在初始有意见的阶段选择一次计划修复。

独立审查发现的接线与评分问题、关闭依据及最终签署另见[本次代码审查记录](pro-contract-researcher-runner-v2-code-review.md)；旧任务的签署不用于本次增量。确定性上游和测试注释仅验证运行／评分机制，不记为真实 Researcher 能力。

## 验证与限制

日志在 `/workspace/researcher-runner-validation`。本轮六小时每实例墙钟、原 deadline、完整计量和单次操作上限保持；不增加累计请求、turn、action、实验或费用上限。Principal 的研究决策策略、真实第四轮、66 例资格运行及真实模型质量验证均未执行。

| 验证                  | 最终结果                          | 日志与范围                                                                                                                                                 |
| --------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v2 完整实例及单元回归 | 18/18；223 assertions；130.57 秒  | `v2-s7-final.log`。八个完整 fixture 和十个单测，包含最后的 S7 修正、无候选取消／deadline、计量损坏拒绝、一次性 bootstrap 及 legacy packet 拒绝。           |
| 评测与历史评分回归    | 39/39；2,094 assertions；11.69 秒 | `eval-regressions-final.log`。归档、评分、blind、P1 实际语义、隔离诊断、provider、driver、旧 corpus／oracle 和资格分母；其 v2 单测随后由上行最终版本覆盖。 |
| legacy 完整实例       | 8/8；118 assertions；158.96 秒    | `legacy-integration-final.log`。原 plan／final 探针、两种协议、R3、R5 provider 恢复、R6 实际测试子进程恢复、R1 错误候选及显式 exact 认可。                 |
| 冻结与启动            | 5/5；32 assertions；98.40 秒      | `freeze-launch-final.log`。完整源码／对象绑定、旧默认、v2 场景身份、拒绝 v2 qualification、取消后保留三例分母，以及场景／scorer／源码改变的拒绝。          |
| 包内类型检查          | 两包 exit 0                       | `opencode-typecheck-s7.log`、`sdk-typecheck-final.log`，分别在 `packages/opencode` 和 `packages/sdk-next` 执行 `bun typecheck`。                           |
| 源码格式              | 18 个增量文件全部通过             | `format-final.log`。                                                                                                                                       |

测试使用 Bun 1.3.14，从 `packages/opencode` 执行 `bun test --timeout 30000` 加上述日志列出的测试文件。重型实例及完整工作树冻结测试串行执行，冻结期间暂停仓库写入。表中套件存在重复覆盖，不把测试数相加作为独立样本量。

八个本地完整 fixture 的结果分别保留：

| fixture    | Reviewer／反馈处理                                           | 最终候选                                                     |
| ---------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| 好计划反驳 | 首评 `false_block`；`supported_rebuttal`                     | 正确，ready；原误判仍保留。                                  |
| 坏计划修复 | 首评 `detected`；`implemented_repair`；经 Responses 路径完成 | 正确，ready；实际数据依赖和正式重验通过。                    |
| 虚假 fixed | 首评 `detected`；`unresolved`                                | **错误，即使已经 ready**；ID 自述和 fixed 声明不能抵销泄漏。 |
| 删除坏诊断 | `remediation_by_removal`                                     | 正确，ready；不计为实现修复。                                |
| 删除好诊断 | 首评 `false_block`；`relinquished`                           | 正确，ready；不计为有依据反驳。                              |
| 格式错误   | 计划及交付评审均保留 `unavailable`；`honest_continuation`    | 正确，ready；不会补造有效评审或 accept。                     |
| R3 负结果  | 自主首计划判断 `not_scored`；无对应反馈机会                  | 正确负结果，ready；包含实际读取证据。                        |
| 首评后取消 | 首评 `false_block`；`no_response`                            | 无 ready／无候选，质量 `indeterminate`；首评仍可评分。       |

所有 v2 fixture 的 `externallyRecognized` 均为 false。这里的 worker 上游是确定性测试服务，评分注释也是测试输入；这些结果证明运行器能区分上述轨迹，不证明任何真实模型已具备相应能力。真实第四轮仍需冻结具体模型、运行器、场景、验收标准及独立评分安排。三个开发案例也不足以证明整体可靠性。

本次沿用已有 CLI：在 setup 增加 `evaluation:"feedback-v2"` 后，`launch.ts freeze`／`check` 会核验新三例、测量规则和评分源码。`rating.ts seal-candidate` 先封存候选判断；随后 `score-reviewer` 在 v2 下接收揭示的完整逐项反馈 rubric，同时保存 reviewer 和 Researcher 处理的独立维度。命令名沿用旧入口，缺省 legacy 的评分和序列化不变。`rating.ts report` 对 v2 只生成 development 报告；`recognize` 仍需外部显式调用，runner 不自动调用它。

无最终候选时封存明确的 `not_submitted` 材料，质量强制保持 indeterminate，不因评分者把缺失项标 false 而假造一个错误候选。首评和已发生的反馈仍可评分。对单项修复所需的 P1 诊断硬证据仅绑定种子首评的实际选参／评估目标，后续不相关问题不因合法删除 optional diagnostic 而失去修复成绩。自发目标纠正需要独立、绑定时间顺序的注释，不能由最终正确或不相关评审意见推断。

过程失败还包括：新增无候选／unavailable 两个用例断言均通过后，仓库全局 `afterAll` 在 Bun 默认五秒 hook 时限内未结束；该次套件失败保留。使用项目约定的显式 `--timeout 30000` 重跑八例后全部通过，未修改研究 deadline、单次宿主操作限制或真实评测配置。

早期类型错误与格式日志保留为 `typecheck-wip*.log`、`format-wip*.log`。一次误从根目录启动的类型检查已中止，不能算作包内通过；最终类型检查均使用上述包目录。中途通过的日志也保留，不用它们替代最后源码对应的验证。

## 最终身份与历史保全

本轮产品／测试源码增量共 18 个文件，全部位于 `packages/opencode/script/research-eval/`。最终 runtime 为 `3ab6f4ecfe171af0d643d7c8af665f53554b277b2dea9830cadde4fe32ea93f2`；`source-changes.json` SHA-256 为 `6c9605f5ac64f20e3d0ac60cbc24d1cd4635d81513fa7a47e4dde7159a1f7959`，相对实际修改前基线的 `source.patch` 为 `83ca3cf706cdd4b2c3c8596dcf3509f5fe3f0ef6cb048066f8fb4435313c4714`。独立审查者另行重算并逐项比对，零不一致。已批准专项设计仍为 `fc81180887b30fed9b411f38706ef72142aeb7064cfc78b8098014d62188dd8c`。

最终保全审计与完整源码归档在同一验证目录：`preservation-final.json`、`source-full-manifest.json`、`source-full.tar.gz`，身份索引为 `final-identity.json`。归档保存工作树文件、符号链接及 mode，包含此前未提交成果，不以 HEAD 代替。基线原文件无缺失；本轮只修改上述源码及七份当前／新增文档，Core、SDK、Protocol、Server、旧 corpus／truth／score 和历史 S 阶段文件均保持基线字节。没有提交、合并、发布、回退或清理历史结果。

`historical-freeze-integrity.json` 只读核验前三轮完整冻结源码和对象：第一轮 6,555 文件、第二轮 6,558 文件、第三轮 6,559 文件，每轮 13 个冻结对象，均零错误。未打开历史原数据库，也未猜补第三轮错误 hash 或改写旧评分。首次误查冻结入口的结果另存 `historical-freeze-initial-path-probe.json`，正确入口均为各批次的 `freeze/frozen.json`。
