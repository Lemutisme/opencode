# ProgramBench 后续实验预算要求

用户于 2026-09-13 指示：“最好以后也不要设置1000 turn的限制，只有6小时的限制”。

状态：2026-09-14 已在独立 `deadline-only` 工作树移植并验证预算支持；不修改历史冻结实验。

## 本次实现

OpenCode 基于 `7a1142404`（其运行时修改文件与 Luna/Terra 冻结修复版本相同），只移植可选 turns/actions、计量预约、Session step/settlement window 和期限中止相关改动，并修复 Node/DOM 字节流类型桥接。没有引入质量门槛、差分工具、参考工具增强或新的搜索 policy。

配套 runner 为 `/home/duozhou/ProgramBench-deadline-only`，基于同样已核对的 `985ad9e`。YAML 中 `provider_turns: null`、`procontract_actions: null` 明确表示无累计上限，Contract payload 省略这两个字段。可信网关绑定原始 issue 的绝对 deadline，重启不得重新获得期限。旧有限预算继续受限。

已完成 Schema、Core、runner 机制测试，包括 3001 次网关请求、3001 条消息计量与重载、跨旧 turn/action 边界、到期拒绝与在途请求中止。客户端和 legacy SDK 由生成脚本更新。构建、小样本与启动证据在 `/home/duozhou/run-artifacts/programbench-sol-xhigh-6h-20260914`。

这不是所有历史故障均已修复的声明：大验证 JSON、评测结果尺寸和测试未运行等问题仍可能发生。没有改写既有统计口径或历史失败。

## 默认条件

- 每题累计墙钟上限 21,600 秒；恢复、重试与 Session 切换不得重置原 deadline。
- 不设累计 provider-turn 上限，也不以 action 数、wire request 数或成本上限替代。
- 继续记录所有 turns、actions、请求、tokens、费用及缺失 usage；取消限额不是取消计量。
- 可以在满足任务要求后提前完成，不强制用满六小时。
- 保留单次操作超时、断网与凭据隔离、故障熔断、磁盘保护及用户中止。它们是运行安全机制，不是固定轮数预算。
- 用户后续明确要求不同预算时，以该次明确要求为准。

## 当前冻结实验不变

Terra Max 的活动 cohort：

`/home/duozhou/run-artifacts/programbench-terra-max-200-20260913/terra-max-full-20260913`

该 cohort 继续沿用 6 小时 / 1000 turns，不在中途变更实验条件。历史 Luna 和其他实验的配置、结果与 artifacts 全部保留。

## 已确认的跨层限制

以下是对冻结版本的只读检查，不是已修复声明：

| 层 | 已存在的约束 |
| --- | --- |
| Runner 配置 | `Limits.provider_turns`、`procontract_actions` 必须为正整数，不能表示无上限 |
| Contract adapter | `MAX_PROVIDER_TURNS=1000`；发行 payload、limits 校验、预算耗尽判断依赖固定值 |
| ProContract Schema/Core | `Budget.turns/actions` 必填；动作/轮次预约和 settlement window 依赖数值上限 |
| Provider 网关 | 限制 1000 次已接纳请求及 3000 次 wire attempts |
| Usage/汇总 | 对 1000/2000 turns 及 1001 messages 存在验证边界，不能在取消执行上限后仍拒绝合法账本 |

只改 YAML，或把 1000 换成一个更大的常数，都没有实现 deadline-only。

## 下轮启动门槛

在独立工作树实施，保留显式有限预算对历史 Contract 的兼容语义；不要修改活动 Terra runner 或已冻结的 binary。

必须用确定性、无模型的检查证明：

1. 超过 1000 provider turns、超过旧 wire/action 边界仍可继续，不增加或重置 deadline。
2. Usage、恢复、保存/重载、最终报告均接受并准确保留超过旧上限的计数；未知费用不按零处理。
3. 达到原六小时 deadline 后拒绝新工作，并中止/收尾在途操作；Session 切换不能获得新的六小时。
4. 历史显式有限预算仍然被执行；新 profile 不继承隐含的旧固定计数上限。
5. 真实小样本确认配置到网关、Contract、Session 的条件一致，再启动付费全集。

新结果标注为 `6h-only`，不声称与历史 `6h/1000-turn` 结果预算严格匹配。
