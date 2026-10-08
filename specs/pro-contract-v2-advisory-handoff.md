# V2 原生 advisory：supervisor 交接说明

日期：2026-10-08。写给接手 planner 与 code review 角色的 fresh Claude session。上一任 supervisor（Claude）从 2026-09-23 起主持 `native-advisory` 工作线，并起草了本分支的 [V2 advisory 设计稿](pro-contract-v2-advisory.md)。本文只交接继续工作所需的信息；细节以所引文件和源码为准，不确定时先核实再下结论。

## 1. 角色与工作方式

- **Principal 是用户本人**，负责所有决定：方案取舍、实施授权、提交、推送、启动实验、删除任何数据。用户用中文交流。
- **planner 与 code review：**fresh Claude（你）。负责写设计和方案、给其他 session 写 prompt、审查实施结果、核对运行记录，并把需要 Principal 决定的事项清楚列出。
- **implementer：**fresh Codex session，按你写的 prompt 实施，完成后停在未提交的工作树，等你把关。
- **独立审查：**设计稿以及任何涉及停止、隔离、计量边界的改动，在实施前额外请一个 fresh Codex 只读独立审查。上一轮正是这一步找出了上一任 supervisor 漏掉的阻断问题（见第 5 节）。对审查结论同样要逐条对照源码核实，不盲从。
- **沟通要求：**
  - 用平实的中文解释，先说结论和影响，少用内部术语；用户多次需要追问才理解过于技术化的说明。
  - 每次把需要用户决定的事项编号列出，并给出建议。
  - 给其他 session 的 prompt 用普通段落和编号列表，用"（prompt 开始）／（prompt 结束）"标出范围，**不要用 markdown 引用 `>`**：终端会在每行行首显示 `|`，用户还要手动删除。
  - 转述实施者或审查者的报告时，先自己核实关键事实（文件、行号、测试结果、哈希），再给结论。
- **提交与推送：**只在用户授权时提交；推送另需授权。提交信息遵循仓库 `AGENTS.md` 的约定（`type(scope): summary`），结尾加 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。

## 2. 目标与原则

**目标：**在 Researcher（V2 原生 worker）执行长任务的整个过程中，在每个关键节点提供独立的第二意见，降低低级错误和方向性错误的概率；ProContract 负责任务责任、进度判断和长任务完整性，reviewer 负责提高正确性的概率，两者互补。

**Principal 已定的原则：**

1. 只提建议，决定权始终在 Researcher；不能阻碍推进和收敛。
2. 关键节点必须审阅。Researcher 可以暂停等待审阅，但**必须是合适的暂停节点**，不能在任意时刻强行打断。
3. 基于 `procontract-closure`（V2）开发。
4. 尽量不改基础设施，只做 reviewer 必需的部分。
5. 吸取上一轮 `native-advisory` 的经验教训。
6. **ProgramBench 必须能直接跑：**advisory 默认关闭，不开启时行为与 `procontract-closure` 完全一致，不需要 intern 额外处理分支。分支推送后，用户会让 intern 在 ProgramBench 上做系统评估（`procontract-closure` 之前已在 ProgramBench 上测过）。
7. 只设六小时原始 deadline，不设累计请求、轮数、动作或费用上限，见仓库 `AGENTS.md`。

**关于第一版范围：**用户"勉强同意"第一版可以只做交付前审阅，但明确表示最终版本必须覆盖长任务过程中的关键节点。设计稿因此按多节点搭建，第一版启用哪些节点待用户决定。

## 3. 当前状态

**分支与工作目录：**

