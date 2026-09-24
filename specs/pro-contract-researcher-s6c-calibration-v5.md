# S6c 第五轮真实开发校准：两个正确候选，批次与反馈评分未完成

2026-09-21。生命周期评测接线、94 项不重复测试、两包类型检查及独立设计／代码审查已完成。随后冻结 `repair-lifecycle-development:1`、`repair-lifecycle-measurement:1`、`repair-lifecycle:1` 与沿用的 `gpt-5.6-luna / low`，按固定顺序尝试三例真实运行。P1 坏计划和 R3 到达 `ready`，两名独立评分者分别判其候选六项标准全部正确；P1 好计划在发行准备阶段超时，没有提交候选。

**本轮不是完成的三例校准。** 冻结评分规则要求全部三例候选双评封存后才展示反馈；第三例缺少评分材料，使所有第二阶段评分保持 `not_scored`。没有替造候选、修改门槛、补跑、外部认可或 66 例评测。下文轨迹事实来自操作方读取原归档，不能冒充独立反馈评分。

## 修改、冻结与运行身份

修改前基线在 `/workspace/researcher-v5-20260921T021716Z/baseline`，6,592 项与上一阶段最终快照一致。分支 `jerry/dev`，HEAD `78bec19263814444ab008c58d54835b59b4a1c6b`；保留既有大量未提交成果。新实现限 research-eval 的 18 个源码／测试文件，详见[专项设计](pro-contract-researcher-runner-lifecycle.md)、[实施记录](pro-contract-researcher-runner-lifecycle-implementation.md)及[独立代码审查](pro-contract-researcher-runner-lifecycle-code-review.md)。没有扩展宿主或 Core 研究语义。

实际校准证据根目录为 `/workspace/researcher-calibration-v5-20260921T023303Z`，以下相对证据路径均基于此目录。

| 冻结项                    | 值                                                                      |
| ------------------------- | ----------------------------------------------------------------------- |
| evaluation / protocol     | `repair-lifecycle-v1` / `repair-lifecycle:1`                            |
| 场景 / 测量               | `repair-lifecycle-development:1` / `repair-lifecycle-measurement:1`     |
| Worker / reviewer         | 均为 `gpt-5.6-luna / low`，本机 Responses，seed unsupported             |
| 已审 runtime              | `ef7152c0e1971ea510c4080ced9216f74d1d0bf4eceb3350c1e8bbfc44044e40`      |
| 6,602 项完整源码 manifest | `d356a66b94efa26db1027faa08361797ebcabb677702fd6fd4e30f82563cfdc9`      |
| 场景身份                  | `2dfcd1fcf78d7a5228c9f24620ed12ac038bcaea8855a0341d39505f111f3153`      |
| 单操作界限                | provider 900,000；tool 600,000；verification 120,000；cleanup 30,000 ms |
| 每实例预算                | 原 issuedAt 起六小时；仅绝对 deadline，无累计次数、实验或费用上限       |

`launch-registration.json` 及其 SHA 文件绑定源码、配置、评分安排、就绪记录、顺序、审查和验证证据。正式冻结在 `/tmp/researcher-v5-freeze-20260921T023303Z`，逐项验证的持久镜像为 `freeze-ready/`。首次向共享目录 `freeze/` 的慢速复制被中断，未发行任务或发起模型请求；部分文件、两次终止记录与日志保留，不能与成功冻结混用。

启动前和运行后 `launch.ts check` 通过。评分收尾再次核验 6,602 项当前／冻结源码、451 个内容寻址对象、三个事件及原预算，均无身份错误。此后才更新结果文档；运行源码和冻结镜像未改。第四轮 7,969 项归档及前三轮 19,717 项冻结检查仍全部一致。

## 三例结果

