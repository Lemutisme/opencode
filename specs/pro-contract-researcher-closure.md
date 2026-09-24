# 研究交付收尾与 IPC 证据去重专项设计

2026-09-21。依据第六轮封存证据进行定向修改；本轮不启动第七轮或 66 例，不调用真实模型。修改前 6,619 项工作树与第六轮 final-source 的内容、符号链接及 mode 全部一致；完整基线在 `/workspace/researcher-closure-20260921T054035Z/baseline-source/`，manifest SHA-256 `be007dc8204ecbb6aeecdeeb0b59e5d360a6d71d683eb679708f604f91738817`。HEAD 不是完整基线，既有未提交实现均保留。

## 事实、范围与不变边界

坏计划实际修复并先修订计划、再通过验证；没有完成声明不抹去修复。好计划实际删除诊断而计划仍要求实现，是真实不一致。三例均收到历史目标但只响应最新评审；提示中提前出现 submit/stop 是可检验的影响因素，不能认定为唯一原因。18 项 null 保留原评分，多数无对应机会，不等于 18 个产品缺陷。

只修改 research 宿主呈现和 research-eval 证据保全，不改变 Core。Principal 仍决定任务约定及最终认可。宿主只校验权限、身份、时序、版本及核心证据；语义上的计划对齐、真实修复与回应支持程度仍须独立判断。advisory 下 pending/unresolved 不成为新阻断，严重级别 P1 不自动暂停；显式 required 及历史 v1 的评审 accept 门槛保留。原六小时 deadline、取消、单操作边界及无累计次数／费用上限不变。

## 显式呈现版本与状态转换

Manifest 增加可选 `feedbackGuidance:"closure:1"`，仅允许与 v2 `repair-lifecycle:1` 组合；不隐式默认，不回填历史任务。缺省字段继续使用原提示。该字段进入 manifest/input 指纹，既有 ID 不允许换版本。评测 setup/deployment/frozen/config 身份及发行入口显式携带该字段；无字段时保留旧发行结果与评分规则。此项是呈现版本，完成声明协议及评分真值不变。

新提示在计划阶段逐项呈现当前 finding，并区分建议、原已满足、真实缺陷和未知；不给模型预先判定分类。在 delivery 阶段按以下顺序：

1. 检查当前完整执行计划、已验证候选及证据清单，对照实际方法、数据使用和诊断是否保留。reviewer accept 不替代此检查。先读真实证据；仅有清单不足以支持修复声明。
2. 按 `outcomeHash + findingID` 查看历史原意见、当时回应、当时计划、旧声明及当前适用性，逐项决定是否已完成、合法删除、有据反驳、需要纠正，或继续未决。不要将旧修复理由套给新意见；原已满足要求不可说成新增修复。
3. 对有依据的历史目标追加 `review_completion`，使用原 `responseHash/findingID` 和当前 basis/evidence，保留前序声明。没有足够证据则保留原意图并在最终 summary 披露，或追加 unresolved；不要求每项有完成声明。
4. 若需变更方法／数据使用／诊断状态，以 `review_response(planChange:revise, action:repair)` 关闭只读反馈并重新进入 exploration；先提交并准入新版计划，再执行、实验、验证。原计划内代码修复 retain/repair。已有产物与计划不一致时，先修订计划并在新版下重新验证。不得在只读反馈阶段执行修复。
5. 处理当前 outcome 的每项意见后，最后调用 `review_response(action:submit)` 并停止；该调用关闭当前反馈入口，之后不能再补完成声明。无 findings 时 responses 为空。提交是候选，不是成功或 Principal 认可。

现有状态机保留：feedback → repair/exploration 或 execution → experiment → delivery verification/review → feedback → submit/freezing → ready。无新增语义阻断或自动补写完成声明。

## 逐项状态视图

仅新 guidance 构建独立 closeout 视图，旧 details 格式与提示保持。每个历史目标包含独立 key、完整原 finding、原 outcome 阶段/可用性、原 response、原 planHash 与计划正文、当前 planHash 与正文、该目标声明链及 `current` 适用标识。原 finding 可能与最新 finding 同 ID，绝不合并。当前尚未回应的 outcome 单列逐项提供，不能当成已存在 response 的完成目标。

当前性仅表示身份匹配，不等于已修复。没有当前声明时明确显示未决意图或原回应且无当前完成证明；有历史声明但已换候选时显示历史有效、当前不适用。完整 outcome 和原 hash 保留。未知／损坏的计划或证据对象拒绝，不猜补。原 availability=unavailable 如实显示并允许按既有策略继续。

## IPC 日志格式与兼容