| 工作目录                               | 分支                                                                    | 状态                                                                                                                                                        |
| -------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/workspace/opencode-closure-advisory` | `closure-advisory`，从 `origin/procontract-closure`（`66128706b2`）建出 | 本交接说明和设计稿所在；**已取消对 `procontract-closure` 的跟踪**，以免误推到 Duo 的分支；将来推送时显式推到同名远端分支 `closure-advisory`。依赖尚未安装。 |
| `/workspace/opencode`                  | `native-advisory`                                                       | 上一轮工作线，HEAD `0d35d8da4`，比 `origin/native-advisory`（`906c507dc`）多 1 个未推送的文档提交。用户暂不推送。不再在这条分支上继续开发。                 |

**设计稿：**[pro-contract-v2-advisory.md](pro-contract-v2-advisory.md)。核心思路：V2 的运行器先把模型回复读完，再等待工具完成（`packages/core/src/session/runner/step.ts`），所以在 Researcher 自己发起的工具调用（`handoff`、`blocked`）内同步审阅，或者在 Session 自然空闲时审阅，都不会中断任何回复或工具，用量也完整。改动只在 `packages/sdk/script/` 的 worker 脚本，Core、Server、网关核对逻辑都不改。

**待用户决定的事项**（设计稿第 9 节）：

1. 节点设计和"合适的暂停节点"标准是否认可。
2. 第一版启用哪些节点。上一任建议：交付前、报告 blocked 前、Session 空闲三个；中途节点设计好但默认关闭，待看过 ProgramBench 轨迹中 `probe` 的调用分布再定。另一选择是第一版只做交付前。
3. 默认参数：`reviewMs` 建议 30 分钟；空闲和中途节点的 `afterMs` 建议 45 分钟。
4. 审阅出错、超时或时间不足时放行（按原逻辑继续并如实记录"审阅未发生"）是否认可。

**接下来的顺序：**用户决定上述事项 → 修订设计稿 → fresh Codex 只读独立审查 → 核实审查结论、修订 → 用户批准 → fresh Codex 实施 → 你审查并亲自重跑关键测试 → 用户授权提交 → 准备 ProgramBench 交接（推送需授权）。

## 4. 环境与约定

- **Bun 版本：**本分支要求 Bun 1.4.2（根 `package.json` 的 `packageManager`），本机**尚未安装**。`/tmp/opencode-research-toolchain/bun-linux-x64/bun` 是 1.3.14，只用于 `native-advisory`。实施前需要先安装 1.4.2 并安装依赖，相关操作先征得用户同意。
- **测试：**只在 package 目录下运行，不在仓库根目录运行；涉及数据库时为每次调用设置独立的 `OPENCODE_DB`，依次运行，不并行。V2 默认使用内存数据库，详见 [pro-contract-v2.md](pro-contract-v2.md) 的"Authority and deployment boundaries"。本分支已有的验证命令见 [pro-contract-v2.md](pro-contract-v2.md) 的 Validation 和 [pro-contract-v2-delivery.md](pro-contract-v2-delivery.md) 的 Qualification。
- **本机缺少的东西：**ProgramBench runner 源码（Python 测试需要 `PYTHONPATH="$RUNNER/src"`）和容器镜像（`OPENCODE_OTA_IMAGE`）都在 Duo 的环境（`/home/duozhou/...`），不在本机。因此 Python 测试和容器资格检查（`--fixture` 等）可能无法在本机运行，需要与用户或 intern 协调，不要把跳过的检查说成通过。
- **文件系统：**`/workspace` 是网络文件系统（MooseFS），2026-10-05 一天内出现过三次长达 16–50 秒的 I/O 卡顿，导致长时运行中断。长时运行的写入放在本地盘（如 `/var/tmp`），结束后回存并核验。
- **推送：**远端为 `git@github.com:Lemutisme/opencode.git`。用户的 GitHub 账号 `runjerry` 已获写权限。推送依赖用户从 Mac 终端用 `ssh -A` 连入本机转发的 agent；容器的 fish 配置会把 `~/.ssh/agent_sock` 指向最新的转发 socket。推送前用 `SSH_AUTH_SOCK=$HOME/.ssh/agent_sock ssh-add -l` 确认能看到密钥；看不到时请用户重新 `ssh -A` 连接。
- **真实模型实验：**只在用户批准后启动；运行前先做无真实模型的确定性演练；停止规则是遇到基础设施故障或方案未覆盖的情况就停止并保全现场，不重试、不自动恢复。

## 5. 上一轮（`native-advisory`）的概要与教训

上一轮在 `procontract-rsi`（V1）路线上实现了 native advisory，跑了五轮 SBNO（按文档实现一个算法）行为冒烟。记录都在 `native-advisory` 分支：

- 实施与五轮记录：`/workspace/opencode/specs/pro-contract-researcher-native-advisory-implementation.md`（最后几节为第三、四、五轮及后续事项）
- 节点设计：`/workspace/opencode/specs/pro-contract-researcher-native-advisory-nodes.md`
- 核实提示与 context 文件定稿：`/workspace/opencode/specs/pro-contract-researcher-native-advisory-next-steps.md`
- 被否决的暂停用量修复及独立审查结论：`/workspace/opencode/specs/pro-contract-pause-provider-usage.md`
- 实验证据：`/workspace/sbno-native-advisory-preparation-20260924T054618Z/`（各轮目录内有 `RESULTS.md` 和封存）

**观察到的行为**（每个条件一两个样本，只是定性观察）：

- 只靠 Researcher 主动请求时，reviewer 从没被调用过；改为交付前必审后才真正发挥作用。
- Researcher 为 low 档时，收到意见只改交付声明、不改代码；调到 high 后会根据意见修改。
- 前两轮里，reviewer 排在第一条的意见都是对代码运行行为的错误断言（转抄代码出错、误判库函数），其中一次 Researcher 没有核实就照着改了。第五轮加入两段提示（reviewer 把运行行为结论标为未验证；Researcher 改代码前先核实）后，两组意见都准确，其中一组 Researcher 先写脚本核实再修改。
- 交付前审阅一般约 2 分钟；high 档 Researcher 在 SBNO 上 7–14 分钟就交付。

**教训：**

1. **暂停和中断是最大的复杂度来源。**V1 上的暂停要关闭 admission、中断正在进行的回复，引出了停止边界、用量丢失、调度器竞态等一系列问题。修复"暂停导致用量丢失"的设计（等回复结束再停）经 fresh Codex 独立审查发现：漏掉了调度器这个中断源；"admission 关闭"也可能来自 driver 故障保护，修复会削弱它；admission 关闭后不续租，lease 可能不够；流结束后还有不受授权检查的收尾工作；还可能用掉审阅机会。最终该修复未采用。新设计因此只在合适的暂停节点同步审阅，不中断任何东西。
2. **未经审查的大块工作被整体带入。**`native-advisory` 的第一个提交是一个检查点，带入了此前只存在于本地、从未审查的"独立 Researcher"研究编排层及其底层改动（kernel、绑定、工具、执行许可等）。这让分支与 ProgramBench 测过的基线差异很大，难以归因。新分支只包含 advisory 本身。
3. **材料格式：**单行 JSON 在分页读取时被截断，长文本应写成纯文本文件并折行。
4. **独立审查有用。**fresh Codex 的只读审查多次找出真实问题。对它的建议同样要核实：例如它指出"每个合同约一次、约 1%"只是样本观察，不能推广，这一条成立并已修改。
5. **基础设施：**文件系统卡顿会中断长时运行，见第 4 节。
6. **兼容性：**曾把 blocked 路由的默认值改成"连续两次后转交 issuer"，这会改变 ProgramBench 的默认行为。新分支的原则是一切新功能默认关闭。

## 6. 待用户授权的清理事项

以下都已回存到 `/workspace` 并核验，可以删除，但**必须用户明确同意**：

- `/var/tmp/sbno-native-advisory-local-20261005T050601Z`（约 179M，第三轮 attempt-3）
- `/var/tmp/sbno-native-advisory-local-20261005T063051Z`（约 408M，第四轮）
- `/var/tmp/sbno-native-advisory-local-20261007T052407Z`（约 1.2G，第五轮）
- 旧 bundle：`/var/tmp/opencode-branch-bundle-20261005T062526Z`、`/workspace/opencode-branch-bundle-20261005T062526Z`。`/workspace/opencode-branch-bundle-20261006T053913Z` 是推送前的最新备份；`native-advisory` 已推送，它也可以删除。

## 7. 关键文件索引（本分支）

- 设计稿：`specs/pro-contract-v2-advisory.md`
- V2 ProContract 概览、交付机制与回归结果：`specs/pro-contract-v2.md`、`specs/pro-contract-v2-delivery.md`
- worker：`packages/sdk/script/contract-worker.ts`
- 工具配置与空闲重新提示：`packages/sdk/script/contract-profile.ts`
- 交付证据与 `exclusive` 串行队列：`packages/sdk/script/contract-delivery.ts`
- ProgramBench 宿主、网关与评测：`packages/sdk/script/native-programbench.py`
- V2 单步执行（先读完回复再等工具）：`packages/core/src/session/runner/step.ts`
- 工具列表按会话权限过滤：`packages/core/src/tool.ts`（`whollyDisabled`）
