# ProContract 论文实验总计划

日期：2026-09-04。状态：实验设计与代码审查，不是已完成的模型性能实验。

本文是 orchestrator 的决策入口。论文论证与证据边界以
[paper skeleton](../pro-contract-paper.md) 为准；三个研究报告分别负责
[因果与性能](causal-study.md)、[可靠性](reliability-study.md) 和
[递归改进](rsi-study.md)。

## 0. 当前方向决策

修订日期：2026-09-04。本节明确替代同日较早的 C2-first 决策。先前三个 Sol 报告
完成的是设计、源码审查和既有测试复核；本次另做定向 Sol 反方审查。我们没有启动新
性能 campaign，不据此推断用户自己运行的 campaign 状态。

**主线：当执行者和搜索策略变化时，什么让未履行责任、当前完成认定及失证后的
处置保持连续，而不必固定搜索过程？**

更尖锐的切入点是：**相同产物与测试日志，可能因授权与支持历史不同而必须得到
不同认定。** 因此研究对象不是更长或更短的提示词，而是足以区分这些历史的状态与
转换语义，以及它们相对强工程基线的实际价值。这个反例本身不构成新颖性证明。

### 研究取舍

- **C1 是当前主实验。** 固定搜索能力、验收器和预算，测生命周期中的错误接受、
  错误 quiet、有效交付、错误阻塞与恢复成本；逐项删除语义，不把所有保护一起关掉。
- **C2 降为接口假设。** 固定同一个认定机制之后，比较信息投影方式。无论投影结果
  阳性、阴性或等效，都不能单独证明或推翻认定权分离。
- **C3 后置。** RSI 必须挣得自己的证据，不靠更高层 MetaContract 或代数进入标题。
  先验证策略变化后可正确采用、撤销并保留效用，再检验递归是否优于一次改良。
- **强 CI/持久工作流是主实验对照。** 不需先建设通用平台，但必须给常规机制合理的
  配置与相同信号。若其补齐语义后同样有效，继续保留为基线，不能宣布“它已变成
  ProContract”而将其排除。
- **200 题是效用支柱。** 用户报告 Luna Max 全集约领先 leaderboard Sol 1.5%，需要
  固定最终聚合及指标。它支持整个系统的竞争力，不单独识别 kernel 的因果增益。

### 质量标准

1. 保持性能第一：冻结预算下最终产物独立质量与有效交付不能缺席。可靠性不能用
   永远拒绝来获得；不把质量、可靠性和成本临时拼成一个能赢的加权总分。
2. 不能以降低验收要求、越权或额外预算换分。200 题报告取代仅靠三题 pilot 的效用
   叙事，但外部跨模型比较仍不等于匹配因果对照；百分比与百分点也必须分清。
3. 每个工程改动必须服务于“操纵一个因素、观测一个变量、排除一种替代解释”之一。
   不能说明这一点的框架、抽象层或状态机暂不做。
4. 架构失败、接口失败和递归失败各有独立判据。不用投影失败否定架构，也不用漂亮
   分数掩盖权限/责任边界失效；不给已观测的结果事后改写 claim。

以下研究地图保留先前报告的审计价值，当前优先级以本节与第 8 节为准。旧的
request-only P0 不再是唯一最高优先级；它仅是接口实验的前置审计。

## 1. 本轮授权与交付边界

- 保存论文骨架，并由三个 `gpt-5.6-sol`、`xhigh` 研究员分别探索三个实验方向。
- 研究员只能修改各自报告；不改 runtime、不提交 Git commit、不创建分支。
- 允许只读源码/已有结果审查及必要的现有本地测试。
- 本轮不启动付费模型 campaign、容器实验、下载构建或云资源，不把方案写成结果。
- 编排者负责研究结果整合、相关工作定位、文档一致性与分阶段放行条件。

## 2. 决策顺序

先冻结主张和独立 oracle，再验证成对历史；把核心语义接到真实任务生命周期后，
才有实践价值证据。请求投影审计走次级接口分支，递归实验走更后面的分支。

