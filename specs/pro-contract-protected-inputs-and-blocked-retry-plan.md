# ProContract 原生问题规划：受保护输入的恢复途径与 blocked 后的路由

日期：2026-10-02。状态：规划，未实施。本文承接[问题说明](pro-contract-protected-inputs-and-blocked-retry-problem.md)，遵守 [Constitution](pro-contract-constitution.md)，供 Claude 与 Codex 审查。

修订记录：

- 同日按用户意见改为最小改动方案。理由是 ProContract 现有流程运行良好，问题 A 极少遇到。用户同意本文对 A、B 的推荐。
- 同日用户以 Principal 身份确认了 §8 的全部事项，目前没有待决项。

基线是 `native-advisory` 分支 `efa12bea6`。本文的源码结论都在该提交上重新核对过，问题说明中的结论和候选方案只当作线索。本次没有修改源码、没有提交、没有运行真实模型。为记录现有行为，在 `packages/core` 下用独立的 `OPENCODE_DB` 运行了 11 个既有测试文件，192 项全部通过（§7.6）。

证据根目录记为 `E = /workspace/sbno-native-advisory-preparation-20260924T054618Z/nodes-preparation-20261001T062410Z`。

## 0. 结论

| 问题 | 本轮方案 | 备选、否决或推迟 |
| --- | --- | --- |
| A：受保护输入被写坏 | **A0：准备阶段提交受保护输入**。工作区本来就是 git 仓库，只是从未提交。准备时把已核验的受保护输入提交一次，执行者误写后就能用 `git checkout` 逐字节恢复。ProContract 代码不改 | A1′（写入层拦截）作为备选，暂不实施，再次出现且 git 恢复无效时再启用；内置快照与恢复（A3）本轮不做；A2 在本部署实测不可行；A4 否决 |
| B：blocked 后空转 | **B(iii′)**：同一合同连续两个 attempt 都以被接受的 blocked 结束时，原生 driver 返回 `escalate`，交给 issuer。不比较原因文本。策略在签发时写入 binding：新签发的原生合同默认启用，已有 binding 保持现状 | B(i) 解决不了结构性障碍；B(ii) 作为 Principal 的备选，同一实现即可支持；按"原因相同"判断无法实施；新 driver identity 和新增 Spec 字段两种版本化方式都否决 |

改动范围：

- A 只改下一轮实验的准备脚本（仓库外），新增一次无模型预检，并在仓库内新增一个只含测试的用例。
- B 只改执行适配层的两个文件：`open-code.ts` 和 `driver.ts`。
- 两者都不改 kernel reducer、公开 Schema、Protocol 或 Server `HttpApi`，所以不需要 `bun run generate`。

## 1. 独立核实

### 1.1 与问题说明一致的事实

- 原生 driver 对 `blocked` 一律返回 `retry` / `new`（`packages/core/src/pro-contract/driver.ts:45-52`）。`settle` 把下次派发时间设为 `now + retryDelay`（`open-code.ts:327`）。
- 两份试运行合同都是 `resolution: { retryDelay: 1000 }`，没有 `maxAttempts`（`E/contracts/review-on.spec.template.json`）。受保护项共四个：`SBNO_formulas.tex`、`SBNO_formulas.pdf`、`TASK.md`、`acceptance.mjs`。
- replay 先检查 `protectedBefore`（`replay.ts:293-297`），不符时不运行任何检查（`replay.ts:321`）；检查之后再查一次（`replay.ts:403-410`）；最后合并判定（`replay.ts:426-435`）。
- 写 `TASK.md` 与写 README、FORMULAS、REPORT 来自同一条 assistant 消息 `msg_0f6460f4e001zmjW0gkOe2DYfL`，工具返回 "Wrote file successfully"。

### 1.2 需要更正或补充的事实

1. **序号**：问题说明的工具序号从 0 开始计。本文按 `E/groups/review-on/archive/tool-history.json` 从 1 开始计：写 `TASK.md` 是 #27，首次 `contract_check` 是 #28，首次交付是 #32，再次交付是 #57，blocked 报告是 #58、#73、#84、#113。
2. **工作区是 git 仓库，但从未提交**。准备脚本在核验四个输入后执行 `git init --quiet workspace`（`E/approved-execution-20261001T065720Z/trial.ts:40-41`）。原因是 ProContract 的 Snapshot 要求项目是 git 仓库（`packages/core/src/snapshot.ts:135`）。准备时只做了 init，没有提交：模型在 #69 看到 `your current branch 'master' does not have any commits yet`，#30 中所有文件都是 `??`。工作区里没有 `.gitattributes`，`.git/config` 没有设置 autocrlf 或 filter，也没有项目 ID 缓存文件 `.git/opencode`。准备时工作区只有这四个已核验的输入（`E/groups/review-on/input-hashes.json`），与合同的 `replay.protected` 完全一致。
3. **模型的第一反应就是用 git 恢复**。#28 检查失败后，#29 立刻执行 `git checkout -- TASK.md`，失败原因只有一个：`pathspec 'TASK.md' did not match any file(s) known to git`，即从未提交过。后续 attempt S3 的 #69、S4 的 #81 也都先运行了 `git status`。
4. **提交会改变项目 ID**。没有提交时项目 ID 是 `global`；有了提交后，在没有 remote 也没有缓存的情况下，项目 ID 取根提交哈希（`packages/core/src/project.ts:110-116`）。项目目录在两种情况下都是工作区根目录，replay 计算候选根所用的相对路径不变。核心测试中，replay 前都会执行 `git init` 加提交（例如 `test/pro-contract-control.test.ts:438-443`），说明有提交的工作区是测试过的配置。
5. **A2 在本部署不可行**，已核实：
   - 开启组宿主进程以 uid 0 运行，CapEff 为 `0xa80425fb`（Docker 默认能力集），包含 `CAP_DAC_OVERRIDE` 和 `CAP_FOWNER`（`E/groups/review-on/host-process-status.txt`）。chmod 只读对它无效，它还能把权限改回去。bash 的 `rm`、`mv`、`sed -i` 本来也只需要目录写权限。
   - Landlock 按目录层级授权，权限向下继承并取并集，无法把可写目录中的单个文件排除出去。
   - CapEff 不含 `CAP_LINUX_IMMUTABLE`，所以 `chattr +i` 理论上可行，但 `/workspace` 是 FUSE（MooseFS），`lsattr` 返回 "Operation not supported"。
