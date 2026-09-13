# ProContract 两次 200 题全集复核

日期：2026-09-05。状态：对既有记录的只读、回顾性复核，不是新实验或预注册分析。

## 1. 范围与证据

第一批结果目录：

`/home/duozhou/.config/superpowers/worktrees/ProgramBench/full-runner/output/luna-procontract-200-20260821-v6-combined`

P0 结果目录：

`/home/duozhou/.config/superpowers/worktrees/ProgramBench/p0-full-run/output/luna-max-policy-split-p0-200-20260902-v5`

| 文件                     | SHA-256                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| 第一批 `RESULT.md`       | `11a9713f4cd9cde9ea4995bea47b8944294cb865fd060394d10aa8b5a80262d6` |
| 第一批 `comparison.json` | `d891d4d18daa45d357aea8d73252798462a3759595b216e6e8f0131371d450ac` |
| P0 `RESULT.md`           | `f25f9d86be48ecdaf781a7e8fdda9b8acb1e5a7050dc0e554d4cb29acff2bc22` |
| P0 `comparison.json`     | `9542ccf0b121369c11bce66a14bfc9d0ec5c66b4055a1f5ff5e49065e7c61a01` |

两份 comparison 均含 200 个相同 task ID，status 均为 `invalid_protocol`。
本次只读取报告、逐题聚合和相关校验代码；没有独立重跑隐藏测试，没有验证所有归档
产物的字节，没有更改原结果、runtime 或评分规则。

## 2. 聚合口径

逐题读取 `pairs[].procontract`，以 `utility.decimal` 为行为分数，以
`pairs[].instance_valid` 为报告中的协议有效标记。缺少 utility 的实例按零进入
固定 200 题的描述性汇总，并单独报告缺失数；不把缺失伪装成观测到的行为零分。

三个固定分母汇总必须分开：

- **全部候选行为均值**：所有已记录 utility 的总和除以 200，缺失项为零。
- **invalid-as-zero 诊断**：只累计 `instance_valid=true` 的 utility，仍除以 200。
- **记录内交付条件联合诊断**：在前项基础上还要求 `package=true`、`preflight=true`、
  `contract.status=discharged`、`contract.quiet=true`，其 utility 总和仍除以 200。

后两项是本次回顾性诊断，不是官方 leaderboard 指标，不是事后替换原主指标。
第三项也不是独立证明产物已经正确交付，只是报告内状态的联合检查。不能用有效率
直接乘全部候选均值：有效性与分数可能相关。

`comparison.aggregate.mean_utility` 实际是 valid-only 均值，并非用户表中的全 200
题均值。两批有效任务组成不同，valid-only 上涨不能代替固定分母结果。

## 3. 重算结果

| 指标                        |     第一批 |         P0 |
| --------------------------- | ---------: | ---------: |
| 全部候选行为均值            | 67.494142% | 70.196313% |
| protocol-valid              |    170/200 |    150/200 |
| valid-only 均值             | 70.652625% | 77.605734% |
| invalid-as-zero 诊断        | 60.054731% | 58.204300% |
| 记录内交付条件联合诊断      | 60.054731% | 56.112575% |
| 满足联合交付条件的记录数    |        170 |        145 |
| 全部候选满分                |          3 |          3 |
| protocol-valid 且满分       |          3 |          1 |
| 全部候选 ≥95%               |          7 |         28 |
| 全部候选 ≥90%               |         29 |         54 |
| 全部候选 ≥80%               |         73 |        105 |
| 已记录的精确零分            |          2 |         14 |
| protocol-valid 且精确零分   |          0 |          0 |
| utility 缺失                |          2 |          1 |
| 最终记录所载 cost 合计/200  |  $1.252569 |  $3.257969 |
| 最终记录所载 turns 合计/200 |    218.095 |    329.120 |

全部候选均值提升 2.702170pp；与官方 Sol 69.9% 的差值按此描述性口径为约 0.30pp。
协议有效标记比例下降 10pp；invalid-as-zero 诊断下降 1.850431pp。

逐题变化：148 上升、45 下降、7 持平。有效性转移：144 个 valid→valid、26 个
valid→invalid、6 个 invalid→valid、24 个 invalid→invalid。

