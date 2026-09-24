# S6c 本机 Responses 接线与首轮真实开发校准

2026-09-20。用户允许复用服务器上的 Codex 服务、选择更快更便宜的模型并进入实测。本轮完成本机 Responses 接线、测试和独立审查，随后运行了一个三例开发校准批次。真实请求已经发生，但校准发现阶段提示和公开语料问题，批次已停止；没有启动 66 例资格评测或 S6d 研究试点，没有资格通过结论。

依据为 [S6 设计](pro-contract-researcher-s6.md)、[设计审查](pro-contract-researcher-s6-review.md)及[原离线接线记录](pro-contract-researcher-s6c-wiring.md)。这些历史文件和旧批次保持原状。本记录是在新批次结束后追加的，不把原离线审查签字套用于新代码，也不把 Codex CLI 连通测试计入研究探针。

## 后端与新增接线

Worker 和 reviewer 均使用 `gpt-5.6-luna`、`reasoning_effort=low`，受信上游固定为 `http://127.0.0.1:8317/v1/responses`，`credentialEnv: null` 明确表示本机免密网关。复用的是已由 Codex CLI 验证的服务；模型执行仍经过 OpenCode 的生产 Session、canonical tools、research reviewer job 和实际 gate，没有嵌套调用 Codex agent loop。

修改仅涉及 `packages/opencode/script/research-eval/` 下的 `provider.ts`、`launch.ts`、`instance.ts` 及各自测试：

- 保留 HTTPS／环境变量凭据配置；真实免密 HTTP 只允许 `127.0.0.1`。协议由冻结 endpoint 绑定，角色仍由受信 operation 确定。
- Responses 使用仓库现有原生协议实现。P/F 的脚本 worker 继续使用本地 Chat Completions fixture；reviewer 和 R worker 使用真实 Responses。
- 冻结的 `reasoning_effort` 映射为 Responses `reasoning.effort`。禁止存储会话、异步后台请求、托管工具和远程输入；只允许已声明的本地函数选择和带 `encrypted_content` 的本地 reasoning 重放。
- 保留凭据隔离、候选授权头拒绝、取消、原 deadline、流记录和完整 transport 内容身份。

