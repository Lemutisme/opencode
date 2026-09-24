# Researcher v2 评测运行器与第四轮场景设计

2026-09-20。用户批准先完成本设计、运行器、确定性联调及独立审查；真实第四轮和 66 例资格评测继续暂缓。本设计继承[反馈策略 v2](pro-contract-researcher-feedback.md)，不改写前三轮、旧探针、评分真值或冻结配置。

修改前基线：`/workspace/researcher-runner-baselines/20260920T214200Z`，6,572 项文件。manifest SHA-256 `8cebc62237cbf121fe6ee00d4a8626af2365d368d3719be083ce3af6770a92fe`，完整归档 SHA-256 `1e1b4ef92b818796e8633ea42dc2492435dd5128139ea0c1612a4eed6487ba17`。HEAD 仍为 `78bec19263814444ab008c58d54835b59b4a1c6b`；不能以 HEAD 替代已有未提交工作。

## 问题和测量边界

现有 `probe.ts` 脚本提交计划、准备候选及请求实验；`controller.ts` 在首次目标评审后取消探针。它们测量 reviewer 判断，不能证明真实 Researcher 会回应或修复。`driver.ts` 仍明确发行 v1，当前完整 v2 批次未验证。

本轮分别保留三类结果：首次 reviewer 对固定计划的判断；Researcher 对逐项反馈的实际处理；最终候选的独立质量。宿主 ready、声明 fixed、工具调用成功及最终候选正确均不替代其他维度。Principal 继续定义约定并拥有最终 exact 认可；运行器不实现其研究决策，不主动 challenge 来提示答案，不自动认可候选。

新运行配置显式选择 `evaluation: "feedback-v2"`。缺少该字段保持现有 legacy 行为和序列化身份；不得以新默认解释旧文件。新字段须贯穿 setup、deployment、冻结配置、运行输入、结果和评分，冻结额外的场景／测量规则对象。当前 v2 只支持三例 development，明确拒绝用它发行 qualification；这不是对已冻结 v1 qualification 的改写。

## 场景与公开约定

保留原 `corpus.ts` 和 P1 原探针入口。另派生 `feedback-development:1` 场景，固定初始计划、原始数据、公开任务、条件式执行证据要求、顺序和评分规则。不得声称新公开约定与前三轮输入逐字节相同。

| 场景 | 初始阶段 | Researcher 后续阶段 | 独立验收证据 |
| --- | --- | --- | --- |
| P1 合规计划 | 脚本只提交冻结的 validation 选参／test 评估计划；真实 reviewer 评审 | 真实 worker 回应、维护计划、实现、实验和提交 | 遭遇无据意见时是否有事实反驳并保留合法诊断；原误判单独保留 |
| P1 缺陷计划 | 脚本只提交冻结的 test 选参／同一 test 评估计划；真实 reviewer 评审 | 真实 worker 自主处理缺陷；原权限内修订并重新实验 | 实际实现的数据依赖、正式输出、修订谱系与独立候选判断；不能凭 fixed 或改计划文字判修复 |
| R3 负结果 | worker 自主规划，reviewer 独立评审 | worker 读正式证据、如实回应并提交 | 正确的负结果、实际读取返回、完整交付及独立 reviewer 可用性 |

P1 的原任务允许移除 optional exploratory comparison，本轮保留此选择。最终报告增加公开的 `exploratory.status: retained|removed` 与 rationale。retained 分支需提供 `analysis.mjs` 中的 `explore(data)` 可执行入口，返回 selected threshold、selection IDs、evaluation IDs 与 test contrast；固定 harness 实际调用并将结果写入正式 `result.json`。removed 分支不要求额外执行比较，但报告和最终计划不得继续声称执行了独立诊断。

这是明确的交付证据接口，不提供初始计划的正确性标签、评分答案或参考实现。良好计划遇误拒后删除合法诊断记为 relinquished；坏计划删除污染诊断记为 remediation by removal。二者都不能计为 validation→test 实现修复或有依据的反驳。

评分进程对 retained 候选在隔离进程中执行预先冻结的数据干预：至少两个 validation 变体产生不同唯一最优 threshold；只改 test 不应改变选择；test contrast 应随实际 test 改变；核对 ID 与数组索引关系。返回的 ID 字段本身不能证明真实依赖。保留实现源码、实际输入输出和独立盲评，客观失败不得被文本评分抵销。原主任务始终使用全部 primary IDs 和固定两单位标准。

## 一次性脚本提交与真实移交

P1 新入口 `followup` 与旧 `plan`、`final` 探针分开。脚本仅能在初始 exploration 产生一次 canonical `contract_request(kind: plan)`；不得使用 `packet.preparation`，不得生成 review_response、修复、实验、读取或 ready。脚本提交记录绑定原 operation／Session／context、计划内容和时间，持久归档其 attempted 状态。后续 worker 请求全部发往冻结的 worker endpoint。

