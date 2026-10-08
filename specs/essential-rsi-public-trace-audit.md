# Essential RSI：公开求解轨迹审计

日期：2026-10-08。范围：`programbench-essential-r2-nine-20261007` 已关闭 cohort。

> **Operator-only / 不得进入 solver。** 本文包含已暴露 benchmark 的具体公开反例，只供研究诊断。未来 release、模型可见 runtime、候选 method 和任务输入必须排除此 spec 及其具体反例，不能用它给 solver 注入历史答案。本文不是新实验协议，也不是性能提升验收。新代码或新 method 尚未证明提高 ProgramBench 成绩。

## 结论及证据边界

本轮至少存在直接可定位的链条：**公开探测已经看到差异 → 差异未成为持久回归或未决事项 → 狭窄本地验证通过 → 主动 submit**。这比“运行时间短，所以求解不足”更有诊断力。

模型并非没有差分求解能力。eva 的一个 540-case 矩阵从 177 个差异修到 0；xh 和 direnv 也进行了大量探测与修补。缺口更像是**探测结果没有可靠累积为控制下一步和停止判断的工作状态**，而不是缺少更多工具或更长最低运行时间。

以下区别必须保持：

- **观察事实**：明确公开反例、候选源码、工具结果、提交时刻与保存路径。
- **机制假设**：持久未决状态、完整观测比较和跨 Session 证据供应不足，可能削弱求解方法。
- **未证实因果**：不能把历史 R2 与新版的全部分差归于上述机制，不能声称新修复已经恢复 R2 性能。

审计只读取公开 solver 轨迹、交付源码、自有验证、cohort 汇总与相关 runtime 源码。没有读取私有评分失败断言，没有重跑候选、reference、模型或评分，没有修改任何历史 cohort 文件。R2 Luna 汇总引用的 45 个原始文件仍不可用；本文不虚构 R2 在相同任务上的实际探索过程。

## 证据根与定位规则

以下 `C` 代表：

```text
/home/duozhou/run-artifacts/programbench-essential-r2-nine-20261007
```

每个 execution 下，`state/session.sqlite` 的 `session_message` 表保存 JSON；本文的 `seq` 是该表的 `seq`，不是 provider-turn 计数。工具调用定位到 `data.content` 中 `type == "tool"` 的 `id`，公开输入/输出在其 `state` 中。分析不需要输出 reasoning、provider 加密状态、凭据或私有 grader 文件。

| 简称 | 相对于 `C` 的 execution 路径 |
|---|---|
| XH1 | `runs/4-rsi-r1/campaign/executions/202da907-f01f-45b7-9783-5cbe2be0ae01` |
| XH2 | `runs/4-rsi-r2/campaign/executions/47f4fcda-257d-4f01-b32f-d42f191159f7` |
| EVA1-before | `runs/1-rsi-r1/campaign/executions/a2063ba6-1caa-454d-ae9e-1cce7f1f5cb6` |
| EVA1-after | `runs/1-rsi-r1/campaign/executions/72076b99-ee4e-4423-a470-e3f4a587d0ee` |
| EVA2 | `runs/1-rsi-r2/campaign/executions/9beda38f-e165-4383-8e7d-f8aa36fc89bc` |
| DIRENV1-before | `runs/3-rsi-r1/campaign/executions/5af15c41-2817-4d59-838d-7281f5dfdadd` |
| DIRENV1-after | `runs/3-rsi-r1/campaign/executions/2e2cb3d6-ff27-4d3d-8068-2572322b633b` |
| DIRENV2 | `runs/3-rsi-r2/campaign/executions/7a2f2275-d08d-4027-8cf1-92f4ae63bfc1` |

## 1. 停止发生在 deadline 之前，但时间本身不是质量判据

从 `C/ANALYSIS.json` 的每行计算：

```text
start = original deadline - 6 hours
end = max(executions[].lastEvent)
native elapsed = end - start
```

