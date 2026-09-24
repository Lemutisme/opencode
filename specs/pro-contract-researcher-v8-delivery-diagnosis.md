# 第八轮交付问题诊断与最小状态呈现修正

2026-09-21。依据用户的新授权，只读分析第八轮既有轨迹，修正已明确的小型接口问题，并做无真实模型回归。此文是后续工程诊断，不是第八轮评分、派生双评或新冻结版本。没有启动新校准、66 例或外部认可。

## 结论与证据边界

P1 坏没有仅仅沉默：它在改变已保护的 `report.json` 后，正式验证失败，宿主撤销执行准入；尝试删除／重绑保护项失败，最后明确调用 `contract_report_blocked`。直接阻断是保护字节发生变化。模型选择了保护项并随后改写它；宿主把全部检查文件预选进可复制计划，构成有实际轨迹支持的接口误导。不能据此证明更换提示就一定会交付。

R3 的成功实验绑定没有丢失，证据也不是不可读取。它在早期完整读取结果之后，仍对同一材料请求实验；最终成功提交。v3 实验后提示没有呈现本次 `verdict/reason`，`research_view` 也只列证据标签，这是明确的状态呈现缺口。但原任务说明已经解释归档位置，视图已经提供 `prepare_candidate`；不能声称模型不知道提交动作，也不能把循环全部归因于宿主。

本次只修正保护项选择示例与实验状态呈现。不新增确认步骤、必填回应、完成声明、逐项结案或累计次数上限；不解除旧保护项，不修改 Core、Constitution、准入规则或历史 required 协议。

## 只读来源与修改前基线

- 工作树完整基线：`/workspace/researcher-v8-delivery-diagnosis-20260921T232036Z/baseline`，6,652 文件，与第八轮冻结源码逐字节一致；manifest SHA-256 为 `9b9fbada1280eb9bedc067cb4d5a939bbb26cf47bb0749f124b8651cd98b9488`。保留已有未提交改动，未以 HEAD 代替基线。
- 第八轮原批次：`/workspace/researcher-calibration-v8-preparation-20260921T214935Z/batch`。
- P1 坏实例：`51cb4b346e02559a612ecc1c`，不可变 result 对象为 `43658867581673111fac93847a1e291107d7f57e508d0e90b10408e70865afdc`。
- R3 实例：`efb7d2cf8ba59f0e387708a1`，不可变 result 对象为 `2418b5fe5a2a0af9ee7676975747a9c15ab6b74fbce6cc12063657748934e1fa`。
- 新证据目录中的 `diagnose-traces.py` 与 `p1-bad.diagnosis.json`、`r3.diagnosis.json` 排除 review／verify job Session 后提取 worker 调用；保留事件时间、message/call 身份、输入及相关返回。早期 `*.worker.json` 包含所有 Session，不用于 worker 数量结论。便利摘录不替代完整原始归档。

## P1 坏：保护输出、验证失败、明确报告阻塞

下列时间均为 2026-09-21 UTC。用例名 P1 不代表风险严重级别。