两批共同有效的 144 题，描述性均值为 71.189506%→77.936505%。这是支持行为改善
并非仅由少量极端赢家造成的线索，但该子集由两批运行后的有效性筛选，不能当作
无偏的因果估计或替代全 cohort。

## 4. 满分不等于有效交付

| P0 候选                            | 行为分数 | Valid | 记录状态                                                                                     |
| ---------------------------------- | -------: | ----- | -------------------------------------------------------------------------------------------- |
| `luajit__luajit.a553b3d`           |     100% | false | `missing_or_malformed_result`；completion/Contract 状态缺失；package/preflight=false         |
| `lua__lua.c6b4848`                 |     100% | false | `delivery_failed`；preflight=false；Contract=verification、quiet=false；候选与协议包身份不同 |
| `wintermute-cell__ngrrram.8ea13c3` |     100% | true  | package/preflight=true；Contract=discharged、quiet=true                                      |

对应 P0 `RESULT.md` 第 50、64、86 行。第一批三个满分均为 protocol-valid。
因此“满分仍为 3”只描述候选行为分数，符合协议标记的满分实际上是 3→1。

另有 5 个 protocol-valid 记录未满足联合交付条件：`gomplate`、`ascii-image-converter`、
`code-minimap`、`bat`、`run`。这些记录仍为 active/escalated、quiet=false，且无合格
package/preflight。valid 不能当成“已完成交付”的同义词。

`lua` 的记录没有将该候选伪称为 discharged。它体现了好候选与未完成交付可以同时
存在，不能仅凭 delivery_failed 推断 kernel 发生了错误接受。缺失结果的 `luajit`
则不足以证明认定正确或错误，需要恢复证据链。

## 5. invalid 需要分型

以下是按实例去重的标签计数，类别可重叠，不能直接相加得到失效实例总数。

| 标签                                               | 第一批 |  P0 |
| -------------------------------------------------- | -----: | --: |
| `missing_or_malformed_result`                      |      0 |  15 |
| `candidate_artifact_differs_from_protocol_package` |      0 |   6 |
| `top_error:compile_failed`                         |      0 |  12 |
| `branch_error`                                     |     22 |  21 |
| `not_run`                                          |     25 |  34 |
| `oversize_eval_json`                               |      2 |   1 |
| `unexpected_test`                                  |      5 |   1 |

P0 的 14 个明确零分全部被报告标为 invalid，两批 protocol-valid 精确零分均为 0。
“有效零分增加”若采用另一含义，需要另给定义；它不是此处 Valid 列支持的结论。

校验代码会把顶层 `error_code`、not_run、测试分支错误等纳入 invalid；故该标记
混合了多种失效。尤其 compile_failed 需要查明是候选的真实任务失败，还是构建环境／
评测故障，不能一律解释为执行者违反协议，也不能事后全部改为 valid 来修排名。

校验器当前代码的对应检查见外部 `submission-conservation/scripts/campaign_evaluate.py`：
第 169 行附近记录顶层错误；第 1107 行在候选归档与结果记录的 package_hash 不符时
记录身份差异。候选可合法保留供研究，但不能自动继承另一个交付包的认定。

## 6. 比较限制

- 第一批记录的 HF 身份为 `local-7a3e237be8104cfcd3eaa7cec1d349f0a3895bfba28bb8006fe38f844cdf47a6`，
  P0 为 `de0ddfb637590c7ecb54fa0b5301f6dc7dfbcee5`；五题 total 不同，包括一题第一批缺失。
  相同测试总数也不证明测试内容相同。配对比较前仍需对齐评测版本及验收口径。
- 第一批 runner 记录为 dirty `7ea13bcb4a08ca4bcbd668715cf252bb58a9b044`，P0 为 clean
  `8c156d4475c4eb1fc006123cbb9f45b72dccef01`。不同批次不是只改变一个因素的对照。
- 用户报告第一批 $5.47/题是实际投入；其 comparison 中最终选中记录的 cost 仅为
  $1.25/题。P0 表中 $3.26/题对应最终记录 cost。必须统一恢复、失败尝试及全部外部
  调用的账本后才能作成本归因，不能把这两个统计范围直接当成 matched-budget 比较。