6. **若改代码，`LocationMutation.resolve` 不是合适的拦截点**。除了 write（`write.ts:71`）、edit（`edit.ts:139`）、apply_patch（`apply-patch.ts:103`），read（`read.ts:62`）和 bash 的 workdir（`bash.ts:130`）也调用它，而且它看不到写入内容。只被三个写入工具使用、并且已经读取 `ExecutionContext` 的是 `FileMutation`（`file-mutation.ts:80-84`）。另外，`write.ts:89` 和 `apply-patch.ts:190` 会把错误吞成通用信息；`apply_patch` 按顺序写入（`apply-patch.ts:160-188`）。这几点只与备选方案 A1′ 有关（§2.3）。
7. **四次 blocked 的原因措辞各不相同**（#58、#73、#84、#113），实际原因相同。按原因文本相等判断"同一原因"，本事件中一次也不会触发。
8. **每个新 attempt 都带着上一次的原因启动**。线上请求中出现了四次不同的 `Previous attempt blocked:` 首条输入（`scheduler.ts:151`，`provider.jsonl`）。attempt 2-4 都是看过原因后的独立复核，结论相同。
9. **节奏以线上记录为准**。每次 blocked 之后 1.2-1.8 秒，新 attempt 就发出首个请求（07:05:19.555、07:05:37.747、07:05:56.959、07:07:00.540）。各 attempt 持续 17-62 秒。`attempts.json` 的 `startedAt` 是 advisory 宿主的观察时间，比实际开始晚 14-57 秒，不能当作 attempt 开始时间。
10. **空转成本**：attempt 2-4（S3、S4、S5）共发出 32 次上游请求，消耗 559,021 total tokens（按 `provider-results.json` 的 Session 汇总），约占开启组 worker 上游 tokens 的 36%。第 5 个 attempt 的首个请求在 07:07:00.540 被已关闭的网关拒绝。
11. **`retryDelay` 被所有 retry 决定共用**（`open-code.ts:327`）。`retryable-error`、`interrupted`、`dispatch-failed` 在同一 attempt 内的重试也要等它。把它调到几分钟，会同时拖慢传输故障的恢复。
12. **以前靠有限的 `maxAttempts` 兜底**。attempt 用尽时，`settle` 直接 escalate（`open-code.ts:313-319`）；既有测试 "consumes native blocked retry exactly once after recovery" 依赖 `maxAttempts: 1`。deadline-only 去掉了 blocked 循环唯一的终止条件，只剩 deadline。
13. **路由机制已经存在**。Driver 的 `Decision` 包含 `escalate`；`settle` 收到它时发出 institution 的 escalate 命令；kernel 的 `resume` 只允许 issuer 调用，把合同从 escalated 改回 dormant，并保留 `blocked`（`kernel.ts:419-436`）；HTTP 已有 `proContract.resume`（`packages/server/src/handlers/pro-contract.ts:172-175`）。
14. **replay 摘要措辞有误导**。`protectedBefore` 不符时检查并未运行，但摘要仍是 "Protected file changed after replay checks"（`replay.ts:83-85`）。本轮不改（§2.4）。
15. **此前也出现过**：第八轮 research P1 中，受保护的 `report.json` 被改写，交付因此无法完成（[第八轮诊断](pro-contract-researcher-v8-delivery-diagnosis.md)）。那次的保护项来自 research 宿主计划层的 `additionalProtected`，不在本轮范围（§9）。

## 2. 问题 A

### 2.1 本轮方案 A0：准备阶段提交受保护输入

**做法**：在下一轮实验的准备脚本中，紧接现有的 `git init`（对应本轮 `trial.ts:40-41` 的位置），在宿主启动之前执行：