| 阶段               | 要回答的问题                             | 放行所需产物                                               | 当前定位                                   |
| ------------------ | ---------------------------------------- | ---------------------------------------------------------- | ------------------------------------------ |
| G0：证据与实现审计 | 我们究竟在运行、比较和测量什么？         | 精确坐标、可验证证据链、可运行控制臂清单                   | 本轮只读审查覆盖部分，不等于工程缺口已补齐 |
| G1：无模型验证     | 同产物异历史能否得到正确且不同的处置？   | 独立 oracle、强 workflow 参考、逐项语义消融、正常/扰动控制 | 首要工作包，不等同于已建立强部署隔离       |
| G2：决定性小试     | 这些语义能否改善真实任务的持续有效交付？ | 固定模型与预算、完整恢复轨迹、错误接受/quiet/阻塞及成本    | 不预设正向结果，不把 pilot 当确认集        |
| G3：冻结确认       | 效应能否跨任务重复，代价与坏尾如何？     | 冻结处理和分析、独立任务、完整失败账本                     | 样本规模由 pilot 方差和有意义效应确定      |
| G4：递归价值       | 自改进参与下一轮是否产生额外价值？       | 固定/一次改良/递归，以及必要的固定生成器迭代部署对照       | 不是增加 MetaContract 层数的演示           |

不必先证明 G2 的性能提升，才能研究 RSI；但不得把未隔离的处理效应或未建立的
证据来源作为 G4 的既定前提。如果 placement 假设被推翻，应先改写论文主张，
再决定是否以独立 RSI 问题继续。

## 3. 统一实验登记

每个阶段开始前登记以下信息，不能仅记录 OpenCode commit：

1. **实现坐标**：OpenCode、runner、模型适配器和 evaluator 的 revision；若工作树
   不干净，附精确 patch/content digest。记录实际运行二进制与镜像 digest。
2. **模型输入**：provider/model ID、版本可用信息、reasoning 设置、完整 prompt、
   工具定义、execution policy、角色与注入时机、截断/压缩和缓存设置。
3. **实验处理**：要改变的唯一因素、保持不变的因素、实际请求层面的处理核验，
   以及哪些条件因实现原因无法完全匹配。
4. **任务与运行**：预先固定的任务集合、划分、run ID、重复次数、随机化/分块方法、
   reference 与 evaluator 的可见范围。
5. **预算与成本**：墙钟、turn/action、调用成本和搜索总成本；恢复、失败候选和
   验证成本是否计入、如何计入。不得按已花费用反向截断已有轨迹来伪造匹配预算。
6. **结果协议**：候选选择/冻结时刻、subject 身份、外部评估、主指标、坏尾、
   排除条件、缺失值和基础设施失败处理。
7. **统计与决策**：estimand、实验单位、置信区间/检验、最小有意义效应、
   多候选/多指标选择规则、停止及放弃条件。
8. **责任与证据**：谁生成记录、谁能变更记录、谁能调用晋升/结算、谁接收评估反馈，
   以及原始报告如何绑定到被评估的精确候选。

字段齐全不是证据真实的证明。必须通过独立 recorder 与实际可执行的权限边界，
保证候选不能自己编造其使用的结果。

## 4. 共享指标与禁止混用的结果

性能主轴为冻结预算下最终选定产物的独立行为质量，另报成本、时间和有效交付率。
研究阶段可以比较质量/成本曲线，但不能未经声明把最高质量目标替换为最低成本。

架构主轴同时报告 false acceptance、false quiet 和 bounded-horizon valid delivery，
另报 false blocking/excessive reopening。对同一声明范围，quiet 只能由 `discharged`
或 issuer 授权的 `released` 支撑；release 不是任务完成，escalation 也不是 quiet。
缺乏调度或预算可以妨碍最终完成，但不能让尚欠责任消失。

200 题至少分别报告 fully resolved、almost resolved 和 average pass rate；后者
不能冒充 leaderboard 主指标。保留所用 cohort 的完整失败/恢复账本，不能用一部分
已评分样本的均值冒充 200 题结果。+1.5 的指标、单位和最终报告坐标尚待对应。

以下状态分别统计，不能统一叫“成功”或“失败”：

