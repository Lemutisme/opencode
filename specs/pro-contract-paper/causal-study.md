# ProContract 因果与性能实验研究报告

状态：实验设计与实现审计，不是已完成的确认性结果。日期：2026-09-04。

研究坐标：`contract-policy-split`；runtime reference
`910d9f2856323ad5493ee52f8cb2c315d2172e10`。当前 HEAD
`524da4a639a8f0192453428d2ff59b89315ed424` 相对 reference 只修改实验文档。

标签：**[代码事实]** 可由源码/diff/artifact 核对；**[观察]** 仅约束已有 pilot；
**[假设]** 待实验解释；**[未实现]** 后续研究实现建议。

方向修订：同日后续评议将生命周期中的责任/认定连续性提升为论文主线；本报告保留
为因果与接口子研究，不再决定首个实验。下文“主研究”“主故事”均指此子研究，
不能用投影实验代证认定权分离。执行顺序以 [实验总计划](experiment-plan.md) 为准。

## 1. 结论先行

1. **[代码事实]** 当前 policy “inject once”只是只写一次 durable user message；该
   message 在 compaction 前仍随 history 进入后续 provider requests。旧 projection 实验实际是
   “history 已有一份”对“每轮再加一份 system 副本”，不是“只看一次”对“每轮看见”。
2. **[观察]** 两任务 policy on/off 识别的是 within-ProContract fixed-policy presence effect，
   不识别 ProContract、policy/Contract separation 或 selector 的效果。
3. **[观察]** full/minimal projection 没有形成因果识别：单次随机轨迹、相反方向 invalid、
   未完全冻结的 dirty runner，以及 role、position、duplication、length、semantics 同时变化。
4. **[代码事实]** ordinary runner 已有 durable admission/resume、immutable freeze、packaging、
   preflight 和 usage accounting，并非空白 strawman；但当前 vanilla 与 ProContract 仍差 binary、
   prompt、permissions、delivery、budget enforcement、ready signal 和 settlement reminder。
5. **[未实现]** 主研究应是同 binary 的 `institution × policy` 2×2；institution-off 必须是强
   CI control。constraint placement 另做正交实验，避免不可解释的高维全交叉。

## 2. 当前 runtime 的真实 treatment surfaces

### 2.1 Admission、history 与 projection

- **[代码事实]** `executionPolicy` 位于 `ProContractOpenCode.Binding`，不在 canonical
  `ProContract.Spec`：`packages/core/src/pro-contract/open-code.ts:15`。
- scheduler 将 `brief/goal`、可选 policy、依赖/challenge 和 control-tool 指令拼成一次 `queue`
  prompt：`packages/core/src/pro-contract/scheduler.ts:84`；先 `resume:false` durable admission，
  再 wake execution：同文件 `:110`。
- 每个 turn 读取 Session history 并构造 `request.messages`：
  `packages/core/src/session/runner/llm.ts:228`、`:273`。因此 admission-only 不是
  first-request-only exposure。
- compaction 后只读取最新 compaction 及之后的 history：
  `packages/core/src/session/history.ts:24`；原始 policy 是否继续存在取决于 summary，当前无逐字段
  保留保证。
- 当前 top-level `request.system` 没有 recurring Contract dossier：
  `packages/core/src/session/runner/llm.ts:267`。但剩余 turn/action ≤20 时会追加
  `Settlement window active` system message：同文件 `:95`、`:262`。

| 名称                         | 精确定义                                     | 当前支持                  |
| ---------------------------- | -------------------------------------------- | ------------------------- |
| `admit-once/history-carried` | 只持久化一次，compaction 前每轮仍在 history  | 是                        |
| `recurring-system-duplicate` | history 一份 + 每轮 top-level system 一份    | 历史 commit，当前无配置面 |
| `first-request-only`         | 第一轮可见，之后明确移除 institutional block | 否                        |

### 2.2 Enforcement、settlement 与预算口径

- Contract binding 以事务 reserve main provider turn 或非 control tool action，超 deadline/ceiling
  拒绝并 escalate：`packages/core/src/pro-contract/open-code.ts:130`。
- main turn 在 `llm.stream` 前 reserve；但 auto-compaction 在 reserve 前可能另发 provider request：
  `packages/core/src/session/runner/llm.ts:287`、
  `packages/core/src/session/compaction.ts:195`。确认前必须统一 compaction 是否计 turn。
