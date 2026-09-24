# 修复生命周期评测接线：独立设计审查记录

以下保留独立 agent 的原始意见与最终关闭意见，确切版本身份见各报告。

# 第五轮评测接线独立设计审查

审查者：独立 agent `/root/v5_design_review`。日期：2026-09-21。

审查对象：`specs/pro-contract-researcher-runner-lifecycle.md`，SHA-256 `8fdcec03bc6ba79eea07936be1d61de17cca86f4b554b9f109ae71c8f77a32e8`。

本次只读审查设计及现有实现，未修改源码、未执行测试、未重新审计上一轮全部宿主实现，也未接触第五轮真实运行结果。

## 结论

没有阻断实施的设计问题。可以按本设计实施限定的评测接线；真实运行仍应等待确定性完整流程、独立代码审查和冻结核验通过。无需增加宿主或 Core 研究决策语义。

设计正确区分了原回应意图、后续实际行为、完成声明、当前候选质量和外部认可。新 evaluation、scenario、measurement 与显式 `repair-lifecycle:1` 协议可以避免用第四轮入口误测新协议。将完整实现修复与实际代码修复分开报告，保留删除、退让、反驳和未完成意图，符合用户给出的边界。未发生的反馈机会不能补跑制造，补记用量也不能改变被中断操作的状态或宣称已完整计量。

## 对现有代码的事实核对

- `driver.ts` 当前 `feedback-v2` 明确发行 `response:1`；省略 evaluation 发行 version 1 review policy。因此增加显式新分支有实际必要，不能替换旧分支默认值。
- `scenarios.ts` 的 `feedback-development:1` 使用独立派生身份、可选诊断真实执行及隔离干预检查。新协议任务说明将改变模型看到的任务材料，必须记录为场景变化，不能据跨轮结果直接归因于模型能力提升。
- `feedback-evaluate.ts` 当前有原 finding、response 和原 review 的判断，但没有单独完成声明评分；其旧 `implemented_repair` 派生不能直接充当新生命周期的完整成功判据。
- `archive.ts` 保留全部 durable run、operation、job、session、候选快照及 completion 根，再递归归档内容引用。现有归档基础能支持只读材料构建，不需要扩展研究宿主状态机。
- `feedback-evidence.ts` 的 host completion 校验包括 basis、下一 append 事件、原回应、前驱、当前正式验证与证据 allowlist。`feedback-lifecycle.ts` 的 `current()` 仅判断当前候选等身份适用性；它不证明语义修复成立，也不单独表示该记录未被后续声明取代。
- `evaluate.ts` 当前 `sealCandidate()` 在逐例封存后立即创建反馈轨迹材料。第五轮要求全三例候选判断先封存，因此需要明确增量接线，不能把现有逐例顺序直接当作全队列盲评保证。

## 实施与代码复核的验收要点

下列事项是设计所述保证的具体核验条件，不是新增准入策略或要求再次征求用户许可。

1. **全队列封存后再展示轨迹。** 新入口应使用 seal-only 与 reveal 两个步骤，或具有等效可验证的全队列封存检查。两名评分者对三例的判断及必要裁决完成后才生成可交给评分者的阶段二材料。确定性测试应证明缺失任一例的封存时不能提前 reveal。保持第四轮已有 API 的历史语义。合作式文件访问隔离仍需在运行记录中如实披露。

2. **材料可以引用归档，但必须可直接核对。** 不要求把所有二进制快照和日志嵌入单个 JSON；要求阶段二给出确定性的材料清单，将每个原 review subject、计划版本、实验、验证、completion basis/append/前驱和所引 blob 映射到 hash 与明确的归档相对路径。构建材料时校验内容身份。评分者需要能读取当时的源码／计划和对应正式输出，不能只有最终源码、散列串或宿主成功状态。缺失或损坏核心材料应明确使依赖它的评分不可完成，不能自动转成通过或语义失败。

3. **机械历史有效、当前适用、被后续更正分别表示。** 验证所有历史声明的原始来源，包括 basisVersion 对应的真实历史状态、紧邻 append 事件和前驱链。后续更正不得删除早期不实声明，且旧的 `current:true` 记录如果已被新声明取代，不应独立充当最新处理结论。增加删除历史声明、串用另一 run／response／候选、跳过前驱、伪造 basis 和只保留过期完成的反例。