`end` 是提交后原生 Session 的最后持久事件，略晚于成功 handoff，不是最终评分结束。所有 18 个原始任务均主动 submit；native 阶段范围 **25.61–55.49 分钟**，中位数 **30.66 分钟**。

| 任务 | r1 native 分钟 | r2 native 分钟 | r1/r2 provider 请求 | r1/r2 shell 调用 | r1/r2 patch 调用 |
|---|---:|---:|---:|---:|---:|
| eva | 55.49 | 34.78 | 173 / 99 | 134 / 68 | 27 / 22 |
| direnv | 47.15 | 30.56 | 397 / 257 | 256 / 136 | 128 / 75 |
| xh | 35.06 | 28.88 | 281 / 205 | 150 / 149 | 100 / 76 |

工具数量按最终 `session_message` 内容计数，包含失败调用，跨 checkpoint Session 相加；不是执行预算，也不是能力分数。本轮没有累计 provider/tool 次数上限，以上不是撞到六小时 deadline 的表现。

**不能推出“必须跑满六小时”。** 已完成工作应结束。应调查的是：当仍存在已知、可修复的行为差异时，为什么停止条件被认为满足？以下两个案例回答的是这一更窄问题。

## 2. XH1：已知 stderr 差异留存，本地绿灯后提交

### 2.1 原始公开差异

位置：`XH1/state/session.sqlite`。

| 字段 | 值 |
|---|---|
| UTC | `2026-10-07 23:54:51.612` |
| message ID | `msg_118ca934d001S8L03FMSfMg3sR` |
| seq | `2518` |
| tool call | `call_qKOUsPy5jkGS98mglQQHFjSb` |

该 14-case 双程序 probe 打印了 reference 与自己的 exit/stdout/stderr，但只展示 `stdout[:100]`、`stderr[:180]`，没有自动相等断言。至少六种错误参数的 stderr 在打印范围内已经不同：`--bogus`、`--pretty=x`、`--style=x`、`--print=x`、`--format-options=x:y`、`--response-charset=x`。

两个代表性例子：

- `--pretty=x`：两者 exit 均为 2。reference 有 `[possible values: all, colors, format, none]`，own 缺少该行，却额外输出通用 Usage。
- `--print=x`：reference 首行包含 `: 'x' is not a valid value`；own 缺少这段，且额外输出通用 Usage。

这不是读取隐藏测试之后才发现的问题；solver 当时已经收到这些公开字节。截取会限制其完整性，但这里的可见前缀已足以证明不相等。外层 probe 正常结束也不等于内层两程序行为相等。

### 2.2 为什么可以说未闭合

seq2518 之后的候选 patch 只涉及 no-* 重置及 URL 判断。最终 `XH1/workspace/xh.py:296–301,497,506` 仍保留上述错误构造差异。此判断来自工具编辑轨迹和最终源码静态核对；本审计没有再执行候选。

最终 `XH1/workspace/validate.sh`：

- 第 7–30 行：9 个 CLI invocation；
- 第 57–60 行：唯一一次本地 HTTP 请求检查；
- 不含上述错误参数回归。

最终检查在以下位置报告 `validate: ok`，同时重放 help 和生成 completion/man 输出，而不是上述错误矩阵：

| UTC | message / seq | tool call |
|---|---|---|
| `2026-10-07 23:56:01.407` | `msg_118cba3ef0018QilPY84uFVgk1` / `2603` | `call_w8Dsxxe2yO5y6M5HOMqbU53I` |
| `2026-10-07 23:56:28.911` | `msg_118cc0f5f001PQeikBFJ8GU6Tc` / `2641` | `call_SnL9ZbSjceALWdKF2eviFCcW`（成功 submit） |

原始 deadline 为 `2026-10-08 05:21:28.837 UTC`，成功提交时仍约剩 **5 小时 25 分钟**。

这支持“已知反例未闭合就提交”，**不支持**“这些错误文本差异解释了 xh 的全部分差”。

## 3. EVA2：一个差异族修好，另一个差异族未成为持续义务

### 3.1 正面证据：不是缺乏差分修复能力

同一 `EVA2/state/session.sqlite` 中：