```sh
git -C "$workspace" add -- SBNO_formulas.tex SBNO_formulas.pdf TASK.md acceptance.mjs
GIT_AUTHOR_DATE="$FIXED" GIT_COMMITTER_DATE="$FIXED" \
  git -C "$workspace" -c user.name=preparation -c user.email=preparation@invalid -c commit.gpgsign=false \
  commit --quiet -m "approved inputs"
```

- 提交的路径就是合同 `replay.protected` 中的全部路径，它们也恰好是准备时工作区的全部内容。如果以后的任务在工作区中有不受保护的初始文件，仍然只提交受保护的那些。
- 固定作者、提交者和时间，使同样的输入得到同样的根提交哈希，也就是可复现的项目 ID。提交哈希要写入准备记录。
- 不新增 `.gitignore`、`.gitattributes` 或其他文件，也不修改 git 配置。`.gitignore` 会影响 Snapshot 捕获的范围。
- 两组（开启组、关闭组）的准备步骤相同。
- 提交必须在宿主第一次启动前完成，否则宿主可能已经把项目 ID 缓存进 `.git/opencode`。
- 已冻结的准备脚本和归档保持原样，这一步写进下一轮新复制的脚本里。

**为什么有效**：本次误写之后，模型在 #29 就尝试了 `git checkout -- TASK.md`，只差一次提交（§1.2 第 3 条）。有了提交，这条命令会逐字节写回原文件，之后的 `contract_check` 和交付照常进行，问题 B 的空转也不会出现。这个恢复途径不限于哪种写入工具：无论是 write、edit、apply_patch 还是 bash 改坏的文件，以及 pdf 这样的二进制文件，都能恢复。

**为什么是最小改动**：

- ProContract 的代码、提示、工具列表和 replay 判定都不变。不碰受保护文件的运行，与现在完全一样。
- 执行者没有获得新的权限。这些字节在开始时本来就在工作区里，执行者本来就能读写它们。git 只是把签发时的版本留在执行者已有的手段之内。
- replay 仍然是唯一的判定依据，比较的是冻结哈希，而不是 git 中的内容。即使 git 历史被改动，也不会让损坏的输入通过验证。

**局限**（如实记录）：

- **不是保证**：它依赖执行者想到用 git。本次的样本只有一个（#29），而且 S3、S4 也都运行了 `git status`。
- **git 历史可能被污染**：执行者如果把损坏的文件提交了（例如 `git commit -a`），`git checkout -- <path>` 恢复出来的就是坏版本。这时只能从根提交恢复，或者交给 Principal。
- **项目 ID 会变**：从 `global` 变成根提交哈希。这是部署变量的变化，需要通过 §7.1 的预检确认没有影响。
- **字节可能被转换**：设置了 `core.autocrlf`、`.gitattributes` 或 filter 时，checkout 可能不逐字节一致。预检要确认这些设置都不存在。
- **适用范围有限**：只对按这份准备流程准备的部署有效；通过 HTTP 等其他途径签发的合同得不到这个恢复途径。
- **不是新增风险**：工作区本来就是 git 仓库，`git clean` 删除未跟踪 artifacts 的风险以前就存在。提交受保护输入后，`git checkout .` 只会还原这四个文件，不会碰 artifacts。

如果恢复没有发生，执行者会报告 blocked，B(iii′) 会在第二次 blocked 后把问题交给 Principal。Principal 可以在宿主侧恢复文件，例如从根提交或已归档的原批准副本，然后 resume（§3.3）。

### 2.2 写入工具与 bash 的现状（如实记录）

本轮不拦截任何写入。write、edit、apply_patch 和 bash 仍然可以修改、删除受保护文件，被拒绝的仍然是之后的 replay，行为与现在相同。区别只在于工作区中多了一份可供恢复的提交。问题说明 §6.3 要求"通过 write、edit、apply_patch 修改受保护路径被拒绝"，这一条只在以后启用 A1′ 时才适用（§7.5）。

### 2.3 备选方案 A1′（暂不实施）

**启用条件**：再次发生受保护输入被写坏，并且 git 恢复没有发生，或者因历史被污染而无效。届时按下述设计实施，测试见 §7.5 的备注。

- **规则**：在合同 root 执行中，写入目标属于当前已授权 revision 的 `spec.evidence.replay.protected` 时，只有写入后完整字节的 SHA-256 等于冻结哈希才执行；删除一律拒绝。这条规则就是把 replay 已有的判定提前到写入那一刻，写入逐字节相同的内容仍然被放行。
- **落点**：`ExecutionPermit.context` 为 root permit 在 `ExecutionContext` 中带上 `protectedInputs`，取自已授权的合同；`FileMutation` 的五个写入原语在目标锁内按最终字节检查。不放在 `LocationMutation.resolve`，原因见 §1.2 第 6 条。
- **路径同一性**：比较规范路径；目标与受保护文件都存在时，再比较 `(dev, ino)`，以覆盖符号链接、硬链接和大小写别名。
- **其他细节**：`apply_patch` 在第一次写入前整体预检，任一命中则整个补丁不执行。`write.ts` 和 `edit.ts` 要单独映射新增的 `FileMutation.ProtectedInputError`，把明确原因返回给模型，不暴露哈希。
- **局限**：挡不住 bash；它改动的是所有合同共用的写入路径。也正因为它是一次真实的行为变更，本轮不做。

