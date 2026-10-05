# ProContract 递归自我改进与晋升研究

日期：2026-09-04。状态：实现审计与可执行实验设计，不是 RSI 性能结果。

本文服务于 [paper skeleton](../pro-contract-paper.md) 的 C3。核心问题是：在相同总搜索
成本下，被认可的 successor 实际参与下一轮 candidate generation，是否产生超过固定
机制和一次性改良的 untouched-final 收益。若不能，论文必须删除 recursive-capability
主张；本文不承诺持续改进、开放式增长或任意统计精度。

方向修订：C3 现为后置分支，不承担整篇论文成立的必要条件。先验证可变执行下的
认定连续性，再验证采用/撤销候选后的效用保留，最后才研究递归优势。本文的否定
结果只收窄相应改进主张，不能替代对 C1 的检验；见 [实验总计划](experiment-plan.md)。

## 1. 新颖性边界

本研究不把 self-modification、candidate archive、独立 evaluation、promotion gate、
预算门禁或 rollback 单独作为新颖性。DGM `arXiv:2505.22954` v3 摘要已描述自身代码
修改能力、archive 以及 `no-self-improvement`/`no-open-endedness` baselines。公开索引
的 _Scientific CI/CD for Self-Modifying Discovery Agents_ 已提出 statistical、capacity
和 domain-verifier gates；其 venue status 未核实。

可争取的知识增量是 identification：区分 successor 被选中、被部署，以及它实际改变
后续 candidate distribution，并测试该参与是否可审计。

## 2. `910d9f285` 仍然实现了什么

运行时坐标是 `910d9f2856323ad5493ee52f8cb2c315d2172e10`；当前 HEAD 与它的
runtime 相同，差异仅为 `specs/pro-contract-experiments.md`。

| Surface                       | 当前实现                                       | 未实现                                     |
| ----------------------------- | ---------------------------------------------- | ------------------------------------------ |
| `pro-contract-rsi.ts`         | 两个 hash 的 paired JSON adjudication          | run provenance、完整搜索成本、promotion    |
| `select-contract-artifact.ts` | evidenced development selection                | policy improvement/holdout authorization   |
| `contract export`             | exact handoff Snapshot materialization         | winner selection/active policy change      |
| `executionPolicy`             | durable binding，按 Session 首次注入           | evaluated identity 到 successor 的可信绑定 |
| Contract kernel               | revision/subject/evidence/authority settlement | evaluator origin 与 semantic truth         |

### 2.1 RSI adjudication

`packages/opencode/script/pro-contract-rsi.ts` 的 `Manifest` 固定 baseline/candidate/budget
hashes、`private/confirmation/ood` tasks 与 evaluators，以及 replicate、mean、bad-tail、
cost、attempt thresholds。`Run` 记录 split/task/replicate/harness、utility、cost、attempts、
manual interventions、violations 和 budget compliance。

gate 拒绝 split overlap、unknown/missing/duplicate pairs、错误 evaluator/budget、未登记
replicate、人工干预、violation、超预算和 threshold failure；输出带 manifest/runs/report
hash，reject 返回非零 exit code。它只裁决调用方 JSON：

1. `candidateHash` 不绑定 bytes、generation、parent 或 mechanism class。
2. 不记录 generator cost、失败 candidate、selection multiplicity 或 retry lineage。
3. `replicate` 是调用方整数，不证明随机化、seed 或真实 pairing。
4. 三个 splits 被一次 decision 同时消费，不能表达逐代 fresh promotion blocks。
5. `runsHash` 对 array order 敏感；重排语义相同 records 会改变 identity。
6. accept report 不执行 promotion，也不证明 report 来源。

### 2.2 Selection、export 与 execution binding

`select-contract-artifact.ts` 要求 current revision 的 `discharged` Contract、exact
`subjectHash`、`attestationID` 与 passed replay；从 exactly one incumbent 和 admissible
candidates 中按 score、timeouts、Contract ID 选择。输出 create-once/conflict-fail，并
明确写 `policyPromotion: false`、`validationOpened: false`、`holdoutOpened: false`。
score/admissible 仍来自外部 report。`contract export` 只 materialize handoff。

`packages/core/src/pro-contract/open-code.ts` 在 `Binding` 中持久化 raw
`executionPolicy?: string`；`scheduler.ts` 在新 executor Session 首次 admission 注入 exact
text，Session rotation 会从 binding 再注入。其边界是：

