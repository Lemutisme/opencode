# Advisory v3 批次接线：独立审查记录

2026-09-21。独立 agent `/root/advisory_runner_review` 审查[设计](pro-contract-researcher-advisory-runner.md)及增量源码；执行者另外完成实际入口联调。本次没有真实模型评分或历史重评分。

## 设计审查

支持限定接线，不需要扩展宿主协议。无状态评分请求可以构成真实隔离上下文，无须引入 SDK Session。要求未开始实例保持真实分母、不补造 agreement；stable_copy 还需核对表与观察完整性；本例揭盲不等待另一失败实例。要求实际请求验证独立性，并明确与旧动态诊断评分的差异。

## 实施审查及处理

- 发现 runtime 漂移后仍可能进入评分：现评分绑定、请求前后及 seal 前核验；读取异常归为 shared stop，并继续封存分母与报告。
- 发现终态观察可能跨实例混用且引用 blobs 未复验：现重建冻结公开任务，核对实际 attempt/admission/result/failure/audit，并逐个验证观察依赖。
- 发现旧评分 Result 类型扩展后可能把 v3 当 v2：现旧验证默认拒绝 v3，只有新发行显式选择；feedbackMaterials 同样拒绝。
- 建议完整单列评分 usage、拒绝畸形已知用量，并在消耗实例前查凭据来源：均已接入。
- 更早的 pre-admission 启动故障仍保守 shared/unknown，已明确列为边界；不宣称旧发行故障已修复。

审查者确认 model 分支仅传公开任务，不用 oracle 替 Researcher 作决定；评分请求无工具／conversation，双评与裁决／本例揭盲顺序正确。独立发现边界测试临时包名被 runtimeFiles 排除，执行者修复 fixture；另外发现一次文本补丁没有真正加入负面测试，执行者补入后再验证，没有把未运行检查记成通过。

最终独立复跑、13 个源码／测试文件 hash 与保全核验记录位于本轮证据根 `/workspace/researcher-advisory-runner-20260921T201422Z`。审查范围为机制及接线，不证明未来模型的研究判断或反馈处理可靠。

独立边界测试最终 3 pass、16 assertions，原日志为 `independent-boundaries-final.log`；初始 fixture 命名失败保存在 `independent-boundaries-initial.log`。最终审查清单 `independent-reviewed-files.json` 的 SHA-256 为 `6052c5b23e6f37a3eb70bab4b379def05490811564d748d45464e2dbf65c9a1f`。审查者最终结论为没有未关闭的代码阻断；重型实际入口测试由执行者运行，审查者没有将源码核查冒称重跑。

执行者最终增强入口与边界验证：5 pass、145 assertions，包含对真实终态归档的跨实例替换、数据库 blob 损坏和 deadline 改写拒绝，以及实际旧评分 API 拒收 v3。加上此前全入口 5 pass／240 assertions，覆盖发行、候选归档、双评／裁决、评分者不可用和两条取消路径；不同的新测试共 8 项。最终 `bun typecheck` 通过。13 项审查身份在最终源文件再次核验一致。