- 完成真实任务并具备有效证据；
- 正确履行一个有限交付条件，但任务行为质量不足；
- issuer 授权 release，未实现原目标；
- 不具备权限或证据的操作被正确拒绝；
- 本来可以完成的任务被错误阻塞；
- provider、observer、runner 或 evaluator 的基础设施失效；
- 候选程序的行为错误、超时或缺失产物；
- 实验如实完成，但候选提升假设被拒绝。

如果主分析采取 invalid-as-zero，另报 invalid 原因与比例，并冻结敏感性分析。
不得把恢复运行覆盖原始 invalid，也不能在看到结果后选择 valid-only 平均。
一题内部的大量测试不是大量独立任务，三题小数点后四位也不是统计确定性。

## 5. 相关工作与新颖性纪律

编排者核对的比较方向包括 ADAS、DGM、CaMeL、AgentSpec，以及 Scientific CI/CD
公开稿。候选生成、archive、外部 enforcement 和独立晋升本身都不能宣称首创。

- [ADAS](https://arxiv.org/abs/2408.08435)：代码形式的 agent 搜索与候选 archive。
- [DGM](https://arxiv.org/abs/2505.22954)：自身代码修改、经验评估、后继继续改进与
  open-ended archive；需要正面对比，而不是只比较普通执行代理。
- [CaMeL](https://arxiv.org/abs/2503.18813) 与
  [AgentSpec](https://arxiv.org/abs/2503.18666)：外部安全/运行时约束的相关边界。
- Scientific CI/CD for Self-Modifying Discovery Agents：检索可见的公开稿已讨论
  统计门禁、预算、领域 verifier 和回滚。直接全文访问遇到站点验证，发表状态与
  方法细节尚未完整核实，因此这里只把它列为必须解决的新颖性风险。

另一个必须比较的近邻是 [CommitGuard](https://arxiv.org/abs/2607.10487)，其正文
已经讨论当前端点相近、授权历史却不同，以及 commit-time freshness。不能把
“认定依赖历史”单独当首创。主张应落在责任保留、已认定支持的撤销及其下游闭包的
组合语义与实测价值；还需正面对比 truth maintenance 与持久工作流，不预判对方缺失。

我们希望获得的新知识是：哪些状态区分和生命周期语义对可靠完成认定必要，哪些
组合能在不固定搜索的情况下保留责任及有效结果，相对强工作流付出什么代价。
信息呈现是否影响搜索表现是单独的次级问题。这些都不是已证明的新结果。

## 6. 放弃或收窄条件

- 匹配上下文后效应消失：只收窄接口主张，不声称制度认知效应，不自动推翻 C1。
- 在承诺的信任边界内，生命周期转换仍丢失义务或保留失证认定：核心实现主张失败，
  不能用 200 题分数或投影收益替代修正。
- CI、不可变产物与 durable queue 已足以实现同样边界和结果：不声称 ProContract
  必不可少或独有。若连开销、验证负担和可移植性也无优势，放弃经验优越性主张。
- 当前调用方可伪造被信任记录：先修证据来源或收窄为 trusted-caller，不能继续宣称
  对抗条件下可靠晋升。
- 更多递归轮次只增加筛选机会：与同总成本固定机制无法区分时，不作 RSI 优势声明。
- 独立确认出现不可接受坏尾：保留负结果，不能事后更换任务、阈值或主指标救结论。

## 7. 三份研究报告的整合结论

三个 Sol 研究方向均已形成报告；编排者复核并收窄了部分措辞。本轮并未实现新
harness、基线、隔离边界或递归闭环。

1. **先更正 exposure 定义。** 当前 `executionPolicy` 只 admission 一次，但 compaction
   前会随 history 进入后续 requests。已有 projection 对比不是“一次可见”对“反复可见”，
   而是 history-carried 内容上再增加不同 role/位置的副本。具体见
   [因果报告](causal-study.md#21-admissionhistory-与-projection)。
2. **控制臂尚不充分匹配。** 现有普通 runner 已有不少 durable execution/CI 能力，不能
   将其描述为无保护；但当前两条路径仍存在 binary、prompt、permission、delivery、ready
   signal 和 budget 口径差异。共同 model-facing ready facade、institution-neutral budget
   与 request-segment recorder 都是待实现项，不是现成 CLI 开关。
3. **可靠性最强主张仍是坐标完整性。** 现有测试覆盖不等于所有可到达路径都被 fence。
   旧 Session control tools、permission/tool 间接 principal 路径、跨事务 crash windows
   是静态审查提出的待验证问题；尚未构成完整端到端漏洞复现。执行权限也不是 OS sandbox。
4. **当前 RSI 只有部件，没有可信晋升闭环。** JSON adjudication、development selector、
   exact export、raw `executionPolicy` binding 分别存在，但 evaluated policy 到真实
   successor admission 的可信身份链仍需 experiment-owned binder/recorder。不能恢复
   `spec.policy` 来掩盖这个边界问题。
5. **`R-O` 不是所有递归主张的充分识别。** 它首先测持续适应相对一次改良冻结的价值。
   若论文声称后继参与生成使候选分布更好，固定生成器但允许持续晋升/部署的对照不可省略。
   seed 阶段没有成功 S1 的 assigned lineages 必须保留，不得只分析成功起点。

两个额外的统一口径：

- budget-end 强制冻结可以提供诊断性 artifact score，但不能自动算 authorized delivery。
  在 pilot 前决定主指标是 artifact quality 还是 authorized-delivery quality，并并列报告另一项。
- `minMeaningfulDelta` 由应用价值事前定义；blinded pilot variance 用于选择样本量，而不是
  调整门槛以配合观察到的涨分。

## 8. 推荐先执行的最小工作包

**P0：成对历史的生命周期判别。尚未实现或执行。** 这是新的首要工程包，替代旧的
request-only P0；不先建递归 controller、通用 policy registry 或另一套完整工作流平台。

1. **先冻结 claim 与独立 oracle。** 对每个事件前缀规定允许的 decision、当前 support、
   outstanding duty/owner 和 scope-relative quiet。以声明语义写预期，不复制 reducer；
   区分当前代码已有承诺与拟新增的更强证据/部署语义。
2. **固定共同输入及存储能力。** 同一候选、原始验收报告、任务条件、资源账本与
   合法主体。强 workflow 参考实现保留持久义务、不可变产物、独立审批、版本绑定与
   支持依赖。适配器只转换接口；不得通过隐藏某臂本可获得的信息来制造失败。
3. **逐项语义消融。** 在相同执行路径上分别删除精确绑定、跨执行者责任保存、支持
   失效传播。消融用于说明必要区分；对强 workflow 的比较才识别相对工程价值。
4. **覆盖正常、扰动及无关事件。** 除下表外加入精确重试、错 subject 的 challenge、
   正常重新提交和无关任务。重启检查 durable 读回；模拟进程事件不等于真实 crash。
5. **冻结 readiness report。** 输出每一历史的完整 trace 与 oracle diff、各臂真实差异、
   未建立的隔离/恢复条件。缺少执行证据就保持未测试，不让测试代码先替论文赢。

| 成对历史：当前产物与原始测试相同                        | 必须区分的处置                                                                  | 防止“永远拒绝”的控制                                      |
| ------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 新 revision 已被 issuer 批准 / 只是 executor 提议       | 只有已授权 revision 能在满足其证据条件后完成；提议不等于授权                    | 合法批准后可完成；旧 revision/stale approval 不得偷渡     |
| 未履行 duty 经 executor 丢失/替换 / issuer 明确 release | 前者 duty 仍在、有责任人、非 quiet；后者可 quiet 但不算有效交付                 | 替换者可继续并合法完成；正常 release 不应被误阻塞         |
| B 的认定依赖 A 的 live support / A 仅是 B 的生成祖先    | 接纳 A 的精确 defeater 后，前者 B 失去相关支持并进入有主补救；后者 B 不自动重开 | 无 defeater 时正常完成；无关 U 不变；独立新证据可恢复履行 |
| 有效支持下 discharge 并导出 / 合法 release              | 二者可 quiet，但只有前者有成功履行与有效交付资格                                | 合法 exact export 可计交付；缺失/错误 export 均不得计交付 |

最后一行的交付 receipt 属于实验侧独立核对，不假装 kernel 已内建消费者收货。
新的 issuer attestation 是否可以重用旧 evidence bytes，必须按冻结的证据接纳规则
判定；“hash 相同所以必须永久拒绝”不是当前 kernel 的既有保证。principal 对证据
的语义再接纳不能被偷换成 executor 绕过。

**P1：任务相连的生命周期小试。尚未执行，模型预算需另行冻结。** 使用相同
Luna、policy、验收器、ready/反馈接口和总预算，将替换、重试、授权变化、被接纳
反证放入能真实恢复并交付的任务。正常与扰动分别报告；记录全轨迹上的错误接受/
quiet，以及固定恢复期限后的有效交付、质量、错误阻塞和恢复成本。不能只测拦截率，
也不能声称人为注入的故障分布代表自然发生率。

P0/P1 正常通过才进入更广确认，任务/扰动组合与分析先冻结。已看过的 HTMLq/Entr
及用于调参的 200 题不能重命名为新的 untouched confirmation；可以明确用于协议开发
和复现实验。边界任务的效用必须另有独立验收，不能只让自己的状态机给自己评分。

**并行证据整理：200 题最终报告。** 对应用户实际报告的 campaign、200 个 task ID、
最终选中 artifact 与 evaluator 版本，保留全部失败/恢复和成本。当前找到的
`luna-max-policy-split-p0-200-20260902-v5` 快照不是已确认的最终聚合，不用于否定
用户完成情况，也不据此拼接一个猜测分数。核实 leaderboard 指标后才能写精确差值。

**后续独立分支。**

- 接口：复用 recording provider，记录实际 request 的 role/content hash、history/
  compaction/rotation、policy 与制度片段、主调用/控制调用及真实 usage。只有确认同一
  backend 除投影外不变，才比较 history-carried、完整重复投影与最小事件更新。
  初步差异识别的是 content/role/length/position 组合，不是已识别的注意力机制。
- 部署：旧 Session/间接权限路径 negative controls、真实进程 crash 与 OS/凭证隔离
  是强 adversarial claim 的额外门槛，不由 fake provider 测试代替。
- 持续改进：先完成 evaluated policy -> approval -> binding -> admission 的无模型
  身份 probe，再测采用/撤销后保留的真实效用；只有这些成立，才研究 F/O/R 及必要的
  固定生成器迭代部署对照。递归无优势不等于认定连续性无价值。

本次只更新方向和文档，没有执行上述新测试或任何 campaign。

## 9. 本轮验证记录

研究员执行的现有测试全部通过：

| 包/范围                                  | 结果                | 解释                                             |
| ---------------------------------------- | ------------------- | ------------------------------------------------ |
| Core：ProContract、replay、constitution  | 47 pass             | 当前已有机制测试，不是新故障矩阵                 |
| OpenCode：HTTP ProContract               | 3 pass              | 当前 HTTP 边界覆盖，不是所有间接路径证明         |
| OpenCode：RSI gate 与 artifact selector  | 7 pass              | JSON gate/selection 正常行为，不是自动晋升       |
| Schema：legacy policy discard 定向测试   | 1 pass，7 filtered  | 当前 schema 丢弃旧 policy metadata               |
| Core：separate-binding dispatch 定向复核 | 1 pass，44 filtered | 与上方 Core suite 的相应测试重叠，不另算独立覆盖 |

编排者另外检查 Markdown 格式、内部链接、文件变更范围。具体测试命令与审查范围
保留在各研究报告结尾。本轮不包含模型效果、强隔离或递归增益的新证据。

本次方向修订追加一轮 `gpt-5.6-sol` 只读反方审查，并经编排者源码复核修正了一个
过强 oracle：旧 attestation ID/坐标重放与新 issuer attestation 对相同 evidence bytes
的再接纳不是一回事。后者不违反当前 admission 语义，不能冒称已复现漏洞。
上述既有测试未在本次修订中重跑；本次只重新验证五份文档格式与 21 个内部链接。