### 2.4 其他否决或推迟

- **A2 部署层只读**：本部署不可行（§1.2 第 5 条）。即使在支持 inode 标志的部署中，它也只是 Core 无法验证的运维加固，还需要清理步骤，否则标志残留会导致归档和清理失败。
- **A3 和 ProContract 内置快照与恢复**：本轮不做，用户已同意。原因：
  - 现有 Snapshot 只在 `contract_check` 和交付时捕获，那时文件已经坏了；
  - 要在执行者写入之前捕获，就需要新的捕获时机；
  - 恢复需要一个入口，而无论是新工具、宿主的自动触发规则还是操作者命令，都比 A0 改动大。新工具还会改变所有运行的工具列表。

  A0 用工作区已有的 git 达到了同样的恢复效果。
- **A4 replay 时用原始版本覆盖**：否决。replay 证据描述的字节会与冻结的候选快照（`subjectHash`）不一致，它还会掩盖损坏，并改变同一 `policyHash` 下报告的含义。
- **A1b**（bash 结束后检测受保护文件并提示）**和 A1c**（更正 replay 摘要措辞，§1.2 第 14 条）：都是代码改动，按最小改动原则本轮不做，随 A1′ 一并再议。

## 3. 问题 B

### 3.1 根因

`native.outcome` 对 blocked 永远返回 `retry` / `new`。有 `maxAttempts` 时，attempt 用尽会 escalate；deadline-only 合同没有 `maxAttempts`，blocked 循环只能等到 deadline。执行者"无法继续"的声明从来没有交给 issuer。可是 Constitution 把"outstanding work cannot execute 时的 issuer 决定或 escalation 路由"列为不可约状态，kernel 也已有 escalate 和 resume。

采用 A0 之后，本事件大概率不会走到 blocked。但 B 针对的是所有结构性障碍，比如缺失依赖、被隔离的网络、无法完成的条款、无法恢复的输入。不做 B，deadline-only 合同遇到任何一种都会空转到 deadline。

传输层抖动不会产生 blocked。provider 5xx、超时、中断、派发失败分别产生 `retryable-error`、`interrupted`、`dispatch-failed`，都在同一 attempt 内重试。只有执行者显式调用 `contract_report_blocked` 才会进入本问题。下文的"暂时性障碍"指两种情况：执行者因会自行消失的条件报告 blocked，或者单个 Session 误判后报告 blocked。

### 3.2 候选对比

| 策略 | 暂时性障碍 | 结构性障碍（如本次的 TASK.md） | 无人值守的 6h 运行 | 代码 |
| --- | --- | --- | --- | --- |
| B(i)，`retryDelay` 1 s | 1.2-1.8 s 后开新 attempt。障碍持续多久，就连续开多少个 attempt，消失后自动继续 | 一直开新 attempt 直到 deadline。本次约 100 秒内开了 3 个，消耗 559k tokens，每个 attempt 还可能触发一次交付前审阅 | 持续消耗 | 无 |
| B(i)，`retryDelay` 设为数分钟 | 恢复变慢，而且所有传输重试也要等数分钟 | 仍然空转到 deadline，次数约为 6h 除以延迟 | 消耗减少，但不会停 | 只改合同参数 |
| B(ii)，首次 blocked 即 escalate | 立刻交给 Principal。无人值守时一直停着，直到 resume 或 deadline | 1 个 attempt 后停下并交给 Principal，损失最小 | 误判时代价大 | 小，与 B(iii′) 共用 |
| **B(iii′)，连续两次 blocked 后 escalate** | 再开 1 个新 Session。障碍在 retryDelay 加一次启动的时间内消失，就继续执行，无需 Principal；否则交给 Principal | 2 个 attempt 后交给 Principal。放到本次，会在 #73（07:05:36.5）之后停下，S4、S5 的 482,644 tokens 不会发生；S3 的 76,377 tokens 是这次自动复核的代价 | 折中 | 小 |
| B(iv)，按连续 blocked 指数退避 | 自动恢复，只是越来越慢 | 仍然空转到 deadline，次数更少；不会交给 issuer | 消耗减少，但不会停 | 需要新的节奏常数和退避封顶；Driver 的 `Decision` 没有延迟字段 |
| 原 B(iii)，"原因相同"才转交 | — | 本事件中四次原因措辞各不相同，永远不会触发 | — | 无法实施 |

### 3.3 推荐方案 B(iii′)：连续 blocked 交给 issuer

**规则**：对启用了该策略的原生 binding，如果一个 attempt 以被 kernel 接受的 report-blocked 结束，而紧邻的上一个 attempt 也以被接受的 report-blocked 结束，中间没有机构性转移，那么 native driver 返回 `escalate`，不再返回 `retry` / `new`。