- 不属于 `ProContract.Spec`，不进入 `specHash` 或 Contract revision；
- 没有独立 `policyHash`、parent、promotion evidence 或 issuer identity；
- `create` 使用 `onConflictDoNothing`，没有 public in-place policy update；
- CLI/tool/HTTP 可直接传入；HTTP `policy` 只是 deprecated binding-input alias；
- tool 要求 independent selector，但 runtime 没有 selector/binder。

这足以执行给定 policy，不足以证明 policy 经可信评估后接管 successor。kernel 仍可复用
exact Spec/revision/subject/replay/attestation、issuer-only discharge、challenge propagation、
atomic ledger 和 replay/export；但 `principalAttest`/`settleEvaluation` 信任外部 caller。

## 3. 已失效的 MetaContract / `spec.policy` 叙述

`MetaContract` 在检查过的 runtime commits 中不是独立 schema、command 或 state；它是
ordinary Contracts、selection 与 policy dependency 的历史组合名。

`7054140b6` 把 search policy 移到 execution binding 并删除 CLI `contract policy`。
`910d9f285` 进一步删除 `Spec.policy`、`Requirement.policy`、`contract_policy` config、
inherited Policy Contract configuration 和 canonical policy-selection command。

Schema 会丢弃 legacy `Requirement.policy` metadata；HTTP deprecated `policy` 仅提升为
`executionPolicy`。旧文档中的 `spec.policy`、`requires.policy`、`opencode contract policy`
及 automatic policy-consumer retraction 均不是当前可执行路径。

普通 `requires` 仍传播 support loss，但不验证 requirement handoff bytes 等于 binding
policy。纯 generation ancestry 不应放入 `requires`，否则 parent evidence 失效会错误撤销
已经独立验证的 child。

## 4. 历史 pilots 的证据边界

历史 E2E 演示过 `P0 -> MetaTask -> P1 -> Task`，并在 challenge P1 后撤回 dependent。
它依赖已删除 vocabulary，只证明旧机制 bounded flow。capability pilots 均未证明增长：

- CMatrix first-order 与 baseline 同为 768/769 raw，但 turns +20.3%、actions +18.1%、
  cost +3.9%，且缺 confirmation/OOD，故拒绝。
- CMatrix second-order turns +54.2%、actions +36.1%、cost +78.0%，并有两次
  unbounded-process incidents，未进入 confirmation。
- Tailspin cost -32.9%，但 mean utility 75.57% -> 74.10%，一对下降 5.54 points。
- 四任务 policy confirmation 平均为正，但两题下降 12.08/10.89 points，违反 bad-tail。

这些结果支持 conservative rejection，也证明“生成 P2”不等于“P2 改善生成机制”。

## 5. 冻结研究对象

首项研究只允许改变 `ExecutionPolicyArtifact S_g`，不允许任意改 OpenCode 源码：

```text
version, mechanismClass, generation,
policyHash, parentPolicyHash, text, generatorRunHash
```

`policyHash = SHA-256(canonical UTF-8 text)`；`mechanismClass` 固定为
`execution-policy-text-v1`，text 有预注册 byte/token ceiling。以下不可由 candidate 修改：

- model/provider/settings 与 base weights；
- OpenCode binary、runner、tool schema、system prompt；
- meta-generation brief 与 candidate output schema；
- Contract terms、authority、budget、replay、settlement；
- tasks、evaluator、promotion rule、generation/candidate counts；
- recorder、archive、holdout custodian 与 active-policy binder。

## 6. 最小无付费模型 readiness probe

这是任何 recursive-value campaign 的硬前置，目标是证明 evaluated policy identity 实际
进入 successor run，而不恢复 `spec.policy`。

### 6.1 实验侧 `PolicyBinder`

输入为 exact PolicyArtifact bytes、candidate delivery/evaluation coordinates、accepted
gate report、principal-approved `PromotionRecord` 和 successor draft。`PromotionRecord`
至少绑定：

```text
fromPolicyHash, toPolicyHash, mechanismClass, generation,
candidateSubjectHash, evaluationReportHash, gateReportHash,
ruleHash, budgetHash, principalIdentity
```

`PolicyBinder` 必须：