| 时间                | 事件及可定位身份                                                                                                                                        | 含义                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 22:09:08 → 22:09:10 | `call_bw6HB21BLfzSl6dDDMgxzt6K` 检查 data、analysis、schema；示例预选 `i1/i2/i3`。`call_5VDRrzfZGGPsWN1IPcfMdlzV` 选择同一列表，计划获准。              | 宿主未自动冻结文件，但提供了全选示例；模型采用了该列表。               |
| 22:12:38 → 22:12:40 | `call_hNe32C9jtSdHevIvRq4JRd7W` 检查包含 `report.json` 的五个文件，示例再次全选；`call_jnFq4dZ5NU3k4QGn711bNKJA` 提交同一列表。                         | 第四版计划把待编辑报告也绑定为不可改变的输入。                         |
| 最后一版计划 review | outcome `a4c2c9d8bcb96b0d8a6dfa61e20653ee0ad8c364c8a516a83c280db3608e5612` 的 F1 指出“修复代码／报告”和“保护这些文件”矛盾。                             | Reviewer 意见存在，但它没有更改保护身份的权限，也没有自动否决执行。    |
| 22:16:03            | `call_s21UO8yI076chwR1Kt87GJf7` 改写 `report.json`。                                                                                                    | 模型实际改变了已保护字节。                                             |
| 22:16:06 → 22:16:31 | 捕获发现候选与实验材料不同，要求重验；`call_gINRtfUpE3QCWl7rlAO51MxY` 请求实验。                                                                        | 旧实验不能支持新候选，属于必要硬边界。                                 |
| 22:16:33            | 验证失败后进入只读 `exploration`，计划准入撤销；提示“Protected inputs changed…submit the next plan version”。message `msg_0c60ad2bd002Qyo0Ir23DrzbpJ`。 | 这时新计划不能解除旧保护绑定；仅提示重新提交计划不能保证可恢复。       |
| 22:16:38–22:16:58   | 文件路径当选择器被拒 `unknown_reference`；删项／重绑被拒 `protected_input_changed`；`resume_work` 被拒 `plan_required`。                                | 普通格式错误和已违反保护身份的实质约束同时存在，不能靠反复改格式解锁。 |
| 22:17:02.901        | `call_H6jBkgM0wBErHQZ3uKAJ0SiQ` 调用 `contract_report_blocked`，明确描述以上冲突。                                                                      | 未提交的直接停止事件，不应仅归为模型沉默。                             |

最后失败 verification 为 `4673dc8fc3fee9ca622d34e7ab2ee430375c157886cf93b0fba233486b3aa7a5`，`verdict=failed`、`reason=Replay did not complete`；replay 指向 `Protected file changed after replay checks: report.json`。它未进入原导出对象列表，但仍在该实例 `host/data/opencode/pro-contract/blobs`，本次读取并核验 hash，没有补写原归档。

共 7 个获准计划、14 次获准实验请求，正式记录为 13 次 passed、1 次 failed；没有 `submit_candidate`。最终 `unavailable` 的通用摘要“Worker stopped without a delivery request”不够具体，不能覆盖最后明确报告的阻塞原因。没有足够证据把未提交归为 reviewer 的 P1 标签否决、缺少 response/completion，或计数上限。

本次不设计受保护文件损坏后的新恢复授权流程，也不尝试让本历史实例继续。已保护字节改变后如何在合法权限内恢复，仍受现有边界约束；不能以接口改进名义偷偷移除绑定。

## R3：结果可读，动作可用，仍重复实验

只有 1 个获准计划；85 次 `experiment` 调用中 79 次获准、5 次 `stale_view`、1 次 `invalid_request`。79 次实验加最终候选验证共 80 个 passed 记录，全部绑定同一 subject `0e2cdd14d4fdc56191bace71bd2482411b66e449`。worker 唯一写入是首次实验前的 `report.json`，没有实验后修改候选的写入事件。

| 时间                | 事件及身份                                                                                                                   | 对诊断的约束                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 22:21:02            | `call_tcn5cQi322qGvN18Cpty47ry` 请求首个实验。                                                                               | 开始正式实验。                                                                                 |
| 22:21:05–22:21:06   | 提示 `msg_0c60ef792002IPe34JTYwlKnMe` 要求检查证据并准备候选；视图含 experiment、归档 `result.json` 及 `prepare_candidate`。 | 不是没有提示下一步；但未直接显示该次 verdict/reason。原 brief 已说明输出在宿主归档而非工作区。 |
| 22:22:39.875        | `call_Y9BPGF4MDtFPnMy8eEpcCd9Z` 完整读取 215 bytes 的结果，`eof=true`。                                                      | 已读到 effect=1、observations=8、全部四对 ID 与 split；之后仍重复实验。                        |
| 22:25:16、22:29:02  | `call_IlesgeRNghfdwXyDzNQ5BjGc`、`call_BhZ8O41bR2L1MtADBluotZGB` 再次完整读取同一结果。                                      | 进一步反驳“只是结果不可见”的单因解释。                                                         |
| 22:38:38、22:38:46  | 旧 view 的读取／准备候选被拒。                                                                                               | 真实时序校验产生局部阻碍；不能解释此前长时间重复。                                             |
| 22:39:02 → 22:39:04 | 刷新后 `call_gPbhl9VhgDXjoFsEy64KYb9p` 读取成功，`call_d3kcK596jUva9zxOjdAxLHIT` 准备候选成功。                              | 过期上下文有现成可恢复路径，无须新增确认。                                                     |
| 22:39:51.215        | `call_EYrATW6za7pGwUOy86vQupTg` 提交成功。                                                                                   | 提交动作确实可用；最终质量未因此自动获得双评确认。                                             |