4. **新测量重新派生处理结论。** 可以复用旧材料构建和 reviewer 判断函数，但新增测量应显式纳入意图、计划同步、实际行为、后续正式验证、完成声明及当前适用性。实际代码修复不因完整链失败而丢失；完整实现修复不能仅由旧的 `implemented && revalidated` 或一个 `fixed` 标签得到。删除应单列并核对计划／报告／证据一致性；反驳不应被迫产生虚构修复声明。无声明、历史声明已过期、不实声明及评分证据不足要有可区分结果。

5. **评价可观察证据，不推断心理状态。** “意图如实”应落实为是否准确描述拟采取动作、当时是否已经做完、后续是否与记录一致；不能把尚未完成本身判断为撒谎。R3 原本已满足要求而声称新增修复，必须由原材料与后续材料的独立比较评分，不能依赖案例名称硬编码答案。

6. **完整流程证明测量真的收到新证据。** 至少有一个实际宿主局部流程经过意图、新版计划、实现、正式实验、证据读取、完成声明、提交和两阶段评分，并断言新增材料 hash、rubric 项和输出维度。另覆盖未完成意图仍可披露提交、不实完成不因 ready 而成功、当前／历史区别、删除、有据反驳和 unavailable。测试中脚本扮演行为仅证明接线，不能进入真实模型能力结论。

7. **旧路径与来源版本不可串用。** 新分支应覆盖 freeze、launch、直接 instance、scoring、report 和离线计量补记入口，核对 evaluation、scenario、protocol、measurement 的组合。旧 `feedback-v2` 材料与评分不应因新 wrapper 改变含义；旧冻结目录与评分文件不应被重写。补记的原账本、独立来源、未知项仍各自保留。

## 阻断与关闭条件

设计阻断：无。

实施后如未满足以上保证，尤其全队列封存门、可解析的历史材料、或新完成声明未实际进入评分，应在独立代码审查中作为阻断真实启动的问题报告，并以针对性测试关闭。此次批准设计进入实施不等于批准未经核验的运行器或证明模型反馈处理可靠。

## 审查材料身份

| 文件                                                          | SHA-256                                                            |
| ------------------------------------------------------------- | ------------------------------------------------------------------ |
| `packages/opencode/script/research-eval/driver.ts`            | `0daf7e96e55ce42b33805e927c98dca67456807d9b968aaaa4adc6aea5ee7437` |
| `packages/opencode/script/research-eval/scenarios.ts`         | `318344786fcbd6f2de9b3bbefe07bf324c586fb45bb463148b7e110d53bf9637` |
| `packages/opencode/script/research-eval/evaluate.ts`          | `9f6e2e57a63ed0de52b5f63b8ab3dd052e9fdab2c3e867d37ba63f26a9d3713c` |
| `packages/opencode/script/research-eval/feedback-evaluate.ts` | `1ce1819da80868d85d03f25bb564bba173be35c6455928c7db2f2068d8d7855c` |
| `packages/opencode/script/research-eval/archive.ts`           | `67b917b1afa377c05e38c4eedf3500fb04018c367d178304bf858f022f6a1de9` |
| `packages/opencode/script/research-eval/blind.ts`             | `923f28b14a113b4edf37907ec2a59077531f981d4936d8f24b2b29f3b17c1b63` |
| `packages/sdk-next/src/research/feedback-evidence.ts`         | `9f84ba961e828c8e4a6e6135f1bbaed18bd1a1937538b4515326944b7e488943` |
| `packages/sdk-next/src/research/feedback-lifecycle.ts`        | `2dddd2da3a854626edaae8e2239d8e540e2e8d338c952f9f9e098f4d25797b8f` |

# 第五轮设计补充复核

审查者：独立 agent `/root/v5_design_review`。日期：2026-09-21。

最终复核的 `specs/pro-contract-researcher-runner-lifecycle.md` SHA-256：`2a33b34c046a934c4890a34a68a44fc9654f247fad17be02378670c9c14641ec`。

已复核两项补充：

- 阶段二明确提供原 subject／plan、实验／验证、basis／append／前驱的内容 hash 和归档相对路径，构建时校验实际字节。允许受检索引读取候选 tar，能够支持历史与当前材料的独立比较，不要求全部内嵌。
- 新协议候选封存与轨迹展示分离；model reveal 必须核验固定三例分母的全部阶段一封存，local fixture 的单例放行不能用于 model；旧 API 保持原语义。

补充足以明确这两个实现边界。结合 `design-review-1.md` 的只读源码核对，结论为：**可以实施，设计阻断为零，没有待补充设计事项。** 原报告其余要点作为实施测试和后续独立代码复核的验收依据，不需要在设计阶段扩大宿主审计或再次请求用户确认。

本结论不代替完成后的确定性验证、独立代码审查和真实启动前的冻结核验；本次未执行测试。
