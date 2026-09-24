# S3b：受控 job 与实际执行许可

状态：实施设计，用户已批准本切片的设计审查、实现、端到端测试及独立代码审查。S3a 工作树基线保存在 `/tmp/opencode-s3b-baseline`。本切片仍只建设 Researcher 所需的通用执行机制；不实施 Principal 策略、S4 研究产物流水线或真实实验。

## 已确认的入口缺口

S3a 的 driver 统一了主执行 binding 的生命周期，但普通 Session admission 尚不读取受控身份。无主 binding 的 reviewer 会被当作普通 Session。权限等待后的 write/bash 可以继续执行；自动和 overflow compaction 在主 provider reservation 之外请求模型并丢弃 usage；验证进程只靠外层工具传递期限。Session 的 switchAgent、switchModel 和文件 revert 也需要明确限制。

具体审计结果形成如下实施边界，不以工具目录过滤代替执行授权。

## 持久身份与宿主 API

新增通用 `ProContractJob` 存储，不增加 kernel 状态、命令或研究阶段。job 属于一个 root Contract，保存不可变输入、root 当前 `ContextTarget`、精确 driver、角色、Location、模型／agent、原始 deadline、Session／Prompt 身份，以及可撤销的许可版本、owner、generation、lease、状态和历史 lineage。

- 第一批角色为独立只读 reviewer 和机械 verifier。主执行者继续使用 S3a binding，不将 reviewer 写进该 binding 的当前 Session。
- Session 与 job 的持久映射单独保存；缺少 job 正文、driver 或有效许可仍是受控 Session，拒绝执行。映射不随 job 完成、取消或进程退出删除。
- 可信宿主先原子保存 job、精确输入和 Session 映射，再创建 Session、准入唯一 prompt。已有普通 Session 不允许事后认领为 job；job ID／Session ID 重用必须完全匹配，不能更换输入。
- `SessionV2.create` 对预留 ID 的创建、采用和并发冲突恢复均在权威事务中核对固定 Location／model／agent；不能让普通 create 抢占预留 ID 后被 job 收养。runner／provider 还会比较实际 Session 的持久坐标。
- reviewer 输入从宿主提供的明确 prompt 和材料身份建立，不复制主 Session 历史。模型、agent 和 Location 固定；公共 switchAgent／switchModel／revert 对受控 Session 拒绝。S4 才负责生成和冻结真实评审材料。
- reviewer 的工具许可为有限只读集合，默认仅 read／glob／grep；禁止修改、任意 shell、网络、Contract 控制命令及未声明支持受控执行的应用工具。现有 agent 权限仍取交集。路径限制在指定 Location，外部目录许可不能扩大这一范围。
- 工具检查包含实际实现的受控声明，不能只认 `read` 等注册名而放过同名替换的未受控实现。reviewer 的文件读取、verifier 的进程执行等能力还须属于 root 已有 authority。
- verifier 固定 snapshot、replay policy 及其 hash，不接受模型临时追加命令。它通过宿主验证入口执行，不要求 root 处于 active 或持有主执行者 lease。
- 首版 job 仅接受 root 的 deadline-only 预算，拒绝含累计 turns/actions 上限的组合；S3a 原生和通用 driver 的既有计数预算行为保留。job 不继承 generic agent steps 限额。

`sdk-next` 暴露宿主 `contractJobs` 接口，负责 create/get/start/cancel/recover/verify/operations 等操作。它复用现有 Session API 和同一个服务图，不创建第二套 agent loop。公共 HTTP 不新增 job 发行端点；既有 Session 路由仍受到相同准入约束。

## 执行许可与接线

新增 process-global 通用执行许可服务，解析三类 Session：普通、主 binding、受控 job。许可捕获原身份，随后每次检查均比较相同坐标，不能在执行时换取新版本。研究阶段及计划语义不进入 Core。

| 入口                                   | 处理                                                                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `SessionV2.prompt`，含 admit-only      | 在 inbox 事务中检查许可；job 只接受冻结的 Prompt ID、内容和 delivery，精确重试可对账；失效许可不能插入新输入           |
| resume／wake／local drain／直接 runner | 按 Session ID 读取持久标记；job 缺失、driver 缺失、owner 错误、取消、过期均拒绝，不回退普通执行                        |
| 普通 provider turn                     | 捕获许可，实际 `llm.stream` 前重新校验并预留 operation；在途执行受原 deadline 和撤销监控约束                           |
| 正常／overflow compaction              | 直接复用 provider operation 入口，保存原始 usage 完整性，使用相同 deadline；一次 compaction 是一次独立 provider 操作   |
| canonical `Tool.settle`                | 在工具实际执行边界检查；普通工具表示保持唯一。Registry 只做查找、环境传递、现有计数及输出结算，不增授权回调            |
| leaf 权限等待                          | 保留 leaf 的 permission 顺序；批准后再次核对原许可，写入／进程启动等真实副作用前再检查，覆盖两次检查间的可等待准备工作 |
| 组合工具                               | 继承同一捕获许可，子动作各自检查、计量；不能在第一动作后撤销却继续第二动作                                             |
| replay／进程 executor                  | 宿主验证 job 入口绑定固定输入；真实 process spawn 前检查，单项 timeout 截断到 root 原 deadline，保留 S3a 中断归档语义  |

canonical Tool 的通用检查通过共享许可服务完成。Registry 为既有 Tool runtime 提供该服务，实际授权不放到 Registry 的工具目录或另一种 executor 中。低层直接 `Tool.settle` 对受控 Session 同样要求可信许可服务和捕获身份，不能通过省略上下文绕过。应用工具只有显式接入受控执行边界后才可用于受控 job。

