# Astra：17 开发题 + 5 跨领域确认题的 S/H OTA

2026-09-23，用户授权启动；不是此前分析中的性能预测。

运行目录：`/home/duozhou/run-artifacts/procontract-astra-ota17-20260923`。
实际启动时间、模型请求和绑定见 `LAUNCH.json`、`STARTUP_OBSERVATION.json`；
动态阶段见 `STATUS.json`。截至首次启动核验，Astra Max 已开始第一代 H 提案，尚无性能晋升。

## 冻结边界

- K：规范 Kernel 及依赖源码不变，另用 `inputs/KERNEL-v2.json` 核对 H 中的对应源码。
- S：策略；H：OpenCode 求解侧上下文、记忆、工具、调度等完整执行实现，排除 K。
- 外部评分器、测试／ignore map、隔离／凭据、预算会计、晋升规则和监督器不可 OTA。
- 真正的 H 源码补丁离线构建为新二进制，经成对测评后才冷切换；不是只换提示词。
- 固定每次实例 6 小时 deadline-only，无累计 turn/action/request/金额上限；恢复不重置。
- `task-pareto`：固定重复下逐题均值不退步，至少一题提升，保留既有／要求的满分。

17 个开发题沿用 [修复方案](pro-contract-astra-repair-plan.md) 中的 8 个 lost-full、
5 个大退步和 4 个满分保留案例。按用户最新要求，不再从中切出确认集。

另选的确认题：DuckDB（数据库）、FFmpeg（多媒体）、TinyCC（编译器）、Typst（排版）、
Quinn（QUIC 网络）。这些是难且领域不同的公开任务，不声称历史上从未暴露；它们的结果不回传
给本次策略生成器。每题每版本 2 次执行，一个候选与父代完整比较为 **88 次任务执行**。

## 启动与验收

控制器单测、Kernel 源码门禁、真实容器和 Astra-wire 的 S→H→S／私有状态回滚测试通过。
测试曾发现 archive 0664→0644 规范化差异，以及宿主测试环境缺 pytest-timeout；失败记录保留，
分别在新资格版本采用 Git executable-bit 语义、私有 scorer venv 修复，未改规范源码／测试断言。

先允许第一代研究提案生成。完整任务付费执行和 OTA 有额外硬门禁：用新的 timed scorer 在独立
目录核验 22 份保留候选，完整测试图、known-full 控制和 scorer-negative bridge 都合格后，
`qualification/EVALUATOR-ADMISSION.json` 才可放行。它们不是新模型 baseline，不改历史评分，
也不把资格检查中的隐藏失败细节交给生成器。新对照必须真正重新执行父代和候选。

检查点：第一次新增 robust full pass 经完整对照确认并验证新版本启动后停止检查，不将该里程碑
称作全面超过 200 题 baseline。此前仅有均分／逐题正提升的合格更新可以继续 OTA；无提升不切换。
缺失／不合法评分不记成实测零，不删除任务，不允许不完整确认授权晋升。

隔离源码：OpenCode `/home/duozhou/opencode-astra-ota`，commit `882e065558bffb98b016f5274f8c63209d9808fb`；
ProgramBench `/home/duozhou/ProgramBench-astra-ota`，commit `37357e3e89572d635838bc117e94b34be83483ab`。
主工作树既有修改与历史 cohort 未变；实验内采用不等于更新全局运行版本。

取消入口：在运行目录创建 `CANCEL`；它停止新准入及本批拥有的工作，不停止其他实验。
