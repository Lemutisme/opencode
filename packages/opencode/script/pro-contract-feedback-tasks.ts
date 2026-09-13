import { chmod, mkdir, readdir } from "node:fs/promises"
import path from "node:path"

export type FeedbackFile = {
  readonly path: string
  readonly content: string
  readonly executable?: boolean
}

export type ReplayCheck = {
  readonly argv: readonly string[]
  readonly timeout: number
  readonly exit: number
}

export type OracleCase = {
  readonly id: string
  readonly args?: readonly string[]
  readonly stdin: string
  readonly stdout: string
  readonly stderr?: string
  readonly exit: number
}

export type FeedbackTask = {
  readonly id: "ready-control" | "repair-portability"
  readonly brief: string
  readonly files: readonly FeedbackFile[]
  readonly replay: {
    readonly checks: readonly ReplayCheck[]
    readonly protectedFiles: readonly string[]
    readonly artifacts: readonly string[]
  }
  readonly oracle: readonly OracleCase[]
}

export type OracleResult = {
  readonly passed: boolean
  readonly cases: readonly {
    readonly id: string
    readonly passed: boolean
    readonly exit: number
    readonly stdout: string
    readonly stderr: string
    readonly timedOut: boolean
  }[]
}

export const limits = {
  maxTurns: 24,
  maxActions: 96,
  deadlineMs: 240_000,
  maxAttempts: 3,
} as const

export const order = [
  { taskID: "ready-control", replicate: 1, arms: ["baseline", "current"] },
  { taskID: "repair-portability", replicate: 1, arms: ["current", "baseline"] },
  { taskID: "repair-portability", replicate: 2, arms: ["baseline", "current"] },
  { taskID: "ready-control", replicate: 2, arms: ["current", "baseline"] },
] as const

const readyCLI = `#!/usr/bin/env python3
import argparse
import json
import sys


def main() -> None:
    parser = argparse.ArgumentParser(description="Pack unique input lines as JSON")
    parser.add_argument("--sort", action="store_true")
    args = parser.parse_args()
    values = list(dict.fromkeys(line.strip() for line in sys.stdin if line.strip()))
    if args.sort:
        values.sort(key=str.casefold)
    print(json.dumps(values, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
`

const readyCompile = `#!/bin/sh
set -eu
cp linepack.py executable
chmod +x executable
`

const readyValidator = `#!/usr/bin/env python3
import subprocess
import sys


CASES = [
    ([], " red \\nblue\\nred\\n", '["red","blue"]\\n'),
    (["--sort"], "Zulu\\nalpha\\n", '["alpha","Zulu"]\\n'),
]


def main() -> None:
    failures = []
    for arguments, input_text, expected in CASES:
        result = subprocess.run(
            ["./executable", *arguments],
            input=input_text,
            text=True,
            capture_output=True,
            check=False,
        )
        if result.returncode != 0 or result.stdout != expected:
            failures.append(
                f"{arguments}: exit={result.returncode} stdout={result.stdout!r} stderr={result.stderr!r} expected={expected!r}"
            )
    if failures:
        print("\\n".join(failures), file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
`

const repairCLI = `#!/usr/bin/env python3
import argparse
from collections import Counter
from pathlib import Path
import re
import sys


STOPWORDS = set(Path(".cache/stopwords.txt").read_text(encoding="utf-8").splitlines())


def main() -> None:
    parser = argparse.ArgumentParser(description="Print the most frequent words")
    parser.add_argument("--top", type=int, default=5)
    args = parser.parse_args()
    if args.top < 1:
        parser.error("--top must be positive")
    words = re.findall(r"[A-Za-z]+", sys.stdin.read().lower())
    counts = Counter(word for word in words if word not in STOPWORDS)
    ranked = sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    for word, count in ranked[: max(args.top - 1, 0)]:
        print(f"{word}\\t{count}")


if __name__ == "__main__":
    main()
`

const repairCompile = `#!/bin/sh
set -eu
cp wordfreq.py executable
chmod +x executable
`

const repairValidator = `#!/usr/bin/env python3
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def check(label: str, command: list[str], cwd: Path, input_text: str, expected: str) -> str | None:
    result = subprocess.run(command, cwd=cwd, input=input_text, text=True, capture_output=True, check=False)
    if result.returncode == 0 and result.stdout == expected:
        return None
    return (
        f"{label}: exit={result.returncode} stdout={result.stdout!r} "
        f"stderr={result.stderr!r} expected={expected!r}"
    )


def main() -> None:
    root = Path(__file__).resolve().parent
    failures = []
    with tempfile.TemporaryDirectory() as temporary:
        clean = Path(temporary)
        shutil.copy2(root / "executable", clean / "executable")
        failure = check(
            "portability",
            ["./executable", "--top", "2"],
            clean,
            "A green green amber\\n",
            "green\\t2\\namber\\t1\\n",
        )
        if failure:
            failures.append(failure)
    failure = check(
        "semantics",
        ["./executable", "--top", "2"],
        root,
        "kiwi mango kiwi orange\\n",
        "kiwi\\t2\\nmango\\t1\\n",
    )
    if failure:
        failures.append(failure)
    if failures:
        print("\\n".join(failures), file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
`

const gitignore = `.cache/
__pycache__/
`

const cache = `a
an
the
`

