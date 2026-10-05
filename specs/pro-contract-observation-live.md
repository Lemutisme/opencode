# ProContract ObservationPack：ProgramBench 实跑

2026-09-11。**六条真实模型轨迹与独立评分已完成。** 实验结束时因成本门槛失败而保留为可选机制。

后续用户明确选择行为表现优先，并授权[晋升为 ProContract 默认策略](pro-contract-observation-promotion.md)。
普通 Session 保持显式启用，宿主可用 OPENCODE_OBSERVATION_PACK=0 回退。
下面保留实验当时的配置、门槛与结果；该授权不改变实验的证据边界。

三题平均分由 66.80% 到 67.54%，记录成本由 $10.08 到 $14.68，成本门槛未通过。两条 bartib 经历了共享磁盘中断与恢复，整体数据不能当成无中断 A/B 的因果效果。

本次承接[固定轨迹研究](pro-contract-observation-pack-study.md)，接入并实测原生观测压缩与精确回读。没有同时引入 Action Fusion、模型摘要器或主动 compaction，也没有安装 Pi 插件。

## 已落地的实现

实验时宿主通过 OPENCODE_OBSERVATION_PACK=1 启用，默认关闭。
晋升后默认在 ProContract Session 启用，1 仍可扩展到普通 Session，0 可关闭。
设置在宿主服务图初始化时读取；候选工作区的配置文件不能改变已经启动的宿主设置。

- packages/core/src/tool/builtins.ts 接入条件注册节点。
- packages/core/src/tool/observation.ts 提供宿主配置层与 session_read_observation。
- packages/core/src/session/observation-pack.ts 保持原始历史、输入和结构化状态，只改变模型视图。
- packages/core/src/session/runner/llm.ts 仅在有效工具目录含回读工具时应用投影。

原有 10 KiB 阈值、两个后续完成消息的窗口、诊断否决、SHA-256 校验与字节分页规则不变。错误、超时、截断、媒体、Contract 与 reference 回执不参与压缩。回读消耗既有 action 预算；没有新增结算权力或自动 attestation。

## 冻结条件

| 项目 | 两组共同条件 |
|---|---|
| 实例 | nikolassv__bartib.6b9b5ce、hush-shell__hush.560c33a、abishekvashok__cmatrix.5c082c6 |
| 模型请求 | openai/gpt-5.6-sol，reasoning xhigh，同一冻结模型目录 |
| 执行策略 | behavioral |
| 原生预算 | 每题 1,000 turns、1,000,000-action 离线哨兵、六小时原始截止时间 |
| 成本保护 | 每组三题累计 $20 的 usage 熔断阈值，没有因恢复重置 |
| 并发 | 每组一个 worker，两组并行；seed 42 固定选题顺序，不固定模型采样 |
| 参考与评分 | 相同隔离 reference 接口、冻结镜像与测试 blob、wheelhouse、独立评测器 |

两份二进制来自同一冻结源码，仅把开关分别编译为 0 与 1，版本字符串相同。共同基座为已验证的 offline/reference runtime，基于 97d61022abdc33397ee97447c7bbc6f571574e1e 及其冻结修复。实验冻结时，压缩和回读模块与当时的主工作树逐字节相同，见 production-module-identity.json。这不是对主工作树全部既有未提交改动的组合评测。

| 二进制 | SHA-256 |
|---|---|
| baseline | 5dde4afbae97541614ebbad00533707e46ae2faf368fcf24dff4d6030b5ae9c8 |
| enhanced | 2266707acb49a9dbd3279bed38e2c85f676e1e598270816e7601c2c245514526 |

实际模型请求已核验：两组都有 reference，只有增强组有 session_read_observation。网关仅增加统计元数据，不改写请求或保存 provider 凭据。隐藏评测失败没有反馈给这些候选，没有替换任何不利轨迹。

## 完整结果

**六项评测均有效，六条合约均原生 discharged。**