- `contract_report_ready/blocked/propose_revision` 不计 native action budget：
  `packages/core/src/tool/registry.ts:17`；runner telemetry 又统计 message tool calls。不能把两个
  action 口径混称 exact equal budget。
- Contract Session 先 deny all，再按 authority 开放 read/glob/grep/edit/bash 和 control tools：
  `packages/core/src/session/runner/llm.ts:231`。ordinary Session 当前工具集合不同。
- `contract_report_ready` 捕获 exact snapshot、执行 replay、记录 subject/replay；model ready 本身
  不 discharge：`packages/core/src/tool/contract-control.ts:123`。
- scheduler、lease、attempt、revision、旧 Session fencing 均持久化：
  `packages/core/src/pro-contract/scheduler.ts:147`、
  `packages/core/src/pro-contract/open-code.ts:257`。

### 2.3 Cache 可观测性

- main request 的 OpenAI `promptCacheKey` 来自 Session ID：
  `packages/core/src/session/runner/llm.ts:261`；challenge/recovery Session rotation 同时换 key。
- runner 已记录 per-turn input/output/reasoning/cache read/write、prompt total 和 max prompt：外部
  `scripts/campaign_usage.py:36`，但没有 segment cache attribution 或 rendered request hash。
- **[观察]** policy 四条轨迹 cache-read ratio 为 99.22%–99.62%，provider 报告 cache writes 为零。
  高 read ratio 是成本证据，不表示 policy 不影响模型，也不证明各 segment cache treatment 相同。

## 3. 既有实验的识别边界

### 3.1 Policy on/off：窄而有用

Artifacts：外部 `policy-split/output/policy-split-{on,off}-luna2-20260828-v{1,2}/` 下的
`RESULT.md`、`campaign.json` 与 `procontract/<instance>/procontract-issue.json`。

**[代码事实]** 两臂使用同一 OpenCode binary SHA
`b9a8f3e6ce4064fb78fd08870ab972e41504d90848341fc44b73a9a1929e12a1`、model/variant、images、
replay 和 ceilings；off 显式复用 on binary。ProgramBench SHAs 不同，但其 Git diff 只有 off YAML
增加 binary pin，runner behavior 未变。on manifest 省略 `execution_policy` 因为 `behavioral` 是
canonical default；off 记录 `none`。两边 brief 相同，差异是 binding 是否含固定 policy。

| Task                    |                Policy on |               Policy off |       已观察差值 |
| ----------------------- | -----------------------: | -----------------------: | ---------------: |
| `mgdm__htmlq.6e31bc8`   | 95.67%, 447 turns, $3.95 | 95.33%, 207 turns, $1.52 |  +0.34pp，多算力 |
| `eradman__entr.8e2e8b4` | 98.46%, 232 turns, $0.90 | 71.84%, 299 turns, $1.47 | +26.62pp，少算力 |

可接受表述是：在这两个已选 tasks、单次 stochastic runs、相同 ProContract runtime/ceiling 下，
fixed policy presence 对 selected final artifact 的总效果。

它不识别 separation、ProContract-vs-CI、总体 policy ATE、Entr-like selector、policy 语义相对
token/position/停止通道，或 equal-spend 效果。每 task/cell 只有一次；provider 无可验证 seed；
两个 campaigns 非随机 factorial；IDs、deadlines、cache keys 和 Entr 运行时段不同。HTMLq 几乎同时
admission 减轻时段混杂，Entr 不能。两任务宏平均 13.48pp 没有 task-population uncertainty。

### 3.2 Full/minimal projection：历史 falsification lead

Artifacts：外部 `full-runner/output/reliable-{base,candidate,minimal}-*/RESULT.md` 与对应
`campaign.json`；recovery artifacts 必须单列，不能覆盖 strict invalid。

**[代码事实]** `a1a791595` 每轮在 top-level system 重复 goal、claim、brief、policy、authority、
budget、evidence 和 settlement framing；`8cc580c84` 重复 goal/claim/精简边界；`2abdc89d` 不做
top-level copy，但原始 brief 仍在 durable history。base→full/minimal 产品 diff 均集中于
`session/runner/llm.ts` 与 test，但 treatment 仍同时改变 content、length、role、position、duplication
和 binary。

**[观察]** strict 四任务 base/full 中，HTMLq、FFmpeg 两边 valid 且 full 较低；Dupl 只有 base
valid，Entr 只有 full valid；invalid-as-zero mean 47.31% 对 46.76%。minimal 仅跑 HTMLq、Entr，
各一次，均高于 full，但低于 exact base 或后续 recovery。

