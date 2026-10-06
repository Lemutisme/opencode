# 原生 advisory 下一步：讨论稿

日期：2026-10-06。状态：定稿。Principal 已按第 8 节确认全部建议；第五轮实施议题一 (a) 和议题三方案 A，其余记为后续。基于 `native-advisory` / `0a6f180eb` 的源码，以及第三轮 attempt-3 和第四轮的正式运行证据（见[实施记录](pro-contract-researcher-native-advisory-implementation.md)最后两节）。

## 1. 出发点

原始目标是让 reviewer 作为第二意见进入 Researcher 的探索过程，与 ProContract 互补，并遵守两条原则：只提建议、决定权在 Researcher，不阻碍收敛；Researcher 想要时可以请求，重要节点必须审阅。

两轮正式运行显示，机制已经可靠：交付前节点拦截、意见只投递一次、回到原 Session、重新交付，全程约 2 分钟。剩下的问题都在"意见是否可靠、能否进入过程中段"：

| 观察 | 第三轮（Researcher low） | 第四轮（Researcher high） |
| --- | --- | --- |
| reviewer 第 1 条意见 | 错：把 `'ild,jd->ilj'` 引成 `'ilj,jd->ilj'`，据此断言测试跑不起来 | 错：断言 `torch.linspace(-0.2, 0.2, 1)` 返回 `[0]`，实际是 `[-0.2]` |
| Researcher 的反应 | 不改代码，只改声明 | 修改了成立的意见；也照着错误意见改了代码，没有先验证 |
| `contract_check` 的时机 | 每次都在交付前 4–9 秒 | 每次都在交付前 5–10 秒 |

本稿讨论五个议题，最后给出第五轮的排法和需要决定的事项。

## 2. 议题一：reviewer 无法验证自己对代码运行行为的断言（后续事项第 7 项）

**现状：**reviewer 作业是只读的，`ExecutionContext` 对 review 作业固定 `readOnly: true`、不允许执行进程（`packages/core/src/session/execution-permit.ts`）。reviewer 提示已经写明"You have read-only authority"，任务的 reviewer 指令也写明"tools allow reading and search, not running new experiments"。两轮的错误仍然发生：一次是转抄代码出错，一次是推断库函数行为出错。意见投递给 Researcher 的文本只说"你决定是否采用"，没有提醒哪些断言未经验证。

**方向 (a)：两端提示，不改权限。**

- Researcher 端（`packages/sdk-next/src/native-advisory.ts` 的投递文本）：说明 reviewer 只能读、不能运行代码；它对运行结果、测试通过与否、库函数语义以及代码原文的断言都是未经验证的判断；因具体断言修改代码之前，先自行核实，例如运行一小段代码、跑相关测试或重读所引的行。
- reviewer 端（同文件的 reviewer 提示固定文本）：凡是依赖运行行为的结论，写明推理过程并标为未验证；引用代码时按工具返回的原文照录。
- 只改两段固定文本，不改 Schema、存储、权限或缓存语义。历史请求不受影响。
- 局限：仍然依赖 Researcher 自己去核实。第四轮的 high 档 Researcher 有能力核实（它有 `process.execute`），只是没有被提示。

**方向 (b)：让 reviewer 在隔离副本里运行小段检查。**

- 可以直接消除这类错误，例如它本可以自己运行 `torch.linspace`。
- 但现有边界不支持：Core 已有能执行进程的 `verify` 作业，它是 replay 校验器，其进程并不局限在作业目录内。评测部署里整个宿主共用一个 Landlock 边界，宿主对 Researcher 的实时工作区有写权限。reviewer 一旦能运行命令，就可能触及 Researcher 的工作区。本地部署的隔离本身仍是协作式的（Constitution 记录的过渡债务）。
- 要做到安全，需要每个作业单独的进程隔离（只能写自己的快照副本、无网络、有时限），并补齐计量和清理。这是一次 Core 级改动，需要按 change gate 单独设计。

**建议：**本轮做 (a)；(b) 记为后续，等 (a) 的效果观察之后再决定是否设计。

## 3. 议题二：中途节点在实际行为下等于第二个交付前节点

**现状：**中途节点在计时满 `afterMs` 后的下一次**通过的** `contract_check` 触发（[节点设计](pro-contract-researcher-native-advisory-nodes.md)第 5 节）。但四次正式运行中，Researcher 只在交付前几秒调用 `contract_check`，从不在中途调用。

**后果：**无论 `afterMs` 设多少，中途节点只会在交付前一刻触发。又因为交付前节点的缓存键包含执行者声明，中途审阅不能替代它，结果是同一份代码连续审两次。按现在的 Researcher 行为，开启中途节点达不到"让 reviewer 进入过程中段"的目的。

**可选方向：**

| 方向 | 做法 | 代价与风险 |
| --- | --- | --- |
| 引导 | 在两组 brief 中加一句"完成每个主要阶段后调用 `contract_check`" | 不改代码；依赖 Researcher 遵从；改 brief 等于改任务，两组须同时改 |
| 时间触发 | 计时满 `afterMs` 后，在下一次任意工具调用的边界按方案 A 接纳暂停，该次调用不执行，恢复后由 Researcher 决定是否重发 | 真正与 Researcher 行为无关；但要把节点钩子从合同工具扩展到通用工具执行路径，是 Core 改动，需按 change gate 设计 |
| 改进后复审 | 交付前审阅之后，若候选有改动、再次交付时再审一次 | 小改动；能复查修改本身（如第四轮那次按错误前提的改动）；但审阅次数随修改轮数增加，需要设计收敛规则，避免拖慢交付 |

