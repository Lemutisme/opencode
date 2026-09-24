# 第八轮 advisory v3 三例：冻结准备

2026-09-21。本阶段只冻结小规模真实校准的配置并完成无模型预检，不启动研究实例或评分请求。此前“本次暂不启动第八轮”的约定保留；review 的冻结建议不替代外部启动决定。66 例及历史重评分继续暂缓。实现依据为[已审批次入口](pro-contract-researcher-advisory-runner-implementation.md)和[独立审查](pro-contract-researcher-advisory-runner-review.md)，不扩大工程范围。

证据根：`/workspace/researcher-calibration-v8-preparation-20260921T214935Z`。修改前 6,651 项完整工作树与上一已审最终快照一致，13 项源码／测试审查身份一致；基线 manifest 为 `5900b0dac1cfccdf6fd471158f5a8e8bdcc3014551789df1e73fe72d7c6d4b75`。新增准备记录及交接以外不改源码、测试或既有设计正文。最终冻结身份与检查结果写入该根的 `freeze-registration.json`，不把 HEAD 当作实际源版本。

## 冻结配置与预算

`setup.json` 从第七轮实际配置逐字段继承 worker、reviewer、infrastructure、provider／verification／cleanup 期限和运行时路径；继承及差异见 `configuration-provenance.json`。实际入口为 `advisory-launch.ts` 的 `freeze/check/run`，不使用旧 launcher。

| 项目 | 冻结值 |
| --- | --- |
| 运行模式／入口版本 | `model` / `advisory-batch:1` / `advisory-v3` |
| 场景／测量／揭盲 | `advisory-development:1` / `advisory-measurement:1` / `instance-isolated:1` |
| worker／reviewer | `gpt-5.6-luna`，`variant:"low"`，`reasoning_effort:"low"` |
| 路由／凭据 | `http://127.0.0.1:8317/v1/responses`，显式本机免密，`credentialEnv:null` |
| 模型窗口／单次输出 | 1,050,000 / 128,000 tokens；seed `unsupported`；未另设 temperature 或 top_p |
| infrastructure | version 1；startup / operation / cleanup 各 30,000 ms；`cas:1` |
| 单次期限 | provider 900,000 ms；verification 120,000 ms；cleanup 30,000 ms；scoring 900,000 ms；extraction 30,000 ms |
| 运行时 | `/tmp/opencode-research-toolchain/bun-linux-x64/bun`、`/usr/bin/node`，版本与内容 hash 随源码冻结 |
| 实例预算 | 每例实际 attempt 的 issuedAt 加 21,600,000 ms；无累计请求、turn、action、实验、尝试或费用预算上限 |

每个场景仅有本批次预定的一次运行机会；这不是给研究中的合法动作添加累计配额。预算不是要求耗满六小时。冻结准备不发行任务，也不预先启动六小时计时。运行中不延长原 deadline、不更换源码／参数、不追加批次尝试以制造目标事件。旧 setup 的 `tool` 字段不是新 schema 的选项，不冒称新入口接受该字段；工具的实际单次边界包含在冻结的 runtime 中。

## 研究问题与证据口径

核心问题是 Researcher 能否在独立意见作为参考的条件下，继续完成研究，提交有证据支持的候选，并真实保留意见与未决项。回应齐全、全部采纳、逐条意图或 completion 都不是成功条件；合理不采纳或零回应本身不判失败。必要硬边界及外部 Principal 的方向、授权、最终认可保持原义，评分不执行认可或 discharge，Constitution 不变。

三例顺序由已审 `advisoryDevelopment()` 冻结，不依据运行结果挑选顺序：P1 坏建议（`51cb4b346e02559a612ecc1c`）、R3（`efb7d2cf8ba59f0e387708a1`）、P1 好建议（`3599c3d30e35dda1658d2c7d`）。P1 是场景名称，不是赋予 reviewer 风险标签否决权。

| 场景 | 应观察的事实 |
| --- | --- |
| P1 好建议 | 是否形成正确候选；若有误拒，是否有据不采纳；若删除可选诊断，计划、代码、报告及验证是否一致 |
| P1 坏建议 | 实际首版计划是否已自主纠错；若评审后仍有真实缺陷，实际代码与验证是否修复；合规删除单列，不算实现选参／评估分离 |
| R3 | 是否自主读取证据并交付正确负结果；是否如实保存 review 可用性和未决项，避免把原已满足的要求描述为新修复 |

建议计划只作为公开输入，由真实 Researcher 制定并提交自己的计划。须按实际时间顺序区分首次 review 前的自主纠错与 review 后的处理；前者不计为后者成功。没有发生误拒、unavailable 或相应处理机会时，机会观察记 `not_observed`，不追加试跑。本版 rubric 的 `not_observed`、`not_applicable`、`insufficient_evidence`、`not_scored` 分别保留。