不能推出 “settlement-attention bias”：无 task 内 repeats/randomization；两个 invalid 来自
observer/terminalization；base/full manifest 都是 `programbench.dirty:true`，同 Git SHA 不证明
uncommitted bytes 相同；minimal/recovery 使用后续 clean runner；system copy 同时改变 authority、
prefix ordering、size/cache layout，且没有 length-matched control。

**[假设]** authoritative duplication 可能让 agent 更偏向可 replay 交付、减少 unknown-behavior
探索。可从轨迹生成 process metrics，但当前不能写成结果。

## 4. 主设计：`institution × policy`

| Cell   | Institution        | Policy                |
| ------ | ------------------ | --------------------- |
| `I0P0` | 强 CI control      | 无                    |
| `I0P1` | 强 CI control      | 完全相同 policy bytes |
| `I1P0` | native ProContract | 无                    |
| `I1P1` | native ProContract | 有                    |

`P` 的 estimand 有意包含文本、搜索和停止变化；token decomposition 留给 placement study。

### 强 `I=0` control

**[未实现]** 必须与 `I=1` 共享：同 binary/model/image/task；`SessionV2` durable admission、
`queue` 和 recovery；同 tools/descriptions/permissions；同 provider/action/deadline ceilings；共同
`candidate_report_ready` model surface；ready 后停止 writer、捕获 immutable subject、执行相同
hermetic replay/package/preflight/external evaluation；保存 job ledger、hash、usage 和 lineage。

model ready 不能直接成为 official success。CI 可以没有 Contract revision/dependency/challenge/
issuer/quiet semantics。它已经实现一次性 search/verification separation；若与 ProContract 等价或
更好，必须承认“强 CI 足够”。

现有 `campaign_vanilla.py` 可复用 durable Session/resume/freeze，但不能原样用：它固定 `steer`、
只给 `ORIGINAL_TASK`、allow-all、按 idle freeze，且无 native action reservation。ProContract 还独有
validate/institutional brief、control tools 和 settlement-window reminder。

全 cells 冻结：binary/toolchain/clean runner tree hash；dataset/task/reference/evaluator digests；真实
model route/settings；task/policy/tool/permission/delivery/compaction bytes；cache-key rule、run ID、wave/
slot/order；resource ceilings、selection/replay/preflight/invalid rules；每个 request 的 ordered
role/content hashes。产品 vanilla (`origin/dev`) 只能作 secondary ecological baseline。

## 5. Estimands、outcomes 与 equal budget

task `t` 是总体推断单位；replicate wave `r` 是新 stochastic trajectory；`Y_tr(i,p;B)` 是共同
上限 `B` 下按冻结 selection rule 得到的 official quality。单个 evaluator test 不是独立样本。

```text
tau_I  = E[(Y(1,0)+Y(1,1)-Y(0,0)-Y(0,1))/2]
tau_P  = E[(Y(0,1)+Y(1,1)-Y(0,0)-Y(1,0))/2]
tau_IP = E[(Y(1,1)-Y(1,0))-(Y(0,1)-Y(0,0))]
```

Primary availability-sensitive utility：valid frozen evaluation 用 official score；否则 `Y*=0`。
这不表示 evaluator-invalid 的行为质量真为零。另报 `A`（valid evaluation 概率）、valid-only quality
（仅描述）、accepted 后低于质量 floor 的比例、false/stale/unauthorized settlement、recovery/
quiet、所有 provider calls（含 compaction）、ordinary/control actions、tokens、cost/wall 与 bad tail。

`B` 首选相同可用 turn/action ceilings，不强迫花完；少用预算是 outcome。美元 usage 事后才知道，
只能 turn-boundary stop 并可能 overshoot，不能称 exact equal-dollar。主比较是 `Y*(B)`，另画
quality–compute frontier。

待冻结的 selection proposal：第一次通过共同 replay 的 ready snapshot 为 final；若到 `B` 仍未
ready，可停止 writer 并统一冻结 latest workspace 作诊断性评估，但必须先明确共同 preflight/replay
是否是该诊断分数的前提。不得事后挑最高分 snapshot，也不能把 budget-end 强制捕获当成 authorized
delivery。分别定义 artifact-quality outcome 与 authorized-delivery-quality outcome；后者仅对冻结
协议下真正交付的产物计质量，其余为零。二者谁是主指标必须在 pilot 前选定，不能见分数后切换。

## 6. Randomization、repeats 与 invalids