**建议：**第五轮不开启中途节点。是否投入"时间触发"的 Core 设计，留待你决定；如果只想先看到中段审阅的效果，"引导"是最便宜的实验手段，但要作为单独的一轮。

## 4. 议题三：`materials.json` 长字段（后续事项第 1 项）

**现状：**分行写出之后，`task.brief`（约 6 KB）和 `reviewer.instructions` 仍各占一个物理行。两轮的 reviewer 都用 `limit: 2000` 分页读取，这两行都被截断。两段全文都在 reviewer 提示中，所以没有信息损失；但执行者声明只在 `materials.json` 里，长度没有上限，写长了同样会被截。

**方案：**

- **A（已采用）：**规范内容与 `materials.hash` 不变，只改落盘呈现。`materials.json` 只保留短元数据和引用；任务说明、reviewer 指令、执行者声明分别写成材料目录下 `context/` 中的纯文本文件，保留自然换行。超过 1,000 字符的行确定性折行：优先在空白处断开，没有空白时按字符数断开，保证任何一行都低于读工具的 2,000 字符上限。校验仍为逐字节核对"由规范内容渲染出的文件"，与 `d51b45c83` 的做法一致，缓存键和作业输入不变；旧的单行和分行格式继续通过校验。reviewer 提示里"executorStatement 在 materials.json 中"一句改为指向新文件。
- **B：**只从 `materials.json` 去掉与提示重复的两个字段。改动最小，但执行者声明的风险仍在。

## 5. 议题四：交付前节点在流式响应中途拦截时丢失 usage（后续事项第 8 项）

**现状：**第四轮有一次，Researcher 的模型在流式响应中途发出 `contract_report_ready`，工具在流结束前执行，节点随即暂停 Session，同一个流在 114 ms 后被切断。暂停没有造成额外花费，但 usage 在流末尾的事件里，SDK 只能记为 `unknown`。评测网关完整记录了这次调用；没有网关的部署就会缺这一笔。

**可选：**

- 维持现状，明确记为已知情形（SDK 如实记 `unknown`，不推算）。
- 节点接纳暂停后，让当前流在有界时间内收尾，只取 usage、不再执行后续工具调用。这是 Core 执行路径的改动。

**建议：**本轮维持现状并在文档中注明；与将来的 Core 改动（例如议题二的时间触发）一并设计。

## 6. 议题五：reviewer 强度

按[节点设计](pro-contract-researcher-native-advisory-nodes.md)第 6 节，reviewer 不得低于 Researcher，推荐高一档。第四轮两者都是 high，符合下限但没有高一档。升到 xhigh 需要预检确认模型和网关支持该档位。

**建议：**第五轮保持 high，避免与议题一的改动混在一起；之后单独一轮再比较。

## 7. 第五轮的排法

**排法 1（建议）：一次只改一项行为变量。**第五轮只做议题一 (a)，同时带上议题三的方案 A。后者只改材料的落盘形式、不改内容，不算行为变量。其余条件与第四轮相同：Researcher 与 reviewer 均为 high，只开交付前节点，本地盘运行写入。

**排法 2：合并改动。**议题一 (a)、"引导"式中途审阅、reviewer 升到 xhigh 同时上。观察来得快，但出现变化时分不清是哪一项的作用。

**组别：**议题一只影响有审阅的组，关闭组在第四轮已经有同条件的基线。可选：

1. 照旧关闭组加开启组；
2. 只跑开启组，用确定性演练和预检充当 gate；
3. **跑两个开启组（建议）。**成本与第一种相当，但能看到同一条件下 reviewer 出错和 Researcher 核实行为的差异。两组依次运行，第一组结束并通过 gate 后再启动第二组。

**观察点：**reviewer 是否把运行行为断言标为未验证、错误断言是否减少；Researcher 在因具体断言修改代码之前是否先做了核实（从工具历史判断）；错误断言是否仍然导致代码修改；交付时间和审阅后的修改量。每组只有一个样本，只做定性观察。

## 8. Principal 的决定（2026-10-06）

1. 议题一：采用 (a)，第五轮实施；(b) 记为后续。
2. 议题二：第五轮不开中途节点；"时间触发"暂不设计。
3. 议题三：采用方案 A，第五轮实施。
4. 议题四：维持现状，在文档中注明。
5. 议题五：第五轮 reviewer 保持 high。
6. 排法 1；组别为两个开启组，依次运行。

## 9. 不在本稿范围

- 受保护输入在写入工具层拦截（A1′）、静默结束引起的 attempt 循环：仍按[受保护输入规划](pro-contract-protected-inputs-and-blocked-retry-plan.md)第 9 节的处理。
- 第 3 项工程小项中与 advisory 无关的三件（中途节点每轮事务、SDK 测试数据库隔离、时序不稳定的 killed-verifier 用例），可另交 Codex 并行处理。
- 把 `native-advisory` 合并回上游 `dev`。