Infrastructure v1 增加可选 `journal:"cas:1"`，没有字段保持原 inline JSONL。新格式使用每 journal 随机身份及版本字段，事件仍逐条保留 sequence、时间、请求 ID、action、Contract、期限、response/late_response/error 和 cleanup 状态。command_start 同时保存原 payload。身份及控制字段不做有损裁剪。

将 payload/result 的 JSON UTF-8 字节切成固定大小块（建议 64 KiB），按 SHA-256 存放本 journal 的 `operations.objects/<hash>`；每项描述符保存完整内容 hash、字节数、顺序块列表及与 journal/sequence/field/request/action/Contract 的绑定。固定块可复用反复读取的完整历史前缀，同时完整还原每次响应。对象先落盘，再同步追加引用事件；已存在对象必须校验内容，缺失／损坏不覆盖。此轮不改轮询频率、history API 或最早候选选择，避免混入调度变化；传输与 JSON 序列化成本仍存在。

统一 reader 支持历史 inline 和 cas:1。严格校验格式、绑定、块及总 hash/长度后才给调用方完整 JSON 值；未知版本、缺失、损坏、跨事件／请求／journal 引用必须报错。不得把解析失败当作空历史或没有候选。终态封存只信任已绑定私有 IPC 回应，继续核验真实 run 的 Contract；任一已观察候选不能降级成无候选。归档保存日志及全部对象并绑定原路径/hash；离线 reader 可以完整恢复。未确认清理时仍不得读取 live SQLite 作终态证明。

存储失败不得交付一个看似已可靠记录的操作成功；停止后续准入、保留可得失败证据并执行原有有界清理。cleanup 状态与操作执行结果仍分离；去重不证明第五轮卡点已修复，也不解决实时用量竞态。

## 验证与审查

先独立设计审查，关闭阻断再实施。确定性测试覆盖新旧发行与重试身份、提示顺序及状态视图、同 ID 不同 outcome、历史／当前完成适用性、实际计划修订→实验→完成→提交与未完成意图提交。沿用权限／deadline／候选变化／证据损坏和 required 回归。脚本驱动只验证机制，不计作 Researcher 自主能力。

日志测试覆盖 JSON 与 Unicode 往返、重复历史的实际存储减少、payload/response/error/late identity、缺块／损坏／引用串用、归档离线恢复、有候选防降级、操作超时与清理未知。通过相应包 typecheck 及定向测试后独立代码审查。中英文总设计、交接、实施和审查记录同步更新；第六轮和所有冻结材料只读。

后续真实校准必须另行冻结显式 guidance/journal 版本、源码和验收安排，才能检验真实模型是否采用机制。不修改本轮历史评分或定义新机会真值；下一测量版本可将 not_applicable 与 insufficient_evidence 拆开讨论。

## 独立设计审查后的边界补充

- 日志身份属于文件，不属于连接。同实例恢复复用 storage 时，CAS writer 先验证既有行格式、journalID 和连续 sequence，沿用身份并从最后 sequence 继续；不混用 inline/CAS，不重置计数，不覆盖对象。历史 inline 的既有行为保留。部分尾行或格式不符直接拒绝启动新的宿主。reader/归档覆盖同实例重启。
- 存储失败锁存原错误，关闭准入并拒绝 pending。kill／原清理期限／实际进程观察必须独立于 journal 写入是否成功；stop 里的日志写入降为尽力记录，失败不能跳过清理。清理文件若能写则保留 recordingError；写不出时原错误继续向调用方传播，不声称清理或记录完整。
- read 读取候选源码属于当下 workspace 观察，不冒充 subjectHash 绑定证据；归档实验／验证仍是完成声明证据来源。提交重捕获发现漂移继续拒绝旧候选提交，旧声明不借 read 升格为当前证据。
- CAS 模式另为每次连接生成 `connectionID` 并写入 startup/所有事件；清理报告按连接独立文件保留（`cleanup-<connectionID>.json`）。归档只在所有已观察连接各自有匹配的 confirmed 清理记录、最后连接的记录与日志一致时复制数据库；旧连接的成功不能证明新连接结束。历史 inline 保留旧布局。覆盖首次 confirmed、二次 unconfirmed／confirmed 的恢复场景。
- 响应保存后、交付给调用方前重查每请求 absolute operation deadline 及原实例 deadline。若同步序列化／落盘跨过期限，追加超时／未交付事实并关闭连接、清理；timer 尚未执行不授权迟到成功。磁盘节省不表示时延改善。
- guidance 同时进入成功／失败／attempt 记录、阶段二材料 measurement 及 reveal 对照。缺省时不添加字段或改旧 JSON 形状；新字段和配置／任务／测量不一致拒绝。发行前失败以 attempt/cohort/失败证据绑定，不能依赖不存在的 agreement。
