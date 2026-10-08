# Essential RSI：保留了责任边界，却削弱了工作的控制状态

2026-10-08。本文是 operator-only 的诊断与修订说明，不是更好 policy 的实证。
发布给 solver 的 worker release 必须使用 `pro-contract-freeze.ts --worker`，排除
本次 `specs/`、`research/`、SDK 测试和资格脚本。历史 cohort、分数和冻结方法不变。

## 判断

上一版实现不能被称为 R2 的保真极简化：它保留了授权、fencing、独立验收和后继选择，
但将求解过程简化为概括 seed，并把实验状态的保留交给模型自觉写文件。
**更小的责任内核不等于完整的工作方法。** 这不是需要复制 R2 的调度器，而是要识别
不能删掉的闭环语义：观察什么、什么仍未解决、下一步如何区分解释、何时有依据结束。

最重要的差别可以写成：

```text
R2 的可读方法：
公开行为面 → 可回读的观察 → 未解释差异/假设 → 下一项判别或修复
  → 原调用与影响面回归 → 更新未决状态 → 有依据地提交

上一版 Essential 的实际能力：
任务 + 概括方法 → 原生工具 → 模型自行保存证据/写摘要 → submit/checkpoint
  → 宿主验收
```

后者确实可以完成任务，但保存了责任，并不代表保存了完成责任所需的实验状态。

## 负结果不是一个异常点

同题 Luna/max 的六题开发均值，历史 R2 为 77.5658%，新版两次均值为 71.5816%，
差 −5.9842 pp。两次分别落后 4.6753 和 7.2932 pp；去掉最大缺口 xh 后仍落后
4.2605 pp。只看 reference 校准满分的开发子集，也仍落后 3.6619 pp。

未知的 tig 第二次不得补分。但即使仅为上界分析假定它是 100%，新版九题均值也最多
79.0488%，低于历史 R2 的 82.3307%。缺失项不能翻转这九题的描述性方向。

历史 R2 是经过研究选择后的单次观测，新版是两次重复；runtime、评分供应与时间不同。
所以负结果足以推动修正，却不能把 −5.9842 pp 当作某个机制的独立因果效应。
精确复算与边界见 [测量审计](essential-rsi-measurement-audit.md)。

## 三个断点

### 1. 观察没有持续成为未决工作

公开轨迹中，xh 的探测已经显示错误参数输出不一致，相关差异仍存在于最终源码，
却没有进入其很小的最终回归，随后出现 `validate: ok` 和提交。eva 也确实能将一个
540-case 矩阵从 177 个 mismatch 修到零，但另一组已观察到的 24 个 mismatch 没有
完整进入持久回归。

因此不能说模型完全不会探测；缺的是从观察到下一步行动、到停止判断的持续联系。
18 次求解只用了约 25.6–55.5 分钟，不是六小时预算耗尽。
解决方案也不是强迫耗满时间，而是不让仍有价值的已知差异因局部绿灯而消失。

### 2. 责任续行，证据却未对继任者续行

eva 的一次 checkpoint 后，workspace 只有文档，后继只拿到 612 字符摘要；之前的
探测脚本与数据位于 `/tmp`，后继重新探测已看过的行为。旧 Session 数据库仍在宿主上，
但执行者不能回读，不等于有可用的证据连续性。

甚至不发生 checkpoint 时，上游 shell 也只保留 25 个已退出命令的完整输出。
本轮九个已展示的“full output saved to”路径，在结束后相应文件全部不再存在。
不能等交接之后才扫描文件补救，也不能把摘要称为完整观察列表。

这些是实测能力缺失，但仅三次 checkpoint，不能把全部得分落差都归因于跨段失忆。
具体公开事件与 SHA 见 [轨迹审计](essential-rsi-public-trace-audit.md)。

### 3. 可选 propose 不等于主动研究

R2 的历史链有明确的方法生成任务与 R1→R2 后继执行。本轮新版只是允许普通求解者
顺便调用 propose，正式提案、比较、采纳均为零。

这证明本轮没有发生方法研究，**不直接解释求解回退**：R2 执行的是已经研究得到的方法，
新版执行的是概括 seed。求解方法质量与是否发生研究，应分开检验。

## 这次实施什么

### 公共观测连续性：实际机制修复

SDK adapter 新增窄的观测保留边界，不改 Kernel、公共 Contract Schema/Protocol 或
上游 Session 的模型执行循环：

- 每次工具返回时保留真实 native result；shell 完整捕获在下一条串行工具开始前保存，
  不再依赖上游的 25-file 缓存。
- 数据经已有 native PID/birth 绑定通道传给宿主。宿主决定路径与 execution/deadline，
  使用内容 hash 保存，只读挂到 `/admission/observations`。
- 保留 requested/executed input、调用身份和可用结果。`native-result` 是显示处理前的
  值；`model-visible` 是交接前从原生 durable log 导出的终态工具事件，不能称实时同步。
- shell 字节是 **combined stdout/stderr**，不伪称分离流。非零正常退出不等于成功；
  timeout、signal、未知退出、截断明确标为 incomplete。无法获得的 capture 明确 unavailable。
