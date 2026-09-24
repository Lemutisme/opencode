# 发行边界与无候选终态封存

本轮只解决第五轮暴露的基础设施缺口，不调用真实模型，不冻结或运行第六轮，不启动 66 例。修改前完整基线在 `/workspace/researcher-infra-20260921T035216Z/baseline`，6,603 项与第五轮最终快照逐项一致。第五轮仍是未完成校准，两个候选原双评及整批未评分保留。

## 显式策略与历史边界

未来配置可显式提供 `infrastructure:{version:1,startup,operation,cleanup}`，三个正整数分别是启动、单次 IPC 操作和清理的毫秒期限。仅支持 `repair-lifecycle-v1` 开发评测；绑定 setup、deployment、frozen configuration、result、失败对象和评分门。缺省不升级：第五轮的全部三例候选封存规则继续成立。新策略的展示规则版本为 `candidate-or-terminal:1`；研究任务、科学真值和生命周期判断标准不变，冻结测量另记新规则。

单次操作截止取其独立期限与原实例 deadline 的较早者。清理有单独的有限期限，可在研究 deadline 后清理，但不能继续研究。无累计次数或费用上限。默认值不通过很大的有限数模拟无限；本轮不以加大超时掩盖未知原因。

## 发行观测与停止

research 宿主增加可选、受信调用方提供的发行观察器，不写入研究 manifest，不向 Core 引入研究语义。记录校验、Location 获取、验证器／harness 核验、preparation 写入及锁、Snapshot 服务获取、capture、snapshot 保存、materialize、正式发行事务等阶段的 start 和 exit。每条记录绑定发行 ID、IPC request ID、宿主进程、顺序、时间及成功／失败／中断；实际错误原文保留。先记录 start，再执行；没有 exit 表示缺失终态，不能推断停止。观察器默认关闭，旧调用兼容。

新运行器将启动、命令和清理期限分开。IPC 到期或外部取消后先记录 `wait_expired`／取消和 `execution:unknown`，关闭该客户端的新命令准入，主动要求受信 supervisor 清理整棵进程树，不再把只读 IPC 空结果当作发行未发生的证明。迟到响应保留为迟到事实，不能让超时请求变成功。清理只在受信 supervisor 正常完成且原宿主进程身份已不活跃时记 confirmed；超时、特殊失败退出或无法核对时记 unconfirmed，保留原错误和之后的进程观测。相同停止调用复用同一个结果，不重置清理期限。

进程观测显式为 gone/replaced/alive/unknown：只有 `/proc` 明确 ENOENT，或核对 boot/start 身份后证明 PID 已替换，才说明原进程不再活跃；权限／I/O 错误保持 unknown。确认清理还要求 supervisor 成功回收。startup 未返回 host 对象时也持久保留启动和清理证据，不能因调用方没有对象而丢失。

失败后保全发行阶段日志、客户端操作日志、原 transport 和清理报告。确认停止后复制 DB/WAL/SHM 并校验源文件稳定，在副本上读取 preparation、research run、Contract 和 operation。未确认停止时仅保留有明确时间边界的证据及 unknown，不把活动数据库读取解释为终态。原用量账本及中断状态不改，实时用量竞态不在本轮修复。

## 候选与失败封存

新策略要求固定队列每个分母恰有以下之一：实际候选的双人封存；或无可评分候选的终态证据封存。无候选封存不是质量评分，不需要对不存在的候选填写 true/false，也不产生 Principal 认可。

新增 `seal-terminal` 入口，绑定整个 cohort 身份、顺序、不可变事件链、实例 ID、原 result/failure、策略、runtime、原 deadline（若已发行）、transport、阶段日志、停止报告及保全证据。可处理发行前失败、run 创建前失败、正常返回但没有提交候选、以及因前例基础设施失败／显式取消而未启动。保留 reason、attempted/admission 状态、候选不可用与实际不存在的区别、cleanup confirmed/unconfirmed 和未知项。字段缺失不能默认解释为零、停止或不存在。

已存在实际候选、scoring candidateAvailable=true、或失败归档显示 subject/candidate 时拒绝降级为无候选；评分准备失败也不等于候选不存在。能恢复的候选须进入实际候选双评，无法证明可评分材料缺失的情况继续拒绝封存并报告缺口。正常 run 的 not_submitted 有版本绑定的无候选证据，不伪造空候选质量评分。清理未确认时的终态只声明“本次归档没有可评候选、操作终态未知”，不认证宿主已停止；离线评价其他不可变候选不授权继续该研究。

terminal 必须记录证据截止时刻及清单，区分 absence、unavailable、unknown；后续发现候选或相关归档文件改变后，旧 terminal 不再授权展示。检查范围包含 cleanup-failure 的内嵌 result，不得利用“清理失败”隐藏已提交候选。run 创建前已存在 admission.json 时，也必须绑定原 issuedAt/deadline；未收到发行成功不能省略已经建立的坐标。正常 not_submitted 的 feedback 评分使用显式无候选 phaseOne，保留 indeterminate 和 terminal 引用，不编造 first/second 标注；run 创建前无 review 时无自身反馈可评。

所有真实候选双评及必要裁决、所有无候选终态先完成封存，再开放第二阶段。展示门和最终评分入口共同核对；原 artifact、事件、截止、策略或封存被改变，以及把有候选实例伪装成失败，均拒绝。单个 terminal 不展示其他 reviewer 内容。新报告分列候选质量、失败状态、反馈评分与完整性；保留固定三分母和 not_scored/not_observed 区别。

## 验证与审查

先独立设计审查，关闭阻断后实施；之后用确定性 fixture 和本地子进程做故障测试，再独立代码复核。必须覆盖发行前失败、阶段 start 无 exit、操作等待到期时子进程仍在工作、外部取消、原 deadline、迟到响应、清理未确认及证据保存、候选不可降级、跨实例／策略／事件串用拒绝、旧门保持、以及“两例真实生产路径候选、一例发行失败”的封存→展示→反馈评分流程。fixture 不调用真实上游模型，不能计为模型能力。

本轮没有判断第五轮 P1 坏计划缺少完成声明的原因。可选删除保持合法；未来实际修复、删除和完成声明继续分别评价。增量审查通过只说明基础设施可供另行冻结，不能把第五轮改成完成校准。

## 实施细化：候选证据来源

私有 IPC 的 command_start 与 response/late_response 按请求 ID、action 和 Contract 配对。仅结构化 research-get/history/issue/cancel/recover 返回及正式绑定 run/collection/audit 建立候选存在事实。模型原始报告、工件或任意 archive JSON 即使形状相同也不能冒充宿主状态。可信回应在交给 monitor 之前持久记录，因此 collect 中途失败及清理失败不丢掉已经观测的候选。原始反例、修正及独立核验见[增量审查记录](pro-contract-researcher-infrastructure-review.md)。