- turns 更多表示更多交互轮次，不能单独证明 token、美元或墙钟效率全面更差。
- 两次都使用 ProContract，不能据其差值识别 ProContract 相对无 Contract 或强 CI
  基线的因果效果。更低 valid 比例也不能自动归因为 kernel 可靠性下降。

## 7. 对 ProContract 的判断与下一步

这些记录支持更强的候选行为覆盖，但不支持更强的端到端交付已经成立。优先解决
的是把保留下来的有价值候选转为精确、可恢复、可审计的交付，而不是事后认领其分数。

1. 保留原失败，先复核 6 个包身份差异和 15 个结果缺失；确定候选、协议包、验证及
   认定各自的精确对象，按合法恢复流程重新处理，不从隐藏测试满分反推 discharge。
2. 分开候选任务失败、评测失败、记录缺失、包身份差异和合法未完成；查根因后再冻结
   一致的分类协议，并对两批既有证据对称处理。
3. 在打包、验证、认定、结果落盘的关键交界做确定性中断与恢复检查，验证不会丢失
   已有产物，也不会用无关／缺失证据把 duty 结清。新尝试保留独立 lineage 和成本。

这不是已经验证的修复方案，也不证明当前 kernel 发生了误认定。端到端问题需要在
适配器和运行系统中闭合，不意味着把所有任务、评测与打包逻辑收入 kernel。

## 8. 2026-09-05：本体能力修复，而非只修成绩出口

用户明确要求以 ProContract 自身能力为主线，同时修复确认的 ProgramBench 错误。
以下是工作区中的新实现，不属于产生 P0 结果的 `910d9f285` runtime；尚未运行新的
付费模型实验，不能宣称修复后 benchmark 分数已经提高。

### 8.1 确认的本体限制

原来只有 `contract_report_ready` 能调用制度内的隔离 replay。它既检查候选，又申请
进入认定流程。失败的 replay 由 kernel 变成 subject-bound challenge，Contract 回到
`dormant`；下一次调度改变 attempt key、换 Session，并计入新的 semantic attempt。
这不是错误接受，但把一次可修复的构建／回归错误提升成了执行连续性的中断。

另外，原 replay 报告只保留 stdout/stderr 的 hash，交给下一次执行的失败摘要只有
命令和退出码。它足以拒绝错误候选，却不足以让执行者定位编译或回归失败。

P0 的两个直接例子是 `nuta__nsh.bdd0702` 和 `sharkdp__bat.f822bd0`：各自的
`procontract-native-result.json` 同时记录 attempt-budget escalation 和
`Replay check ./validate.sh exited 1; expected 0` 的可见 challenge。这证明该路径在
实际运行中发生过；不证明给更多诊断就一定能修好这两题，也不解释全部 invalid。

### 8.2 已实现的边界

- 新增 `contract_check`：复用同一个冻结 replay policy，对当前快照做非结算检查。
  不提交 handoff、不创建 challenge、不轮换 Session、不消耗新的 semantic attempt。
- 检查照常消耗共享 action budget，且整个检查受剩余 Contract deadline 限制。
  不为新工具开设额外预算；没有 replay policy 的会话不广告该工具。
- 失败反馈包含 cwd、exit 和有限 stdout/stderr 摘录；转义控制字符，替换可识别的
  敏感环境变量值，明确标记为 candidate-controlled、non-authoritative。
  原输出 hash 与有限报告仍绑定精确 subject；这不是通用秘密检测或部署隔离。
- 检查通过仍然不是完成。`contract_report_ready` 对自己的快照重新 replay；不能
  用旧检查的成功替换新产物的证据，principal adjudication 与原 kernel 规则不变。

这里改变的是搜索可用的动作，而不是降低认定标准：

```text
旧路径：隔离检查失败 -> challenge -> 新 attempt / 新 Session
新路径：非结算检查 -> 定位失败 -> 原 Session 修复 -> 再检查 -> 正式申请认定
```