提供可传递的 Effect 执行上下文，使权限、leaf 和验证进程读取同一次捕获的许可。该上下文不是新的持久 drain 身份。主 Session 仍由原 coordinator 串行运行，Location 工具和 runner 仍为 Location-scoped。

## Job 生命周期、取消和恢复

job 初始关闭；可信宿主显式启动后获取独立 lease。主执行 binding 必须已停止，reviewer 才能启动，避免相同候选仍在被主执行者写入。root 为 verification 或同一上下文下等待时，job 可以在自己的许可下执行；root release、revision、challenge 或取消会撤销原上下文的有效性。root 的 admission 关闭是主执行者等待机制，不借此禁止独立 reviewer。

互斥是双向的：job start 的事务检查主 binding lease 与本地在途操作；主 binding 的 open／claim 也检查该 root 的活跃 job。关闭仍须等待已有操作清理，不能在 job 已启动之后重新打开 worker。跨进程互斥依赖持久 lease；不将单进程清理屏障宣称为强分布式执行隔离。

job owner 与主 binding owner 属于同一宿主服务图，但 lease／generation 独立。心跳只延长仍有效、未过期的本地 job。取消先持久关闭 job 并提升许可版本，再中断 Session／进程并等待有界清理；旧完成回调只可追加历史会计，不能把新 job、取消状态或新 generation 标为完成。

完成状态仅表示执行结束，不表示研究通过或 Contract discharged。输出来源引用 job、Session、模型和固定输入；S4 才解析研究报告和形成验收 bundle。

重启不自动重放已执行的工作：

- job 已建／prompt 未写，或 prompt 已写但没有任何 provider／工具 operation：原 lease 到期后，宿主可显式 recover，保留输入身份和 Prompt ID。
- 存在已开始 operation、完成状态未知：记录 unknown／interrupted，拒绝盲目 resume。宿主经检查后另建带 lineage 的 job，使用新的 Session，但保留原 deadline 和全部历史计量。
- 已完成／取消 job 不能被 recover 重新打开。缺 driver 无法恢复，重新装载也不会自动启动。

主执行者与 reviewer 的共享目录强隔离仍不在 S3b 声明内。只读 reviewer 使用受控文件工具；任意 shell 的宿主 authority 不授予 reviewer。冻结候选及强进程／网络／凭据隔离属于后续适配器边界。

## 完整会计

新增持久 operation 记录，保存 root、job 或主 execution 身份、操作种类、开始时间、原 deadline、状态及已观察到的用量。provider、compaction、工具子动作、每个验证进程分别记录；聚合展示不得把嵌套过程误加为额外 tool action。

provider usage 到达时立即保存原始可选字段；缺失字段保持 unknown，不折算为零，不等待工具结算或最终快照。无 usage 的失败／取消请求同样有已开始记录。进程硬杀后遗留 running operation 在恢复审计中标为 unknown；保留身份与已知用量，不能退款或重置。

会计写入可以在许可过期后补完原 operation，但不能修改当前许可、job generation 或 root 状态。root 汇总区分主执行和 job 的操作及未知用量；不把 reviewer 伪装为主 Session 的对话历史。初版 job 拒绝计数上限，所以不存在未原子共享 ceiling 的绕过。

## 验证与接受条件

1. 真实 SQLite：job／Session 映射原子发行、冲突重试拒绝、缺正文仍关闭、取消／恢复／旧回调 CAS、主 binding Session 不被覆盖；并发普通 create 无法抢占预留 Session，job 启动后主 worker 不能重新准入。
2. 真实 Session admission／HTTP：closed 或缺 driver 的 job 在 prompt、admit-only、resume、wake 和直接 runner 均不调用 provider、不留下可执行新 prompt；模型／agent 切换和文件 revert 拒绝。
3. 真实叶子：write/bash 等待权限后撤销；同 ID 新许可不能承接旧调用；组合工具两阶段间撤销；只读 reviewer 不能执行写入、外部目录、进程或未受控应用工具。
4. 脚本化 provider：普通 turn、主动和 overflow compaction 共享 deadline、撤销与 usage；缺失用量显示 unknown；usage 到达后、工具尚未结束时已经可从数据库读取。
5. 真实验证子进程：root verification 下独立 verifier 可以运行；旧许可、原 deadline 和取消停止进程并保存已捕获证据；迟到结果不能让 job 通过。
6. 生产 Server／宿主子进程和磁盘 DB：SIGKILL 前后 queued 未执行 job 的显式恢复；已有 provider 工作不自动重放；缺 driver 拒绝；持久取消不复活；原 deadline 不延长、所有历史 operation 保留。
7. 原生 Session、S1–S3a 回归、包级 typecheck、Schema／迁移生成检查；公共 wire 契约若改变，按仓库规则重新生成客户端。

先独立审查本设计并修订，再实现；完成后独立代码审查并关闭已确认问题。测试使用确定性本地 provider／reviewer，不调用真实研究模型或启动 ProgramBench。

## Constitution change gate

本切片加强 exact authority、obligation conservation 和 auditable accounting。反例是无主 binding 的 reviewer 获得无限普通 Session 权限、撤销前的 permission 回复继续写入、compaction 绕过期限／计量，以及旧 job 回调发布新阶段结果。修复跨持久 Session admission、实际执行入口与宿主存储，单纯增加 SDK 包装不能堵住既有路径。

kernel 保持纯 reducer；job 许可、操作会计和 Session 归属属于执行适配器。root 的认定／release 权限不交给 job，新增能力不扩大任何既有 authority。新增表按仓库生成迁移，不覆盖 S1–S3a 已有迁移及历史记录。