- 不比较原因文本（§1.2 第 7 条）。
- 计数器 `blockedStreak` 是 binding 上的适配层状态，存在 JSON 列中，不需要迁移：
  - `reportBlocked` 被接受后加 1，并把计数后的 binding 交给 driver（`open-code.ts:807-830`）。driver 出错、没有产生决定时，不保存计数。
  - `settle`：决定为 escalate（包括 `maxAttempts` 耗尽）时清零；应用 blocked 产生的 `pendingOutcome` 时保持；其他以 `retry` / `new` 结束的 attempt（`completed`、`invalid-session`，即不是以 blocked 结束的）清零；同一 attempt 内的重试（`retry` / `same`）和 `wait` 保持。
  - `retire` 时清零（`open-code.ts:335-344`）。`retire` 发生在合同离开 active、revision 或 recognition context 改变时，所以交付、challenge、修订、release、Principal resume 这些机构性转移之后都重新计数。
- escalation 的原因写成 `Blocked in 2 consecutive attempts; routed to the issuer: <最后一次原因>`。ledger 中前面两条 report-blocked 事件保留各自原文。
- 模型看到的内容不变：`contract_report_blocked` 的描述本来就是 "schedules retry or escalation"，返回值和 admission 文本都不变。
- 交给 Principal 之后：resume 把合同改回 dormant（`blocked` 保留），重新激活后开一个新 Session，brief 中含 `Previous attempt blocked: …`。计数器在 escalate 时已经清零，所以 resume 后再次 blocked 仍有一次自动重试。release 则结束这项义务。既有测试 "builds dispatch material from the context actually claimed after issuer resume" 已覆盖这条派发路径。

**为什么阈值是 2**：第一次 blocked 可能是暂时的，也可能是单个 Session 的误判。下一个 attempt 是带着原因启动的新 Session，相当于一次独立复核。复核后仍然 blocked，再开第三个 Session 能带来的新信息很少：本事件的 3 次复核结论完全相同。阈值不做成可调参数，以免这条路由规则变成可配置的次数上限。

**为什么不算累计上限**：

- 它不结束义务：escalated 不是 settlement，resume 可以恢复执行；
- 它不统计 turn、action、请求或费用；
- 它只看连续两个 attempt 的执行者声明，任何不以 blocked 结束的 attempt 或机构性转移都会让计数清零；
- 它没有用大数冒充"无上限"，不启用时就是原来的行为。

**与其他机制的关系**：

- `maxAttempts`：两者谁先触发，都会 escalate。
- deadline：不变。escalated 状态不会因为 deadline 再变化，sweep 只处理 active 和 dormant。
- native advisory：每个 attempt 的交付前审阅机会，在一轮 blocked 中最多用两次。`setAdmission` 的暂停与恢复属于同一 attempt，不影响计数。
- host driver：`View.binding` 中能看到计数，但只有 `native.outcome` 会用它。

**残余风险**：blocked 与静默结束交替出现时不会触发。静默结束指 `completed`，即没有调用任何结算工具就结束。静默结束后反复开新 attempt 是现有的原生行为，不在本轮范围内（§9）。

### 3.4 版本化与按合同启用

**写入 binding**：新增 `Binding.blockedRouting?: "retry" | "escalate" | "escalate-after-repeat"`。

- `"retry"` 对应 B(i)，与现有行为相同；`"escalate"` 对应 B(ii)；`"escalate-after-repeat"` 对应 B(iii′)。
- 原生 binding 在 `create` 时写入该字段：签发输入给了显式值就用它，否则使用已确认的默认值 `"escalate-after-repeat"`。
- 已持久化的 binding 没有这个字段，按 `"retry"` 处理。所以已签发的合同不论在哪个部署里运行，行为都不变。
- 幂等重复签发时：输入显式给出、且与已存的值不同，则拒绝，报 "contract execution binding does not match"；输入没给，则保留已存的值（包括缺省），不会悄悄升级。这样 native advisory 对既有合同重复调用 issue 时仍会被接受（`native-advisory.ts:112` 的路径）。
- 进程内签发入口 `ProContractOpenCode.issue` 接受这个选项，native advisory 原样透传输入。已确认不把它加进 HTTP 签发载荷，以免改 Protocol 和重新生成代码；HTTP 签发使用默认值（§8）。

**否决的两种版本化方式**：

1. **新 driver identity `native:2`**：需要审查 11 处使用 `ProContractDriver.native.identity` 的代码，其中的相等判断要改成"是否原生"的判断（`open-code.ts` 7 处、`job.ts:191`、`native-advisory.ts` 3 处）。更危险的是，`driverID` 对缺少该字段的旧 binding 默认取 `native.identity`（`open-code.ts:846`），一旦升级 identity，旧 binding 会悄悄变成新行为。
2. **新增 Spec 字段 `spec.resolution.blocked`**：它会进入 `specHash`，改变公开的 Schema 和 Protocol，需要 generate 和重建 SDK。而路由节奏是执行适配层的恢复策略，不是义务条款，也不影响 authority 或 settlement（Constitution：escalated 是路由，不是结算）。

## 4. Change gate 论证

**A0 不是 ProContract Core 的改动，change gate 不适用。** 它不改变任何不变量，也不改变任何代码或判定：replay 谓词仍然是唯一依据，执行者的权限没有扩大（§2.1）。它只是部署准备的一步，但会改变实验条件，所以要做预检（§7.1）并在标签中注明（§5）。

