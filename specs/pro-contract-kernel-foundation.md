# ProContract kernel foundation: task first, RSI later

后续真实 ProgramBench 结果与最新解释见
[live insights](pro-contract-live-insights.md)。下文保留本轮基础设计和资格的原始时间边界；
脚本化资格不被追认为性能证据。

2026-10-11. 本轮只研究和验证 ProContract 本身；不启动 Test-time RSI、方法搜索、
运行时 OTA 或付费模型实验。新工作树 `opencode-kernel-foundation` / `kernel-foundation`
从 upstream `v2@1d610f9` 创建，再快进到已有 V2 实现 `receipt-layout@42d0289`。
历史工作树、cohort、数据库、分数和已冻结 release 均不修改。

## 1. 研究问题与成功标准

问题不是“如何把 R2 的代码搬回来”，而是：在可替换的短命执行者之上，最少需要什么，
才能让真实工作的进展、责任和有效完成跨上下文继续存在？

用户选择的顺序是：

1. 深度吸收 R2 的有效工作原则，建立小而完整的原生 V2 ProContract。
2. 用真实模型的匹配对照检验它是否强于 R2。
3. 只有这个基础成立后，再研究 Test-time RSI。

“全面超越”是待验证目标，不是架构命名。必须同时区分三个证据等级：

- **机制成立**：真实 Session、工具、隔离、ledger、checkpoint、verifier 和 fencing
  能正确组成闭环。脚本化 provider 可以验证这一层。
- **面板非劣且提升**：同模型、同任务/环境/评分和预定重复下，各题均值不退步，
  至少一题严格提高，并保留已得满分、安全和完整证据。
- **跨任务推广**：另用没有参与本轮机制设计的任务或新版本检验。不能把已经分析的
  九题改称新盲集，也不能将有限面板的 Pareto 结果扩大为所有任务的保证。

## 2. 从 R2 吸收什么，而不是复制什么

可读的 R2 v5 方法将未解释的行为观察作为工作控制状态：

```text
重要的未决观察 → 区分解释的实验 / 有依据的修复
    → 重放原调用及受影响边界 → 更新仍未解决的问题 → 有依据的停止
```

这比“多测试、坚持更久、写更长总结”更本质：观察必须能改变下一步，局部通过不能
覆盖仍可行动的已知差异。保留完整调用、可得输出和 incomplete 边界，使继任者不必
依靠摘要猜测前任实际看到了什么。

应保留的五个约束：

| 约束                     | 最小落点                                                | 不应误解为                                |
| ------------------------ | ------------------------------------------------------- | ----------------------------------------- |
| 责任不随 executor 消失   | durable Task + 原 deadline + issuer 权利                | 必须永远忙碌或跑满预算                    |
| 观察能跨上下文回读       | 只读、按内容寻址的公共观察 + 工作 checkpoint            | 摘要是完整证据；日志本身是真实性证明      |
| 未决事项能继续控制工作   | 固定方法中的问题选择、修复与停止判断；可定位的公共反馈  | Kernel 自动理解任意 shell 输出            |
| 自测不能替代验收         | 精确 sealed subject + 独立 verifier + issuer settlement | 外层 exit 0、提交或 Session idle 就算完成 |
| 更换执行者不重开责任坐标 | fence → checkpoint → 新原生 Session                     | 隐式 crash retry、deadline 续期或新预算   |

R2 的调度器、历史数据库、策略谱系、研究候选数量、benchmark 布局和探索程序不是
这些约束的必要定义。它们也不应该进入规范 reducer。

来源边界：R2 v5 可读字节的 SHA-256 为
`b382202cc07a74e212a8ab41e47a117a291dce1815e4967125a360a62e76d067`。
Luna 九题历史分数来自保留汇总，其 45 个索引原始文件仍不可用；不能把另一 R2
运行的源码或方法文件冒充缺失的 Luna 原始轨迹。详见
[measurement audit](essential-rsi-measurement-audit.md) 和
[public trace audit](essential-rsi-public-trace-audit.md)。

## 3. 最小 kernel 的边界

纯规范 reducer 继续只回答：谁有权限、什么责任仍存在、哪些精确证据支持当前状态、
何时可以认定完成或合法释放。它不判断测试覆盖、不选实验、不解释分数、不调用模型。

可执行的最小 ProContract 是这个 reducer 与三个已有边界的组合：

```text
责任 / 授权 ledger
    → 原生 Session + 受控工具
    → sealed workspace + 可回读公共观察
    → 独立验收
    → discharge 或同一责任的反馈 / 续行 / escalation
```

这里有两种不可互相替代的状态：

- **规范状态**：目标、授权、原 deadline、未清偿责任和验收身份。
- **工作状态**：当前产物、实际观察、尚未解释的问题和下一项可区分实验。

保住第一种而丢掉第二种，能得到可信的“未完成”记录，却不一定得到更好的 solver。
反过来，有强 solver 却允许自我验收，也不是可信的责任系统。