- 原任务只继承自己的记录；每个 baseline/candidate/test/repeat allocation 独立，
  不把确认执行的证据挂给 proposer。不把日志塞进交付 workspace。
- 原 deadline、取消、权限和磁盘保护保持。64 MiB/30 秒是单次保留操作的基础设施界限，
  不是累计工作次数或金额预算。
- 修正 handoff 的字段说明：continuation notes 放 summary，instructions 只表示完整
  replacement method，减少已经观察到的误用。

保留的字节仍是**非权威公共观察**，不能替代独立验收。此修复也不自动备份所有 `/tmp`
文件、不证明观察的语义、不能保证模型一定使用证据。

### 求解方法：独立可选的未测候选

新增 `ProContractRSI.investigationMethod`，明确未决观察、区分性实验、共同原因修复、
影响面回归与停止判断。没有题目答案、强制报告格式、最低时长或新调用次数预算。
原 `initialMethod` 保留不变，旧 profile 不被悄悄改写。

这是本次工程修订提供的**未测候选**，不是已经由 RSI 学得或正式晋升的方法。

### 显式研究任务：入口，而非宣称已完成的自动闭环

新增 `ProContractRSI.researchGoal`，把候选生成或有理由的 no-change 明确为普通任务，
绑定精确 parent 和获准公共经验。它不自行产生权限或启动实验。
产物资格、research-parent 选择、性能晋升和真实后继执行继续分开。

**这只是普通研究任务的 goal/API 示例，不是自动的研究→比较→部署驱动器。**
现有 propose→配对验证→选择→后继链仍可运行，确定性资格验证会检查它未被本次改动破坏。
不把一个 goal helper 冒充主动 RSI 已经解决。

## 验收与下一步

确定性原生测试必须证明：大输出首部的反例字节，经 26 条无关 shell 淘汰旧文件，再用
不复述反例的 checkpoint 摘要进入新 Session 后，仍能精确回读；还要覆盖只读权限、
子 PID 拒写、二进制/Unicode、timeout/signal、evaluation 隔离、原 deadline 和取消。
真实只读任务 rootfs 也要通过，不能只在空 sandbox 中通过。

接下来应单独冻结同期实验：同一新 runtime/scorer，一边用原 seed，一边用
`investigationMethod`，两边关闭正式 proposals、保留 checkpoint，使用相同固定 repeats。
这识别 solver 方法的增量，不将历史 R2 当作同期控制。观测归档本身的效果若要归因，
应再做独立干预，不能一次改三层后声称知道原因。

只有方法稳定后，再执行显式研究任务并验证其候选。真正的递归主张仍需要后继真的运行，
并再生成下一版；生成文件、测试机制与真实模型性能提升不能互相替代。
本次没有启动新的付费模型或官方 benchmark 评分。

## 已执行的验收

证据目录：`/home/duozhou/run-artifacts/evidence-learning-qualification-20261008/`。
最终测试使用新的 `runtime-v2/`；初次资格与已冻结旧 release 均保留，没有原地修订。

| 验收 | 实际结果 |
|---|---|
| `observations-v2` | 34 个 scripted 请求，120,077 字节；26 次 shell 淘汰旧文件后仍精确恢复；summary 不包含反例；timeout/SIGKILL/read error 不伪称完整 |
| `isolation-v2` | 20 请求、10 Session、5 个 lineage；原任务与各 evaluation side/test/repeat 隔离，private verifier token 不进入归档 |
| `readonly-rootfs-v2` | 相同 34 请求反例在真实只读 sd rootfs 通过；仅用自建 mechanics verifier，没有运行官方评分或参考程序 |
| `succession-v2` | 86 请求、43 个 native execution、两次选择 0→1→2、最后独立 discharge；evaluation checkpoint 继续正确 |
| `rejected-v2` | 44 请求，confirmation 回退时拒绝候选、保留 incumbent，原任务继续完成 |
| `faults-v2` | 取消、原 deadline 到期、授权撤回均 fenced；无 staging 残留；不重置 deadline |
| Core 责任/选择/constitution | 13 pass、0 fail |
| SDK 相关单元与边界测试 | 26 pass、0 fail |
| 三个实际 native integration 包装测试 | 3 pass、0 fail，非跳过 |
| `bun run check` | exit 0，36 个 package typecheck 成功，保留上游已有 lint warnings |

完整 SDK suite 仍不是全绿：**58 pass、3 个可选 integration skip、4 fail**。
这些 integration 随后单独启用已全部通过；四个失败仍是原 upstream 已复现的 ambient-Fetch
两例、Promise event cancellation 和 embedded web-search provider，未将其记为通过。
本次日志位于 `/home/duozhou/run-artifacts/essential-evidence-learning-20261008/`。

这些结果证明具体的证据丢失反例已修复，且没有破坏已测的选择/拒绝/后继和故障边界。
**它们不证明 Luna 已会使用归档，也不证明新方法追回了 5.98 pp。**
