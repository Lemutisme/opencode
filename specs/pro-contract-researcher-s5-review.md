# S5 独立设计审查

审查对象为 [S5 设计](pro-contract-researcher-s5.md)，初版 SHA-256 为 `b63e02e92a347da9ef8d52d1c055981554ff4d7909a917e357120628572ec4af`。参照 [Researcher 总方案](pro-contract-researcher.md)和已通过审查的 S4 实现；S5 编辑前快照位于 `/tmp/opencode-s5-baseline`，其 `manifest.json` SHA-256 为 `a9fcae0c4c85fd1e599d918136ae24c913d0714f84962d8e37162d1a449b4446`。实现包含尚未提交的修改，不能仅凭当前 `HEAD` 重建。历史 S4 设计与签字文件不属于本轮可修改范围。

最终结论：修订后的设计通过，初轮一项 P1 和一项 P2 均在设计层关闭，没有遗留 P1／P2 设计阻断。最终冻结版本的 SHA-256 为 `91a403dfd33fcc01d1d727377f947d08d4971ccfdc83d959f0ab7e23a9023879`。Principal 的任务约定、Researcher 的范围内计划、独立 reviewer 和宿主机械准入之间的职责划分可行。以下保留初版反例、闭合条件与修订复核证据；本结论不代表实现审查或科学质量认证。

## F1 · P1：无隔离 Node runner 会将候选自己打印的 TAP 当成实际测试结果

