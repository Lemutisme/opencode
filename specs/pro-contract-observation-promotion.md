# ProContract ObservationPack 晋升决定

2026-09-11。用户明确提出：“我觉得可以被晋升。性能是我们重点关注的。”

据此将 ObservationPack 晋升为 ProContract Session 的默认执行策略，优先考虑行为表现与完成质量。
费用和轮数继续记录为权衡指标，既有硬预算保持约束；本次选择不再由“成本必须下降 5%”否决。

## 选择依据

已有三题实跑中，宏平均行为分数从 66.80% 到 67.54%；bartib 从 652/721 到 678/721，
cmatrix 从 505/506 到 506/506，hush 从 122/1201 到 103/1201。
六项评测均有效、六条合约均交付完成，最大单题下降为 hush 的 1.58 个百分点。

记录成本从 $10.08 到 $14.68，增加 45.64%；两条 bartib 经历了中断和 Session 轮换。
只有 cmatrix 实际触发压缩，没有模型回读调用。这些限制继续保留。
晋升是用户在现有证据下作出的优先级选择，不构成新的因果或泛化证明。

原实验的 PLAN.md、FROZEN.json、ANALYSIS.json、构建二进制和原始结果均保持不变。
其成本门槛仍记为失败，本次另行记录用户授权的晋升。

## 生效范围与回退

| 宿主环境变量 | ProContract Session | 普通 Session |
|---|---|---|
| 未设置 | 默认启用 | 不启用 |
| OPENCODE_OBSERVATION_PACK=0 | 关闭 | 关闭 |
| OPENCODE_OBSERVATION_PACK=1 | 启用 | 启用 |

其他显式值按关闭处理。宿主服务图初始化时捕获一次选择，工具注册与 runner 共享这一选择。
普通 Session 的模型上下文保持原有默认行为。重建并重启使用该源码的宿主后生效。
历史实验二进制不覆盖；没有为这次默认值调整重新消耗模型预算。

压缩算法、10 KiB 阈值、首次反馈保留窗口、诊断否决、精确回读、权限和共享预算规则均不改变。
Contract 的 claim、revision、attestation、交付资格和硬预算也不改变。
成本优先级的调整不代表可以自动扩充任何合约预算。

## 验证与后续判断

原生 runner 测试覆盖 ProContract 默认启用、普通 Session 默认不启用、显式回退、
普通 Session 显式开启及无效设置。检查实际模型目录与请求，确认首次两次反馈完整、
持久化历史不变，以及原有 turns/actions/attempt 计数不变。

本次相关测试共 159 项通过，Core 与 OpenCode 的包内 bun typecheck 均通过。

后续以独立行为质量、完整交付和单题回归判断迭代，持续记录费用、轮数、
缓存与恢复开销；不以局部字符压缩量代替这些结果。
hush 的低兼容性和合法 Session 轮换后的观测续接仍是待解决的问题。

验证日志、源码哈希和本次授权记录保存在：

    /home/duozhou/run-artifacts/procontract-observation-promotion-20260911-v1/

实验详情见[完整 ProgramBench 报告](pro-contract-observation-live.md)。
