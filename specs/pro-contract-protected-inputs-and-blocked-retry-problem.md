# ProContract 原生问题说明：受保护输入损坏与 blocked 后的重试空转

日期：2026-10-02。状态：问题说明，供独立规划者使用；不是设计，未授权实施。本文记录 2026-10-01 SBNO native advisory 行为冒烟测试中暴露的两个原生 ProContract 问题、已核实的事实、候选方向和约束。规划者应以当前源码为准独立判断，下文的候选方案和倾向只是参考。

## 1. 背景

试运行代码为 `native-advisory` 分支 `78c6366fd34613f8a0117cfd739bd2bb230d5143`。开启 review 的一组（合同 `pct_sbno_nodes_smoke_on_20261001`）中，Researcher 在审阅之前误写了受保护的 `TASK.md`，此后所有交付都被拒绝；报告 blocked 后，原生调度连续开新 attempt，最终由操作者中止。两个问题都与 advisory review 无关，属于 ProContract 原生行为。

证据目录（均在仓库外）：

- 事件归档：`/workspace/sbno-native-advisory-preparation-20260924T054618Z/nodes-preparation-20261001T062410Z/approved-execution-20261001T065720Z/incident-protected-task/`（写入记录、原文与观测差异、逐时事件、分类）
- 运行报告：同目录上一级的 `approved-execution-20261001T065720Z/RESULTS.md`
- 开启组归档：`.../nodes-preparation-20261001T062410Z/groups/review-on/archive/`（`tool-history.json` 为全部 113 次工具调用，`attempts.json` 为 attempt 观察记录，`provider.jsonl` 为线上请求）

## 2. 问题 A：受保护输入可在执行中被写坏，直到交付才被发现

### 已核实的事实

| 序号 | 时间（UTC） | 事件 |
| --- | --- | --- |
| #23–#26 | 07:03:01.995 | 同一条 assistant 消息里批量写入 `README.md`、`FORMULAS.md`、`REPORT.md`，然后 `write TASK.md`，内容为 "Original task input retained unchanged; delivered files are sbno.py, test_sbno.py, train.py, config.json, README.md, FORMULAS.md, REPORT.md." 工具返回成功 |
| #27 | — | `contract_check` 失败："Protected file changed after replay checks: TASK.md"，`checks: 0`，没有运行验收器 |
| #28–#29 | — | 尝试 `git checkout -- TASK.md` 失败：工作区不是 git 仓库 |
| #31 | 07:03:17.848 | 交付，并在不确定项中承认 "TASK.md was accidentally overwritten while adding a delivery note" |
| #56 | 07:05:14.759 | 再次交付被保护检查拒绝 |
| 之后 | — | 后续 attempt 中多次 check 和 blocked 报告，同一原因 |

- 该回合的推理内容为加密，摘要为空，没有可见的写入理由。
- 被覆盖的原文件与该组 brief 的 SHA-256 完全一致（`adfa1823…`），Researcher 在提示中收到过全文，但判断"无法恢复"，没有尝试写回。
- 关闭组和上一轮（2026-09-27）两组都没有出现此行为；单个样本，不能归因到 brief 或 guidance 的措辞。

### 机制

- 保护只在 replay 时检查。`packages/core/src/pro-contract/replay.ts` 在运行检查前比对 `protectedBefore`（约第 284–321 行），不符时检查列表为空、直接失败；检查后再比对一次（约第 404–434 行）。
- 写入类工具不知道哪些路径受保护。`write`、`edit`、`apply_patch` 都通过 `LocationMutation.resolve`（`packages/core/src/location-mutation.ts`）解析目标路径，这可能是统一拦截的入口，需规划者核实。
- bash 可以用任意方式修改文件，工具层无法完全拦住。

### 后果

受保护文件一旦被写坏，该合同在当前 revision 下就不可能交付，除非执行者逐字节写回原文。这把一次误操作变成了任务失败。

### 候选方向

| 方案 | 要点 | 主要顾虑 |
| --- | --- | --- |
| A1 写入工具拒绝修改受保护路径 | 合同 Session 中，目标解析到 replay 策略受保护路径时返回明确错误 | 挡不住 bash；需要确认路径规范化（符号链接、相对路径、大小写）和 `additionalProtected` 的处理 |
| A2 部署层只读 | 准备工作区时将受保护文件设为只读，或在隔离规则中排除 | Landlock 只能放行不能扣除；chmod 是否有效取决于写入方式（直接写还是临时文件替换），需核实 |
| A3 宿主恢复操作 | 签发时保存受保护文件原始字节，执行者可请求恢复 | 需要新增存储和操作 |
| A4 replay 用原始版本覆盖 | replay 不使用工作区中的受保护文件 | 改变验证语义，历史合同需版本兼容 |

