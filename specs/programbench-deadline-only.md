# ProgramBench 后续实验预算要求

用户于 2026-09-13 指示：“最好以后也不要设置1000 turn的限制，只有6小时的限制”。

状态更新（2026-09-14）：预算支持已在独立工作树实现并验证，历史冻结实验未修改。OpenCode：`/home/duozhou/opencode-deadline-only`，commit `57e89a94bf866b020c0bc3c3b73411f160136b67`；runner：`/home/duozhou/ProgramBench-deadline-only`，commit `bd079f19b25e16eedd8e6ef6effbae8738de0c60`。两边 branch 均为 `deadline-only`。

Schema/Core/runner 已验证跨 1000 turns、3000 requests、历史消息计量与恢复、原始 deadline 持续生效及在途取消；Core/CLI 类型检查和 Client/SDK 生成通过。Sol xhigh 的三题实时验证已经启动，控制器在资格门槛通过后自动启动新 200 题全集并评测。实际阶段以 `/home/duozhou/run-artifacts/programbench-sol-xhigh-6h-20260914/STATUS.json` 为准；此处不宣称资格或全集已经通过。

主工作区与旧 Luna/Terra 二进制仍保留原有限预算实现。新实验应使用上述已冻结的独立版本，而不是只改旧 YAML 或原地修改历史运行。

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