1. 重算 policy/evaluation/gate/rule hashes。
2. refetch current Contract revision/subject/attestation。
3. 验证 gate decision、promotion coordinates 与 mechanism class。
4. create-once 写 PromotionRecord；conflicting retry fail closed。
5. 以 exact `toPolicy.text` issue successor `executionPolicy`。
6. 保存 issue response 的 binding、Session ID 与 prompt ID。
7. 从 institution-owned admission record 重算首次 prompt hash。
8. 断言 admitted policy bytes 的 hash 等于 `toPolicyHash`。

policy identity 属于 experiment/promotion plane；Contract 继续只管理 duty、authority、
evidence 与 settlement。

### 6.2 Deterministic execution 与 negative controls

使用 deterministic local provider 和 tiny filesystem fixture：`S0` 产生固定 evaluated
`S1`，host 形成 gate report/PromotionRecord，binder issue successor MetaTask，证明 binding
与 admission 使用 exact S1；rotate Session 后再次证明；successor 输出只在 S1 生效时出现
的 marker。

negative controls：wrong policy bytes、stale revision、wrong subject/evaluation hash、reject
report、missing approval、conflicting retry、existing binding with different policy、forged
admission hash。每项都不得改变 active pointer 或启动 successor。

Readiness go 需要全部满足：

- artifact -> PromotionRecord -> binding -> admission 是同一 evaluated policy identity；
- exact retry idempotent，conflicting retry rejected；
- rejected/stale/forged evidence 不启动 successor；
- Session rotation 保持 identity；
- all attempts、invalids、costs 有 immutable terminal records；
- ancestry 与 evidential dependencies 分开；
- final-task custodian 对 generator/controller 不开放。

任一项失败即 no-go；不得用付费 campaign 代替修复。

## 7. Successor participation 与三个 arms

每代 fixed `MetaTask` 从允许的 private observations 生成 `K` 个 candidates。binder 以
active `S_g.text` issue MetaTask；runner 记录
`generatorPolicyHash == activePolicyHash_at_start`；candidate 以自身 text 运行 private
task evaluation；finite gate 最多接受一个；accepted successor 绑定下一代 MetaTask 和
task runs。只参与 task execution、不参与下一代 MetaTask 属于 iterative deployment。

### F：`fixed`

所有 MetaTask/task runs 始终使用 `S0`；每代仍生成、评估等量 shadow candidates 并支付
完整成本；would-be promotion 只记录，active mechanism 不变。

### O：`once-improved-then-frozen`

generation 0 用 S0，最多一次 promotion 得到 S1；若没有 candidate 通过，则按预注册规则
冻结 S0。以后 MetaTask/task runs 使用该 exact post-seed active policy；后续 shadow
candidates 仍生成/评估，但不得替换它。

### R：`recursive`

与 O 使用同一 generation-0 protocol；每代最多接受一个 successor；seed stage 或后续
generation 无 candidate 通过时保持当前 policy，并按预注册 schedule 继续或终止。

top-level lineage 在 seed stage 前随机化；O/R 从 exact same post-seed state
`S* in {S0, S1}` fork，而不是只保留成功产生 S1 的 seeds。每个 no-promotion、invalid、
failed seed 及其完整成本都进入 ITT；O 保持 S0 或执行事前声明的 terminal behavior，R
也从该同一状态继续。两臂都把 seed-stage 完整成本计入 attributable total，不能因物理
共享打折；F 执行等成本 shadow seed stage。

untouched-final `R - O` 识别 continued adaptation 相对 once-frozen 的价值，但不能单独
区分 generator recursion 与 repeated successor deployment；`O - F` 测 one-shot value，
`R - F` 也不能单独识别 recursion。

若论文声称 successor 因参与 MetaTask 而改善 candidate generation，`R-sham` 是必需
control：它允许与 R 相同的 successor selection/deployment，但后续 MetaTask 始终使用
post-seed frozen generator policy S\*。R 必须优于 R-sham，且 mediator 证明 candidate-pool
差异来自 generator binding；该控制不得降级为可选分析。

## 8. Equal total search cost

每臂冻结同一资源向量：provider input/output/reasoning/cache tokens、billed cost、turns、
tool actions、wall time、candidate-generation/evaluator jobs、evaluator CPU、retries、invalids、
failed/rejected candidates。计入 generation、materialization、replay/preflight、private 与
promotion evaluation、selector、timeout、infrastructure retry 和 recovery；final 等量单列。

