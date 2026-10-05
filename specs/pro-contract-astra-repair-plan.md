# Astra：先修测量与执行，再证明 strategy 增益

2026-09-22。状态：只读审计后的修复设计，**不是已实现的修复、性能晋升或新实验授权**。
本次未改变任何运行中／冻结 cohort、模型、候选、测试、预算或历史成绩。

## 0. 核心判断

目标是超过同模型 baseline，不是维护 R2 的优越性。当前最有价值的路线是：

1. 先让参考程序、执行环境、交付和评分可信；否则 strategy 会优化错误反馈。
2. 减少模型维护宿主流程的工作，让它把精力用于实现和行为搜索。
3. 把「已发现问题的修复」与「尚未发现问题的主动搜索」分开。v5 已经包含相当完整的
   contrastive-search 指令；再追加一段“认真测试”不是新机制。
4. 分别解决近满分任务的尾部遗漏和低分任务的表示／架构不足。二者不能靠同一种测试量解决。
5. 先证明固定策略在匹配条件下有效，再让 RSI 生成后继；能力提升不能从版本号推导。

最重要的区分：**交付证据闭合，不等于未知行为已充分探索；安全的 kernel，不等于高质量 solver。**

## 1. 先把比较对象校准

### Astra：已有记录没有证明 R2 超过 baseline

