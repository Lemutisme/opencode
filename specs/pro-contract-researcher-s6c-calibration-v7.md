# 第七轮真实开发校准：一例候选通过双评，终态封存阻断反馈评分

2026-09-21。三例均按冻结顺序实际运行一次；本轮仍为**未完成校准**。P1 好计划提交了正确候选，两名独立评分者各六项全 true；P1 坏计划与 R3 未提交候选。两例正常返回的无候选结果触发终态封存代码缺口，整批反馈材料未开放、反馈评分为 `not_scored`。四条完成声明是实际观察，尚无双评支持，不能宣称收尾机制可靠。

证据根目录：`/workspace/researcher-calibration-v7-20260921T062428Z`。入口为 `final-summary.json`、`launch-registration.json`、`scoring-integrity.json`、`journal-restoration.json` 和 `independent-blocker-review/`。独立评分及阻断复核见[独立记录](pro-contract-researcher-s6c-calibration-v7-review.md)。

## 冻结与启动

修改前 6,627 项工作树文件、链接和 mode 与上一阶段已审查的完整快照一致，没有将 HEAD 当作实现基线，没有还原既有未提交成果。新冻结保留完整源码；本轮运行时未改实现、配置或评分真值。

| 冻结项 | 本轮值 |
| --- | --- |
| worker / reviewer | `gpt-5.6-luna / low`，本机免密 Responses；seed 不支持 |
| 场景 / 反馈协议 | `repair-lifecycle-development:1` / `repair-lifecycle:1` |
| 测量 / 展示门槛 | `repair-lifecycle-measurement:1` / `candidate-or-terminal:1` |
| 收尾提示 / 日志 | 显式 `feedbackGuidance:"closure:1"` / `infrastructure.journal:"cas:1"` |
| infrastructure | version 1，startup / operation / cleanup 均 30,000 ms |
| 单次期限 | provider 900,000 ms；tool 600,000 ms；verification 120,000 ms；cleanup 30,000 ms |
| 实例预算 | 原 issuedAt 加六小时；无累计请求、turn、action、实验或费用上限 |
| 完整源码 manifest | `82c60bf365e67b81adb69491408988fc431cf0dbd4204dab55462f4e7c52d8f3` |
| runtime | `7f8a2cb8926e3d84d0d27e886df3a158a4140a25f474d574fae03dc4f8b90f5a` |
| scenarios | `1f2adb348e9ff12d06f1444ced569b081c57ddc108b9a1118a90ca5c1c876a89` |
| 启动登记 hash | `3683c4096139f4cd5c65ea0b17d84feca439260e55faed7e39315243a2fb6f54` |

启动前本次重跑 28 项确定性检查、3,320 assertions，全部通过：Schema 2、Core 预算 3、Session 原 deadline 4、gateway／评分／lifecycle／CAS 19。包括超越旧累计上限、原 deadline 中断、隔离和完整日志恢复。此前实现阶段的完整套件及 typecheck 仍按[原实施记录](pro-contract-researcher-closure-implementation.md)解释，不冒充本轮重跑。冻结、启动前及运行后源码核验均通过。服务预检只建立 TCP 连接，没有额外模型试跑。

预先登记评分者 `/root/v7_rater_a`、`/root/v7_rater_b`，裁决者 `/root/v7_adjudicator`，均为独立新上下文。材料限制为合作式访问，不是 OS 沙箱或异构人类评审。评分者不可用时保留失败、不替补或以单人代替双评；本轮评分者均可用，阻断来自封存基础设施。

## 三例原始结果

| 场景 | 运行与实际记录 | 独立候选质量 | 反馈质量 |
| --- | --- | --- | --- |
| P1 坏，`0ded50a3026b11bdf20d279e` | 计划由 v1 修订到 v2；第二份 review 的 finding 集合改变，后续回应仍带旧 F3，继而多次改变协议字段并报告 blocked；无正式交付、零完成声明 | `not_submitted`，不为不存在的候选评分 | `not_scored` |
| R3，`1897325aa7a29bada49f1e7c` | 两次计划请求均把原 64 位 manifestHash 少写末尾一位，随后声称宿主拒绝原值并报告 blocked；无获准计划、无 review、无候选 | `not_submitted` | `not_scored`；review／修复机会未触达 |
| P1 好，`0ea9999a8cd0a4ecf29b4e02` | 计划 v2；保留可选诊断，validation 选参／test 评估；提交候选；追加四条 `fixed` 完成声明 | 两名评分者各六项全 true，`correct`，无分歧 | `not_scored`；声明真实性及逐 finding 处理未获双评 |

前两例宿主原因均为 `Worker stopped without a delivery request; explicit recovery is required`。这不是 reviewer unavailable，也不是发行超时。没有人工恢复或额外运行。坏例修订计划不等于实际实现并验证了泄漏修复；本轮没有证据将其计为完成修复。

P1 好的候选独立依据包括：全四对效应 3，满足固定两单位描述性阈值；保留正确对照与非因果限制；实际 `explore` 用 validation 选择阈值，再用 test 评估，隔离诊断检查了 ID 重排和数值干预。候选质量评分不认证四条完成声明，也不把原已满足的要求自动算作新修复。原始首评均为 `changes_requested`；好例随后两份为 `accept`。这些是原始判词，首评是否误拒及各 finding 是否成立仍未独立评分。

