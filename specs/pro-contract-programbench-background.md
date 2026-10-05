# ProgramBench 后台对照 — 2026-09-05

已启动三个真实 instance：`eradman__entr.8e2e8b4`、`mgdm__htmlq.6e31bc8`、
`lua__lua.c6b4848`。运行时基线与当前反馈接口候选各一次，共六条轨迹，均为
`openai/gpt-5.6-luna` / `max`。不是与上次 200 题运行完全相同的复跑。

基线是 `910d9f2856323ad5493ee52f8cb2c315d2172e10` 的运行时代码；候选增加此前
冻结的四模块修改。两组采用相同编译设置、模型目录、behavioral policy、修复后的
ProgramBench adapter 和冻结测试数据。现有 `dist` 二进制未替换。

- 每题：1,000 turns、4,000 actions、6 小时执行期限、最多三次 semantic attempt。
- 每组两个并发 worker，总并发最多四个。
- 每组 $12 usage-based 成本熔断，总目标 $24；在途请求可能导致小幅超出阈值。
- 缓存比率仍记录，但不作为这次小样本能力实验的暂停条件。
- 正常结束自动执行官方评测；暂停、预算中断和失败不冒充合法完成，不自动重跑。

完整目录：

`/home/duozhou/run-artifacts/procontract-programbench-luna-max-3pairs-20260905-v1`

其中 `PROTOCOL.md`、`frozen-inputs.json`、`binaries/*/opencode.build.json` 记录冻结
条件和实际二进制身份；`runner-src/` 是隔离的 runner/evaluator 源码及虚拟环境；
`test-blobs/` 仅供外部验收。`runs/baseline/`、`runs/candidate/` 保存逐题状态与评测结果。

查看实时状态：

```bash
python3 /home/duozhou/run-artifacts/procontract-programbench-luna-max-3pairs-20260905-v1/status.py
```

查看后台窗口：

```bash
tmux -L pcbench-3pairs-0905-v1 attach -t procontract-3pairs
```

窗口为 `baseline` 和 `candidate`；日志为完整目录下的 `baseline.log`、`candidate.log`。
窗口结束后 `*.exit-code` 保存退出码。已有的其他 ProgramBench 后台任务未停止。

启动预检已冻结计划，第一次启动因缺少 `--resume` 被拒绝，尚未产生模型调用。
原始日志保存在 `launch-attempt-1/`；随后仅采用已冻结计划继续启动，没有使用
`--retry-infra` 或 `--redo`。详见 `LAUNCH-RECOVERY.md`、`resume-launch.json`。

早期观察：候选 Lua 在首轮主动提出改写目标／brief 的修订请求，进入
`awaiting_revision`；原有证据、预算并未缺失。此请求未获自动批准，暂停轨迹保留，
不选择性重跑。其他任务继续。这只是一个早期边界行为，不是总体性能结论。