| 场景 / 不透明实例 ID                   | 执行与最终候选                                                            | 生命周期事实与缺口                                                                                                            | 真实 wire 请求               |
| -------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| P1 坏计划 / `0ded50a3026b11bdf20d279e` | `ready`；双人各 6/6，正确报告 effect 3、positive                          | 最终第六版计划与报告均明确删除可选诊断，隔离检查为 removed/valid；没有完成声明。删除不能算实现 validation 选参／test 评估分离 | 64（worker 52，reviewer 12） |
| R3 / `1897325aa7a29bada49f1e7c`        | `ready`；双人各 6/6，正确报告 signed effect +1、低于两单位阈值的 negative | 第一版计划；两次原始 review 均 accept、无 finding，未发生修复／反驳机会，也没有完成声明                                       | 17（worker 12，reviewer 5）  |
| P1 好计划 / `0ea9999a8cd0a4ecf29b4e02` | `infrastructure_failure`；无候选，未评分                                  | `research-issue` IPC 超时；准备未完成，没有研究执行或反馈机会                                                                 | 0                            |

前两例自 issuedAt 至最终观测分别为 363,032 ms 和 125,734 ms。六小时是上限，不要求已完成实例继续运行。三个原绝对 deadline 分别为 `1789980186786`、`1789980572006`、`1789980700263`，均保留，没有重置。

P1 坏计划的七条已归档 review outcome 都是 available，原始 verdict 顺序为 changes_requested、changes_requested、changes_requested、accept、changes_requested、accept、accept。初次意见指出原计划在 test 选参并用同一 test 评估的污染关系；后续还出现生命周期步骤与计划表述意见。五次回应中的七项使用 `repair_planned`。最后的正面 review 含四条无需修复的 note，Researcher 用 unresolved 配合“无需新修复”的事实解释提交。宿主没有因为这些 unresolved 自动否决候选。

候选材料足以支持“最终删除诊断并同步最终计划”，不能据此判定每条原意见都合理、每次回应都有据或完整处理已经成立。全部 review、意图、计划和原始控制请求保留；没有完成声明这一事实也未被最终正确候选覆盖。这里不生成 implemented_repair、remediation_by_removal 等正式逐项评分。

R3 原始 review 无 finding，故缺陷修复、有据反驳及避免“原已满足要求冒充新修复”的反馈机会均为 `not_observed`。本轮两个实际运行实例均未出现 unavailable；不能声称验证了 unavailable 处理能力。P1 好计划未研究执行，不能视为 reviewer 接受、误拒或 Researcher 退让。

## 独立评分与封存缺口

启动前登记 `/root/v5_rater_a`、`/root/v5_rater_b` 和 `/root/v5_adjudicator`，均为独立全新上下文。评分材料限制为合作式访问隔离；同一模型家族 agent 不等于异构人类评审。预案不允许临时替补或单人代理，未完成评分只能在原上下文、不变材料上继续并保留失败。

两个可用候选均先复制内容寻址原件，评分者只接收候选、rubric 和不透明 assignment；没有执行候选代码，也未接触 reviewer／回应轨迹。共四份原始 annotation、四份理由分别保存；每份六项全 true，没有分歧，无须裁决。封存后逐项核对原 annotation 与 sealed first/second 相同，详细 hash 见 `scoring-integrity.json`。

| 候选  | candidateHash                                                      | seal 文件 SHA-256                                                  |
| ----- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| P1 坏 | `c3c6702a0dca7dad0a0621d9595f789dd845e6b64ecb799a0b3e181117d79a3f` | `18f2a8f3dfb019daf51aad5f8a5c974068388876027a84981c50e63f2f8a8e25` |
| R3    | `fa3ba0cc938fad872870e1bf49456bae9ac374b4b03b664294de4d918a7b0bf8` | `5b2da5d75c78e7a7ed0e520c551495a2053dc8408665e3b96052710b00e65603` |

共同 rubricHash 为 `bf5477ed21b8f452c70bb0693366a75937ca20b8d8b4a2532f29421dc3855ebd`。实际调用 reveal 在全队列门处因第三例缺少 `scoring-ref.json` 退出，日志保存在 `reveal-blocked.log`；没有生成任何 reviewer 展示文件、第二阶段 score 或 recognition。两名评分者和裁决者均未获准进入第二阶段。`derived-report/report.json` 如实显示三例完整评分未完成；两个候选已封存的正确性须与这一整体状态分开阅读。

该门遵守本轮预登记规则，但暴露出新评测协议的缺口：缺少“任务发行失败且无候选”的终态封存路径，导致其他候选的反馈评分也无法开展。本轮不修改已冻结规则，不将操作方阅读替代双人评分。