| 任务 | 基线通过数 | 增强通过数 | 基线分数 | 增强分数 | 基线记录成本 | 增强记录成本 |
|---|---:|---:|---:|---:|---:|---:|
| bartib† | 652/721 | 678/721 | 90.43% | 94.04% | $2.854 | $8.291 |
| hush | 122/1201 | 103/1201 | 10.16% | 8.58% | $3.947 | $3.589 |
| cmatrix | 505/506 | 506/506 | 99.80% | 100.00% | $3.279 | $2.801 |
| 宏平均／成本合计 | | | **66.80%** | **67.54%** | **$10.080** | **$14.680** |

† 两条 bartib 均受容量保护中断，随后按原 Contract 恢复。

| 指标 | 基线 | 增强 |
|---|---:|---:|
| Provider turns | 248 | 297 |
| 已计入预算的 actions | 685 | 620 |
| 携带压缩观测的请求 | 0 | 45 |
| 模型发出的回读调用 | 0 | 0 |
| 从首次控制器启动到评分结束，含暂停 | 79.90 分钟 | 87.14 分钟 |

平均分差为 +0.74 个百分点，记录成本增加 45.64%，轮数增加 19.76%。动作数下降不代表费用下降。

费用来自冻结模型目录与原生 usage 记录，不是账单。基线 bartib 的网关保留一条未完成记账的请求，增强 bartib 有两条 transport_failed。这些记录没有删除，成本合计不能声称为完整实际账单或无中断效率效果。

冻结的开发门槛为：全部有效且交付完成、均值不降低、单题回退不超过 2 个百分点、累计记录成本至少降低 5%。前三类数值条件成立，**成本条件失败**。此外，本轮仅三个已检查的开发任务，每格一次轨迹，并发生基础设施中断。当时不自动晋升；后续晋升依据用户对行为表现和成本的取舍，实验本身仍不足以证明总体性能提升。

## 机制事实

**cmatrix 是唯一实际触发 packing 的实例。** 增强组 55 次请求中有 45 次携带一个压缩入口，没有模型回读调用。证明了投影在实际请求中生效，没有证明模型主动回读能改善决策；回读身份、哈希、分页和预算行为由原生工具测试验证。

cmatrix 的累计输入 JSON 从 27,880,103 到 14,988,555 字节，记录成本下降 14.58%，通过数由 505 到 506。但未缓存输入 tokens 从 119,719 增至 124,155，输出 tokens 从 41,629 增至 49,141。首次压缩时观察到了缓存重建，不能只用字符数预测费用。基线还有一次模型自行设置的 600 秒 Bash 测试超时，耗时差不能全部归因于 packing。

**hush 与 bartib 都没有触发 packing。** 两组工具目录分别为 10,413 与 11,521 JSON 字节，增强版承担每次请求额外 1,108 字节的目录开销。质量与费用变化不能归因于省略旧长输出；工具目录变化、采样和 bartib 的恢复均可能影响行为。

**hush 暴露了独立语义验证的重要性。** 两组访问了 reference、完成原生 replay 并获得 discharge，独立通过率却只有 10.16% 与 8.58%。这不否定当时有限的交付 claim，却限制了其含义。展示压缩不能替代有效输入、正确执行的探测与足够的语义覆盖。本轮未进一步鉴定具体解析器缺陷，不把低分解释成未经核查的某个实现错误。

## 中断与恢复

初始控制器于 16:16:33 UTC 启动。17:03 左右，共享磁盘跌破冻结的 5 GiB 停止线，控制器停止本轮进程和工作区，保留前四条交付及两条未完成 bartib。

准备和恢复阶段释放可重新下载的工具缓存；展开的 Rust registry 内容保留在压缩包或逐字节校验的压缩备份中；另清理非活动的 Rust 增量编译缓存，将余量恢复到约 19 GiB。源码、最终二进制、历史实验候选和冻结评测数据均保留，操作有记录。

