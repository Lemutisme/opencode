# S6c 离线运行接线：实施与验证

2026-09-20。用户批准继续下一步后，已补齐真实运行器所需的启动、代理、恢复、盲评、认可与报告接线；本轮只用明确标记的本地 fixture 验证。未调用外部模型，未运行真实开发校准或资格批次，`qualification: not_run`。实际 worker／reviewer 模型、受信部署、凭据引用及独立评分者仍未指定。

依据为 [S6 冻结设计](pro-contract-researcher-s6.md)、[设计审查](pro-contract-researcher-s6-review.md)、[S6b 实施](pro-contract-researcher-s6b-implementation.md)及 [S6c 初轮准备](pro-contract-researcher-s6c.md)。本轮独立复核见 [接线审查](pro-contract-researcher-s6c-wiring-review.md)。历史 S6b 审查和准备 JSON 保留原状；工具通过不表示模型质量通过。

独立审查已签署通过，W1–W9 全部关闭，最终版本无遗留 P1／P2。审查报告 SHA-256 为 `ab78f3405d02e85d480d5d489fbd8a55b719c079219ec767a456bf795c62409a`；该结论只覆盖离线接线和对应测试版本，不是实际模型资格结论。

## 实施范围

新增入口位于 `packages/opencode/script/research-eval/`：

| 文件                                       | 职责                                                                         |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| `launch.ts`、`provenance.ts`               | 完整工作树冻结、部署核验、串行 cohort、执行及评分的共同代码身份              |
| `provider.ts`                              | 固定上游、受信凭据注入、真实请求与部分响应记录、取消和原 deadline            |
| `host.ts`、`host-process.ts`               | 隔离的生产 embedded research 宿主、白名单 IPC、进程清理                      |
| `instance.ts`、`probe.ts`                  | 六小时实例、脚本探针准备、真实 worker／reviewer 路由、一次预定故障与显式恢复 |
| `evaluate.ts`、`rating.ts`、`recognize.ts` | 独立候选核验、两阶段盲评、封存评分和 exact 认可                              |
| `qualification.ts`                         | 从完整执行账本及独立评分生成新的资格报告                                     |

既有 `controller.ts` 修复 F 探针首次前置计划拒绝后的结束条件；`freeze.ts` 增加开发校准模式；`isolate.c`／`isolation.ts` 增加 evaluation 专用 subreaper supervisor。没有修改本轮之外的生产 Core、Protocol 或 Server API，不需要重新生成 SDK。原确定性测试入口继续有效。

运行器没有测试框架的 150 秒结束条件。每个实例从设置发行时间起使用原 21,600,000 毫秒 deadline，恢复、换 Session 和重新规划均不重置；没有累计 turns、actions、wire requests、费用或 attempts 上限。保留单次 provider 最多 900,000 毫秒、生产工具 600,000 毫秒、明确的验证／清理限时、取消及基础设施故障守卫。

P/F 仅 worker 准备可脚本化，真实运行中的前置和目标 reviewer 均走模型。R 的 worker 和 reviewer 全部走模型，controller 不代写计划、答案或修复。R5 只在实际上游 response 尚在途时注入，R6 用独立 `/proc` 身份确认真实 Node 测试子进程；每实例只有一次预定机会，错过保留 miss。测试为复现竞态使用的部分响应和短暂延迟只在 fixture 中存在。

## 部署与启动入口

命令从 `packages/opencode` 执行，配置和输出放在仓库外的受信目录；以下大写参数表示待准备的文件或新目录，不是可直接发行的实际配置。

```sh
bun script/research-eval/launch.ts freeze SETUP.json NEW_FREEZE_DIRECTORY
bun script/research-eval/launch.ts check DEPLOYMENT.json
bun script/research-eval/launch.ts run DEPLOYMENT.json NEW_COHORT_DIRECTORY
```

`freeze` 生成 `frozen.json`、`deployment.json`、完整 `source/` 和内容寻址 `objects/`。`Setup` 的必填结构以 `launch.ts` 为准：

| 字段                 | 要求                                                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------- |
| `version`、`mode`    | `1`；先 `development-calibration`，校准后另冻 `qualification`                                                   |
| `worker`、`reviewer` | 分别完整指定下面所有模型字段；无默认模型                                                                        |
| `endpoint`           | 固定 HTTPS origin，路径严格为 `/v1/chat/completions`，不含查询、片段或 URL 凭据                                 |
| `model`、`variant`   | 精确模型／快照和变体；非 `default` 变体与 `parameters.reasoning_effort` 对应                                    |
| `parameters`、`seed` | 显式采样／输出参数；seed 为整数或明确的 `unsupported`，与参数一致                                               |
| `context`、`output`  | 正整数，须按实际模型能力配置                                                                                    |
| `credentialEnv`      | 受信 controller 读取的环境变量名；配置只存引用，不存秘密                                                        |
| `bun`、`node`        | 受信可执行文件路径；冻结版本与二进制 hash                                                                       |
| `timeouts`           | 必填 `provider`、`tool`、`verification`、`cleanup`；provider 不超过 15 分钟、tool 为 10 分钟、cleanup 至少 6 秒 |