本地测试覆盖：`maxAttempts=1` 下连续两次失败、修复后通过，仍保留同一 Session；
检查不能直接 attest；通过后修改候选再申请 handoff，会因重新 replay 失败而被拒绝。
另有 action 耗尽、输出截断／脱敏及 report identity 测试。相关 Core 测试 77 项通过，
`bun typecheck` 通过。这证明机制和边界，不是模型质量增益的实测。

### 8.3 同时确认并修复的 ProgramBench 交付错误

修复位于外部 `ProgramBench/submission-conservation` 工作树，基线 `bd8226b`。
原 `_deliver` 在 preflight 前封存 `<iid>/submission.tar.gz`，但只有 preflight 成功
才发布顶层 `submission.tar.gz`。失败后的候选保全逻辑只检查顶层文件，随后在同一
`<iid>/submission.tar.gz` 路径重打包，覆盖已经由 package receipt 引用的字节。

Lua 的对象身份已用只读输入、临时目录重打包核实：

- 从保存的 `subject` 重建出的归档 hash 精确等于原 package receipt：
  `20e18c27c69a1f976b0e0c796bca33cae2912f66bca1d8522ec51a3280b18e0b`。
- 当前诊断候选 hash 为
  `bfcf4a48208a775642010d21c519b195f837a989a04ce9e52062bae80d55480f`。
- 两份包的 81 个成员同名，文件内容全部相同；81 个成员的权限不同。
  因而这是封存／保全过程造成的包身份变化，不是 Lua 实现内容丢失。
- 原 preflight 只留下通用错误，没有保留失败命令输出。**尚不能认定权限差异就是
  原预检失败原因**，更不能根据隐藏测试满分补写 discharge。

修复后，有 package receipt 时校验并复用原封存包；没有 receipt 时，独立诊断候选
写入 `candidate-artifacts` 子树，不覆盖协议归档。损坏的封存证据保留且失败关闭。
交付错误新增有限、脱敏、绑定阶段与 artifact hash 的诊断记录。

新增真实文件回归在修复前为 4 失败、1 通过，修复后 5 项全部通过；连同 runner、
ProContract adapter、candidate 和 evaluator，439 项 Python 测试通过。没有修改
evaluator 的身份不匹配判定、valid 口径或原始结果。既有 eval 的 pytest-rerun 历史
处理属于 `bd8226b` 已有修复，不计为本次新增贡献。

15 个 `missing_or_malformed_result` 的持久检查点审查得到：13 个
`execution_failed`，2 个 `delivery_restart_failed`。其中 LuaJIT 最后留下 export，
尚未进入 preflight；旧 runner 只保存 traceback 的 hash，没有保存可恢复的异常
文本／frames，因此无法还原精确异常。当前工作树已经有 `campaign-exception.json`
的类型、阶段和 frames 留存，这是先前的修复，本次不重复实现。不能把这些记录缺失
直接说成 kernel 丢失，也不能据候选仍在就断言 kernel 完全无损。

### 8.4 还没有解决的能力问题

这次不把 50 个 invalid 归结为单一原因，也不承诺消除它们。新工具仍是可选择的
搜索动作；模型会否有效使用、是否节省轮数，以及是否改善 95% 到 100% 的行为覆盖，
都需要固定模型、验收、任务和总预算的对照。native replay 通过也不等于外部 cleanroom
preflight 或完整行为测试通过。

下一步应分开测量非结算检查与诊断信息两个因素；同时记录实际跨 Session 轮换时丢失
了哪些假设、回归证据及未决问题，再设计执行者交接。不要用更多尝试次数、自动
discharge 或隐藏评测反馈替代这些能力问题。

## 9. 2026-09-05：非结算反馈接口的真实模型筛查

后续完成两题、两组、两次重复的八条 Luna Max 真实轨迹。两组均为 4/4 独立检查
通过且获准交付；新接口平均 provider turns 从 8.00 增至 9.75，动作数从 14.00
增至 16.50，估算成本略降 2.725%。四次 `contract_check` 都直接通过，未实际测试到
失败反馈促进恢复的机制。结论是不晋升为性能冠军，不将本轮外推为 ProgramBench
全集增益。完整协议、逐对结果、无效装置试运行及限制见 `specs/pro-contract-feedback-screen.md`。
