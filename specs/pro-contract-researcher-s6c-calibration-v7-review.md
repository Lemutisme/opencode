# 第七轮独立候选评分与封存阻断复核

2026-09-21。证据根目录：`/workspace/researcher-calibration-v7-20260921T062428Z`。本记录对应[第七轮真实校准](pro-contract-researcher-s6c-calibration-v7.md)，不是完整反馈评分或新的实现审查。

## 预登记与候选双评

启动前登记 `/root/v7_rater_a`、`/root/v7_rater_b` 和独立裁决者 `/root/v7_adjudicator`，三个新上下文分别确认阶段允许清单。两名评分者只读取评分说明、唯一实际候选及固定六项 rubric，不执行候选，不查看研究轨迹、历史结果或彼此意见。独立上下文使用相同模型家族；材料隔离是合作式限制，不冒充异构人类评审或 OS 沙箱。

P1 好候选身份 `baa22a3330d176c32e0d60b16ab8aef6240f08d9362eaa77a04fbacaca1a0241`，rubric 身份 `bf5477ed21b8f452c70bb0693366a75937ca20b8d8b4a2532f29421dc3855ebd`。两人对 `numeric`、`conclusion`、`evidence`、`controls`、`limits`、`population` 均判 true，无分歧，不需要候选裁决。独立理由包括全四对效应 3、固定描述性正结论、正确对照与因果限制，以及实际 validation 选参／test 评估及干预诊断证据。

原始 annotation 与理由分别保留在 `ratings/a/phase-one/` 和 `ratings/b/phase-one/`。生产 `seal-candidate` 封存 hash 为 `8bc1ab9f8dbecee6e4c13ca2c46edb9a7f0673377ffab1c63e492a385af734ce`；`scoring-integrity.json` 核验两份原始 annotation 与 seal 一致、四个原始文件未变。该结论仅覆盖六项候选标准，不认证修复意图、完成声明或 Principal 认可。

P1 坏与 R3 没有提交候选，未给不存在的候选编造质量评分。无候选结果的生产终态 seal 均失败；唯一一次 reveal 随后拒绝。两名评分者分别记录 `phase-two-not-revealed.json`，未查看 reviewer 意见或回应轨迹、未填写第二阶段 annotation。反馈判断、四条完成声明的支持程度和完整处理链均为 `not_scored`。这是基础设施阻断，不是评分者不可用；没有单人判断替代双人评分。

## 独立工程阻断复核

裁决者在无需候选裁决后，独立执行一项受限工程复核。允许材料仅为冻结的 `terminal.ts`、`instance.ts`、两份失败日志、约定坐标投影，以及从原始 result/admission/scoring 对象提取的指定身份字段；没有开放 reviewer、回应、session 或其他候选轨迹。因此该复核不能作为第二阶段能力评分。

独立结论确认 `terminal.ts` 的正常无候选返回路径存在结果形状缺口：`instance.ts` 正常返回对象具有 `monitored.run.input`，没有顶层 `agreement`；终态校验却无条件把 admission 的 agreement 与 `failure.agreement` 比较。两个归档 result 原始字节 hash 正确，Contract、原 issuedAt/deadline、策略及 admission 与 run input 的约定一致。已检查的拒绝并非真实坐标漂移，而是对象形状处理错误。

复核保留在 `independent-blocker-review/review.md`、`review.json`、`verification.json` 和追加的 `verification-serialization.json`。初次紧凑 JSON 重序列化 hash 与归档不同，后按生产缩进及换行格式重验一致；没有覆盖原始观察，也没有将序列化差异解释为篡改。

该复核没有独立审计完整终态 inventory、候选缺失证明、host journal 或事件链，也未核验源码副本与完整 runtime 的绑定；源码副本绑定由主执行核对。复核者没有重跑真实模型、修改源码／cohort、尝试手工封存或批准绕过展示门槛。据此，下一步建议明确区分正常结果和异常封装，按各自真实形状校验同一份约定并保留原有防候选降级／跨身份／过期防线；补正常返回 unavailable 且有 admission 的确定性用例后再独立审查。当前发现没有在本轮冻结版本内修复。

## 保留结论

一例候选双评完成，零反馈评分，零质量裁决，另有一项独立工程阻断复核。不得把四条 `fixed` 声明当成四次成功修复，不得把未提交与 reviewer unavailable 混为一谈。原始失败、剩余两例分母、真实用量和未知项全部保留；本轮没有重跑、外部认可或 66 例资格评测。
