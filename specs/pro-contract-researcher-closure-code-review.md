# 收尾呈现与 IPC 去重：独立代码审查

2026-09-21。两名独立 agent 分别审查 SDK 收尾与评测／日志增量，均按本轮完整工作树基线比较，没有用 HEAD 代替既有实现。原始发现、关闭依据和最终文件 hash 均保留在 `/workspace/researcher-closure-20260921T054035Z/`。

| 独立范围 | 原始记录 | 结论 |
| --- | --- | --- |
| `/root/closure_sdk_review`：SDK、发行身份和真实宿主过程回归 | `sdk-code-review.md`，SHA-256 `870523a4ec735ab680bff9297baaf80dcc7131933e2c580c374bbd26973b2295` | 两项呈现缺陷及兼容测试建议关闭，无未关闭阻断 |
| `/root/closure_infra_review`：评测配置、CAS、归档和终态 | `infra-code-review.md`，SHA-256 `08e277306bdc5894ec5bb8649f8e7bdbffe8cbde690b4d7b798d65b4d77aee94` | 三项阻断和一项修正回归关闭，无未关闭阻断 |

SDK 初审发现 final-only 被要求对照不存在的计划，以及逐 finding 视图丢失完整历史 outcome、response.summary/action 和空 responses。最终提示分别处理有计划与 final-only；完整 history 与逐项 targets 并存，unavailable 和空回应保留。新增合法 opt-in 冲突、已启用任务省略字段的精确重试、非法协议组合及新旧 final-only 两路径测试。独立 agent 实际运行 SDK 29 项及修正后过程 4 项，全通过；新增空历史过程由主任务另跑 1 项通过。最初完整过程 28 项通过另行列示，不冒称最终所有 30 项在同一轮运行。

基础设施初审发现：无 retained 实例证据的发行失败 wrapper 漏 guidance；恢复 writer 跳过空行而 reader 拒绝；归档先枚举块再读仍在增长的日志，可能缺失引用对象。最终 wrapper 显式绑定 guidance；恢复严格拒绝坏行；先固定日志，再归档对象，并以归档 loader 校验该日志的完整引用闭包与逐连接 cleanup。修正时也恢复了损坏 legacy cleanup 原始证据可保留为 unknown 的路径。

`infra-reviewed-source.json`（SHA-256 `97bb3258742e90f39ba353772e0cba1bc805cf9a8b5a35514d3d045059582915`）保留 19 项增量及辅助源码身份。此 reviewer 未运行测试；FIFO 跨期限、响应阶段存储失败、恢复清理和 CAS-only 候选保护等运行结果由主任务日志证明，不以静态审查代替。

审查没有启动第七轮或 66 例，没有更改第六轮封存判断。确定性接线及静态审查不能证明真实模型已能可靠利用新提示。