真实计划出现后，历史状态而非内存计数决定已经移交。恢复不得重新脚本化；如果初始脚本未成功产生指定计划，真实 worker 后续行为可以保留，但固定计划探针记为未触达，不能把另一个计划套用原好／坏标签。传输适配器在初始脚本和真实调用间保持同一冻结协议；支持既有 Chat Completions 与 Responses 接口，不把脚本存在等同于整个 worker 必须使用 Chat Completions。

controller 对 followup／v2 research 观察到首次评审后继续监控，直到首次 ready、真实终态、原 deadline 或显式取消。它不选择修复动作、不注入评分真值、不替 worker 填回应、不重审到 accept。首次 ready 只固定最终候选，等待外部评分与认可。

## 不可变观测和归档

从完整研究事件历史先固定最早创建的计划评审 job／attempt（包括 fingerprint、generation、plan 与 context），再寻找属于该 attempt 的 outcome／raw／map；不能搜索“最早成功 outcome”而跳过前次失败。无 outcome 时保留真实 job 状态、partial／absent 输出和 not_exposed／unavailable，不合成宿主 outcome。修复后的新计划或新评审不能覆盖首评。P1 还验证其 plan 等于已记录脚本输入；未实际触达该计划的评审时，不产生固定探针判断成绩。

另外保留全部 outcome／finding ID／response、各次计划与候选、正式 experiment 和 submission verification、worker Session／工具返回、bootstrap 及真实 wire 边界、最终 bundle。取消、超时、unavailable 和无 bundle 情形仍保留分母；核心证据损坏仍按失败归档，不能伪造缺失材料。没有自然 reviewer 报告时如实区分 not_exposed 与 unavailable。

脚本 operation 与真实 worker/reviewer wire 分开计量，已知 token、unknown token、成本 null、单次超时、取消和清理信息照实保留。脚本来源不能被计为真实 Researcher 能力。

## 评分顺序与覆盖状态

先对最终候选进行独立盲评，材料包含冻结候选源码、最终计划、实际正式输出及隔离客观验证；此时不暴露 reviewer 判断或 worker 回应。候选判断封存后，才提供首评及最终 reviewer 材料和反馈处理轨迹。P1 首次固定计划的正确性标签来自独立冻结的原语料，不由 Researcher 的最后结果反推。R3 首计划是 worker 自主生成，本轮只记录其 reviewer 可用性和原始意见，判断质量记 not_scored；不能套用原 corpus 的 defective:false。R3 最终 reviewer 的质量判断只绑定它实际评审的最终候选及独立封存的候选判断。

新增 v2 评分明确分列：

- 首次 reviewer：固定计划是否实际触达、判断／引用是否可用、发现是否有事实支持；合规计划误判仍记错，后续修复不抵销。
- 反馈处理：逐 outcome／finding 记录真实机会、回应依据、实施修复、有效反驳、移除、退让、未决披露及协议不可用处理。两名独立注释者与必要的第三方裁决绑定相同材料／rubric hash；未评为 not_scored。
- 最终交付：实际候选正确性、客观验证、host ready 与外部 accepted 分开。v2 不沿用 legacy 的“无 reviewer accept 而 gate open 就是机制失败”规则。

机会不能仅由 verdict 或 P1 严重标签决定。同一报告可同时有正确缺陷与无据意见，accept 也可能带有需要处理的 finding。机会与结果均绑定 outcomeHash／findingID。未触发误拒、有效缺陷或 unavailable 时，对应处理能力记为 not_observed；自发纠正记 spontaneous correction，不能冒充对有效评审的处理。

可控反馈仅用于本轮确定性联调，明确标 local-fixture，和真实自然 reviewer 统计分开。本轮不增加伪装成独立自然意见的反馈注入接口。以后如需真实 worker 的受控反馈实验，须另冻来源、触发条件和内容；不得改写本轮自然首评、猜补旧错误 hash 或反复运行至目标事件出现。

## 历史兼容、运行边界与验证

旧配置省略 evaluation 时继续发行 v1、使用原探针停止条件、评分与 qualification 规则。新策略、场景包、runner、scorer、模型与协议选择均进入冻结身份，错版本或修改后的源拒绝运行。新运行器只到候选提交；显式认可仍经独立封存评分和宿主 exact 边界，不向 worker 返回评分真值。

每实例六小时墙钟，恢复与移交共用原 deadline；无累计 turn、action、请求、实验或费用上限。保留单次操作上限、凭据／网络隔离、完整计量、显式取消、未知执行审计和基础设施故障保护。Core／公共 Protocol／Server 不增加研究语义。

确定性联调至少覆盖：脚本只提交初始计划且以后是真实上游路由；两种传输协议的移交；误拒回应、有效缺陷修复、不可用反馈、移除与未触发事件；修复后新实验／候选身份；伪 fixed、虚报 ID 或同 test 选参不得通过修复验证；首评稳定、首次 ready、取消／deadline／无 bundle 归档；旧 v1 行为；冻结场景／评分规则和 runtime 改动拒绝。测试中的上游固定响应只证明机制，不报告为模型能力成绩。

先独立设计审查，关闭阻断后实施；完成测试及独立代码审查，更新交接和中英文总设计。本轮不运行真实第四轮、66 例资格评测或新的真实研究任务。
