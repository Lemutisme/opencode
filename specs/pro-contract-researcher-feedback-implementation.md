# Researcher 评审反馈与运行策略 v2 实施记录

2026-09-20。按用户本轮确认方向，在[专项设计](pro-contract-researcher-feedback.md)的独立阻断关闭后实施。设计审查见[原始记录](pro-contract-researcher-feedback-design-review.md)，实现审查见[代码审查记录](pro-contract-researcher-feedback-code-review.md)。前三轮校准、冻结配置、历史结果和评分真值不改写；本轮没有启动 Researcher 真实模型校准请求、第四轮校准或 66 例资格评测。

## 基线与范围

当前分支 `jerry/dev`，HEAD `78bec19263814444ab008c58d54835b59b4a1c6b`。修改前已有大量未提交成果。`/workspace/researcher-baselines/20260920T173028Z` 保存 190 个已改／未跟踪文件、状态、完整 binary patch、逐文件 SHA-256，以及 6,438 个跟踪文件完整归档。前者 `worktree.tar.gz` SHA-256 为 `c0e374b254b472a5cf02a31de8cd7ab61a3daa72c451ad43183cc765dcb55243`；跟踪归档为 `8957371a9e816bb12f14cd480d9192e06b60a0973bd801becf4654f59eb7b9dd`。二者共同保留修改前源码和未跟踪历史，不能用 HEAD 代替。

本轮主要修改 `packages/sdk-next/src/research/`，补充生产流程测试和 `script/research-eval/` 的归档／评分维度。没有修改 Core、公共 Protocol、Server HttpApi 或 SDK 生成文件；工作树中这些区域已有的修改属于基线成果。本轮没有提交、合并或发布。

## 实现语义

新发行任务持久化 v2 advisory/advisory 策略，明确 required 的阶段仍要求可用 accept。旧任务缺少字段时仍走原 v1；精确发行重试使用已存策略。历史生产 fixture 和 S6c legacy 评测入口明确选择 v1，不以新默认改写原矩阵含义；后续 v2 cohort 仍须单独冻结和运行。当前 S6c controller 的前置拒绝规则仍属于 v1 runner；新增维度可评估归档的 v2 outcome，但完整 v2 cohort 启动器未在本轮验证，不能据此直接发行 v2 资格批次。

计划准入保存独立宿主 receipt，绑定策略、plan、context、原意见与回应；不再让 experiment 的准入身份等同 reviewer accept。v2 最终评审位于 Core handoff 前，新增反馈阶段只开放 read/control。`review_response` 在当前 execution/context 校验事务内记录逐项回应，允许原授权内继续、修复或提交。修复撤销旧候选验证／实验资格；候选在提交屏障后变化时也返回执行阶段，保留历史反馈并要求重新验证，不陷入永久 freezing 恢复循环。

原始意见、真实报告状态和 Researcher 的 fixed/rebutted/unresolved 声明分别保存。fixed 是声明，不冒充已证实修复。P1、影响、引用和升级信息保留，P1 标签没有自动暂停全部工作的特权。Reviewer 的 scope 意见在 advisory 下也须回应，但不成为隐性模型否决；明确越权请求、原 deadline、权限、保护项及核心证据仍受机械门槛约束。

结构化引用从原 job 的不可变 `{jobID,id}` 映射解析，完整 job input fingerprint、材料 allowlist、plan/candidate/context 及来源校验贯穿收集、回应、提交和认可。报告 schema／引用失败产生 unavailable outcome，原始报告不补写。Reviewer 环境不可用时记录真实环境原因，创建的 job 被取消而不假装已执行；无消息为 absent，有错误或部分消息为 partial。完整源消息以 schema 编码后归档，保留 provider error、工具内容与 DateTime 字段。验证只读重放，不修补损坏归档。

提交前与外部 exact recognition 均验证正式实验、冻结 replay、实际 TAP、受保护输入、产物来源、全部 blob 内容和反馈历史。v2 bundle 的 verdict 保持原评审判断或 unavailable；即使它被允许呈交，也不改为 accept。`ready`、最终候选质量与外部 `accepted` 分开。

评测新增三个维度：reviewer 判断（不以 host gate 抵销错误）、Researcher 反馈处理（机械完整性与未盲评质量分开）、最终候选质量／host ready／外部认可。原 measured 真值和历史矩阵不变。归档包含无 bundle 的反馈回应、admission receipt 和映射，失败／取消不丢分母。P1 回归使用语料实际分析函数、validation/test 选参关系和同一 test 评估，并覆盖多种独立性措辞；不规定好例 reviewer 必须 accept，不删除反例或改旧标签。

## 独立审查与验证记录