1. 从未参与开发的 pool 冻结 confirmation tasks；按 difficulty/language/evaluator runtime 分层。
2. 每个 task×wave 跑完整四 cells，wave 内随机 order/slot并固定并发。`seed:42` 不是 model seed。
3. 在 development tasks 做 treatment-blind pooled-variance internal pilot；以预声明 meaningful effect、
   power、task ICC、within-task variance 决定 confirmation task/repeat 数。当前不可硬编码样本量；
   总体泛化优先 tasks，repeats 用于 stochastic variance。
4. 用 task-blocked factorial contrasts、task-cluster bootstrap/randomization intervals；hierarchical
   model 分解 task/replicate/interaction。non-inferiority claim 必须预注册 margin。

| 事件                                       | Primary 处理                                     |
| ------------------------------------------ | ------------------------------------------------ |
| Randomization 前 hash/config/image 不一致  | 不 admission；修复整个 block，不算 outcome       |
| Admission 后 model/provider/runner failure | 保留 assignment，`A=0,Y*=0`，不替换 trajectory   |
| 同一 durable trajectory transport resume   | 允许；ID/budget/usage/lineage 连续               |
| Frozen artifact evaluator transient        | 同一 bytes 统一 bounded retry；保留 raw attempts |
| retry 后仍 invalid/hang                    | `A=0,Y*=0`，单列；valid-only 仅敏感性            |
| package/preflight/replay fail              | 系统 outcome，`Y*=0`，不称 evaluator invalid     |
| official tests 低分/零分                   | behavioral outcome，保留真实 score               |
| block-wide outage                          | 原数据保留；可追加完整新 block，但不替代         |

旧 recovery 只能作 liveness evidence。任何 exclusion 需 treatment-blind adjudication，并同时报 ITT。

## 7. Constraint placement：分阶段识别

固定 institution/enforcement 与 policy，先比较：

1. `history-carried`：当前 admit-once；compaction 前随 history 出现。
2. `recurring-system-duplicate`：history 一份 + top-level system 一份。
3. `first-request-only`：task 永久保留，institution/policy block 仅首轮可见。
4. `recurring-ephemeral`：每轮可见但不写 durable history。

`tau_duplicate=2−1` 识别额外 system duplication，不是 repeated visibility；`tau_exposure=4−3`
识别每轮 exposure；`tau_persistence=1−3` 识别 durable-history/compaction channel。

随后研究 `minimal duty/full dossier/policy-only/behavioral checklist` content、预注册 matched text、
以及相同 bytes 的 top-level system 与 ephemeral system/user。不存在可证明语义惰性的 filler；role
同时改变 position/serialization，故只能称 matched-control effect 与 role/position bundle。

Cache 另做 `stable-session-key` 对 `rotated-per-turn-key`。它影响整个 request，可能改变 provider
routing，只能称 cache-regime effect。没有 rendered hash、segment boundaries、telemetry validation 前，
不研究 `projection×cache`。Session rotation、compaction 和 telemetry gap 单列；同时报告 equal-turn
与 quality–token 结果。

## 8. 小而决定性的 falsification pilot

### Phase 0：零 provider manipulation audit

用 recording/fake provider 走 factorial/placement：保存每个 request 的 ordered
`{role,contentHash,bytes,estimatedTokens}`；验证 cells 共享 binary/task/tools/permissions/delivery/budget/
compaction/replay；在 admission、mid-tool、ready、freeze、replay、attestation 注入 crash；验证 CI 也能
immutable freeze/replay 且 ready 不自认证；验证 compaction/control calls 的统一预算。任一失败就停止
付费实验——它直接 falsify “只操纵预定因素”。

### Phase 1：最小 provider sentinel

用已开发暴露的 HTMLq 与 Entr，因为它们覆盖旧 pilot 的 policy-cost 膨胀与 Pareto 改善两个相反
模式，而非代表总体。每 task 完成一个随机 2×2 wave，这是实例化所有 cells 的最小 protocol check，
不提供 efficacy power，也不进入 confirmation p-value。

停止条件：出现未预期 prompt/tool/budget/hash 差异；CI 无法匹配 freeze/replay/availability；policy
还进入 brief/tool/reminder；institution identity 泄漏到共同 model surface；或无法区分 admission 与
request exposure。通过后才用 blinded variance 规划 untouched confirmation。复验 Entr +26.62pp
需另预注册 within-task replication，不能用 sentinel 单次方向。

## 9. 后续实现 integration points

### OpenCode（均未实现）

