# S6c 准备：运行清单与启动前核验

2026-09-20 接续：真实运行接线已实施并完成本地 fixture 验证，见[接线实施记录](pro-contract-researcher-s6c-wiring.md)和[独立接线审查](pro-contract-researcher-s6c-wiring-review.md)。模型、受信部署／凭据及评分者仍待指定，真实开发校准和资格评测未启动。以下保留 2026-09-19 初轮准备原文；其中“接线待完成”描述的是当时状态，机器可读准备 JSON 未改写。

2026-09-19。用户已批准推进下一步。本轮完成运行准备清单和不调用模型的本地检查；模型、部署及真实运行接线尚未确定，资格配置没有冻结。实际模型请求数为 0，发行实例数为 0，`qualification: not_run`。

依据为[冻结 S6 设计](pro-contract-researcher-s6.md)、[S6b 实施记录](pro-contract-researcher-s6b-implementation.md)及[独立审查](pro-contract-researcher-s6b-code-review.md)。本文件不改写这些历史审查结论，不修改正在运行或冻结的 cohort。

## 已完成的准备

已生成[机器可读准备清单](pro-contract-researcher-s6c-preparation.json)。其 `launchable` 为 `false`，`proposedConfiguration` 中未知字段使用 `null`；实际调用现有 `freeze.configuration()` 确认该草稿会被拒绝，不以默认模型、虚构 hash 或看似有效的占位字符串充数。尚未调用针对完整真实配置的 `freeze.preflight()`。

完整准备目录为 `/tmp/opencode-s6c-preparation-20260919T190440559Z`，其中保留源码镜像、准备脚本、测试日志、公开任务包、私有任务包和准备清单。`preparation.json` SHA-256 为 `7ebf18a41e3072dac60dafe1fb4161abd5994e9e5a05d97afc121a3f591fa75d`。

源码镜像包含 6,534 项，`source/manifest.json` SHA-256 为 `f76c92909c1c7eb89d5e35747a6ada443d0918bb14c4c93e23ab4082322e6291`。与 S6b 最终完整镜像比较，没有新增运行代码差异；S6b 的 31 项源码清单逐项匹配。当前新增的英文总方案也已保全，没有覆盖或重写。此镜像先于本轮收尾文档生成，属于准备证据；真实接线完成后须重新冻结最终运行镜像。

运行时记录为 Bun 1.3.14、Node v24.21.0、Linux 6.17.0-14-generic x86_64、gcc 13.3.0。Bun 二进制 SHA-256 为 `9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74`，Node 为 `7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c`。

## 配置与部署的待填项

| 项目          | 本轮核验结果／需要的具体输入                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------- |
| Worker        | provider、精确模型 ID／可用快照、variant、支持的采样参数与 seed 能力尚未确定                       |
| Reviewer      | 同上；现有 production manifest 的计划和最终 reviewer 共用一个冻结模型配置                          |
| Provider 部署 | 标准 OpenCode 配置未设置 provider 或默认模型；当前进程无 provider 凭据环境项，标准 auth 文件不存在 |
| 历史部署      | 文档引用的 `/home/duozhou/ProgramBench-deadline-only` 在当前环境不存在，不能视作已接通的服务       |
| 凭据          | 需要部署中已有的凭据引用／配置路径；凭据只由受信代理持有，不写入运行清单、源码镜像或候选工作区     |
| 完整配置身份  | 实际 agent、system prompt、工具目录、配置和 runner 字节及 hash，须在接线完成后填入                 |
| 单次操作限制  | 冻结网关、工具、验证和清理的实际数值及执行位置；不能只在 JSON 声明而未接入运行路径                 |
| 盲评          | 两名独立评分者及争议裁决者的身份／分工尚未确定；不能用被测 reviewer 或单个模型评分替代             |

已向用户询问 worker／reviewer 模型和 provider 部署／现有配置路径。以上是缺少的运行输入，不以猜测补齐。