| UTC | message / seq | 公开矩阵结果 |
|---|---|---|
| `2026-10-08 02:34:34.041` | `msg_1195ccaad001xK9K3Cwa4H5fe7` / `569` | radix/precision 矩阵 `177 / 540` mismatch |
| `2026-10-08 02:35:27.452` | `msg_1195d9b500012eYKPsAbuIxSaH` / `604` | 修复后同矩阵 `0 / 540` mismatch |

该 probe 比较 `(returncode, stdout, stderr)`。这些是广泛探测和有效修复的明确证据，不能把整个 run 描述为“仅写代码、编译就交卷”。

### 3.2 同时存在未被保留的函数差异

更早的函数矩阵：

| 字段 | 值 |
|---|---|
| UTC | `2026-10-08 02:34:03.055` |
| message ID | `msg_1195c51a4001MW9jTpAN6Lo1XR` |
| seq | `551` |
| tool call | `call_hQTZlkAdiBlYcO8KLJzwvPmq` |
| 公开输出 | `total 24 of 594` |

例：`csc(1,0)` 的 reference 为 `(1, "", "Domain Error: Out of bounds!\n")`，own 为 `(1, "", "Parser Error: Too many operators, too few operands\n")`。

最终 `EVA2/workspace/eva.py:263–281` 的一元函数路径仍在该额外数字位置先触发 Parser Error；没有把这个已知例子收入最终 validate。这里静态核对的是一个具体剩余路径，**不把 24 个中间差异全部宣称为最终仍失败**。

最终 `EVA2/workspace/validate.sh` 只有 12 个正常表达式、2 个错误检查和1组 REPL 输入。正常检查用 shell command substitution 比较 stdout，去掉尾部换行，也不验证 stderr；错误检查单独验证 exit/stderr。最终验证通过只能说明这些具体断言通过，不能代表全部已观察矩阵已关闭。

成功 submit：`msg_11962b2b90011wjEO7EGuIOgpS` / seq990 / `call_jQuV7YdegGuwn8SvkdTe94tC`，`2026-10-08 02:41:01.127 UTC`。原 deadline 为 `08:06:17.712 UTC`。

## 4. 大量临时探测没有变成可持续重放的工作状态

| xh | r1 | r2 |
|---|---:|---:|
| shell 工具调用 | 150 | 149 |
| patch 工具调用 | 100 | 76 |
| 明确创建的临时 probe 脚本 | 21 | 30 |
| 最终 validate 中候选 invocation | 10 | 6 |
| 其中本地 HTTP 请求 | 1 | 1 |

这些临时 probe 位于 `/tmp/opencode/probe_*.py` 或 `/tmp/probe_*.py`。两次最终 workspace 的 Python/shell 文件只有 `xh.py`、`compile.sh`、`validate.sh`，没有把这些探测脚本转成独立持久回归库。

direnv 也有相似形态：shell 输入中明确创建的 `/tmp/*.py|sh` 脚本下界为 r1 **58**、r2 **46**。这是按文件定义计数的描述性下界，不是独立有效实验数。DIRENV2 的最终 `validate.sh` 为 1247 字节，检查版本、allow/export JSON、一次 exec、内容变更阻断；最终交付摘要提及更多 stdlib、shell formats、configuration 和 fetchurl 行为。摘要的覆盖声称不能替代相应重放证据。

对已经修复的行为保留回归，对未修复行为保留明确 open 状态，比增加探测次数更有针对性。具体记录格式属于可改进的 solver 方法，不应变成可自授权放宽 Contract 的新权力。

## 5. checkpoint 保存了工作文件，但探索证据只剩摘要

### 5.1 EVA1

EVA1-before 在 29 次 shell 调用后 checkpoint。当时 workspace 只有 `readme.md`、`LICENSE`，没有持久探测记录或 validate。

成功 handoff：`msg_1188fc5eb001WD9MRWqATxBqOu` / seq334 / `call_TwIFdG9QvQ2xpHvlbrC7yJdN`。前一次 seq325 因多带 replacement instructions 被拒，去掉字段后成功；没有把失败调用计成两个 checkpoint。