B(iii′) 的论证如下。

| 项 | B(iii′) |
| --- | --- |
| 维护的不变量 | Constitution 不可约状态中的 "pending issuer decision or escalation routing when outstanding work cannot execute"：执行者声明无法执行、并经过一次独立复核后，义务交给一个明确的负责方（issuer），而不是无限次地重新派给声称无法执行的执行者。Obligation conservation 不变，escalation 不结算义务 |
| 没有它会出现的反例 | 本事件：#58 之后约 100 秒内开了 3 个新 attempt，发出 32 次上游请求，消耗 559,021 tokens，每个都以同一原因 blocked。如果没有人工中止，会一直持续到 13:01:22 的 deadline，issuer 始终没有被询问 |
| 为什么不在 kernel 中实现 | retry 还是 escalate 是 driver 的恢复决策（Constitution 的分层中，execution adapter 负责 recovery），driver 接口已有 `escalate`，kernel 也已提供 escalate、resume 并记入 ledger。如果把 report-blocked 直接改成 escalated，会改变所有执行者（包括人类承包者）的语义，也否定了暂时性 blocked 的合法用途 |
| 纯 kernel 测试 | reducer 不变，kernel 与 constitution 的既有测试必须原样通过。纯函数测试覆盖 `native.outcome` 的完整决策表：7 种 outcome × 4 种路由设置（含缺省）× 不同计数。kernel 既有测试已覆盖 escalate 后 resume 仍保留 `blocked` |
| 真实边界测试 | core：真实 store 上的 driver 生命周期，包括 claim、reportBlocked、complete、sweep、第二 owner 接管、resume。opencode：真实宿主进程加脚本化 LLM，确认不会出现第三个 attempt，HTTP resume 后能恢复 |
| 增加的概念 | `Binding.blockedRouting`、`Binding.blockedStreak`、`native.outcome` 的一个分支、`reportBlocked`/`settle`/`retire` 中的计数维护、签发选项 |
| 删除的概念或分支 | 无。`"retry"` 就是现有分支，留给旧 binding 使用 |

如果以后启用 A1′，它的论证要点是：

- **维护的不变量**：适配层的副作用授权，即 kernel invariant 5 在执行面的落实。
- **反例**：本事件的 #27。
- **为什么在适配层**：kernel 看不到副作用，只有 `FileMutation` 同时知道写到哪里、写入什么。
- **其他**：reducer 不变；聚焦测试是 `FileMutation` 单元测试，边界测试是经 ToolRegistry 结算的合同工具调用。

## 5. 兼容方案

1. **历史 cohort 与归档**：不改动任何已有的 artifacts、ledger、replay 报告或 binding 数据。Spec 哈希、ReplayPolicy 哈希和 ledger 命令格式都不变。已冻结的准备脚本和本轮归档也保持原样，A0 只写进下一轮新复制的脚本。
2. **正在运行或已冻结的 cohort**：它们使用各自冻结的源码和准备流程，不升级。Terra Max 保持原来的 6h / 1000-turn 条件。
3. **已签发、仍在运行、且所在部署被升级的合同**：B 中，binding 没有新字段，按 `"retry"` 处理，行为不变。A0 不涉及代码，对它们没有影响。
4. **公开 API**：不改 Protocol、Server `HttpApi` 和 Schema，不需要 generate，也不需要重建 SDK。`Binding` 类型只新增两个可选字段，sdk-next 的读取方不受影响。
5. **标注**：之后的运行要在标签和 RESULTS 中注明两项条件变化：
   - `inputs-committed`：受保护输入已提交，项目 ID 为根提交哈希；
   - `blocked-route=escalate-after-repeat`：blocked 路由策略。

   RESULTS 中要说明，这些运行与前两轮冒烟测试（2026-09-27、2026-10-01）以及历史的 `6h/1000-turn` cohort 不严格可比。`retryDelay` 保持 1000 毫秒，与前两轮相同，便于对照。
6. **运行安全约束**：网络与凭证隔离、显式取消、单次操作上限、基础设施故障保护和计量都保持不变。B 只减少无效的 attempt，不改变计量口径。

## 6. 改动清单

### A0（仓库内无生产代码改动）

| 位置 | 改动 |
| --- | --- |
| 下一轮实验的准备脚本（仓库外，对应本轮 `trial.ts` 与 `rehearse.ts` 中 `git init` 的位置） | 在 `git init` 之后、宿主启动之前，提交受保护输入并校验（§2.1）；把提交哈希与项目 ID 写入准备记录 |
| 下一轮的启动方案（仓库外） | 增加 §7.1 的预检门槛，并注明新的准备条件 |
| `packages/core/test/`（已确认加入，仅测试） | 新增一个刻画用例：在已提交的工作区中，bash 改坏受保护输入后 `contract_check` 失败（`checks` 为 0），`git checkout` 恢复后通过。它在仓库内记录 bash 的行为和 A0 依赖的恢复途径，不改生产代码 |

### B(iii′)