五份已发生报告均 `available`。reviewer unavailable 处理机会为 `not_observed`；R3 根本未到 review 阶段。没有为了获得误拒、unavailable 或修复机会重跑。未评分不能记为成功，也不能用操作方读轨迹替代两名评分者的判断。

| 实例 | issuedAt（UTC） | 原 deadline（UTC） | 真实请求 worker / reviewer |
| --- | --- | --- | --- |
| P1 坏 | 06:29:21.264 | 12:29:21.264 | 15 / 3 |
| R3 | 06:31:55.514 | 12:31:55.514 | 4 / 0 |
| P1 好 | 06:32:31.908 | 12:32:31.908 | 22 / 7 |

三次发行成功，逐连接清理均 `confirmed`，数据库均在停止后复制取证。发行主操作分别约 1,223 / 1,250 / 1,417 ms；这不证明第五轮发行卡点已修复。原期限没有延长。

## 评分阻断与保留边界

两例无候选分别执行一次生产 `seal-terminal`，均报 `Terminal admission coordinates differ`。普通 `runInstance` 返回对象把约定保存在 `monitored.run.input`；`terminal.ts` 却将 admission 中的约定与不存在的顶层 `failure.agreement` 比较。两个真实对象的 admission、run input、Contract、issuedAt 和 deadline 相符；拒绝来自结果形状处理，不是已发现的约定变更。独立工程复核及原始错误日志完整保留。

已有候选的盲评已经封存，candidateHash 为 `baa22a3330d176c32e0d60b16ab8aef6240f08d9362eaa77a04fbacaca1a0241`，封存 hash 为 `8bc1ab9f8dbecee6e4c13ca2c46edb9a7f0673377ffab1c63e492a385af734ce`。随后唯一一次 reveal 尝试按冻结门槛拒绝：缺少前两例终态 seal，不能转而伪造其候选评分。两名评分者均确认未接触第二阶段材料。所有三例的反馈评分保持 `not_scored`，没有完成生命周期能力评分。

没有修改冻结代码、补写 result.agreement、删除 admission、手工伪造 terminal-ref 或换评分规则来走通本轮。候选提交、reviewer 判词、机械准入、科学修复成立及 Principal 最终认可继续分开；本轮没有外部认可。

## 真实日志与计量

生产 `readJournal` 分别从 live 存储及仅归档对象恢复全量内容，检查块 hash、完整内容 hash、字节数、绑定、序号，并比较完整恢复流身份。三例 10,361 个事件全部一致，归档 loader 没有 live 回退。

| 存储口径 | 字节 |
| --- | ---: |
| 全部恢复后的 JSON 事件（含当前身份元数据） | 4,945,960,542 |
| 一份 live journal 加去重块 | 32,478,860 |
| 上述 live 文件的文件系统分配量 | 32,610,304 |
| 另存的归档 journal 及块 | 32,478,860 |

当前表示相对完整恢复表示减少约 99.34%。该口径不包含源码镜像、传输日志、数据库、工作区及其他归档对象；不是整根目录压缩率，也不是与第六轮同一轨迹的对照试验。没有测得或声称时延改善，不能据此倒推第五轮超时原因。

真实请求共 51 次（worker 41、reviewer 10）。原账本已知 642,373 tokens；独立来源化补记 9,202；派生已知 651,575。补记对应一条仍为 `interrupted` 的操作，来源、operation/request 及去重 factID 在 `accounting-supplement/`；没有改成操作成功。75 个未知操作条目、费用和独立评分 agent 用量仍未知，派生已知总数不是完整计量，实时记录竞态仍未修复。

第六轮及上一实施阶段的 29,968 个已登记文件本次重新核验零差异；更早批次按已有完整性记录保留，没有写入历史根目录。最终只新增本轮文档并更新中英文总设计与交接，不改 runtime。

## 下一步与比较限制

先修复正常返回但无候选的终态封存分支，补充该真实对象形状的无模型回归及独立复核；失败封存应继续严格证明身份、原 deadline 和候选缺失，不能通过宽松比较消除错误。另定向诊断 worker 的 hash 抄写、跨轮 finding 集合以及版本错误提示：坏例最先是多带旧 finding，后续 legacy 解析错误又诱导它去掉新版字段，不能只归因于模型或只归因于宿主。

本轮不追改评分或启动新的实测。若未来授权用修订评分基础设施重放这些材料，应另建有新身份的派生评估，保留本轮未完成状态。修正与独立验证后再决定下一轮小规模校准；66 例继续暂缓。

与第六轮沿用三例、Luna / low 和评分真值，但提示新增 `closure:1`、日志新增 `cas:1`，真实轨迹和被触达机会均不同。本轮仅一个最终候选，反馈评分未开展；四条完成声明与此前零条的差异只能说明观察到调用，不能证明真实性或总体可靠性提升。历史实际修复、合法删除、未结意图和所有 null 评分原样保留。