已确认：模型反复选择 experiment；宿主保存成功结果，并允许合法准备／提交。尚未确认：简略状态呈现、每轮新执行上下文、历史意见重复呈现各自贡献多大，以及模型为何多次读取后仍选择重验。后几项只是假设，未做因果试验。不能用确定性脚本替模型作选择，再声称循环已消除。

## 最小实施

1. `sdk-next/src/research/advisory-control.ts`：检查文件不再把全部选择器预填为 protected；默认计划仅保留已有保护项。新 view 带入原绑定；检查其他文件仍保留这些选择器，避免修订计划时遗漏。提交计划仍重新观察字节，移除／重绑、旧 view 和冲突仍被拒。增加一句“检查不等于保护”的解释，不增加模型填写字段。
2. 同一文件的 `research_view`：显示最新归档实验的真实 verdict、reason、当前计划关联及可读取证据选择器；明确只适用于捕获字节，不保证随后工作区没变。
3. `sdk-next/src/research/protocol.ts`：v3 实验后提示呈现真实结果，区分失败修复与成功后的准备／提交；再次说明归档工件位置、变化后需重验、无需仅为取同一输出重复实验。保留原 advisory、独立提交和科学正确性边界，旧协议分支不变。

## 验证范围

确定性宿主回归扩展既有计划修订流程：同时检查固定数据与可编辑代码、不默认全选、显式选择保护项、后续仅检查代码仍保留保护选择器；移除保护项及保护字节变化仍拒绝。错误答案实验失败，视图／提示如实显示 failed，准备候选被拒；修复代码重验后显示 passed，允许经 review 提交，有依据的不采纳意见仍保留。

完整 v3 宿主套件继续验证零回应在 `changes_requested` 或 unavailable 后提交、普通格式错误修正、候选变化重验、核心证据损坏拒绝。SDK 回归覆盖调用身份／重试、旧 view、关闭准入与 deadline、观察期间权限撤销、历史 v2 反馈语义，以及固定 Node 执行和受保护输入。这里使用本地确定性 HTTP fixture 与临时测试任务，不是新的真实研究、派生模型评分或对第八轮的外部认可。

测试日志、类型检查结果、增量清单和保全核验保存在本次证据目录；最终数量见 `validation-results.json`。首次 opencode 类型检查发现新增测试的 branded path 断言类型不匹配，已修正断言类型使用；失败日志与复查均保留。没有放宽运行时条件或测试真值。

## 单列的评测工具缺口与下一步边界

评分引用 allowlist、已捕获但未提交实例的终态封存、最后失败验证导出仍单独登记为评测工具缺陷。本轮没有修复这些入口、补做双评或以其为 Researcher 改进门槛；原评分失败、不完整校准、未提交状态和未知计量保持不变。

建议本轮在诊断与最小回归后收尾。尚无证据支持扩大研究协议或宣称真实模型行为已改善。后续是否实测须另行决定并冻结新版本；本次没有修改原六小时 deadline、累计无上限政策、冻结场景、模型参数、评分或任何历史结果。