export const tasks: readonly FeedbackTask[] = [
  {
    id: "ready-control",
    brief:
      "Deliver the self-contained Python 3 CLI linepack.py. It reads newline-separated values from stdin, strips surrounding whitespace, drops blank lines, preserves each distinct value's first occurrence, and writes one compact JSON array followed by a newline. With --sort, order values case-insensitively. The repository already contains an implementation: verify its behavior and deliver it. The delivered source must work from a clean exported directory using only the Python standard library and repository files.",
    files: [
      { path: "linepack.py", content: readyCLI, executable: true },
      { path: "compile.sh", content: readyCompile, executable: true },
      { path: "validate.py", content: readyValidator, executable: true },
      { path: ".gitignore", content: gitignore },
    ],
    replay: {
      checks: [
        { argv: ["./compile.sh"], timeout: 10_000, exit: 0 },
        { argv: ["python3", "validate.py"], timeout: 10_000, exit: 0 },
      ],
      protectedFiles: ["compile.sh", "validate.py", ".gitignore"],
      artifacts: ["executable"],
    },
    oracle: [
      {
        id: "stable-deduplication",
        stdin: " pear \n\nApple\npear\n",
        stdout: '["pear","Apple"]\n',
        exit: 0,
      },
      {
        id: "case-insensitive-sort",
        args: ["--sort"],
        stdin: "beta\nAlpha\nbeta\nalpha\n",
        stdout: '["Alpha","alpha","beta"]\n',
        exit: 0,
      },
      {
        id: "unicode-and-empty-lines",
        stdin: "\n café \n茶\ncafé\n",
        stdout: '["café","茶"]\n',
        exit: 0,
      },
    ],
  },
  {
    id: "repair-portability",
    brief:
      "Deliver the self-contained Python 3 CLI wordfreq.py. It reads UTF-8 text from stdin, extracts ASCII alphabetic words case-insensitively, excludes the stopwords a, an, and the, then prints up to --top entries as word<TAB>count, ordered by descending count and alphabetically for ties. --top defaults to 5 and must be positive. Repair the implementation as needed. The delivered source must work from a clean exported directory using only the Python standard library and repository files; ignored workspace caches are not part of the deliverable.",
    files: [
      { path: "wordfreq.py", content: repairCLI, executable: true },
      { path: "compile.sh", content: repairCompile, executable: true },
      { path: "validate.py", content: repairValidator, executable: true },
      { path: ".gitignore", content: gitignore },
      { path: ".cache/stopwords.txt", content: cache },
    ],
    replay: {
      checks: [
        { argv: ["./compile.sh"], timeout: 10_000, exit: 0 },
        { argv: ["python3", "validate.py"], timeout: 10_000, exit: 0 },
      ],
      protectedFiles: ["compile.sh", "validate.py", ".gitignore"],
      artifacts: ["executable"],
    },
    oracle: [
      {
        id: "portable-stopwords",
        args: ["--top", "2"],
        stdin: "The red red blue\n",
        stdout: "red\t2\nblue\t1\n",
        exit: 0,
      },
      {
        id: "top-and-tie-order",
        args: ["--top", "3"],
        stdin: "pear apple pear banana apple cherry date elderberry fig\n",
        stdout: "apple\t2\npear\t2\nbanana\t1\n",
        exit: 0,
      },
      {
        id: "case-and-stopword-normalization",
        stdin: "THE Cat cat An DOG a dog\n",
        stdout: "cat\t2\ndog\t2\n",
        exit: 0,
      },
    ],
  },
]

export async function materializeTask(task: FeedbackTask, directory: string) {
  await mkdir(directory, { recursive: true })
  if ((await readdir(directory)).length > 0) throw new Error("Task directory must be empty")
  await Promise.all(
    [...new Set(task.files.map((file) => path.dirname(taskPath(directory, file.path))))].map((parent) =>
      mkdir(parent, { recursive: true }),
    ),
  )
  await Promise.all(
    task.files.map(async (file) => {
      const target = taskPath(directory, file.path)
      await Bun.write(target, file.content)
      if (file.executable) await chmod(target, 0o755)
    }),
  )
}

export async function runOracle(
  task: FeedbackTask,
  directory: string,
  prefix: readonly string[] = [],
): Promise<OracleResult> {
  const cases = await Promise.all(
    task.oracle.map(async (item) => {
      const child = Bun.spawn([...prefix, "./executable", ...(item.args ?? [])], {
        cwd: directory,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          PYTHONDONTWRITEBYTECODE: "1",
          PYTHONIOENCODING: "utf-8",
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      })
      child.stdin.write(item.stdin)
      child.stdin.end()
      const state = { timedOut: false }
      const timer = setTimeout(() => {
        state.timedOut = true
        child.kill()
      }, 5_000)
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      clearTimeout(timer)
      const passed =
        !state.timedOut &&
        exit === item.exit &&
        stdout === item.stdout &&
        (item.stderr === undefined || stderr === item.stderr)
      return { id: item.id, passed, exit, stdout, stderr, timedOut: state.timedOut }
    }),
  )
  return { passed: cases.every((item) => item.passed), cases }
}

function taskPath(directory: string, relative: string) {
  const target = path.resolve(directory, relative)
  const resolved = path.relative(path.resolve(directory), target)
  if (resolved.startsWith("..") || path.isAbsolute(resolved)) throw new Error(`Task path escapes root: ${relative}`)
  return target
}