EVA1-after 的 `admission/input.json.feedback[0]` 与成功 tool input 的 `summary` 完全相同；其首个 glob 显示 workspace 仍仅两份原文档，随后重新探测 help/version 等行为。旧 host SQLite 仍保留，不等于继任 solver 获得了那些完整观察。

### 5.2 精确长度复核

早期分析中出现过未复核的 569 / 626 长度说法，均撤回。以下按**解析 JSON 后的字符串字段**复算，不计 JSON 引号或数组包装：

| checkpoint | tool summary Unicode 字符 | UTF-8 字节 | successor feedback[0] | 文本 SHA-256 |
|---|---:|---:|---|---|
| EVA1，seq334 | **612** | **612** | 完全相同 | `66c5d6d1a17801f33747efb7d5a075662a3721631b5deb1132ba6fe2c3b39571` |
| DIRENV1，seq971 | **352** | **352** | 完全相同 | `eea636b80112cb4b979420b74fe3d901099c2f9028aa3f52ae7c3ef49385515f` |

二者均为 ASCII 文本，因此 Unicode code-point 数等于 UTF-8 字节数。若对 EVA1 使用 `json.dumps(summary)`，长度为 614；`json.dumps([summary])` 为 616。这些是不同对象，不能混报为摘要长度。

DIRENV1 成功 checkpoint locator：`msg_118b41c0c001AbT8XFMCCXOp0D` / seq971 / `call_SGK6OjIfjoIeHJnylyOVFnhU`。源码和小型 validate 保留，但传给继任 Session 的反馈是 352 字符功能摘要，没有逐项未决反例和下一步重放定位。

这是**继任执行的证据供应不足**，不是指历史产物已经删除；也没有据此证明 checkpoint 造成了这两题的成绩下降。

## 6. runtime 的 shell 输出保留边界：证据供应损失，不是全局因果解释

旧 cohort 使用的修复源树 `6cbe5e7eb8ca8afede64f90ed20a9eb072dd25b6` 中：

```text
/home/duozhou/opencode-essential-repair/packages/core/src/shell.ts
```

- 第32行 `EXITED_LIMIT = 25`；
- 第235–248行对返回文本做 bounded tail capture，并给出 `full output saved to ...` 定位；
- 第377–381行在超出已退出命令数量后调用 `removeCommand`；
- 第159–169行 `removeCommand` 会 unlink 对应 output file。

DIRENV2 的两个具体引用：

| message / seq / tool | 模型收到的 full-output 定位 |
|---|---|
| `msg_1195dd951001992xr2cunLDc6D` / 90 / `call_CuEPLu1GG4rsI1qJkCEFs1n8` | `/state/data/opencode/shell/bf309ff466f7bcd6b1ca4751d16d42627dbac2ee/sh_1195e0930001dJ4cEbfF8VRxQW.out` |
| `msg_1196a3139001jlwpTt3D959OiG` / 838 / `call_O3LANhg0JpZZ8O4djx7MZlXF` | `/state/data/opencode/shell/bf309ff466f7bcd6b1ca4751d16d42627dbac2ee/sh_1196a3ff0001wX8UkmOF4mKTKG.out` |

审计时将 `/state/` 映射到该 execution 的 `state/` 后，两个文件都不存在。相关源码和数量边界与此现象一致。仅凭关闭后的文件缺失，不能声称模型曾请求重读且因此失败，也不能确定每个文件具体何时消失。

**这只证明一个值得修复的证据供应边界**：曾被承诺可定位的完整输出不保证仍可读。它不证明全部成绩下降由 eviction 引起；也不能把所有 tool `truncated` 统计都算作 shell loss，因为大量条目来自 read。上文 XH1 的已知差异本身已经出现在保留的可见 tool 文本中，不依赖这个 eviction 假设才能成立。

## 7. 与 R2 的关系及改进可检验性

本机可读 R2 v5 设计文件：

