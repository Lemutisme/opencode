# ProContract 非结算反馈接口实测 — 2026-09-05

## 决策

**本轮不晋升性能冠军。** 新接口没有增加有效交付，provider turns 与动作数反而增加；
微小的平均成本差异不足以抵消正确任务上的重复开销，也不能外推到 ProgramBench。
这是一次完成的局部筛查，不是已经证明了本质能力提升。

旧编译二进制未覆盖，原始两次 200 题记录未修改。工作树中的新增工具仍是实验候选；
运行当前源代码会包含这些候选更改，不能将其误认为已经获准替代旧冠军的版本。

## 比较了什么

- Baseline：HEAD `524da4a639a8f0192453428d2ff59b89315ed424` 的四个运行时模块。
  对比 `910d9f2856323ad5493ee52f8cb2c315d2172e10`，只有实验文档发生变化。
- Candidate：新增 `contract_check`、首次调度提示与工具说明、失败 replay 的有限诊断。
  这是组合干预，不能分别识别工具、提示和诊断的作用。
- 模型：实际请求中的 `gpt-5.6-luna`，reasoning effort `max`。
- 两个固定 Python CLI 任务：已经正确的 `ready-control`；带忽略文件依赖和语义缺陷的
  `repair-portability`。每题两次重复、两组、顺序交叉平衡，共八条真实模型轨迹。
- 每条轨迹同为 24 provider turns、96 actions、240 秒执行期限、3 次 semantic attempts；
  代理请求输出统一限制为 8,192 tokens。没有给候选更多尝试、模型或任务信息。
- 完成资格：精确 handoff 导出后，独立执行编译与冻结的三条 oracle case；全部通过后，
  由外部控制方 attestation，并确认 `discharged` 与 scope quiet。不是相信模型自报完成。

运行器与执行者在独立 Docker worker 内运行，代码和单组 overlay 只读；不挂载隐藏
oracle、另一实验组、实验协议或真实 provider 凭据。worker 网络不能直接访问外网，
推理代理只转发已预留的 native turn。独立 oracle 在另一个无网络容器执行。
但 worker 内执行者与运行时仍共享私有状态，本实验不声称证明对恶意执行者的强隔离。

## 完整结果

| 指标 | Baseline | Candidate | 候选变化 |
|---|---:|---:|---:|
| 独立 oracle 通过且获准交付 | 4/4 | 4/4 | 无增益 |
| 冻结 oracle cases | 12/12 | 12/12 | 无增益 |
| 平均 provider turns | 8.00 | 9.75 | +21.875% |
| 平均已计费动作数 | 14.00 | 16.50 | +17.857% |
| 平均 semantic attempts | 1.00 | 1.00 | 无变化 |
| 估算模型成本／轨迹 | $0.007329 | $0.007129 | −2.725% |
| 到 verification 的平均时间 | 48.713 s | 48.129 s | −1.198% |

这里的「已计费动作」指扣除 Contract action budget 的动作，不是美元收费次数。
时间截止于 verification，未包含外部 export、oracle 和 attestation；不能将其称作
完整交付的端到端延迟。成本来自冻结的本地模型目录和实际 usage，不是账单凭证。

逐对 provider turns，不能只选有利的修复题第一次：

| 任务 | 重复 | Baseline | Candidate |
|---|---:|---:|---:|
| ready-control | 1 | 6 | 9 |
| ready-control | 2 | 8 | 11 |
| repair-portability | 1 | 10 | 9 |
| repair-portability | 2 | 8 | 10 |

正确任务两次都增加三轮，且两次成本都上升。修复任务两次成本都下降，但轮数方向
不一致。八条轨迹均无代理请求误拦、未知 usage、执行器异常或额外 semantic attempt。

## 机制检查比均值更重要

四条候选轨迹各调用一次 `contract_check`，**四次全部通过**，返回 `settled: false`；
之后仍分别调用 `contract_report_ready`。修复题也在检查前完成了修复。

所以这轮没有实际激活「失败诊断 → 同一 Session 内修复 → 避免额外 attempt」这条
假设中的收益路径。它观察到的是：一个已经可交付的候选再获得一次非结算检查，
并不自动带来更好的搜索或交付。不能因此宣称失败反馈无用，也不能用这轮来证明
它减少了失败恢复成本。

额外轮数也不能全部归因于检查工具本身。轨迹中存在额外读取、规划、本地测试；
两组都记录了 `glob`／`grep` 等工具错误和后续替代操作。没有单独识别工具数量、
提示内容、轨迹随机性和这个隔离环境的交互作用。两题、两次重复不足以作总体推断。

## 实验装置审计

最终有效批次为：

`/home/duozhou/run-artifacts/procontract-feedback-screen-20260905-v7`

协议 SHA-256：`8299f487217f3297fbabab5caa3e4feadeb704d374c3bbfb58946caeb8792930`。
`protocol.json`、`sealed.json`、两组四模块 overlay、`frozen-harness/`、请求／响应、
精确导出、oracle report、settlement 和私有数据库均保留。

`results.json` 是原始运行结果；`analysis.json` 和 `analyze.ts` 是描述性分析及复现代码。
HTTP history 默认分页，因此完整工具统计使用停止后的只读数据库导出
`durable-events.json`，没有把首屏 history 当作完整轨迹。
`replayReports` 是内容寻址报告数，不等于 verifier 调用次数。

更早的 `procontract-feedback-screen-20260905-v6` 是无效装置试运行，未计入效果比较：

1. `/tmp` 被 Docker 挂载为 `noexec`，使正确候选的 replay 脚本无法执行。
2. 推理代理把响应审计和请求预留混成一个锁，可能误拒绝正常下一轮。

识别后主动停止，保留三条已启动轨迹及五条 `not_run_infrastructure`，未覆盖结果。
修复为可执行的临时 replay 目录、独立的请求预留锁，并在转发下一轮前等待前轮
usage 审计。新装置先通过无模型的完整 replay → export → oracle → attestation
链路测试，两组都合法交付后才冻结并重跑完整八条，而非挑选负轨迹重试。

有效批次 71 次真实 provider calls、估算 $0.05783466；无效试运行 14 次、$0.01257166。
合计 85 次、**$0.07040632**，未超过最初的 $5 上限。无模型探针不计作模型效果。

## 对本质提升方向的修正

方向应当是：**减少一次真实失效之后恢复合法交付所需的工作，而不是增加正常路径上的验收动作。**

下一步应冻结故障触发实验，同时保留零故障控制：区分候选不正确与 verifier 不可用，
持久保存与精确对象／修订绑定的失败观察，向执行者只投影当前可修复差异，并检验
中断或执行者替换后的恢复成本。错误接受、错误 quiet、有效交付和全部恢复预算都要
同时报告，不能通过更容易 discharge 或多给 attempts 获得表面优势。

应分别测量「只加诊断」「只提供可选检查」「额外推荐检查」；本轮组合干预不足以
决定这些组件分别该如何部署。通过这些门槛后，才值得做匹配预算的 ProgramBench
子集，再决定是否重跑全集。这是下一步研究设计，不是已经实现或验证的增益。

验证：本轮 12 项 Core 回归与 6 项 fixture 测试通过；`packages/opencode` 和
`packages/core` 的 `bun typecheck` 通过；最终两组无模型完整交付探针均通过。
单测不代替上述模型结果。