上游目前只实现 Chat Completions；可冻结的参数键是 `temperature`、`top_p`、`seed`、`max_tokens`、`max_completion_tokens`、`reasoning_effort`。须先核实实际部署和模型支持的组合，不声称已经实现 Responses 或验证了账户权限。真实模式要求 HTTPS，本地 fixture 模式仅允许 loopback HTTP。

代理从当前生产 operation 和历史 job 确定角色，校验模型 alias，再强制冻结的实际模型和参数；不会按候选请求任意选择目的地。候选授权头被拒绝，其余任意 header／cookie 不转发，上游重定向不跟随。候选环境为 allowlist，真实凭据只在 controller 代理注入。每次请求保留 body hash／bytes、Contract／Session／job／operation 身份、wire／response、上游请求 ID 和 complete／partial 响应；成功及失败的归档 root 都绑定完整 `transport.jsonl`。

冻结包含全部 tracked 与 untracked、非忽略源码及文件模式。启动前要求实际 inventory 与冻结清单完全相等，再逐项核对源码、runtime、语料／oracle、提示／agent／工具、评分器及隔离对象；仅存在一个合法 hash 不足以通过。执行、评分、认可和派生报告的共同 `runner` 身份覆盖评测运行文件、各包 `src`（含 prompt Markdown）、锁文件、patches、包清单、`tsconfig*.json` 和 `bunfig.toml`。文档和测试不改变后续评分的运行身份，但仍在完整启动快照内。

先用开发集 P1 好计划、P1 坏计划和 R3 完整任务校准；三个真实校准尚未运行。校准后固定最终模型、提示、代码和部署，另冻 66 实例资格批次（48 探针、18 完整任务），保留冻结 seed 和顺序。首批串行，启动前登记所有分母。基础设施失败停止批次，其余实例保留 `not_started`；不自动重放中断 cohort，不以新 deadline 或成功重跑替换旧失败。配置缺项或凭据不可用时拒绝创建 cohort。

## 盲评、认可与报告

执行结束保留 `result.json` 或 `failure.json` 及其内容寻址 root。候选材料从归档的 exact subject Git tar 读取，不依赖可变工作区；需要执行候选时使用不能访问 oracle 的独立执行边界。计划阶段采用计划 rubric，不要求尚未到执行阶段的实验结果。

`blind/blind.json` 指向 `blind/objects/` 中的候选与 rubric。先只给两位独立评分者这些材料；完整标注所有 rubric 项，必要时由第三人裁决。标注 JSON 包含 `first`、`second` 和可选 `resolution`；每项包括 `rater`、`candidateHash`、`rubricHash`、`items`，其中逐项值为 `true`、`false` 或 `null`。

```sh
bun script/research-eval/rating.ts seal-candidate INSTANCE CANDIDATE_RATINGS.json
bun script/research-eval/rating.ts score-reviewer INSTANCE REVIEWER_RATINGS.json
bun script/research-eval/rating.ts recognize INSTANCE
bun script/research-eval/rating.ts report COHORT NEW_REPORT_DIRECTORY
```

候选判断不可覆写；封存后才生成 `blind/reviewer.json`，再标注 reviewer 的语义与 finding。客观 oracle 失败优先于主观判断；完整任务的缺陷状态来自独立候选检查，不沿用探针的配对标签。`scoring.json`、`score.json` 与归档引用必须保持原字节，篡改时拒绝后续认可。

`recognize` 仅对独立判定正确、仍为同一 ready subject／bundle 的完整任务提交 exact attestation，启动的宿主禁止外部 provider 访问，并检查没有新增或在途 provider operation。首次 ready、评分完成和认可完成分别记时。报告另建目录，保留执行 hash chain、所有错误 ready、未触达、超时、取消、基础设施失败及 unknown 用量；未决标注或未完成认可不能通过资格门槛。真实 R1 边界缺陷 fixture 即使公开 TAP 可过、内部 reviewer accept，也记 `false_accept` 并拒绝认可。

## 故障修复与独立复核

独立审查保留了快速 double-fork／setsid 孤儿逃逸、不完整 source manifest 绕过、清理失败在成功落盘之后发生、故障打断在途 IPC 等反例。最终实现用受信 subreaper 等待后代 kill／reap；supervisor 被信号终止或清理超时明确失败，不宣称已清理。只有清理核验完成才发布成功结果。认可步骤也先归档已发生的 attestation receipt，清理成功后才发布 `recognition.json`；失败向 `recognition-failures.jsonl` 追加可达归档 root，保留 receipt 身份和 cleanup 错误，汇总不把它算成已完成认可。