审查者（Claude）的倾向：先做 A1，A3 作为后续第二层，A4 不建议现在做。

## 3. 问题 B：报告 blocked 后无间隔地开新 attempt

### 已核实的事实

- 原生 driver 对 `blocked` 结果一律判为 `retry` / `new`（`packages/core/src/pro-contract/driver.ts` 第 46–52 行）。`settle` 将下一次派发时间设为 `now + retryDelay`（`packages/core/src/pro-contract/open-code.ts` 的 `settle`）。
- 两份试运行合同的 `resolution.retryDelay` 都是 **1000 毫秒**，没有 `maxAttempts`（deadline-only）。
- 开启组 07:05:18.3 报告 blocked 后，宿主记录到第 2、3、4 个 attempt 分别于 07:05:33.9、07:05:52.1、07:06:54.4 开始（`attempts.json`）；Core 最终为第 5 个 attempt、generation 6，第 5 个在中止前尚未被宿主记录。每个新 attempt 都会因同一个已损坏的文件再次 blocked。attempt 之间的间隔远大于 1 秒，主要来自每个 attempt 自身的执行时间。
- 07:07:00 操作者按"方案没有覆盖的情况先保全现场再报告"的规则中止。若不中止，循环会持续到 6 小时 deadline。

### 候选方向

- **B(i)** 维持现状，只靠 `retryDelay` 控制节奏。未来合同把 `retryDelay` 设为几分钟即可大幅缓解，不改代码。
- **B(ii)** blocked 后不再自动重试，等待 Principal 决定是否恢复。会改变所有原生合同的行为。
- **B(iii)** 连续多次 blocked 且原因相同时，转给 Principal。这是路由规则，不是累计上限。

审查者的倾向：B(iii)。但这涉及原生语义，**需要 Principal 决定**。规划者应说明每种方案对暂时性障碍（例如环境抖动）和结构性障碍（例如本次的受保护文件损坏）分别会怎样。

## 4. 约束

- 遵守 [Constitution](pro-contract-constitution.md)。任何 Core 改动都要按 change gate 写明：维护的不变量、没有它的反例、为什么不能在适配层完成、纯 kernel 测试、真实边界测试、增删的概念。kernel 和 reducer 的语义不变，除非能按 change gate 证明必要。
- 不改变任何正在运行或已冻结的 cohort 的预算、源码或配置。新行为只部署到新的运行；如果有合同共享同一部署，需要考虑版本化或按合同启用。
- 不新增累计次数、请求或费用上限（用户偏好）。路由规则可以有，但不能以大数模拟无上限。
- 保留网络和凭证隔离、显式取消、单次操作上限、基础设施故障保护和完整计量。
- 基于 `native-advisory` 分支当前 HEAD 规划；ProContract 的既有成果在该分支的检查点提交中，`dev` 上没有。
- 测试只能在 package 目录下运行；运行测试时使用独立的 `OPENCODE_DB`，避免和其他测试争用 SQLite。

## 5. 与 advisory 工作的交互

- advisory 的 reviewer job 只读，不受 A1 影响；但 A1 不能误伤审阅材料目录的准备过程（宿主自己写入，不经过合同 Session 的工具）。
- 问题 B 的策略会影响 advisory 的节点计数：每个新 attempt 会重新获得一次交付前审阅机会。若采用 B(ii) 或 B(iii)，空转消失，这一交互随之减少。
- advisory 的下一轮试运行计划在本修复合入后进行。

## 6. 期望规划者交付的内容

1. 对问题 A、B 各自的推荐方案，并说明否决其他候选的理由。
2. 按 change gate 写出的论证，以及与现有合同、历史 cohort 的兼容方案。
3. 改动清单与测试计划，至少覆盖：
   - 通过 `write`／`edit`／`apply_patch` 修改受保护路径被拒绝；
   - 未受保护路径的写入和 replay 不变；
   - bash 路径的行为如实记录；
   - blocked 的新策略在暂时性障碍和结构性障碍下的表现。
4. 需要 Principal 决定的事项清单（至少包括问题 B 的策略，以及 A3 是否进入本轮范围）。

只做规划，不实施，不提交，不运行真实模型。