固定 `G`、每代 `K`、每 candidate `R_dev`。hard ceiling 前不再启动新 job；failure 不
自动补跑；仅预注册 infrastructure class 可 retry；retry 追加而不覆盖；余额不跨 arm；
同时报告 ceiling/actual spend。主图是 final quality 对完整 search cost，不是 winner cost。

## 9. Adaptive holdout 与 provenance

数据分三层：`D_search` 是可重复 owned private data；`P_{replicate,g}` 是每代 fresh
promotion block，使用后永久 consumed；`F_final` 在所有 mechanisms 冻结后只运行一次。
即使只反馈 pass/fail，Pg 也已参与 adaptive selection。host 不把 task-level Pg failures
给下一代模型；final task IDs/evaluator bytes/image digests 由独立 custodian 管理。无法
隔离时，claim 限于 trusted-operator protocol。

只读检查 ProgramBench runner revision
`869b7e97390813bf7d84f3407ae93db6d9a3f9f8`：它已冻结 config、binary、image/evaluator
identities，并记录 usage、artifact hashes 与 terminal state；但只支持两臂和
`execution_policy: behavioral|none`，policy 是 hard-coded `ACCEPTANCE_POLICY`，records
未接入 RSI gate。

`RunEnvelopeV2` 至少包含：experiment/replicate/arm/generation/candidate/attempt IDs；
policy/parent/generator/subject hashes；OpenCode revision/dirty patch/binary/runner identity；
model/settings/system/meta/task/tool hashes；blinded task/split epoch/evaluator/image digests；
Contract/revision/spec/binding/Session/prompt/handoff/replay identities；timestamps、exit class、
resource vector、artifact/report hashes；retry parent、previous-record hash、recorder identity。

adjudicator 必须从 runner-owned immutable envelopes 构造 summary，验证 bytes 或可信签名，
并要求每个 planned slot terminal。candidate 自报 JSON 或 content hash 不构成 provenance。

## 10. Finite promotion 与解释识别

每代收齐 exactly K slots，在 D_search 按 fixed rule 选最多一个 finalist，再与 incumbent
在 fresh Pg matched comparison。只有同时满足事前 `minMeaningfulDelta`、bad-tail、budget、
zero forbidden violation 和 complete provenance 才创建 PromotionRecord。达到 G 或 hard
budget 时结束；无 finalist 或 reject 消耗当前 generation/selection slot，不晋升。是否进入
下一个预定 generation 必须在实验前冻结，不得增加 slots“继续试到成功”。`minMeaningfulDelta` 由事前
practical value 规定；blinded pilot variance 只用于确定 confirmatory study size，不得用来
选择一个恰好让 observed winner 过门槛的 margin。

结果解释：

- `O > F`, `R ≈ O`：useful one-shot policy，无 recursive value。
- 完整计入 shadow/failed search 后优势消失：more compute/accounting artifact。
- 丢弃 no-promotion seeds、O/R 未从 same post-seed state fork 或只报最好 lineage：
  selection luck/conditioning bias 未排除。
- `R - O` 达阈值：支持 continued adaptation，不自动支持 generator-recursion mechanism。
- generator-recursion claim 还必须有 actual generator-binding mediator、R descendant pool
  优于 frozen-generator pool，并且 untouched-final R 明确优于 required R-sham control。

active pointer 改变、代数增加或 development score 单调上升都不充分。

## 11. 三种判定、archive 与 dependency

- `experiment completion`：所有 planned records terminal，失败/deviations 如实记录。
- `candidate improvement`：冻结 comparison 支持 candidate 优于 incumbent。
- `promotion`：authorized host 让 exact candidate 成为下一代 active mechanism。

更差 candidate 也可构成成功完成的实验。accepted report 只是 petition；没有
PromotionRecord 和 actual binding 就没有 promotion。research archive 保存所有 candidate
与负结果；deployment registry 只暴露 accepted policy，archive 不授予执行权。

`parentPolicyHash` 是 generation ancestry；`evidenceRefs` 是 current evidential dependence。
parent evidence 失效不应仅因 ancestry 撤销 independently re-evaluated child。

## 12. Staged pilot 与 go/no-go