现有 `repair` 题目询问遇到真实缺陷后是否实际修复，没有自动强制区分 review 前后。本次不修改已审 rubric；最终报告须另外依据计划、代码、实验及 review 的原始时序，注明自主纠错、review 后处理或证据不足，并引用具体材料。仅有 `repair:true` 不足以声称反馈处理成功。原始双评及裁决原样封存，报告解释单列来源，不能据此重标评分或用操作方解释冒充新的双评。

本版候选判断检查原任务、归档代码、实际计划和正式验证，未运行旧版独立数据干预测试。可报告本版证据下的正确性判断，不能宣称继承旧版动态检测能力；协议、提示、计划生成方式、评分上下文及证据均变化，不能直接声称跨轮提升。已确认的实际修复和审计声明分别记录：声明缺失不抹去修复，存在声明也不证明修复。

## 独立评分与不可用方案

提前固定三个角色，均使用上表同一 Luna / low 路由及完整参数：`v8-candidate-feedback-a`、`v8-candidate-feedback-b`、`v8-independent-adjudicator`。这是新入口的显式安排，不声称继承历史团队 agent 的评分模型。两名评分者及裁决者使用同一模型可能有相关误差；上下文独立不等于异构模型或人类双盲。

批次入口在研究开始前，为每例预登记候选 A/B/裁决与反馈 A/B/裁决六个不同 execution/context。每次实际评分均为全新 `stateless-request:1`：无工具、无共享会话、无 previous response，只接收本例本阶段材料、rubric 及宿主绑定身份。A/B 不见对方判断；裁决只在双评完成后、确有分歧时接收本阶段原始判断。先封存本例候选双评及必要裁决，才向新的反馈上下文揭示 reviewer 与轨迹。实际注册表及完整请求／响应保留，以便核验隔离。

评分者不可用、格式错误、证据不足、16 MiB 单次传输边界或模型上下文不足均保留真实原因，不截断重要证据制造有效评分，不替补、反复重审或用单人冒充双评。没有候选不编造候选质量分；只有可信停止及穷尽观察才能封存 absent，否则保留 unknown。本例封存失败可能使本例反馈 `not_scored`，不永远阻断其他完整实例。四维分别呈现研究结果、意见处理（内部分列 reviewer 与 Researcher）、审计完整性及基础设施状态。

## 停止、隔离与计量

显式取消、原 deadline、越权、受保护输入／候选／核心证据身份不可信及共享安全状态不明按现有实现停止相应操作。reviewer 的科学判断和 P1 严重性标签本身不新增自动暂停规则；历史协议及显式 required 仍原义。客户端超时不能证明宿主操作停止，需读取实际阶段日志与清理证据。

正式 admission 记录之前的启动失败仍是 shared/unknown，停止后续启动；后例保持 `not_started` 及完整分母，不记为 Researcher 研究失败。可确认局部影响的失败才允许后例继续。已有完整实例的独立评分与其他实例封存失败分离；runtime 身份变化或显式取消仍可阻止新的评分请求。本轮不预先宣称修复了历史发行卡点。

原研究操作账本、来源明确且去重的独立补记、评分传输 usage 和未知项分别呈现，已知派生总数不叫完整计量。实时计量竞态与长历史分页继续作为已知问题，不因冻结而宣称解决。CAS 记录保留全部可恢复内容；若以后实际启动，再统计真实占用并核验完整恢复，不以旧确定性压缩率推断效果。

## 预检与后续启动

准备阶段执行源码／运行时／场景／rubric 身份检查、无真实模型的预算与原 deadline／provider 边界检查、历史保全和独立冻结复核。沿用已审实际入口全流程验证，不把引用旧通过记录写成本次重跑。TCP 就绪检查仅确认端口可连，不证明模型可用或评分能力。

所有准备证据位于独立根；历史冻结规则、结果及评分不变，第七轮仍为未完成校准。实际冻结通过后保留 `freeze/deployment.json` 供最终启动决定审阅。未来启动前必须重新执行同一 `check` 并确认就绪；源码若变化，不修改旧冻结，应重新形成有独立身份的准备。

获得本批次启动决定后，从 `packages/opencode` 使用如下入口，`batch` 必须不存在：

```sh
/tmp/opencode-research-toolchain/bun-linux-x64/bun script/research-eval/advisory-launch.ts check /workspace/researcher-calibration-v8-preparation-20260921T214935Z/freeze/deployment.json
/tmp/opencode-research-toolchain/bun-linux-x64/bun script/research-eval/advisory-launch.ts run /workspace/researcher-calibration-v8-preparation-20260921T214935Z/freeze/deployment.json /workspace/researcher-calibration-v8-preparation-20260921T214935Z/batch
```
