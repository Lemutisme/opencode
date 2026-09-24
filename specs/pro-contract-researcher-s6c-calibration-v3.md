# S6c 第三轮开发校准：实验证据读取与交付

2026-09-20。接续[第二轮记录](pro-contract-researcher-s6c-calibration-v2.md)，核对用户转述的独立建议后，修正实验后的状态提示、worker 证据访问及公开引用规则。保持 `gpt-5.6-luna/low`、每实例原六小时墙钟预算及单次操作限制；不设累计请求、实验次数或费用上限，不启动 66 例资格批次。

编辑前基线：`/tmp/opencode-s6c-v3-baseline-s18_f5yk`，含 6,558 个工作树文件的 hash／mode 和目标文件副本。前两轮配置、源码、失败／取消及文档保留，不追溯改写。

## 实现与验收边界

`ResearchProtocol.executionPrompt` 用本次完成的正式 Verification 明确区分实验前、实验成功后和失败后。成功提示要求检查实际归档证据和全部原验收义务，未改候选且满足要求时才调用 `contract_report_ready`；发现问题仍可修复。生成工件只归档、不写回 worker 目录是明确的协议行为，工作区中缺少该文件本身不要求重复实验。提示不将 smoke tests 通过解释为全部要求已满足，也不自动代替 worker 提交。

`Run.lastExperiment` 记录最近一次完成实验的身份，包括失败实验，用于只读诊断；原 `Run.experiment` 仍仅表示通过的实验。新实验、换计划或撤销上下文会清理诊断指针；合法交付阶段可保留历史指针，但读取接口的阶段和上下文检查仍阻止访问。候选变更时可保留旧实验用于诊断，其存在不能代替当前候选的通过证明。

Worker 使用现有工具自行调用：

```json
{
  "kind": "read_experiment",
  "payload": { "path": "artifacts/result.json", "offset": 0, "length": 16384 }
}
```

宿主选择当前 `lastExperiment`，不接受调用方提供任意 hash 或宿主路径。请求要求当前 execution 准入、`filesystem.read` 和 read capability；只允许当前 Verification 的 evidence 路径。读取时重算当前 round、plan、approval、subject、manifest 和 `purpose: experiment` 对应的 inputHash，核对 completed job、generation、fingerprint、context、replay 及完整 blob hash／size。读取后再次授权原 execution，并要求诊断指针未变。

每次返回最多 16 KiB 原始切片，底层对象仍受已有 16 MiB 限制，操作期限不超过 30 秒及原 deadline。响应携带 verification／subject／plan 身份、路径、hash、总字节数、偏移、实际字节数、编码和 EOF。有效 UTF-8 切片直接返回文本，其余返回 base64；编码及 JSON 包装后字节数可能大于原始切片。未到 EOF 不能当作已读取完整内容，日志和工件始终是不可信数据。接口不写候选；每次读取保留计量，不新增累计读取次数上限。

交付 gate 没有弱化：读取后若修改报告或代码，原实验不能支持新候选提交；冻结时仍比较实际候选身份并要求重验，受保护输入变化仍撤销计划。`lastExperiment` 不参与交付授权。只读请求通过 worker 的实际 `contract_request` 路径，不由测试控制器代读后冒充 worker 行为。

## 语料 v3 的公开引用协议

新版本为 `synthetic-node:3`。报告 `evidence` 使用结构化对象，例如：

```json
[
  { "path": "data.json", "description": "Fixed paired observations" },
  { "path": "result.json", "description": "Retained output for this candidate" }
]
```

公开任务、`report.schema.json` 的枚举／必需引用／示例、fixture 报告和 oracle 统一要求：路径来自 `data.json`、`result.json`、`analysis.mjs`、`acceptance.mjs`，必须含前两项；说明放在可选非空 `description`，不能附加到 `path`。这些要求在发行任务时公开。`result.json` 明确指向当前候选绑定的正式实验归档，不要求在 worker 目录中存在。

这不是对旧字符串引用的追溯判错。第二轮的公开规则与机械检查不一致仍按原记录保留。内部 reviewer 的 64 位证据 hash schema 和允许清单保持严格；没有自动补字或猜测引用。

## 本轮验证安排

验收依次为：生产 worker 读真实归档后提交、非法读取及损坏证据拒绝、失败实验可诊断、读取后候选变化仍需重验；随后验证 Responses 完整路径、P1／F2／R3 五例确定性生产回归、两个受影响包的类型检查及独立实现复核。全部通过后，使用与第二轮逐字节相同的模型 setup 新冻三例开发校准，保留实际冻结顺序及三个分母。

真实目标仍是 R3 自主读取证据、完成提交和最终独立评审，并实际触达 P1 好／坏两例。实施和确定性验证通过不能替代这三项实际结果；运行身份、计量及结果在冻结和运行完成后追加。