设计审查三项阻断关闭后开始实施。代码审查保留初始发现及修复过程：候选变化后的修复路径、reviewer 环境不可用分类、完整 job 身份、策略提示、v2 评分与无 bundle 归档。测试日志保存在 `/workspace/researcher-feedback-validation`，类型检查的早期失败也保留在基线目录。

首轮两项新版生产测试失败，原因是新增完整消息归档直接持久化 Effect DateTime 内部对象，随后按消息 schema 解码时报错。已改为 schema 编码，并增加真实时间戳、reasoning 时间戳和 provider error 的回归；没有将该失败归因于模型。`research-feedback-first.log` 和 `research-feedback-debug.log` 保留原失败。

旧生产恢复测试本轮曾在 coordinator 已 unavailable、verifier lease 尚未过期时请求恢复，既有清理 guard 正确拒绝。测试改为轮询实际 job lease 到期后再请求显式恢复；Core 和运行时 guard 不变。保留该失败，不声称已证明旧基线必然复现。

独立审查 C7 还发现长证据 I/O 之后的授权时序窗口。回应与正式实验请求现在在读取、校验及不可变对象归档后，重新核验原 execution／lease／deadline，再关闭准入并写入状态。候选提交在 `reportReady` 前重验宿主 guard，bundle 归档后再检查原 coordinator token 和原 deadline，才发布认可上下文；过期使整个状态事务回滚。无引用的内容寻址对象不能构成回应、准入或交付成功。

C7 首轮三个回归中，回应和 bundle 两项通过；正式实验一项在发行阶段失败，因为原 checkpoint 测试夹具只注册最终交付 driver。夹具补注册既有 planned driver 后再跑完整套件；不修改生产发行校验，原 `feedback-c7-process.log` 保留。

### 测试与源码身份

所有测试从相应包目录执行，确定性 provider 仅用于生产机制验证。完整日志保存在 `/workspace/researcher-feedback-validation`。

| 验证                                                  | 结果与日志                                                            |
| ----------------------------------------------------- | --------------------------------------------------------------------- |
| SDK 反馈、计划、schema、store、TAP 五套件             | 46/46，138 assertions；`sdk-tests-final.log`                          |
| 评分、无 bundle 归档、P1 真实选参与评估关系及历史兼容 | 15/15，574 assertions；`feedback-eval-final.log`                      |
| 新版生产流程首个完整通过版本                          | 11/11，93 assertions；`feedback-process-v2.log`；后续 C7 边界验证另列 |
| 最终新版生产流程（包含三个 C7 真实 I/O 过期反例）     | 14/14，111 assertions，176.31 秒；`feedback-process-final.log`        |
| 旧版计划与最终交付生产套件                            | 首次 33/34，352 assertions；`legacy-process.log`，保留 lease 时序失败 |
| 旧版失败用例定向复验                                  | 1/1，20 assertions；`legacy-recovery-recheck.log`                     |
| C7 后旧版计划、实验、交付与 exact 认可完整链          | 1/1，29 assertions；`legacy-final-c7.log`                             |

包内 `bun typecheck` 均退出 0：`sdk-typecheck-c7.log`、`opencode-typecheck-final-c7.log`，后者包含三个 C7 回归及补齐后的 checkpoint 夹具。

本轮 22 个源码／测试文件的增量清单为 `source-changes.json`，SHA-256 `2a392e1603d0e9a60b742eed1aafc48e0027f0208d615ee7c18376bebc58b0c7`；相对真实修改前基线的补丁为 `source.patch`。通过现有 `codeIdentity()` 只读计算的 runtime 身份为 `b20092cc489413fae8e2198eaa3c8d34f2111da413bfae7255aae967fb6c9cd7`，这不是新 cohort，也未调用 launcher。

保全核验覆盖修改前清单与当前全部受版本控制／未忽略文件：无文件丢失，33 份历史 S1–S6 文档逐字节不变，Core／Protocol／Server／生成文件无本轮增量。59 个归档符号链接不变；原 regular-file 清单漏记的 `packages/console/app/public/email` 是既有 dangling symlink，已按原状态和 HEAD 链接目标单独核验，不能误记为新增文件。最终保全清单为 `preservation-final.json`，完整源码快照与清单为 `source-full.tar.gz`、`source-full-manifest.json`；文件身份另存 `source-identities.json`。

独立代码审查已签署通过，C1–C7 全部关闭，无剩余实施阻断。审查者独立重算了上述 22 项文件清单和 runtime 身份，并核验最终测试日志；原始发现与关闭依据见[独立审查记录](pro-contract-researcher-feedback-code-review.md)。设计、实现和审查收尾完成；完整 v2 cohort 启动与真实模型质量仍属于后续单独冻结、验证的工作。

本轮只验证实现机制，不声称模型判断质量或真实研究交付能力已通过。每实例六小时墙钟、原 deadline、计量与单次操作限制保持；无新增累计请求、实验次数、turns/actions 或费用上限。