公共观察保持非权威。模型标记一个假设为 resolved，不因此获得 attestation；
内容 hash 证明字节身份，不证明意义、覆盖或 verifier 真实性。

## 4. 本轮落地：独立的 fixed-task admission

现有任务 API 要求即使不研究方法，也构造 safety/development/confirmation 面板。
这是研究层对基础任务层的不必要约束。新增：

```ts
import { ProContractTask } from "@opencode/sdk/pro-contract/task"

const host = await ProContractTask.open(privateRoot, {
  runtime,
  model,
  method: { instructions: exactFixedMethod },
})
const result = await host.run(task)
host.close()
```

这个入口只有 runtime、model、显式固定 method 和可选磁盘保护；任务自行绑定目标、
输入、verifier 和原 deadline。它不接收 performance 面板、提案次数或晋升规则。
CLI 的 `opencode contract run ROOT --profile PROFILE --task TASK` 识别同一 task profile。

host admission 写入明确的 `kind: task` 协议，而不是空面板的假性能协议。原生工具
不暴露 propose；ledger 同样事务性拒绝 `propose` 和 `select`，不只是在提示词中劝阻。
相同原生执行、观察归档、checkpoint、验收和 fencing 继续复用，不新增模型循环、
调度器、表或规范状态。旧 RSI 协议及其 task-Pareto 语义保留。

这是任务优先的接口和权限分离，不是宣称所有研究实现代码已从共享 host 中移除。
共享实现目前仍保留历史 `RSI` 命名；本轮没有建立另一套重复的 task runner。
未来若抽取共同执行类型，应依据实际复用边界，而非为命名好看再复制一套编排。

没有改变 public Contract Schema、Protocol 或 Server HttpApi；不需要生成 Client。
规范 `kernel.ts` 本轮保持不变。这一步本身不是得分提升证据。

## 5. 本轮原生 E2E 的可反驳验收

不以“最后进程 exit 0”或“模型说完成了”作为断言。资格任务必须证明：

1. 第一原生 Session 的大输出首部包含独立生成的公开反例字节，模型显示尾部没有它。
2. 26 次无关 shell 后，上游缓存确实删掉原输出；宿主不可变归档仍保留精确字节。
3. checkpoint 摘要不复述反例。新的 Session 从归档回读，保留 Unicode、NUL 和
   非 UTF-8 字节，不能通过摘要泄漏伪造跨上下文连续性。
4. 继任者第一次 submit 仍缺少一项公开产物。独立 verifier 拒绝；自称 ready
   不 discharge，公共反馈进入同一 Task。
5. 第三个原生 Session 实际修复并重新 submit；独立验收后才 discharge。
6. 三段保持同一 Task、精确固定方法和原 deadline；每段退出都有 fence receipt。
7. 全部实际 provider 请求的 handoff schema 不含 propose；comparison 数为零。
8. 原始非零正常退出、timeout、SIGKILL、read error 不被伪装为成功完整观察。
   工具子 PID 无权写观察通道，归档只读且不污染交付 workspace。

模型响应和资格评分是脚本化的，但 SDK、Session、shell、文件、模型通道、数据库、
独立 verifier 和进程清理真实执行。这是闭环资格，不是 learned improvement。
SDK 和 CLI 使用分别新建的资格根；任何失败尝试保留，禁止原地修补 frozen release。

包目录中的复现命令：

```sh
# packages/core
bun test test/pro-contract-task.test.ts test/essential-rsi.test.ts test/pro-contract-constitution.test.ts
bun typecheck

# packages/sdk
bun script/pro-contract-freeze.ts SOURCE NEW_RELEASE --worker
bun script/pro-contract-observation-qualify.ts NEW_ROOT NEW_RELEASE BUN --task-only
bun script/pro-contract-observation-qualify.ts NEW_CLI_ROOT NEW_RELEASE BUN --task-only --cli
PROCONTRACT_QUALIFY_WARMUP=1002 bun script/pro-contract-observation-qualify.ts NEW_LONG_ROOT NEW_RELEASE BUN --task-only
bun script/pro-contract-faults.ts NEW_FAULT_ROOT NEW_RELEASE BUN --task-only
PROCONTRACT_RELEASE=NEW_RELEASE bun test test/pro-contract-task-e2e.test.ts
bun typecheck
```

fixture 的短 deadline 和有限 scripted 行为不是未来模型实验的累计次数或费用预算。
长资格必须实际跨越历史次数限制，而不是往数据库填 synthetic prior rows；原 deadline
到期与取消另测。新 paid cohort 仍需检查其实际环境、gateway 和完整记账是否匹配。

## 6. 下一步研究，不在本轮伪装为已实现

真实轨迹说明，“能回读”仍不等于“已知差异持续约束下一步和停止判断”。所以保留一个
具体而未证实的研究假设：以最少的显式 working frontier 累积已观察的未决事项，
再让固定求解方法消费它，可能比只保存日志与最近摘要更有效。