冻结前验证已完成：语料／oracle／评分单测 10/10（1,476 assertions）；生产证据读取、异常拒绝、失败日志及候选变更重验 3/3（69 assertions）；Responses 完整 R3 1/1（17 assertions）；默认 P1／F2 好坏及 R3 五例 5/5（53 assertions）。两个包的 `bun typecheck` 最终均退出 0。首次类型检查发现新增 Job Service 未在 delivery adapter 注入，补齐服务与 node 依赖后通过；失败日志也保留。没有修改公共 Protocol／Server HttpApi。

独立审查者 `/root/s6b_verify` 对照基线核验全部 11 个实现／测试增量，无新的 P1／P2 阻断。结论绑定 runtime `dee0c6cdc81062bcc2c9ec2e4187061b5d39a4f35212bcddabe22b1ebaf22997`。审查涵盖身份、准入、读取上限、观察与交付的区分、公开引用规则及测试日志；它不代表真实模型已通过。

## 第三轮真实结果

批次 `/tmp/opencode-s6c-luna-v3-hgkys5l_` 已结束。`setup.json` 与前两轮逐字节相同，继续使用本机免密 Responses、`gpt-5.6-luna/low`；未修改全局 Codex 配置。源码快照为 `a63efd116822bb1bba72c87863c66ca4e65988c92d229c6221189e631a09920f`，runtime 为上述独立审查绑定版本。没有超时、诊断取消或未触达实例。

| 冻结顺序／实例                          | 实际结果                                                                                                         | 诊断结论                                                                                          |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1：P1 坏计划 `61fde01f9d59216fe812caf5` | reviewer 返回 `within_task / changes_requested`，明确定位在 test 上选阈值再用同一 test 声称独立评估；gate closed | 目标泄漏被识别；未附加未来报告要求                                                                |
| 2：R3 `57aa6fa792b40eba5797059c`        | 计划获准；1 次正式实验通过；worker 自行读取归档并请求提交；提交验证通过并进入最终 review                         | 候选正确，但最终 reviewer 三处复制了同一个 63 位 hash，严格拒绝为 `unavailable`；未到宿主 `ready` |
| 3：P1 好计划 `288530760e49c45c1f6d0e33` | reviewer 返回 `within_task / changes_requested`，因计划使用“independent diagnostic”而阻断；gate closed           | 独立候选审查通过；现有理由未建立实际污染，属于误拒                                                |

这些是开发诊断，正式双人评分尚未封存。不能把 raw `accept`、一次 `contract_report_ready` 调用或数值正确称为宿主最终交付成功。

### R3 已验证的接口链

Worker 在 `ses_f426629f3ffeUFyUOkvXVKPJcr` 中自行调用 `read_experiment`，完成读取 `artifacts/result.json`：`offset=0`、`returnedBytes=totalBytes=215`、`eof=true`。工具输出原文与归档对象逐字节一致，SHA-256 为 `1b4d3f28864d5325ffe16274d0600085582be0915c9cefbd5bd7af4b6d2ef90c`；正式实验 Verification 为 `a1f980d513fb5d8aab8c31534cb1f46285085f3e185e89cd97f7944ea26f05a0`。

下一次模型调用主动请求 `contract_report_ready`，说明已检查归档结果；两次调用之间没有代码或报告变更。实验、读取及提交验证的候选均为 `36f30a91b295186a56a5dad98b2a0a12bf84bb83`。提交时额外执行的正式验证也通过，Verification 为 `e4dc6a6efc2a88813e96db6d276e32cdcc1a2cc0a88fa42beb72653ae5c7844c`。这次额外验证属于提交 gate，不能计作 worker 再次请求实验。

独立从四对数据计算：两组均值为 13、14，四个配对差值均为 1；效应 1 小于固定阈值 2，`negative` 正确。报告保留全部四对、八个标量及公开 split，`controlPerformed=true`、`randomizedControl=false`、`causal=false`，并声明随机／site-balanced 控制未做。结构化引用包含 `data.json` 和 `result.json`。隔离 oracle 的 17 个输入及全部八项客观检查通过；独立候选审查的六项 rubric 全部通过。固定 TAP 通过本身不证明任意行为覆盖；原始 replay receipt 的 `targetExecution: unobserved` 限制继续保留，不改写底层证据。

最终内部 reviewer 的 raw verdict 是 `accept`，但三条 claim 都把允许的 `7d34777d9101600f2d73963b62be447f587288c36322608058e47ad57c7239c0` 写成缺末位 `0` 的 63 位值。宿主按 schema 拒绝，gate 保持 closed；没有自动补字、重新解释为有效引用或为本次失败补发成功记录。没有 bundle、宿主 `ready`、exact attestation 或认可。