每例仍只有 21,600 秒累计墙钟上限，无累计 turns/actions/requests/费用/attempts 上限。单次 provider 为 900 秒、tool 为 600 秒、verification 为 120 秒、cleanup 为 30 秒。模型限制配置为 context 1,050,000、output 128,000，依据[官方模型文档](https://developers.openai.com/api/docs/models/gpt-5.6-luna)；它们不是新增累计预算。seed 标为 `unsupported`。实际服务账单未知，不以官方标价冒充网关费用。

本轮独立的小型 Responses 函数调用返回 `sum(2,3)`，76 tokens，记录在 `/tmp/opencode-local-responses-route-cffyywyt`。两次 Chat Completions 路由尝试均为 HTTP 403，分别保留在 `/tmp/opencode-local-chat-route-ekr6zvxp` 和 `/tmp/opencode-local-direct-route-yven4r8y`。这些接线检查不计入开发 cohort。

## 验证与独立审查

| 检查                                   | 结果                  | 日志                                     |
| -------------------------------------- | --------------------- | ---------------------------------------- |
| 路由与完整冻结配置                     | 8/8，54 assertions    | `/tmp/s6c-responses-route-tests.log`     |
| 完整实例回归初轮                       | 7/8；保留 R6 断言失败 | `/tmp/s6c-responses-instance-tests.log`  |
| 最终代理准入／取消回归                 | 5/5，49 assertions    | `/tmp/s6c-responses-route-final.log`     |
| 最终 R3 Responses 与 R6 回归           | 2/2，32 assertions    | `/tmp/s6c-responses-instance-final.log`  |
| `packages/opencode` 的 `bun typecheck` | 通过                  | `/tmp/s6c-responses-typecheck-final.log` |

初轮 R6 的实际恢复已到 `ready`，但旧测试固定要求三次 reviewer 调用。其保留了已批准计划，合法恢复的是 verifier job，只需计划／最终两次审查。测试现按实际 `replan` 分支精确断言；没有改变生产恢复行为。旧失败和证据目录 `/tmp/opencode-s6c-full-0cb0e92e-a83e-4f98-ae8a-b9ff7f83366b` 保留。

独立 agent `/root/s6b_verify` 发现并复核关闭两项准入遗漏：托管类型的 `tool_choice` 和只有 ID 的 reasoning 原先可被转发；最终同一反例返回 403，合法 encrypted replay 仍返回 200。审查还独立核验 R3 Responses 的七个 wire operation 均记录 fixture 的 13 tokens、完整归档身份和 exact 认可，以及 R6 的原 deadline、unknown operation 和恢复 lineage。最终增量审查无遗留 P1/P2；这是接线审查，不是模型质量审查。

最终六文件清单 `/tmp/s6c-review-responses-final-manifest.json` SHA-256 为 `4cb129a379ab35493f89f136cc38ad684afbb897f20fde945ce6baca0606aa7b`。运行代码身份为 `65aaf51e60686167391b0cfd43dc7dc59593c60f71d9ef1a2afdce7f2478bb11`。反例、最终日志和审查记录也复制在下述批次目录的 `validation/` 和 `review.json` 中。

## 首轮真实结果

完整目录为 `/tmp/opencode-s6c-luna-development-iwehh2n1`，包括 `setup.json`、`freeze/`、`cohort/`、`cancellation.json`、`execution-summary.json` 和验证材料。配置先冻结再运行，执行期间未改变源码或配置。冻结配置文件 SHA-256 为 `4352c8a4037b11063f57065bbed63a4853fc0f7e01c6bd7dcd064645bba8817d`；完整源码 manifest SHA-256 为 `2f6d7d0ce8b48c30488bd0f37f3c7de3da5664b8937cd2eacb173f51137c73ab`。

沿用既有 seed 的排序，实际顺序是 P1 坏计划、R3、P1 好计划对照。三例均已登记且已发行；最终状态如下，不能按取消时的预期把最后一例写成未启动。

| 实例                                     | 实际结果                                                                                                                                                      | 模型 wire requests | 用量                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------- |
| P1 坏计划 `105ad0d3a8f84a996709fac1`     | 首份目标报告完成；`changes_requested`，目标数据泄漏被指出，但附加了计划阶段不应要求的最终交付物；`pending_scoring`                                            | 3                  | 13,809 tokens                                   |
| R3 `094dc33dc897a592f56af228`            | 四轮计划评审均要求未生成的报告；最后一份报告把证据 hash 少抄一位，触发 schema 错误，进入 `unavailable`；没有进入正式实验或产生完整候选，`scoring_unavailable` | 21                 | 107,104 tokens                                  |
| P1 好计划对照 `e2a6db9dc83b48959d244f4d` | 批次停止时已开始；在途响应被显式取消，`cancelled`，不得把部分文本算作完成的 verdict                                                                           | 4                  | 已知 14,346 tokens，另有一个 operation 用量未知 |

合计 28 个模型 wire requests，已知 135,259 tokens，另有一个未知用量 operation；费用保持 `null`。R3 的自然失败发生在显式取消之前；取消实际中断了最后的 P1 对照。三例均保留原六小时 deadline，未延长或重置。所有 result root、完整 transport 和 cohort 事件链均校验通过；控制器已退出，没有残留 cohort 进程。全局 Codex 配置 hash 未变。

停止理由是已观察到的计划／交付阶段循环和材料歧义，不是新增请求数或费用上限。所有失败、部分响应和三个分母均保留，没有成功重跑覆盖。尚未完成双人盲评，也没有对真实候选执行 exact 认可。原始 launcher 摘要中的 `qualification: pending` 是未完成评分的通用占位；本批次 `mode` 为 `development-calibration`，资格批次实际未运行。

## 校准发现与接续

独立诊断确认了两个前置问题，不能仅凭本轮结果断言 Luna 的一般研究质量：

1. **计划评审混入最终交付要求。** `packages/sdk-next/src/research/planning.ts` 的计划提示插入了 `driver.ts` 提供的最终交付式 reviewer instructions；材料包含空 `report.json`，没有明确说明这是尚未执行的候选。模型反复将缺少报告／`result.json` 当作计划阻断，但 worker 此阶段只有读取和 Contract 控制权限，不能完成这些交付。固定 smoke harness 非穷尽也被部分报告误当作必须修改的阻断。
2. **公开 split 与观测的对应不清楚。** `data.json` 的 `a`／`b` 是各四个数的配对方法数组，却同时声明 train `[a,b]`、validation `[c,d]`、test `[e,f]`，没有观测 ID 到数组行的映射。模型对缺少 validation/test 观测的质疑有公开材料依据，不能简单当作错误拒绝，也不能让 reviewer 忽略它。

R3 的 63 位证据 hash 是另一个已观察到的模型格式错误，现有 schema 正确拒绝；没有由 controller 替模型补字或改写报告。好计划对照只保留取消前的部分响应，不用于判断最终接受率。

下一步应另立新版本：明确计划评审只检查可执行性和约束保持，最终报告／实验产物在后续阶段验证；澄清观测 ID、split、all-pair 主指标与 held-out 评估的关系，并复核好坏配对标签。先做回归和独立复核，再冻结新版三例开发校准。原语料、设计签字和本次批次保持不变；当前不启动 66 例资格批次。

## 工作树保全

本轮编辑前基线为 `/tmp/opencode-s6c-responses-baseline-u2kc8onv`，包含 6,555 项文件的 hash／mode 清单及六个目标文件副本。运行前核验只有上述六文件变化，无文件缺失；新增本记录和交接更新发生在实测结束之后。既有未提交改动、英文方案、历史 cohort、设计及审查均保留。没有提交、回退、清理或修改历史运行配置。