第一次恢复的严格检查发现 Session ID 被轮换，随即停止。源码核查表明，ProContractOpenCode.claim 的既有租约过期策略会轮换已使用的 Session，同时保留 Contract、累计预算与 semantic attempt。因此不能描述为同一 Session 原样继续。该检查和停止的额外恢复代价也保留。

随后通过适配器原有恢复路径继续，持续核对 Contract ID、revision、specHash、deadline 和预算上限不变，turns/actions 不减少，旧 Session 仍映射到原 Contract，semantic attempt 始终为 1。两条 bartib 最终各有三个 Session，均在原始截止时间内完成。

| bartib | 首次中断后的 durable 计数 | 最终计数 | 状态 |
|---|---|---|---|
| baseline | 23 turns / 127 actions / 1 attempt | 89 / 371 / 1 | discharged |
| enhanced | 52 turns / 85 actions / 1 attempt | 152 / 278 / 1 | discharged |

这验证了这些实例中的合约身份和预算连续性，没有验证对话记忆原样延续。保留旧会话不等于新执行者自动获得全部旧观测；当前回读工具限定当前 Session，也不能描述成跨 Session 的 Contract 观测继承。

恢复后的 HTTP 导出计数口径存在差异：baseline 为 91 行、声明 67；enhanced 为 152 行、声明 100。分析没有依赖单个计数字段认定完整性，而是沿数据库 pro_contract_opencode_session 读取完整会话链。最终保存六份历史、十个 Session、553 条消息；增强 bartib 的数据库链有 154 行。原始 HTTP 文件保持不变。

## 对继续增强 ProContract 的约束

mini-swe-agent 的简短循环与 SoL-Pi 的效率机制，应服务于可观察的任务收益。本轮支持保留精确回读和宿主开关，并记录实际触发、缓存代价和完整结果；不支持把展示压缩直接作为更强的完成证据。

后续应优先验证：有效正向探测如何进入持久化回归；合法 Session 轮换后如何恢复有来源的观测与未决问题。工具目录按需暴露、压缩经济门控也值得单独测试，但新增工具会改变缓存前缀，不能预设一定更便宜。这些是后续候选设计，本轮没有宣称已经实现或有效。

## 验证与复现

- 主工作树接线相关 Core 测试：106 通过。
- 冻结 runtime 的观测、reference、传输测试：19 通过。
- ProgramBench：391 项先通过；真实计算器评测 smoke 初次缺少 wheelhouse 环境变量，补齐正式离线配置后该项通过。失败日志保留。
- 主工作树 Core、OpenCode 与 benchmark Core 的包内 bun typecheck 通过。
- 六项独立评测有效，两个控制器最终退出码均为 0，最终源码冻结核验通过。

没有修改 public Protocol 或 Server HttpApi，本轮无需再生成 Client/SDK。

材料位于 /home/duozhou/run-artifacts/procontract-observation-live-20260911-v1/：

    PLAN.md / FROZEN.json / runtime-source.tar.gz   推理前条件和完整源码
    baseline-opencode.build.json                  基线构建记录
    enhanced-opencode.build.json                  增强构建记录
    QUALIFICATION.json                            实际模型目录检查
    interruption/ / recovery-audit-1/              中断和首次恢复检查
    CONTRACT-RECOVERY*.json                        恢复与预算连续性
    HISTORY-MANIFEST.json / durable-histories/     完整会话链与哈希
    ANALYSIS.json                                 最终数据、门槛与限制
    REPORT.md / FINAL.md                          简表与完整解释

独立工作树为 /home/duozhou/opencode-observation-bench 和 /home/duozhou/ProgramBench-observation-bench。主工作树原有的其他未提交工作保留。以下命令只重算分析和核验，不启动模型：

    python3 /home/duozhou/run-artifacts/procontract-observation-live-20260911-v1/analyze.py
    /home/duozhou/ProgramBench-observation-bench/.venv/bin/python /home/duozhou/run-artifacts/procontract-observation-live-20260911-v1/study.py verify

不要将运行控制器当成重算分析命令。新模型实验应使用新的输出目录、冻结条件与预算。