| 文件 | 改动 |
| --- | --- |
| `packages/core/src/pro-contract/open-code.ts` | `Binding` 增加两个字段；issue 与 create 的输入增加选项和默认值；幂等签发只比较显式给出的值；`reportBlocked` 中维护计数并生成原因；`settle` 与 `retire` 中维护计数 |
| `packages/core/src/pro-contract/driver.ts` | `native.outcome` 读取 `blockedRouting` 与 `blockedStreak` |
| `packages/opencode/test/fixture/*` | 按需透传选项，仅限测试 |

不改动：`kernel.ts`、`replay.ts`、`file-mutation.ts`、各工具文件、`packages/schema`、`packages/protocol`、`packages/server`。

仓库外：下一轮 advisory 试运行的签发模板要显式写入 blocked 路由策略，并更新标签。

## 7. 测试计划

### 7.1 A0 预检（无模型，作为下一轮启动门槛）

1. **准备结果核对**：
   - `git rev-list --count HEAD` 为 1；
   - `git ls-files` 恰好是合同 `replay.protected` 的全部路径；
   - 对每个路径，`git show HEAD:<path> | sha256sum` 等于 `input-hashes.json` 和合同中的哈希；
   - `git status --porcelain` 中没有受保护路径；
   - `core.autocrlf` 未设置，没有 `.gitattributes`，也没有 filter 配置；
   - 记录提交哈希。
2. **恢复演练**：在准备好的工作区的一次性副本中进行，不在正式工作区里做。用与 worker 相同的隔离启动器（相同的 Landlock 规则和用户），依次执行：
   - 覆盖 `TASK.md`、截断 `SBNO_formulas.pdf`、删除 `acceptance.mjs`；
   - 执行 `git checkout -- <这三个路径>`；
   - 核对三者的 sha256 都等于冻结哈希。

   这一步同时记录 bash 路径的实际行为：改写会成功，恢复也可以通过 bash 完成。
3. **宿主演练**：沿用现有的 rehearsal 路径，不调用真实模型，使用脚本化 provider。在已提交的工作区上签发演练合同，然后核对：
   - 快照捕获成功；
   - `contract_check` 与交付的 replay 通过，`checks` 实际执行；
   - native advisory 的材料捕获和审阅能完成，清理状态为 `confirmed`；
   - 记录项目 ID（预期是根提交哈希），并与上一轮的 `global` 对比，确认合同 scope、Session 和 replay 没有其他差异。
4. 任何一项不符，就不启动正式组，先报告。

### 7.2 B 单元测试（`packages/core`）

扩展 `test/pro-contract-driver.test.ts`，以纯函数方式覆盖 `native.outcome` 的决策表：7 种 outcome × 路由设置（缺省、`retry`、`escalate`、`escalate-after-repeat`）× 不同计数。非 blocked 的 outcome 在所有设置下都必须保持现有决定。

### 7.3 B 生命周期测试（`packages/core`）

扩展 `test/pro-contract-driver.test.ts`，使用原生 driver，不设 `maxAttempts`：

1. **结构性障碍**（`escalate-after-repeat`）：第一次 claim 后 reportBlocked，再 complete。此时 `blockedStreak = 1`，`nextActionAt = now + retryDelay`，合同仍为 active。第二次 claim 开新 Session，再 reportBlocked、complete，合同变为 escalated，原因包含 "Blocked in 2 consecutive attempts"。之后 claim 返回 undefined。ledger 依次为 report-blocked、report-blocked、escalate。
2. **resume 之后**：resume、激活、claim，开新 Session，再 reportBlocked 一次，决定是 retry 而不是 escalate，证明计数在 escalate 时已清零。
3. **暂时性障碍**：一次 blocked 之后，下一个 attempt 以 `completed` 结束（没有结算），计数清零，之后再 blocked 仍然是 retry。另一种情况：一次 blocked 之后，下一个 attempt 交付成功，合同进入 verification，经 `retire` 清零。
4. **中间夹着传输重试**：一次 blocked 后，下一个 attempt 中途出现 `retryable-error`，在同一 attempt 内继续，然后再 blocked，会 escalate。证明传输重试不会清零计数。
5. **B(ii)**（`escalate`）：第一次 blocked 就 escalate。
6. **旧 binding**：通过 DB 写入一行没有 `blockedRouting` 的数据，模拟升级前的 binding。连续 3 次 blocked 都是 `retry` / `new`，`nextActionAt = now + retryDelay`，以此刻画现状。到达 deadline 时，sweep 仍会以 "OpenCode deadline exhausted" escalate。
7. **重启**：pending 的 escalate 在租约过期后由第二个 owner 恰好执行一次，ledger 中没有重复事件。仿照既有测试 "consumes native blocked retry exactly once after recovery"。
8. **幂等签发**：同一 id 显式给出不同的路由，被拒绝；不给，则被接受并保留已存的值。
9. **与 `maxAttempts` 并用**：两者谁先触发都会 escalate。

### 7.4 B 进程测试（`packages/opencode`，真实宿主进程，脚本化 LLM，不调用真实模型）