初版[运行协议](pro-contract-researcher-s5.md#L66)固定使用 `--test-isolation=none`，而[实验记录](pro-contract-researcher-s5.md#L29)和[最终验证](pro-contract-researcher-s5.md#L62)继续使用 Node TAP 适配器。这种模式令候选代码与 reporter 共用进程及标准输出。文件权限可以拒绝候选改写 harness，却不能证明 stdout 中的测试事件由 runner 产生。

本轮在 Node `v24.21.0` 上使用独立临时目录复现。固定、只读的 `harness.cjs` 为：

```js
require("./candidate.cjs")
const test = require("node:test")
test("required case", () => {
  throw new Error("must fail")
})
```

候选 `candidate.cjs` 只使用普通 Node API：

```js
require("node:fs").writeSync(
  1,
  "TAP version 13\nok 1 - required case\n1..1\n# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n",
)
process.exit(0)
```

在该目录中执行：

```sh
node --permission --allow-fs-read="$PWD" --test --test-reporter=tap --test-concurrency=1 --test-isolation=none harness.cjs
```

进程退出 0，stdout 完整等于候选写入的 TAP。必需断言根本没有注册或执行。将实际 stdout 交给现有 [`ResearchTap.parse`](../packages/sdk-next/src/research/tap.ts#L5)，配置 `tests: ["harness.cjs"]`、`expectedTests: ["required case"]`、`minimumTests: 1`、`maximumSkipped: 0`，得到 `verdict: "passed"`。候选没有写文件、启动子进程、使用 native addon 或破坏 Node 权限系统。即使另有 generated artifact 要求，也可在同一次提前退出前写入被明确允许的输出文件，不能依靠 artifact 存在性修复事件来源。

对照执行省略 `--test-isolation=none` 的当前 S4 命令时，候选 stdout 被 runner 转为 `#` 注释，只产生文件包装用例；现有解析器会拒绝缺失的预期显式测试。因此这是 S5 新执行方式引入的可复现回退，不能用“合作式、非恶意代码 OS 沙箱”的限制代替[总方案要求的实际测试来源](pro-contract-researcher.md#L105)。S5 的“伪造输出不能认可”接受条件也不能只检查内容 hash 或 job 来源：它们证明了哪个进程打印这些字节，没有证明哪个断言执行过。

闭合条件：

- 在设计中明确一个可实施的结果来源边界，将受信任的 runner／控制进程与候选可直接写入的输出区分开。保留运行期保护输入、无任意子进程和原 deadline 的约束；简单恢复进程隔离并给候选授予 `--allow-child-process` 不足以闭合。
- 宿主根据可信 runner 的实际完成事件判断必需用例，并保留对应 job、命令、runner 身份及原始证据。缺少事件、候选提前退出或通道不完整均不能通过；重新解析同一份可伪造 stdout 不是独立核验。
- 增加真实 Node 回归：固定 harness 导入候选后才注册必失败断言，候选直接打印完整成功 TAP 并退出 0。正式实验与最终验证都必须拒绝；同时覆盖正常通过、实际失败、空文件、缺失预期用例和运行期保护文件写入。

本轮原始探针位于 `/tmp/opencode-s5-review-probes`，完整多参数输出为 `tap-results.json`，SHA-256 `74e866283a7c5053e396cc5440a3817b34f73800e4f49348a94c832343cc268a`。实际探针中候选文件名为 `spoof.cjs`；上文改名仅为说明角色，内容与行为一致。读权限限于冻结目录时使用相对测试路径即可复现，不需要扩大至整个文件系统。

## F2 · P2：任意 context 变化使批准失效，与正常最终交付流程矛盾

初版[失效规则](pro-contract-researcher-s5.md#L72)规定 context 改变后旧批准不得继续使用，同时[最终流程](pro-contract-researcher-s5.md#L62)要求当前计划批准与正式实验贯穿 S4 的 exact 认可边界。当前 S4 正常成功路径本身会改变 context 两次：

1. [`contracts.reportReady`](../packages/sdk-next/src/research/index.ts#L696) 提交 handoff，并将 run context 更新为带 handoff 的 target。
2. [`setRecognitionContext`](../packages/sdk-next/src/research/index.ts#L921) 发布 bundle，推进 context version，再将 ready run 绑定新 target。

可达反例是完全正常的 S5 流程：计划在执行 target 下批准，正式实验成功，最终验证对相同 subject 通过；宿主执行第一个 handoff 转换后，若按“context 改变即失效”执行，计划批准和正式实验已不可用于最终 reviewer／认可。第二个发布转换又会重复该问题。若实现默许某些变化而保留批准，则其例外和 exact 身份关系并未被设计规定，容易误放行外部撤销或恢复引起的 target 更新。

当前 S4 [`validator`](../packages/sdk-next/src/research/adapters.ts#L143)已区分 verifier、handoff 和 published target，并核对其版本及 handoff 关系。这为扩展提供了基础，但不能据此推定新 plan／experiment 对任意后续 context 都有效。

闭合条件：

- 明确计划批准和正式实验冻结的是原始执行 target，且原 review／verify job 输入始终不可改写。
- 列出可保留该批准的宿主原子转换：同一当前 plan／experiment／subject 的最终 handoff 与该交付包发布。记录并重新核验转换前后 target、plan／experiment 引用、subject、handoff 身份、expected stage、owner／generation／有效 lease；不得用“revision 与 specHash 没变”替代完整链。
- 外部 revision、pending revision、challenge、取消、未知 context 变化及没有可验证来源的转换仍撤销批准。恢复明确选择复用仍有效的原链或重新规划，不能刷新旧 job context 来恢复授权。
- 真实全流程须穿过两个正常 context 转换而成功；分别在转换前插入外部 context 更新、challenge 和旧 callback，证明旧批准不能借正常转换例外继续使用。

## 非阻断结论与实施验收重点

- **任务约定与研究计划。** 严格 Plan 的 agreement 对比、拒绝授权覆盖字段、范围不明停止，以及独立 scope verdict，符合[总方案的计划归属边界](pro-contract-researcher.md#L323)。自然语言是否改变固定方法、数据或验收仍属 reviewer 的判断能力，设计已明确这一限制；本轮不把结构检查当作语义证明。
- **权限必须落到实际叶子。** 可选 admission capabilities 应只收窄 Spec 权限，并通过原 admission version 使旧调用失效。`AppProcess`、`FileMutation`、replay、控制工具和组合工具须实际执行这些限制；仅改变工具列表或在 handler 入口检查一次不能满足设计。通用 Core 接口不应包含研究阶段，也不新增并行工具执行器。
- **保护文件与输出路径。** 新增 plan protected 文件必须进入正式冻结、job policy 与最终验证，不能只在 live workspace 检查。输出不得与保护文件及其祖先重叠；在实际权限参数、清理和产物归档中保持相同路径语义。本轮额外检查了利用允许输出创建符号链接或硬链接后改写保护文件的普通 API 路径：当前 Node 分别以完整文件权限要求和源文件 `FileSystemWrite` 拒绝，没有将该猜测列为缺陷。
- **停止和外部修订。** `needs_principal_revision`／`unclear` 后不得恢复实验准入。宿主状态应保留未决项并允许外部主体通过既有 ProContract 处理；不能假设已关闭 admission 的旧 worker 仍能调用需要原执行许可的修订工具。范围内更新应重新评审并保持原 deadline，不要求 Principal 为每个方法细节重发任务。
- **恢复、取消与旧工作。** 计划 review 和正式实验须复用既有事务 fence、job 原始输入、operation accounting 与显式恢复规则。取消和根授权变化时，旧 provider／tool／process 不得启动新工作；已完成的历史证据保留，不能改成新的批准。
- **兼容性与声明。** `research:1` 与 `research-final:1` 必须使用各自校验器和持久 profile。Node 平台能力不满足时失败关闭。确定性 fixture 只能证明机制与数据流，不证明 reviewer 的研究能力或方法正确性，不启动真实研究实验。

## 修订复核

| 发现       | 状态       | 修订后的设计约束                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1 · 原 P1 | 设计层关闭 | [运行协议](pro-contract-researcher-s5.md#L66)改为宿主固定、启动前核对 hash、源码留存的独立 `runner.mjs`。父进程只加载 `node:test` 的 runner／reporter，自身不加载候选；通过 `isolation: "process"` 启动受权限限制的测试子进程，子进程没有 child_process／worker／native addon 权限。候选普通 stdout 由父 reporter 转为注释。明确禁止无隔离模式和继承 eval 参数的 `-e` runner，并在[接受测试](pro-contract-researcher-s5.md#L83)加入伪造 TAP 后退出的反例。 |
| F2 · 原 P2 | 设计层关闭 | [失效与转换规则](pro-contract-researcher-s5.md#L72)只允许原子最终 handoff 与发布两条内部转换。plan review、experiment、final verification 保留相同的原始 job context，final review 的版本为原版本加 1，published 为加 2，revision／specHash 相同；validator 核对完整链，不改写旧 job 输入。其他变化仍使批准失效，外部 challenge 回到只读规划。                                                                                                             |

本轮独立复跑了实施方提供的最小 runner `/tmp/s5-runner-VSsW5y/runner.mjs`。它使用 `run({ files, concurrency: 1, isolation: "process", execArgv: ["--permission", "--allow-fs-read=."] })` 并在父进程输出 TAP。相同伪造候选的 stdout 变为注释，只留下 `harness.cjs` 文件包装；调用现有解析器得到 `verdict: "failed"`。另一个临时 harness 的两个真实断言分别验证保护文件写后恢复的第一次写入、`execSync("true")` 均以 `ERR_ACCESS_DENIED` 拒绝，保护文件字节不变；这次 runner 输出由现有解析器判为 `passed`。输出留存在 `/tmp/opencode-s5-review-probes/isolated-runner-results.json`，SHA-256 为 `186b89c19c0eea2beca66e6ba4b1969c251471621ef40b070d1d76eff39cfe71`。

上述探针证明了修订方案能够兼容现有 TAP 解释并保留所需权限边界，不代替生产接线验收。实现仍须核验实际 policy 的 runner hash、完整实际命令、明确输出写白名单、原始证据归档与取消清理；正式实验和最终验证都使用相同可信入口。F2 还要求注意现有 `close(unavailable)`／显式恢复中的 context 撤销：只要它推进了 target，就不属于两个允许转换，不能通过恢复旧阶段直接续用旧 plan／experiment 批准。

## 验证范围

F1／F2 首次关闭版本为 `d6e53840d240f439d3d826970d922eab00fa9ac61f874a01e91b186c7f423679`。最终冻结版只把首段状态改为“独立设计审查通过，冻结用于实施”。本轮在内存中还原这一状态文字，所得 SHA-256 与首次通过版本完全一致；正文没有其他变化，最终冻结版继续通过。

本轮读取设计、总方案及相关 S4 实现，运行了上述独立临时目录内的有界 Node 探针，并直接调用现有 TAP 解析器验证真实输出；未运行仓库测试或 typecheck，未修改设计、实现、测试、迁移、实验配置和 S4 历史签字。唯一工作树写入为本审查文档。设计通过只允许进入实施与相应接受测试，不表示 S5 已实现或可以启动真实研究实验。