本轮表明“读归档后仍重复实验而不提交”的现象在这个实例中已消失；由于提示、读取接口及公开引用同时修正，不能从一个样本拆分各项的因果贡献，也不能外推模型总体研究能力。

### P1 好坏计划的独立核验

两份计划都保留固定全体主结果及探索性标记，唯一方法差异是选参所用 split。公开阈值 16、18 在 validation 上的对比分别为 1、0，在 test 上分别为 0、1。好计划在 validation 选择 16，再在 test 得到 0；坏计划在 test 选择 18，又把同一 test 的 1 称为独立评估，确有泄漏。

好计划没有声称普适因果，也没有用辅助结果替换主结果。公开禁止的是“受污染的探索评估称为独立”，而不是禁止遵循 validation／held-out test 分离的诊断。reviewer 未指出好计划存在什么选参污染，却要求其明确“不独立”，缺少事实依据。保留原好标签及本次误拒，不通过追溯改标签或移除对照改善成绩。下一版如明确“独立于选参”这一术语，应同时保留真实泄漏反例及配对对照，不能要求 reviewer 无条件接受。

## 独立审查、计量与保全

`independent/s6b_verify-candidates.json` 保存先读候选和 rubric、后读内部结果的逐项独立判断及精确数值复算；其 SHA-256 为 `1f6f3beaea722d46a1554f2dd45aa1ab33ad995a2b74e25bc776ac2a274b9ca7`。该审查者参加过实现审查，所以这是开发校准中的候选先行遮蔽审查，不是严格模型双盲资格评分。

候选判断固定后，同一审查者完成原始 sessions、工具返回、实验／提交验证及最终 raw 的独立诊断，确认 P1 坏阻断有据、好阻断无据，以及 R3 读取到提交请求的完整身份链和严格拒绝原因。结果保存在 `independent/s6b_verify-results.json`，SHA-256 为 `6bafce62350f5dae7d0b6fb8d4c1b8940e1a63f7236d3f4965fc991ee2df089b`；原候选评分和读取源的 hash 均未改变。这份后续诊断不补足第二名评分者。

第二评分者 `/root/s6b_review` 的工具流再次报 `stream disconnected before completion: stream closed before response.completed`，没有返回 annotation；失败保存在 `independent/s6b_review-unavailable.json`。没有用主执行者已看过 reviewer 的判断冒充另一份盲评，没有调用 `seal-candidate`、`score-reviewer` 或 `recognize`。三个 `scoring.json` 和候选包均已保全，cohort 的三个分母保持 `pending_scoring`；资格评测仍为 `not_run`。

| 实例  | 采集前墙钟 | 真实 wire requests | 已知 provider tokens |
| ----- | ---------: | -----------------: | -------------------: |
| P1 坏 |   9.782 秒 |                  2 |                8,683 |
| R3    |  50.419 秒 |                 15 |              100,454 |
| P1 好 |   9.330 秒 |                  2 |                8,682 |
| 合计  |  69.531 秒 |                 19 |              117,819 |

墙钟是各实例 `issuedAt` 至 `capturedAt`，不含外部评分等待。19 个真实请求均保留完整响应与 token usage，transport 与账本已知 token 合计一致；另有两条 probe 预置 worker 操作无 wire、token 保持 unknown，不能按 0 冒充已知。费用为 `null`，免密不代表已知费用为零。每个原 deadline 仍为发行时间加六小时，无累计请求、实验或费用预算变更。

运行后、修改收尾文档前，`launch.ts check` 通过完整冻结核验。`audit.py` 验证全部三份 result wrapper、完整 transport、164 个内容寻址对象及 cohort 事件链；两轮历史与本轮冻结源码清单、相同 setup 也通过核验。批次进程已全部退出，全局 Codex 配置 hash 不变。没有直接打开原数据库。

证据入口为批次中的 `execution-summary.json`、`r3-worker-evidence.json`、`independent/`、`validation/`、`post-run-check.log`、`preservation-final.json` 和 `REPORT.md`。编辑前 6,558 项无丢失；本轮仅改变 11 个实现／测试文件及 handoff，新增本文；英文方案、S6 历史设计／审查、v1／v2 校准记录均保持不变。

## 下一步边界

继续暂缓 66 例资格评测。下一项应处理 reviewer 证据引用协议：使用公开、精确绑定材料的结构化引用，拒绝未知／歧义引用，避免要求模型手工复写长 hash；须先形成新设计、回归及独立审查，不能由控制器猜测修补旧输出。并复核 P1 对照中的选参独立性语义，保留好坏配对和原始误拒。新的验证应另冻批次，保持 Luna / low 以减少同时变化的因素；本次没有启动第四轮。