1. **原生合同的 blocked 路由**：attempt 1 和 attempt 2 都调用 `contract_report_blocked`，合同变为 escalated。验证只有两个 worker Session，并且在等待超过 retryDelay 加调度间隔之后，仍然没有第三个 attempt（例如 retryDelay 设为 100 ms，等待 3 s）。然后经过 Principal 认证调用 HTTP `proContract.resume`，第三个 Session 启动，首条输入包含 `Previous attempt blocked`。
2. **native advisory 下的 blocked 路由**：一轮 blocked 最多产生两次交付前审阅，暂停与恢复不影响计数。
3. 回归：`pro-contract-native-advisory*-process`、`pro-contract-driver-process`、`pro-contract-process`。

### 7.5 与问题说明 §6.3 的对应关系

| 要求 | 本轮的处理 |
| --- | --- |
| 通过 write、edit、apply_patch 修改受保护路径被拒绝 | 本轮不适用：A0 不拦截写入，这些工具仍能修改受保护文件，由 replay 拒绝，与现在相同（§2.2）。以后若启用 A1′，需补充三类测试：`FileMutation` 单元测试（五个原语、逐字节相同时放行、BOM、符号链接和硬链接别名、名字相近的路径）；经 ToolRegistry 的边界测试（write、edit、apply_patch 整体不写入、`mutate_run` 跳过 run 阶段）；以及宿主进程测试 |
| 未受保护路径的写入与 replay 不变 | A 没有代码改动；B 只改 blocked 的路由。通过 §7.6 的回归和 §7.1 第 3 项确认 |
| bash 路径的行为如实记录 | §7.1 第 2 项，以及 §6 中的仓库内刻画用例 |
| blocked 新策略在暂时性与结构性障碍下的表现 | §7.3 第 1-5 项、§7.4 第 1-2 项 |

### 7.6 回归命令与基线

在各 package 目录下运行，每次使用独立的 `OPENCODE_DB`，例如：

```sh
cd packages/core && OPENCODE_DB="$(mktemp -d)/opencode.db" bun test test/pro-contract-driver.test.ts test/pro-contract.test.ts
```

- core：`pro-contract*`、session-runner，以及 A0 的刻画用例。
- opencode：`test/server/pro-contract-*-process.test.ts`。
- sdk-next：`native-advisory*.test.ts`、`contract-jobs.test.ts`。
- 在 `packages/core`、`packages/opencode`、`packages/sdk-next` 下分别运行 `bun typecheck`。
- 注意：core 和 opencode 的 test preload 目前会在进程内强制使用 `:memory:`；进程测试的夹具会为每个宿主设置自己的数据库路径。按要求，外部的 `OPENCODE_DB` 仍然照常设置。

本次在 `efa12bea6` 上记录的基线（`packages/core`，bun 1.3.14，独立 `OPENCODE_DB`）：

- `pro-contract-driver`、`file-mutation`、`tool-write`、`tool-edit`、`tool-apply-patch`、`location-mutation`：86 项通过，0 失败。
- `pro-contract-control`、`pro-contract-replay`、`pro-contract-constitution`、`pro-contract`、`pro-contract-admission-input`：106 项通过，0 失败。

## 8. 决定事项

以下全部事项已由用户以 Principal 身份确认（2026-10-02），目前没有待决事项。

**方案选择**：

1. A 采用 A0（准备阶段提交受保护输入）。
2. A1′、A1b、A1c 暂不实施。A1′ 的启用条件见 §2.3。
3. A3 与 ProContract 内置快照本轮不做。

**确认事项**：

4. B 采用 B(iii′)。
5. 新签发的原生合同默认启用 `"escalate-after-repeat"`；已持久化的 binding 仍按 `"retry"` 处理（§3.4）。
6. 不把 `blockedRouting` 开放到 HTTP 签发接口。不改 Protocol，不需要 `bun run generate`；HTTP 签发使用上述默认值。
7. 下一轮试运行的 `retryDelay` 保持 1000 毫秒，便于与前两轮对照。在 B(iii′) 下，第二个 attempt 约在 1 秒后开始，传输重试的间隔也不变。
8. 标签按 §5 第 5 条注明 `inputs-committed` 和 `blocked-route=escalate-after-repeat`，并说明与前两轮不严格可比。
9. 在仓库内加入只含测试的 A0 刻画用例（§6），固定"bash 写坏受保护文件后用 git 恢复"这条路径。

## 9. 不在本轮范围与残余风险

- A0 不是保证：执行者可能不用 git，或者把损坏的文件提交进去。这时会经由 B 交给 Principal，由 Principal 恢复后 resume。
- 本轮不拦截写入工具和 bash 对受保护文件的改写，只靠 replay 拒绝。如果再次发生且 git 恢复无效，启用 A1′（§2.3）。
- research 宿主计划层的 `additionalProtected`（第八轮的类型）不在本轮范围。
- 静默结束（`completed`）导致的新 attempt 循环是现有的原生行为，B(iii′) 不处理。blocked 与静默结束交替出现时不会触发路由。
- 本地部署仍然是协作式的（Constitution 的过渡债务），执行者可以读写工作区的 `.git`。