```text
/home/duozhou/run-artifacts/procontract-sol-r2-full-20260919/runtime/solver-policy.txt
```

其中明确以未解决的行为观察为 control state，要求完整可得 outcome tuple、区分性邻域、修复后的重放，并禁止以局部通过掩盖未解释的高影响差异。新版 `C/SEED.json` 保留了这些方向，但表达更概括。

**这份文件来自本机另一 R2 运行，不能冒充缺失的 Luna 九题原始 policy/轨迹。** 它提供的是值得重新表达并检验的方法设计，不是当前分差的已证实原因。

最小改进假设为：

1. 未决公开反例及可改变下一步的未知行为成为持久工作状态，而不是让最近一次绿灯主导 readiness。
2. 完整观测、独立 reference 预期和受影响回归可以持续重放；截断/缺失/超时显式保留为 incomplete，不用外层 exit0代替行为相等。
3. checkpoint 和输出保留不切断上述状态；正式 policy 学习另需实际生成、冻结、比较和采纳事件，不能以可选工具存在冒充已发生的 RSI。

这些变化都需要确定性验收以及另行冻结的真实模型对照。本审计不授权改变旧 cohort 的分数、预算、配置或停止语义，不把再次准入写成历史预注册证据。是否提高成绩仍未知。

## 附录：只读复算

以下片段只读取汇总及指定的公开 Session 字段，不访问 credentials 或 verifications：

```python
import hashlib
import json
import pathlib
import sqlite3
import statistics

root = pathlib.Path("/home/duozhou/run-artifacts/programbench-essential-r2-nine-20261007")
rows = json.loads((root / "ANALYSIS.json").read_text())["rows"]
minutes = [
    (max(e["lastEvent"] for e in r["executions"]) - (r["deadline"] - 6 * 3600_000)) / 60_000
    for r in rows
]
print("native minutes min / median / max:", min(minutes), statistics.median(minutes), max(minutes))

pairs = [
    ("1-rsi-r1", "a2063ba6-1caa-454d-ae9e-1cce7f1f5cb6", 334, "72076b99-ee4e-4423-a470-e3f4a587d0ee"),
    ("3-rsi-r1", "5af15c41-2817-4d59-838d-7281f5dfdadd", 971, "2e2cb3d6-ff27-4d3d-8068-2572322b633b"),
]
for run, before, seq, after in pairs:
    executions = root / "runs" / run / "campaign" / "executions"
    database = executions / before / "state/session.sqlite"
    connection = sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)
    message = json.loads(connection.execute(
        "select data from session_message where seq = ?", (seq,)
    ).fetchone()[0])
    connection.close()
    tool = next(part for part in message["content"] if part["type"] == "tool")
    summary = tool["state"]["input"]["summary"]
    feedback = json.loads((executions / after / "admission/input.json").read_text())["feedback"][0]
    print(run, "characters", len(summary), "UTF-8 bytes", len(summary.encode("utf-8")),
          "identical", summary == feedback, "SHA-256", hashlib.sha256(summary.encode("utf-8")).hexdigest())
```

关键静态证据 SHA-256：

| 文件 | SHA-256 |
|---|---|
| `C/ANALYSIS.json` | `b384af027da47ccf905a648b730d83860851434a420de0170a46c62adad26f30` |
| `C/FROZEN.json` | `ca315ab726a77c536756bf6f957e03e6f9328770958b53b49071eabc86b76e6e` |
| `XH1/workspace/xh.py` | `893ffed8155bf43400d3468560c6a16ed1e51b9e4e96565778c59ce36647db2b` |
| `XH1/workspace/validate.sh` | `744cbb7366eba9a85cd66f97f71fe1732625c82950f4349beab553254162f5a8` |
| `EVA2/workspace/eva.py` | `d5cbc01a8dd370fa9df01cad4f67a39be8e340be2978a860fef92d5b04a83f5f` |
| `EVA2/workspace/validate.sh` | `bee794fcab8e5294af19c74209f1e973a7e78ba2508acae6f8f55b37e6e37fd1` |