来源是 [Vals ProgramBench](https://www.vals.ai/benchmarks/programbench)，页面更新于
2026-09-21，本地审计抓取于 2026-09-22。它是第三方的 Astra Max 结果，不能称为已确认的
OpenAI 自有 harness。公开配置是 mini-SWE-agent、Astra Max、6 小时／1000 steps；还存在
动作超时、工具展示截断和 grader 配置等差异，不是我们的严格随机对照。

以下固定使用审计文件 `ALIGNED.json` 的快照，不随仍在进行的评分漂移：

| 相同 177 个已有源码分数的 task ID | R2 + Astra Max | Vals Astra Max |
| --- | ---: | ---: |
| 任务等权平均通过率 | 86.8884% | 87.2046% |
| 至少 95% | 85 | 95 |
| 精确满分 | 4 | 11 |

177 个分数中有 9 个是未交付源码诊断，不能全部称为成功交付；4 个满分均已交付。
剩余 23 题仍未知。Vals 的全 200 题数据为 11 个满分、100 个至少 95%、均分约 85.417%。
不能拿我们的已知子集均分与它的全量均分比较。公开 heatmap 的逐题均分精度为两位小数；
满分使用其明确的 resolved 标记，不用四舍五入的 100%。

**Vals 满分的 11 题，我们全部已经交付并获得评分。** 其中 3 题共同满分，8 题我们未满分；
我们另外获得 fasttext 满分。因此净差是 7 题，不能归咎于 19 个未交付或等待中的评分。

| Vals 满分、R2 未满分 | 本次记录 | 诊断方向，不是提供给 solver 的隐藏答案 |
| --- | ---: | --- |
| loop | 707/710 | 参数与迭代形式 |
| zip-password-finder | 677/680 | 参数边界、错误优先级、内在限时 |
| miniserve | 302/304 | 服务接口／辅助输出 |
| tty-clock | 278/281 | 交互状态与按键 |
| csview | 334/335 | CLI 别名／组合 |
| BLAKE3 | 644/647 | 两项输入校验；另有缺失 grader helper，不能全算模型错 |
| keifu | 256/262 | 图表示与交互导航 |
| eva | 893/913 | 数学函数和参数边界 |

168 个已有评分的合格交付中，83 个至少 95%，其中只有 4 个满分，留下 **79 个近满分但非满分**。
这是值得投入尾部搜索的机会，不是“79 题都容易修好”的预测。另一方面，dog 为 36.38%
对 97.80%，revive 为 28.47% 对 78.95%，lazygit 为 56.26% 对 77.89%；还需要修复明显低分的行为族。

即使找回上述 8 个满分并保住现有 4 个，也只有 **12/200**，仅略高于 11/200。
若挑战 20/200，还需在这之外再得到至少 8 个新满分；只追着已知的八道题打补丁不足以“大幅超越”。

### Terra：可以借鉴，但不能当作全面胜利的既成事实

相同 199 个已知 task ID，Terra R2 源码均分为 76.0986%，Vals Terra 为 72.3724%；
合格满分 3 对 1。但至少 95% 是 **28 对 30**。R2 相对我们更早的 Terra 版本，交付和满分增加，
全量源码均分区间反而下降。参见现有 `ADOPTION.md`，它本来就没有声称全面优于旧版。

合理假设是：某些 scaffolding 可以帮助 Terra，但相同约束未必适合 Astra。
要检验 model × policy 交互，不能把模型差异、预算差异或历史随机性都归功于 RSI。

## 2. 原因分层：哪些已证实，哪些尚是假设

| 层次 | 已观察到 | 不能据此断言 | 最小可区分实验 |
| --- | --- | --- | --- |
| 测量 | 缺离线依赖、helper、收集／报告问题；补评禁用 pytest timers | 当前每个失败都是能力问题；修评分一定提高分数 | 同一冻结候选、固定新 grader profile、正负控制 |
| 交付 | 19 个失败分为 8 环境、7 凭据、2 Docker、2 export | 修完 19 个就追回 8 个已交付满分损失 | 故障重现与修复后 cleanroom replay，不重跑模型 |
| 搜索 | 自测数百项仍漏边界；四个审计例子约 34–46 分钟主动交付 | 应机械用满 6 小时；长跑一定更好 | 同预算 self-review 对 fresh-context challenge |
| 比较器 | 有主动忽略路径等字段、模拟传输替代部分真实环境的情况 | 所有归一化都错；mock 是全部失败原因 | 原始字节、归一化依据、真实端到端见证分开记录 |
| 提示目标 | 强制 validate.sh；交付义务止于 replay；v5 可在披露不确定性后停止 | 仅修改一句停止语就能提升 | 固定 runtime 的 delivery-brief ablation |
| 能力结构 | 大幅低分和近满分遗漏并存 | 一套更大的通用测试表能解决两者 | 表示选择／状态建模干预与尾部干预分开评测 |

四个早交付例子并不是没有测试：保留轨迹分别出现约 450、492、458、595 项自建探测／断言。
更具体的假设是：**实现者和测试者共享盲点，自建成功案例多，不能证明尚未被提出的问题少。**
目前没有匹配 Astra 实验能把差距唯一归因于 v5、Contract 开销、工具集或停止策略。

还有历史反证必须保留：`pro-contract-experiments.md` 中更强调反证的 Loop policy 曾从
652/710 退步到 530/710；`pro-contract-adaptive-search.md` 的小样本 adaptive policy 未晋升。
新设计必须同时保护实现不变量和已得能力，不能把“更多探索”当作单调增益。

## 3. P0：先修测量，不让 scorer 冒充能力瓶颈

### 3.1 分离 canonical evaluation 与 diagnostic continuation

现有补评 `checkpoint_plugin.py` 的 `pytest_timeout_set_timer` 返回 True，阻止官方
per-test timer 安装；还把 session timeout/expiry 设为 0，并改变 fail-fast。
**没有额外总测评预算，不等于可以取消 benchmark 自带的测试超时。** 内部子进程自己设置的
5 秒等超时仍可能存在，也不能把所有时间行为混为一谈。

新 profile 必须：

- 固定测试包、ignore map、依赖、collection、rerun、timeout、资源、并发与构建语义。
- checkpoint 仅观察最终 JUnit 节点，不改执行语义；不把 unfinished/error 行删掉制造完整分数。
- 明确 `behavior_fail`、`candidate_build_fail`、`reference_unavailable`、`grader_setup_fail`、
  `collection_invalid`、`report_incomplete`、`cancelled` 等状态，不用一个 exit code 解释全部。
- 基础设施 watchdog 可停止不健康的操作，但必须记 infra-incomplete，而不是伪造模型超时失败。
- 不热改现有测试。新结果并列保存 profile 身份；要重评同一批候选，事先规定所有受影响对象，
  不能只重评有望变好的任务，也不能跨 profile 取最好一次。

若无法拿到 Vals 的完全相同 grader 版本，明确标为本地 canonical profile；使用同一 profile
运行新的 mini-SWE 和 ProContract 对照，不宣称完整复现其官方分数。

### 3.2 全 branch 离线 qualification，而非只证明 Docker 能启动

现有不完整评分涉及：gotests 的 Go toolchain、age 的 operation-local helper 输入、pandoc
的系统包、fselect 的 zip/xattr、pueue 的 Rust crates、gping 的 apt、ditaa 的 numpy、skeema
的报告完成状态、jsonschema 的 collection 名称映射。BLAKE3 另有 `hazmat_tester` 缺失，
说明 `instance_valid` 字段本身不足以证明测量有效。

付费 cohort 前在独立 grader 环境逐 branch 验证 setup → collection → reference positive
control → deliberately broken candidate negative control → finalized report。参考程序若按该
benchmark 定义不要求全过，使用事先冻结的 reference expectation／官方 exclusions，不能
临场增加 ignore。正控制通过不代表比较器能发现错误，因此负控制不可省略。

全部依赖和传递 helper 输入纳入内容清单，预备 pinned grader-only 镜像／缓存；solver
不能获得隐藏测试、helper 答案或 grader-only mount。修复依赖供应，不修断言迎合候选。

同时验证 solver 获准使用的 reference 能成功执行真实功能，不只会输出 help 或环境错误。
Sol 的 cppcheck 曾把缺失 `std.cfg` 的 setup failure 学成目标行为，这是额外旁证，
不能倒推为 Astra 所有低分任务的已证实原因。

## 4. P0：修 19 类交付失败的实际边界

### 4.1 凭据：不关 scanner，阻止控制面秘密进入任务面

7 题拒绝导出的原因是 evidence/debug 文件含**实际临时 OpenCode server password 字节**，
不是误扫到变量名。审计未在限定目录发现被检查的宿主 API/base 字节，不代表普遍无泄漏。

最小防误泄漏修复是在所有环境增补之后，为工具子进程显式构造安全环境；不可仅传 undefined，
也不能过滤后再由 `extendEnv` 合并回宿主环境。结构化观测由宿主生成，不要求模型 dump env。

这还不是安全边界。同 UID 的任务进程可能读取父进程 `/proc`、状态目录或控制 socket。
完整修复需要隔离 supervisor/control 与 task 的身份、进程可见性、可读 mount 和通道权限；
task 不持有 issuer 凭据，不可调用 attest/revise 等控制权限。单靠 Bash 路径警告不够。

资格测试必须实际尝试 env、父进程 environ、配置／日志／socket 访问以及 export，使用合成
秘密并证明无法读取；日志脱敏在持久化／展示边界执行，原有 publication refusal 保留。

### 4.2 环境：共享 EnvSpec，同时主动测试变化

8 题 preflight 失败具体涉及 UID/GID、HOME/GOPATH、hostname、DNS、capabilities、终端／
进程状态。development 是 agent/1000，preflight 以 root/default 启动；dust 的降权操作又
撞上 cap-drop ALL。不是一个“多跑 validate.sh”能修的故障。

用有版本的 EnvSpec 描述 reference、build、candidate probe、delivery replay 的对应语义：
用户、目录、locale/TZ、umask、TERM/PTY 尺寸、hostname 策略、DNS、CPU/RAM、capabilities、
依赖及网络策略。保持必要差异显式，不盲目把官方 grader 改成 development 环境。

稳定基准环境之外，执行合法的 metamorphic 变化：换 HOME、CWD、hostname、非 root 用户、
空 stdin／pipe／PTY。不能靠统一 hostname 掩盖实现把旧 hostname 写死的问题。
禁止外网与凭据泄漏，不等于禁止离线 namespace 内的 loopback 客户端／服务端测试。

### 4.3 源码和证据分开交付，统一快照身份

- parallel-disk-usage：raw bytes 匹配 Git tree，但 `.gitattributes` 的 text/eol 规则使 status
  仍 dirty；两个一致性谓词互相冲突。
- dstask：probe 目录含 7 个 mode160000 gitlinks，超出 export 的 blob/symlink 支持。

使用明确的 immutable content manifest：路径、类型、mode、内容／链接目标；导出和验证
对同一规范对象做判断。提前拒绝不支持的 gitlink 并给出位置，或单独实现明确的 materialization
语义，不能等模型结束才报泛化错误。证据、探测仓库、缓存、控制记录不混进 source deliverable。

已实现的 private snapshot／owned object closure 可复用；它们是否覆盖 CRLF 和 gitlink
这两个案例仍须单独测试，不能从已有 snapshot 单测数量推定已经修复。

### 4.4 Docker 生命周期：能定位、能回收、不重开预算

thokr/lnav 的保留记录只证明 resume/restart 的 Docker inspect 路径抛错；低层 stderr
没有保存，不能断言确切是 daemon、网络或超时。新 harness 记录 operation/stage、exit、
timeout、经过脱敏的 stderr、owner 和 create-intent journal。

创建一半、取消、恢复、评分前闭合都通过同一所有权账本；finally 和 guardian 只处置 exact-owned
资源，禁止全局 prune。恢复同一任务不自动重新开始模型试验、不重置 deadline；不明确的 provider
执行保持 pending/unknown 会计，而不是退款式恢复出新的预算。

## 5. Harness 应当更薄，而不是让模型填更多表

`build_issue_payload` 目前强制自包含 validate.sh，并把合约义务结束于 native replay。
另有强调继续广泛 differential testing 的段落仅进入 `current/semantic-v0`，不进入实际
`policy-split-v1`。实际 v5 虽有行为优化目标，也含交付和停止说明。两层目标应明确区分：

- **实验效用目标**：在授权时间内最大化官方可观察行为兼容性，减少漏解。
- **安全／交付资格**：精确冻结源码、可重建、可隔离执行、证据无伪造且可追溯。
- **局部测试含义**：仅支持已观察的行为，不是隐藏测评或完整性认证。

建议在新 benchmark profile 对 mandatory validate.sh 做最小消融：保留可选回归工具及其
有用反馈，把一般自测从强制验收义务改为 solver 的可选策略；源码与 compile 的交付条件仍
明确冻结。它是否有益需实验，不直接删掉现有验证，也不追认旧失败为成功。

宿主自动捕获 argv/stdin、exit、stdout/stderr、截断／超时、相关非秘密环境、候选／reference
身份和真实资源；模型只负责提出假设、选择探测、改代码。归档不等于把全部日志重复塞进上下文：
保留当前反例的精确差分和可回读入口，成功重复项降权，关键失败跨 compaction 持续可见。

不要每个探测都建 Contract，不要对每个探索性编辑强制全量 replay，不要让完成流程再造第二套
模型循环。任何新 gate 的收益都必须超过它对正常可解题的额外负担。

## 6. Strategy：实现三个不同的搜索工作

### 6.1 建立能表达目标行为的实现，而非堆特判

先做小的端到端切片验证关键表示，再扩大覆盖。任务公开信息与实际 reference 观察决定选择，
不是把历史 task ID 映射到定制答案：

| 行为族 | 需要验证的表示／不变量 | 防止的伪进展 |
| --- | --- | --- |
| CLI／格式 | parser 边界、错误优先级、类型和精度、输出通道 | 相近样例都过，但空参数／组合必错 |
| 状态程序／Git 图 | 显式状态转换、持久化和图身份 | 独立命令可用，连续操作丢状态 |
| 网络／并发 | 帧、生命周期、取消、真实端到端请求 | 只会模拟错误，正常协议路径没跑通 |
| TUI | PTY 输入序列、屏幕状态、尺寸／resize | 文本快照近似，却没有真实交互状态 |
| 分析器／语言／大型转换 | 语法／语义表示、共享 invariants、依赖边界 | 用 regex／例子覆盖替代结构，越补越乱 |
| 数值／性能 | 精度、算法规模、边界资源行为 | 小输入正确，大输入超时或溢出 |

需要改变表示时保留已通过的回归与候选 checkpoint，工作分支可探索失败；最终采用的候选仍须
重跑受影响约束。checkpoint 只是已测能力的保护，不冒充对隐藏性能的可靠排序。

### 6.2 从“当前没失败”切换到“主动找未测的高风险行为”

风险表由任务公开接口、允许的文档及 reference 证据驱动，而不是列固定 100 项模板。
最小记录是：行为族／来源 → 当前假设 → 已测／未测／不确定 → 下一条能区分假设的调用。
原始调用和结果由宿主绑定；模型不重复抄哈希、usage 和全部输出。

探测优先级：

1. 实际已发现、会影响一族输入的反例。
2. 尚未执行过的公开模式、真实正常路径和状态转移。
3. 共享 parser/state/formatter 的交互：空值／缺值／attached-empty、组合参数×CWD、
   文件／pipe／PTY、无 helper、权限失败、启动／停止、并发／截断。
4. 对具有规模语义的程序做小／中／边界规模实验，固定资源并保留原始 timing。

使用 grammar/property/metamorphic 生成和反例缩小来提高探测信息量，不把“测试更多”作为指标。
默认保存完整 exit/stdout/stderr 差异。归一化必须有明确公开语义或重复观测依据，保留 raw bytes
和规则；不静默忽略 path、错误文本、顺序、时间敏感字段。metamorphic relation 本身也可能错，
需要 reference 控制，不因模型写出公式便自动采纳。

### 6.3 真正的 fresh-context Falsifier，而不是同一聊天换个角色名

这是尚需实现和验证的能力干预，不是对现有 v5 的重新命名：

```text
Builder 实现／修复
  → 冻结候选 x
  → fresh-context Falsifier 从公开任务／reference 独立提出探测
  → 受信任工具在固定环境执行 x 与 reference
  → 返回实际反例／测量不可用／本轮未发现反例
  → Builder 修复；同一原始 trial deadline；重验受影响行为
```

Falsifier 起始不看 Builder 的“已覆盖／很有信心”叙事和自测结论；先从公开接口产生探测，
再可按获准范围读 candidate 诊断。候选只读，probe 在独立 scratch 执行；无隐藏 tests、
上游源码、控制凭据、另一实验臂或最终评分。相同模型新上下文仍可能有共同盲点，“独立”不等于 oracle。

Falsifier 不能伪造 expected，不能自签 acceptance。只有工具执行得到的、绑定 exact subject
和 observer 的反例进入证据层。无反例是有限阴性观察，不是通过 benchmark。失效测量单独处理。

第一版使用串行角色阶段，减少并发候选竞争。阶段按剩余风险与实际工作推进触发，不设置
必须跑满若干轮的下限，不新增 6 小时或 1000 轮。所有角色共享原始 trial 的资源、截止和
（仅当存在时）累计计数预留。另设等额 self-review 对照，区分新增思考量和新上下文的贡献。

停止不应由“测试数量足够”决定，也不以追求绝对无未知为条件。在已知重大反例未解决时
不声称完成；完成一轮有根据的未测风险挑战后，如果没有具体、合法、可改变候选的下一步，
可以提前交付。临近截止保留已知可构建的候选和交付时间，禁止无谓返工导致无产物。

## 7. 复用现有成果，但不夸大它们

| 已有构件 | 可直接借鉴的能力 | 不能冒充什么 |
| --- | --- | --- |
| `executionPolicy` | 精确策略绑定、与规范 kernel 分离 | 策略经过了科学验证 |
| `ProContractObservation`／ObservationPack | 记录来源、完整性、回读与上下文索引 | 所有重要反例都被模型理解和保留 |
| `strategy_plan/verify/status` | 耐久 criteria、方法修订记录、同 snapshot 完整检查 | 新上下文 Falsifier 或语义覆盖证明 |
| private snapshots／resource isolation | 非 Git、object closure、工具 OOM 隔离 | 本批 Astra 19 个故障已经全部修复 |
| `strategy-promotion.ts` | 完整成对记录、精确满分、保留已有满分 | 当前 task-pareto 规则或可信自动部署 |
| Sol 外层 RSI issuer／runner | 原生普通 Contracts、生成／研究继承／性能采用区分、后继实际绑定 | 内层独立挑战，或 Astra 上已经证实的收益 |

`strategy.ts` 当前主要根据首次失败的字符串和预设类别路由；`strategy_verify` 验证实际命令
执行、完整批次和候选不变，但不能证明命令内的比较器足够强。保留 task quotation 不代表
新版 assertion 没被削弱；被记录的 checker revision 仍需要明确证据，不能从 exit=0 推出语义正确。

`pro-contract-fundamental-repair.md` 已有 219 个 Core 回归和一次 Luna smoke，是工程资格，
不是 Astra ProgramBench 增益。媒体／OOM 修复尚不是此次 Astra 差距的已证实原因，勿全部
混成一个“R3 bundle”后无法判断哪个机制有效。

规范 kernel 不增加假想的“完整语义成立”字段。策略证据和比较器属于实验／执行层；引用现有
普通 Contracts 管理真实的授权与依赖，不恢复历史 `spec.policy`。V2 保持 durable prompt
admission、process-global Session-ID coordinator、Location-scoped runner 和每 provider turn
一个 `llm.stream`；trial ID 不挪用为 workspaceID，新角色不能用新 Session 绕过总预算。

## 8. 实施顺序、代码入口与验收

只在新隔离 checkout 实施；下表相对路径是修复入口，不是修改旧 runner 的许可。

| 阶段 | 代码／配置入口 | 不付费验收标准 |
| --- | --- | --- |
| M0 测量 | ProgramBench grader、`scoring-support` 的新 profile／只观察插件 | 每 branch setup/collection 合格；正负控制；官方 timers 不被覆盖；报告可闭合 |
| M1 身份／环境 | Core `tool/bash.ts`、`cross-spawn-spawner.ts`；ProgramBench `campaign_workspace.py`、`candidate.py` | 环境继承／`/proc`／mount 负控制；8 类环境 fixture；离线 loopback 可测试 |
| M1 导出／恢复 | Core `snapshot.ts`、`pro-contract/export.ts`；ProgramBench `campaign_procontract.py`、`campaign_runner.py` | CRLF／gitlink 明确语义；中途 create/inspect/cancel；无孤儿、无预算重开 |
| M2 减流程负担 | `build_issue_payload`、scheduler 首次指令、host observation receipts | 同任务／参考／资源，仅改变冻结的 delivery treatment；错误证据不可通过 |
| M3 搜索 | 现有 `pro-contract/strategy.ts`、`tool/strategy.ts`、observation/context 接口；新增实验侧串行 role controller | 自测全绿但公共反例失败的 fixture 能触发 repair；旧 snapshot／伪造报告拒绝 |
| M4 比较／采用 | 实验 issuer、记录器、`strategy-promotion.ts` 的新独立规则入口 | task-pareto、已有满分、完整证据和身份检查；拒绝报告不得部署 |

M3 还须通过 zero-gap 控制：正确候选不能陷入无休止反证循环；deadline/cancel 关闭所有角色；
异步 provider 状态不明确时不能凭空归还计数。先证明机制真实触发，再花钱测模型收益。

新 cohort 默认遵守 6 小时 deadline-only：configuration、Contract/Session admission、gateway、
usage/reporting 一致；验证跨旧 count limit 的继续执行和原始截止终止，不用大整数 sentinel。
如专门复现用户原 Astra／Vals 的 6 小时／1000 envelope，必须另行明确冻结这一计数例外。
历史 Astra、Terra 的 1000 上限不变；deadline-only 与历史坐标不能混报。

## 9. 实验：一次回答一个问题，不再直接堆一个新 200 题 bundle

### 9.1 先做小的已暴露开发面板

开发面板可由上述 8 个 lost-full、5 个大退步族（dog、revive、lazygit、astaxie/bat、oha）
与现有 4 个满分构成，共 17 题。它用于机制诊断和防退步，**明确是 exposed development**，
不是代表总体的随机样本。固定每题重复次数（建议首轮 2 次），不挑最好一次，不因为失败替换题。

分阶段、每次只比较必要的两臂，不一次全跑所有组合：

1. **fresh mini-SWE 对 repaired R2**：同 Astra/effort、任务、资源、授权预算、grader、
   时段配对与并发负载。回答总 scaffold 是否获益，不把工具／提示差异误称单一 policy 效果。
2. **同 repaired R2、v5 对 policy-off**：保持原 delivery terms 和其他输入，隔离 v5 的增量。
3. **同 native runtime、旧 delivery brief 对 lean brief**：独立测强制自测／交付目标的影响；
   不把 terms 的变化藏进“policy-off”。这一步按公共 benchmark 源码成绩比较，原生 discharge
   仍按各自明确的 claim 报告，不能跨 claim 混算。
4. **固定胜出的 harness、新风险搜索对简单基线**：先检验同上下文策略，再比较 fresh-context
   Falsifier 与同等可用资源的自审。测试机制是否真被调用、是否产生 reference 支持的新反例、
   是否修掉它、是否损伤其他族，而不只读最终均分。

新 deadline-only 试验两臂都用相同 deadline-only 规则；与 Vals 历史 1000-step 成绩的比较仅为
外部参考。若选择另行授权的 1000-step 复现实验，1000 按整个 trial 的所有角色累计，不能每角色一份。
公开 Vals 的一个历史结果不能代替同期 baseline。

每次修改都保存 policy/工具目录/首次 provider request/实际使用次数；未调用的 helper
不能作为机制收益解释。应测量“不同缺陷族／有效探测”“反例到修复时间”“返工造成的回归”
和宿主手续占用的请求比例，不把 assertion 数量、对话长度或 token 压缩率当能力指标。

### 9.2 再确认，而非在 17 题上不断调出胜者

另冻 generator 不可见的 confirmation。该 200 题集合已被历史实验广泛接触，“对当前
generator 密封”不等于全球 untouched。要声称跨任务迁移，需额外首次开发未用的新任务／独立
程序族。官方失败细节保持宿主侧回顾性分析，不进入活动 solver；从其得到的设计方向也须披露开发暴露。

完整 200 题胜利必须由固定策略、统一有效 evaluator、完整交付／错误分类和同期 baseline 支持。
任务是统计单元，不把成千上万相关 assertions 当独立样本；配对 task-level 区间、逐题差值和
满分得失集合一起报告。固定 repeats 的 seed 只标识分配，不假装 provider 完全确定。

## 10. 晋升规则与“大幅”的工程目标分开

本地 AGENTS.md 的 2026-09-22 当前偏好为 `performanceRule: "task-pareto"`：

```text
对每题 i，在事先固定的 repeats 上：mean_new(i) >= mean_incumbent(i)
至少一题严格大于；所有平局不晋升
并且：既有满分保护 + 安全有效 + 开发／确认完整 + 身份／预算一致
```

这不是要求至少 1 pp；任意严格正提升可以进入采用判断。它也不是“均值上涨就准许个别题退步”。
当前 `strategy-promotion.ts` 允许新增满分压过均分损失，**不能直接拿来执行这条新规则**。
新规则需要新冻结的 comparator/profile，不热改正在执行的 Sol／OTA／Astra 历史批次。
未知／不完整保留为未知；缺 cost 不可在成本 tie-break 中胜出；研究父代可以产生后继但不自动部署。

对满足 task-pareto 的候选，可以优先研究／选择增加满分者。用以下作为中期挑战目标，而不是
把它们设成违背“任意正提升可晋升”的新门槛，更不是已保证的效果：

| 200 题目标 | Vals 历史 Astra 参照 | 建议挑战值 |
| --- | ---: | ---: |
| 精确满分 | 11 | 至少 20 |
| 至少 95% | 100 | 至少 110 |
| 任务等权平均通过率 | 约 85.417% | 约 87.4% 或更高 |
| 系统性环境／凭据／导出失败 | 不从公开分数推断 | qualification 中为零，不靠排除失败 |

实际正式判定以新的同期 baseline 为准；不能把 20 对历史 11 自动解读成显著因果提升。
“全面”在这里落实为**实测逐题均值不退步、已得满分保留、多个汇总指标提高**，不是保证任何
未知程序或未来随机重复都更好。

完整费用包含失败启动、被拒策略、generator、control、checker、重评和 unknown usage；
性能优先不意味着隐去更多计算。不要为了赢而引入 silent best-of-k 或额外的 trial 时钟。

## 11. RSI 的位置：最后放大已验证机制，不先递归放大盲点

外层策略生成／评价／绑定已经有可复用的 native issuer 路径，见
`pro-contract-sol-strategy-rsi.md`。它与本题缺失的内层 fresh-context Falsifier 是不同机制。

先采用确实胜出的固定 harness+strategy；再让生成器只修改冻结的 policy/mechanism 范围，
不允许自行改 grader、ignore map、预算、环境、安全或 promotion rule。比较 fixed、
once-improved-frozen、recursive；若声称后继改善了后续生成机制，还需 frozen-generator/sham
对照与实际 successor admission 证据。多个版本被生成不是递归能力增益。

如果最薄的 native harness 配简单策略最好，就采用它；如果 mini-SWE 最好，就保留它作 champion。
我们的目标是能力，而不是让更复杂的系统赢得一个被它自己定义的测试。

## 12. 证据索引与本次边界

数字及输入 hash 的独立只读复算：
`/home/duozhou/run-artifacts/procontract-astra-repair-design-20260922/ANALYSIS.json`。

主要依据：

- `/home/duozhou/run-artifacts/procontract-astra-vals-audit-20260922/REPORT.md`、`ALIGNED.json`：
  Vals 配置、同题对齐、满分损失和评分限制。
- `/home/duozhou/run-artifacts/procontract-astra-strategy-audit-20260922/REPORT.md`、`AUDIT.json`：
  早交付、测试量、实际调用和比较器边界。
- `/home/duozhou/run-artifacts/procontract-astra-r2-score145-20260922/failure-audit/REPORT.md`：19 题分类。
- 同目录的 `scoring-support/plugin/checkpoint_plugin.py` 与不可变 readouts：补评语义／测量缺口。
- `/home/duozhou/run-artifacts/procontract-terra-r2-full-20260919/ADOPTION.md` 与
  `comparison-terra-20260919/full200/RESULT.json`：Terra 的可支持结论。
- [fundamental repair](pro-contract-fundamental-repair.md)、[strategy promotion](pro-contract-strategy-promotion.md)、
  [Sol RSI](pro-contract-sol-strategy-rsi.md)、[evidence boundary](pro-contract-evidence-boundary.md)、
  [next mechanisms](pro-contract-next-mechanisms.md)：现有机制、负结果与未实现边界。

本次只新增设计文档与派生审计记录，没有启动模型／grader，没有修改运行时、停止现有评分、
调整 comparator、部署策略或改写已有工作树中的其他改动。后续实现须以各里程碑的真实验收结果
更新状态，不能把本设计中的流程写成已经实现的能力。