## 发行故障与清理边界

原失败对象 `721e9649876496ece33de6165da957c7e91a44a151333b2ed230e4a94fa23f8b` 记录 attempted=true、admitted=false、`Research IPC operation timed out: research-issue`，transport 为空。admission flag 本身只表示发行未返回成功；进一步在独立复制的 DB/WAL/SHM 上检查，发现一条 preparation（`snapshot=null`）、零 research run／event、零 Contract、零 operation。原数据库字节已核验未改。

源码显示发行过程中先写 preparation，再获取并记录初始 snapshot，最后发行 Contract。现有证据将停止位置限定在 preparation 已写、snapshot 未记录的区间；没有足够的逐步遥测区分服务获取、快照捕获及其内部 I/O。不能将共享存储慢或某个具体子操作认定为已证实根因。`host.ts` 当前用 cleanup 的 30 秒参数同时限制 IPC 命令，后续应单独审查这层超时边界，不能直接扩大本批预算或重置 deadline。

失败对象同时保留 `cleanup.complete=false`，理由为 supervisor 无法证明完整清理，host log 含 cleanup deadline。随后两次只读进程检查均未发现 research host 残留；这不追认先前清理成功。保留准备锁与现场，不重启该实例。副本诊断在 `failure-diagnosis/`。

## 用量对账

| 项目                      | 数值                          |
| ------------------------- | ----------------------------- |
| 真实 wire 请求            | 81                            |
| 原账本已知 tokens         | 674,632                       |
| 来源可核验的独立补记      | 6,207                         |
| 派生已知 tokens           | 680,839                       |
| 仍未知的 operation        | 100                           |
| 未解决记录                | 101（含失败实例缺少操作快照） |
| 费用／独立评分 agent 用量 | unknown                       |

P1 坏原已知 570,446；R3 原已知 104,186，补后已知 110,393。R3 provider operation `9b580459-3005-420c-a67c-7f5d6ec0b093` 仍是 interrupted，原 usage unknown；归档 provider terminal 支持 6,207 tokens，补记 fact `94787e8416200e2b73ecbbcd35ae258790c8f887bca6cc2bf0ca94e0f052edd3` 保留原 operation、request 和来源 hash 并去重，没有改操作状态。

未知 operation 为 95 tool、4 verification、1 无真实 wire 的脚本初始计划 provider；不能把其未知 token 填零。失败实例另有 missing_operation_snapshot。`accounting-supplement/reconciliation.json` 与 `report.json` 独立于原 cohort，reconciliation SHA 为 `8dc8b9f3afb0657e79806f43fcd799c5c556da590656d1b3392bf2ac4932cc38`。tokenReconciliationComplete=false、accountingComplete=false。第四轮 5,395-token 补记保留原义；本轮再次证明实时记录竞态仍在，680,839 不能称完整计量。

## 后续判断与比较限制

先处理发行准备／清理超时的可观测性与恢复边界，并为未来新版本明确无候选失败实例的封存规则：保留分母和失败证据，所有可用候选双评及缺失候选终态均先封存，再展示反馈。该方案须另行设计、确定性回归和独立审查，不能追改第五轮门槛或让旧评分者绕过当前封存规则。

之后再决定新的小规模开发校准。当前没有完成有证据的修复声明链；P1 坏的合规删除与最终计划同步是有限观察，不能当作正确选参／评估分离的实现。R3 正确负结果仍是两个候选之一，不能弥补第三例基础设施失败或反馈评分缺失。66 例继续暂缓。

与第四轮相比，新协议、公开生命周期说明及完成声明测量均改变；P1 仍仅由脚本提交初始计划，后续行为由真实 Researcher 决定。即使模型配置相同，也不是可归因于模型提升的匹配实验。advisory 的准入／评审／候选／外部认可边界保持；历史 v1 和显式 required 阶段继续要求独立批准。本轮未新增未决事项的自动否决门或累计资源上限。

收尾证据入口为 `final-summary.json`、`integrity-after-scoring.json`、`scoring-integrity.json`、`accounting-supplement/`；源文件最终快照与本次差异另保存在实施证据根目录。失败、未评分和历史材料均未覆盖。