预定恢复共用一个 promise，等待旧 supervisor 收尾；只读 IPC 可在该边界后重取，mutation 不盲重放。恢复要求旧 binding 释放、job lease 过期、显式 cancel／audit、unknown operation 证据；紧靠 `research-recover` 再核对取消与原 deadline。失败先关闭代理，再采集可得历史、执行清理并保存原错误及 cleanup 错误。独立最终结论和实际反例日志以接线审查报告为准。

## 验证与证据

使用 Bun 1.3.14、Node v24.21.0，全部命令从 `packages/opencode` 执行，生产进程测试串行：

| 检查                                                     | 结果                                   | 原始日志                            |
| -------------------------------------------------------- | -------------------------------------- | ----------------------------------- |
| `bun test --timeout 30000 script/research-eval`          | V4：38/38，3,638 assertions，204.01 秒 | `/tmp/s6c-wiring-suite-v4.log`      |
| 最后认可收尾修订后的 R3 全流程                           | 1/1，13 assertions，20.97 秒           | `/tmp/s6c-recognition-final.log`    |
| `bun test test/server/pro-contract-eval-process.test.ts` | 5/5，53 assertions，45.58 秒           | `/tmp/s6c-s6b-regression-final.log` |
| `bun typecheck`                                          | 通过                                   | `/tmp/s6c-typecheck-v11.log`        |

V4 覆盖 P 计划 unavailable、F 前置计划拒绝后 not_exposed、R3 完整交付／两阶段盲评／认可、R5 在途 provider 故障恢复、R6 实际测试子进程故障与重新规划、R1 边界错误及错误 accept；还包括部署冻结正反例、原 deadline／取消、慢请求头、旧请求数量边界、评分与固定分母、运行身份和四路 supervisor 回归。V4 之后只更改 `recognize.ts` 的清理与落盘顺序，并针对该变更重跑 R3；没有把 V4 的运行身份冒充最终版本。最终类型检查及五例旧入口回归在该修订之后执行。

独立审查者另外直接终止实际实例的 supervisor：没有生成成功 `result.json`，失败 root 绑定完整 partial transport，明确记录 `cleanup.complete: false`，日志 `/tmp/s6c-review-instance-cleanup.log`。另一实测在 accepted receipt 已归档后终止认可 supervisor：没有正式 `recognition.json`，追加失败 root 保留 receipt 与 cleanup 错误；实际汇总为 `recognitionComplete: false`，日志 `/tmp/s6c-review-recognition-cleanup.log`。两次测试由审查者外层 subreaper 完成孤儿清理并退出 0；没有把故障守卫拒绝等同于被杀 supervisor 自动完成了清理。

独立审查者运行的其他反例与轻量回归、最终源码绑定及结论见审查报告；实施方测试不能代替其签署。

最终代码／测试清单为 `/tmp/opencode-s6c-wiring-final-fscayis2/code-manifest-v5.json`，38 文件，SHA-256 `e42806ab539bd11f5947341f9c66e6dfad32dcad9c7ac66bd39307066b5e98c2`。共同运行身份为 `cd20f9d45309d9570293a19cdeef240cd12506a93e71095c9e27246571611390`。证据目录还保存测试日志、独立审查副本、最终完整 `source/`、`preservation.json` 及 `evidence.json`；后者记录完整快照和审查文件的最终 hash，避免文档对自身 hash 的循环引用。该目录是离线验证归档，不是已冻结的真实 cohort。

本轮前基线为 `/tmp/opencode-s6c-wiring-baseline-2026-09-20T034926802Z`，6,536 项，manifest SHA-256 `388d9b3632013c55ca7a228f7668bceb4c0a69800b681808ef918ba3ef54417c`。最终与该基线逐项核验，没有删除原有文件；改动限于上述评测实现和本轮状态文档。已有未提交生产改动、英文方案、历史 S6 设计／审查、S6b 报告及 S6c 准备 JSON 保持原内容；未提交、合并、发布或清理工作树。完整保全结果见 `preservation.json`。

局部和中间日志均保留：V1 为 35/35，V2 为 37/37；V3 扩大运行身份后，三项报告测试触及默认 5 秒测试限时，主动停止于集成之前（退出 143）。随后改为并行读取独立运行文件，身份／报告局部 4/4 通过（29 assertions），最终套件使用包约定的 30 秒默认测试限时。R5/R6 的早期恢复失败、provider 早期取消断言失败及独立反例原日志均未删除，不把历史失败解释为未运行。

当前验证限定于本环境 Linux x64 的隔离和本地 HTTP／TCP fixture。外部 HTTPS 部署、账户模型可用性、实际采样能力及真实研究质量尚未验证。下一步需要填入确切模型和受信部署配置、安排独立评分者，再按三例开发校准、最终冻结、66 例资格评测的顺序执行；当前没有可启动的实际模型配置。