- `packages/core/src/pro-contract/open-code.ts`：在 `Spec` 外保存 execution profile
  (`institutionBackend/projectionMode/projectionRole/cacheMode/templateHashes`)；不改变 `specHash`。
- `packages/core/src/pro-contract/scheduler.ts`：拆分 task/policy/institution blocks，支持 true ephemeral/
  first-request-only。
- `packages/core/src/session/runner/llm.ts`：按 profile 构造 recurring augmentation；统一 settlement
  reminder；记录 request segments/cache-key hash。
- `packages/core/src/session/compaction.ts`：统一计数 compaction call，记录 policy 是否被 summary 保留。
- `packages/core/src/tool/registry.ts`、`packages/core/src/session/execution/local.ts`：抽出 institution-neutral
  budget binding，区分 main/compaction/ordinary/control counts。
- `packages/core/src/tool/contract-control.ts`：共同 `candidate_report_ready` facade；Contract backend 走
  report-ready/replay，CI backend 走 durable freeze/replay；model surface 相同。
- 若 profile 经 API：改 `packages/protocol/src/groups/pro-contract.ts`、
  `packages/server/src/handlers/pro-contract.ts`，并在 `packages/client` 运行 `bun run generate`。
  建议不改 `packages/schema/src/pro-contract.ts`。

扩展 `packages/core/test/session-runner.test.ts`、`pro-contract.test.ts`、
`pro-contract-replay.test.ts`、`packages/opencode/test/server/httpapi-pro-contract.test.ts`；现有覆盖
prompt、policy admission、budget、lease/challenge rotation、replay/tamper 与 API auth。

### ProgramBench runner（外部 repo，只读审计）

- `scripts/run_opencode.py`：把 `execution_policy` 扩成 factorial profile，全部写 canonical manifest。
- `scripts/campaign_runner.py`：冻结 task×replicate×cell、random order/wave/slot 和 clean tree hash。
- `scripts/campaign_procontract.py`：解除 hard-coded prompt/budget coupling，使用共同 blocks/ready facade。
- `scripts/campaign_vanilla.py`/`campaign_vanilla_http.py`：形成 `queue`、matched prompt/tools/permissions、
  exact budget、ready-triggered freeze 的 CI control；保留 durable recovery/freeze。
- `scripts/campaign_usage.py`：增加 request audit、compaction/control 分类、blinded aggregate export。
- `scripts/campaign_evaluate.py`：统一 evaluator retry、invalid taxonomy、`Y*`/`A`，保留 raw attempts。

可复用 `test_campaign_procontract.py`、`test_campaign_vanilla.py`、`test_campaign_runner.py`、
`test_campaign_usage.py`、`test_campaign_paired_integration.py`；已有 durable admission/resume、freeze
atomicity、cache accounting、paired expansion 和 native lifecycle 覆盖。

## 10. 会 refute 主故事的发现

1. 强 CI 在正常/扰动下匹配 settlement precision、availability、quality，而 ProContract 只增 overhead：
   结论应是“强 CI 足够”，ProContract 只是组织形式。
2. `tau_I` equal-budget quality 稳定为负，且无 reliability/bad-tail 收益：不能声称 institution
   preserves performance。
3. `tau_IP≈0` 且 policy 异质性在两个 backends 相同：高分属于 policy/search，不属于组合。
4. matched content/role/cache 后，旧 projection regression 全由 tokens/cache 解释：删除
   “settlement-attention bias”，改写为普通 context/cost 结果。
5. true first-request-only 显著降低 quality/availability，只反驳“移除后续 history exposure”的子假设，
   不反驳当前 admit-once/history-carried 方案。只有相对 history-carried 的匹配对照证明额外 recurring
   dossier 稳定改善质量或可靠性，才能反驳“额外制度副本不必要”的相应主张。
6. Contract discharge 与 official quality/floor 的对应不优于 CI acceptance：只能保留可审计性主张。
7. 效果只在开发 tasks，untouched tasks/另一 difficulty、language、model 上消失或反转：降为 case study。
8. request audit 无法证明 arms 只差 treatment，或 cache/compaction/budget 口径无法统一：causal claim
   不成立，而不是“结果不显著”。

最强可发表结果可能是：institution 在强 CI 上改善 lifecycle reliability 且 quality non-inferior；
或 policy 收益高度 task-dependent 而 institution 不妨碍替换；或 recurring authoritative duplication
无可靠性收益并经可识别通道降低 performance。数据支持哪一个，论文才写哪一个。