必须先回答：谁能注册它、谁能提供关闭见证、见证绑定哪个产物、旧通过在修改后是否
仍有效、什么属于合理未测不确定性。不得把任意文本的语义分类器偷偷放进 Kernel，
也不得以模型写出的 `resolved: true` 接受完成。检查执行和产物换代要能观察实际结果。

没有证据时不新增通用 planner、强制 checklist、最低测试量、搜索算法、reviewer
角色、跨任务经验库或新权限。首先用已有公开失败建立最小反例，再决定哪一个字段
或见证边界不可删除。R2 的方法规则可以作为固定对照，不把复用它叫自主 RSI。

## 7. 强于 R2 的识别设计

这是待冻结设计，不是已授权/运行的 performance cohort：

- **系统比较**：在新隔离根中运行精确历史 R2 与新 V2；同模型/effort、任务、输入、
  CPU/RAM、网络权限、评分和明确相同的六小时 deadline 坐标。不同工具/运行时
  如无法匹配必须披露；这种比较衡量整套系统，不声称识别单个机制。
- **V2 内消融**：固定同一原生 runtime 和 task-only admission，比较原 seed、
  可读 R2 固定方法、最小 evidence-led 方法。禁止 propose、方法替换和 RSI。
  这样才能区分 runtime 与工作方法，而不是一次改三层后归因于 kernel。
- **重复与独立确认**：预先固定重复数、完整任务列表和分母；同期交错运行。不观察
  结果后追加到“刚好成功”。已曝光任务用于诊断；确认任务/版本在冻结前确定并封存。
- **坐标和记账**：每实例六小时，跨上下文不续期；无累计 provider、工具、请求或
  金额上限。不以大有限 sentinel 假装 unlimited。所有 rejected/incomplete/
  verifier/cleanup 消耗计入；未知分数和 usage 保持未知。
- **晋升门**：固定重复下逐题均值 task-Pareto，至少一题严格提高、没有任务均值
  回退，保留已得满分、安全、完整开发与确认。缺失证据不能晋升。
- **过程量**：已知反例是否留存、修复后是否重放、继任是否重复遗失的探测、提交时
  是否仍有已知可行动差异。它们解释机制，不能替代独立最终评分。

当前可用空间不足以无条件启动大规模新 cohort。源代码资格与小型 native fixture
优先；不删除历史工件来腾出预算。效能胜过 R2 必须等这套新冻结对照完成后再报告。

## 8. Evidence record

本轮工件保留在 `/home/duozhou/run-artifacts/procontract-kernel-foundation-20261011/`。
`release/RELEASE.json` 绑定实际 worker 源码；`reports/FREEZE.json` 记录 upstream/base。
源头 commit 仍是 `42d0289` 加本工作树 delta，不能冒称新增实现已有 committed hash。
具体运行结果仅在资格完成后追加；全仓检查、全部 SDK suite、真实模型或性能晋升
没有运行就不记为通过。

### 已执行的资格

- 冻结 worker release：7,111 个源码/链接条目；规范 reducer SHA-256
  `b00a1febbae37742e8308f1e2bcf334a885347128a71e71acdea253c2c046ad9`，
  与本轮 base 相同。新增 task admission，不新增规范命令、状态、表或模型循环。
- `task-api`：36 个真实 native protocol 请求、三个 Session；120,077 个原始字节
  经旧 shell 文件淘汰、checkpoint 和公共验收拒绝后仍可回读并修复，最终 discharge。
- `task-cli-2`：相同闭环通过冻结 release 的真实 CLI **源码入口**；不是编译 binary
  的资格。首次 `task-cli` 因资格 driver 未设置 CLI cwd、错误 JSX runtime 而失败，
  在任何模型请求之前退出；原失败日志保留。第二次使用新根，没有修补 release。
- `task-long`：1,012 个实际请求、1,002 个无关 shell；第一原生 execution 也超过
  1,000 个请求。没有 synthetic prior rows。方法比较为零，原 deadline 不变。
- `task-faults`：取消、原 deadline 到期和撤权均有真实 fence acknowledgement；
  责任仍 escalated，不把进程停止当作完成。
- `legacy-profile`：已有 admission 的 34 请求、两个 Session 观察连续性资格仍通过。
- Core 定向回归：18 pass。SDK 定向 suite 包含已启用、非跳过的 task E2E；完整结果
  见 `reports/sdk-tests-final.log`（19 pass），不是全 SDK suite。Core、SDK、CLI 包目录 typecheck 通过。
- 根目录 `bun run check` **未通过**：继承的
  `research/programbench/endpoint.test.ts:197` 使用 `Reflect.apply` 违反 lint。
  在未修改的 `receipt-layout` base 同样复现（同样 1 error、1,541 warnings）；没有
  为了宣称全绿而修改研究 runner 或跳过此错误。根 check 未到全仓 typecheck 阶段。

这些是本轮工程闭环的资格，所有 provider 是本地 scripted 服务，实际付费模型调用为零。
它们不证明 fixed method 的能力提升、工作 frontier 已被语义化控制，或新版全面胜过 R2。