若使用 OpenAI，按实际模型与协议确定支持的参数；[官方 reasoning 指南](https://developers.openai.com/api/docs/guides/reasoning)说明 Responses 的 reasoning 配置及包含 reasoning tokens 的单次输出上限。官方说明不证明当前账户可访问某模型，也不提供本环境的凭据。模型不支持 seed 时明确记录 `unsupported`；尚未核验时保持未定。语料顺序 seed 与 provider sampling seed 分别记录。

## 固定的运行安排

沿用已审查的 `synthetic-node:1` 语料。资格集保持 48 个 reviewer 探针和 18 个完整任务、14 族、每族三次重复，种子为 `s6b-frozen-20260919`；完整实例 ID、顺序、公开／私有对象身份已写入准备清单。S6b 使用这些材料的确定性自检不计作 S6c 样本。

先进行独立的开发集接线校准：一个 P1 好计划、一个 P1 坏计划和一个 R3 完整负结果任务。只使用 `development` 变体，不进入资格分母；当前这三个真实校准也尚未运行。校准之后才固定最终模型、提示、源码、部署与配置版本，再发行资格批次。

首批串行运行。每实例自发行起累计墙钟为 21,600 秒，省略 turns、actions、wire requests、费用及 attempts 累计上限；恢复、更换 Session、重新规划均共享原 deadline。保留现有单次操作约束：生产 Session 的 provider turn 绝对上限为 15 分钟，idle timeout 为 10 分钟，绝对上限与原 Contract 剩余时间取较早者。其他部署与工具操作期限尚未冻结，不假定沿用自检中的短 timeout 就适合真实运行。

P/F 探针只有 worker 准备过程可以脚本化，所有目标 reviewer 必须走真实模型生产路径；F 组的前置计划评审也是真实 reviewer。18 个完整任务的 worker 与 reviewer 均为真实模型，不能沿用确定性 fixture 的代写计划、修复代码或准备报告。探针取第一份完成的目标报告，不以成功重试替换；完整任务的正确负结果和有据不确定结果同等计为有效交付。

故障规则保持一次预定机会：R5 必须证明真实 provider 请求尚在途，R6 必须证明实际测试子进程仍存活。不能延迟响应或测试来制造窗口；miss 保留原分母。恢复前确认旧执行清理、unknown 记录和原 deadline，再按实际 `replan` 分支显式恢复。无预定注入的未知执行不自动重放。最终 challenge 只转发当前 handoff 的原 blocking findings，不提供 oracle 答案。

独立评分先封存看不到内部 verdict／模型标识的候选判断，再解封 reviewer；主观项双人标注，争议另行裁决。只认可独立判定有效且绑定 exact subject／bundle 的候选。首次 ready、外部评分完成及认可完成分别记录。unknown tokens／费用不填零，所有失败、未触达、未开始和错误 ready 保留。

## 真实启动仍需完成的接线

当前 `pro-contract-eval-process.test.ts` 是确定性生产自检入口；`S6B_MATRIX=1` 只切换语料，不能把它当作真实模型启动参数。已有 `driver`、`controller`、`observe`、`archive`、`blind` 和 `freeze` 模块可复用，当前没有组装完成的真实资格批次 CLI。

1. 组装真实宿主启动器，绑定模型配置，区分脚本探针 worker 和真实 reviewer／完整任务 worker；去掉自检中的答案生成、预期成功断言和 150 秒测试框架终止机制。
2. 接通仅允许固定 provider origin／路径的受信部署代理。现有 observer 只接受 HTTP upstream，不能直接把 HTTPS API URL 填入。被测宿主仍只连接 loopback broker；实际凭据留在候选权限之外。
3. 把每次 wire／response／complete 绑定真实 Contract／Session／job／operation，明确上游请求 ID、断连、取消和 partial response；验证代理在原 deadline 拒绝新请求并收尾在途流。不得把仅到本地代理的发送事件无条件表述为已发到 provider。
4. 保存真实有效配置与每次上下文身份，接入盲评材料和持久标注，并让资格报告从真实观察与评分生成；现有确定性报告始终返回 `not_run`，不能直接改常量来宣布资格通过。
5. 对新增接线做不调用模型的回归和独立复核，再进行上述开发集真实校准。校准失败及所有重启记录另存，不混入资格分母；不改运行中的源码或配置。

真实配置的源码／运行时／配置对象身份验证与实际代理、取消、隔离检查全部满足后，才能将清单标为可发行。当前准备记录没有发行任何 Contract，也没有创建真实资格实例账本。

## 本轮不调用模型的检查

| 检查                                                          | 结果                                          | 准备目录中的日志          |
| ------------------------------------------------------------- | --------------------------------------------- | ------------------------- |
| 评分、矩阵、盲评、快照、历史计量、故障观察、真实 OS／网络隔离 | 19/19，3,487 assertions                       | `local-selfcheck.log`     |
| 跨旧 turns/actions 边界、原 deadline、无累计 attempts 上限    | 2/2，32 assertions                            | `core-budget-check.log`   |
| 省略计数预算与历史有限预算 schema                             | 2/2，17 assertions                            | `schema-budget-check.log` |
| S6b 审查代码与当前运行源码                                    | 31 项全匹配，无运行代码差异                   | `preparation.json`        |
| 未填配置拒绝                                                  | `freeze.configuration()` 拒绝包含未定值的草稿 | `preparation.log`         |

测试分别从 `packages/opencode`、`packages/core` 和 `packages/schema` 运行。19 项中包含超过旧 3,000 wire request 边界的真实本地网关检查；期限测试使用测试时钟，不声称本轮等待了六小时。没有修改运行代码或公共 API，因此本轮没有重复生成客户端或重新执行七包类型检查；S6b 的历史记录继续绑定原版本。

本轮文档、JSON 清单已检查格式、链接及数学分隔符；原未提交改动、英文总方案和历史实验 artifacts 均保留。S6c 真实校准与资格评测尚未执行，S6d 真实研究试点未启动。