**Stage 0：deterministic simulator。** 无模型生成已知 S0->S1->S2 和失败 lineage，验证
三臂、budget、fresh-block consumption、canonical records、dependency 分离和 final secrecy。
全部 corruption cases fail closed，R 使用 S2 而 O 保持 S1，才进入 Stage 1。

**Stage 1：第 6 节 readiness probe。** 无付费 provider，证明 evaluated policy identity
到达实际 successor binding/admission；这是 recursive-value campaign 的硬前置。

**Stage 2：small owned-task model pilot，需另行授权。** 小 K、`G=2`、两个 top-level
blocks、sealed final。不得将 ProgramBench official hidden evaluation 用作逐代反馈。进入
confirmatory 的必要条件：readiness/provenance 全通过；成本合规且失败全部入账；至少一个
可验证 second-generation promotion；两个 blocks 的 final R-O direction 一致且达事前
实用阈值；无 forbidden violation、严重单臂 bad tail 或 evaluator invalidity 聚集。

**Stage 3：confirmatory。** 样本由 Stage 2 层级 variance 与 meaningful effect 决定；冻结
代码、分析、stopping 后打开新 final cohort。R 不优于 O 时停止 RSI claim，不增加代数、
改 threshold 或筛 lineage 救结果。

failure taxonomy：`generation_invalid`、`no_novel_candidate`、`delivery_invalid`、
`evaluation_invalid`、`candidate_regression`、`promotion_rejected`、`binding_mismatch`、
`recursive_stagnation/degradation`、`adaptive_overfit`、`compute_confounded`、
`infrastructure_failure`、`protocol_violation`。主分析 intention-to-treat；recovery winner
不能覆盖 invalid/rejected lineage。

## 13. 后续 integration surfaces

OpenCode：

- `pro-contract-rsi.ts`：保留 v1；新增 canonical Manifest/RunEnvelope V2、generation、
  lineage、完整 cost 与 finite gates。
- `pro-contract-rsi.test.ts`：增加 reorder、missing failure、retry overwrite、holdout reuse、
  wrong generator policy、budget leak、ancestry/evidence confusion tests。
- 新 experiment-owned `PolicyBinder`/registry：验证 bytes、evaluation、PromotionRecord 后
  才传 issue `executionPolicy`；不恢复 `spec.policy`。
- `open-code.ts`/`scheduler.ts`：若外部 recorder 不足，增加 read-only policy-hash/
  provenance 与 dispatch evidence；policy 仍在 Contract terms 外。
- selector 保持 development-only，或新增 generation-aware selector；现有输出不是 promotion。
- ProContract `requires` 只表达真实 evidence；lineage 存 experiment registry。

ProgramBench runner：

- `run_opencode.py`/`campaign_runner.py` 支持 F/O/R、generation、replicate 和 arbitrary
  content-addressed policy file。
- `campaign_procontract.py` 从 manifest 读取 exact policy，记录 issue/binding/admission。
- `campaign_state.py`/`campaign_evaluate.py` 导出 immutable envelopes、retry lineage、
  all-terminal index 与完整 cost，复用已有 binary/image/artifact hashes。
- 独立 split custodian 管理 D_search、一次性 Pg 与 sealed F_final。

无需恢复 global `contract_policy`，无需 MetaContract kernel type，也不允许 candidate 修改
evaluator 或 promotion rule。

## 14. 当前结论与本轮测试

`910d9f285` 有 settlement substrate、execution-policy binding、development selector 和
deterministic pair gate；没有 evaluated policy 到 successor 的可信 promotion loop。最小
下一步是第 6 节 readiness probe。通过后 O/R 从同一 post-seed state（S0 或 S1）fork，才可启动 recursive-value
campaign。

本轮无付费 provider、cloud、Docker、download、build、branch、commit 或 subagent。

已运行：

```text
packages/opencode:
bun test script/pro-contract-rsi.test.ts test/script/select-contract-artifact.test.ts
7 pass, 0 fail

packages/schema:
bun test test/contract-hygiene.test.ts
  --test-name-pattern 'contract requirements discard legacy execution-policy metadata'
1 pass, 0 fail, 7 filtered

packages/core:
bun test test/pro-contract.test.ts
  --test-name-pattern 'dispatches a due contract through its separate binding'
1 pass, 0 fail, 44 filtered
```
