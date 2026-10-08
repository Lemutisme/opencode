#!/usr/bin/env python3
"""Recompute descriptive metrics from retained summaries; never replay a scorer."""

import argparse
from fractions import Fraction
import hashlib
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--cohort",
        type=Path,
        default=Path("/home/duozhou/run-artifacts/programbench-essential-r2-nine-20261007"),
    )
    parser.add_argument(
        "--historical",
        type=Path,
        default=Path("/home/duozhou/ICLR_paper/analysis/rsi_20260918.json"),
    )
    parser.add_argument("--output", type=Path, help="New file only; otherwise print JSON to stdout")
    args = parser.parse_args()

    sources = {
        "analysis": args.cohort / "ANALYSIS.json",
        "protocol": args.cohort / "PROTOCOL.json",
        "historical": args.historical,
    }
    raw = {name: path.read_bytes() for name, path in sources.items()}
    data = {name: json.loads(value) for name, value in raw.items()}
    historical = next(
        row for row in data["historical"]["studies"]["parent"]["rounds"] if row["id"] == "generation-1"
    )
    rows = []
    for panel in ("development", "confirmation"):
        for old in historical[panel]["candidate-000"]["rows"]:
            current = sorted(
                (row for row in data["analysis"]["rows"] if row["instance"] == old["instance_id"]),
                key=lambda row: row["repeat"],
            )
            if [row["repeat"] for row in current] != [1, 2]:
                raise ValueError(f"Expected fixed repeats 1 and 2: {old['instance_id']}")
            if not old["strict_valid"]:
                raise ValueError(f"Historical score is not strict-valid: {old['instance_id']}")
            scores = []
            for row in current:
                if not row["valid"]:
                    scores.append(None)
                    continue
                score = row["score"]
                if not score["valid"] or score["total"] != old["total"]:
                    raise ValueError(f"Invalid or denominator-mismatched score: {row['id']}")
                if not 0 <= score["passed"] <= score["total"]:
                    raise ValueError(f"Out-of-range score: {row['id']}")
                scores.append(Fraction(score["passed"], score["total"]))
            rows.append(
                {
                    "instance": old["instance_id"],
                    "panel": panel,
                    "historical": Fraction(old["resolved"], old["total"]),
                    "scores": scores,
                }
            )

    development = [row for row in rows if row["panel"] == "development"]
    if len(rows) != 9 or len(development) != 6:
        raise ValueError("This audit requires the frozen nine-task, six-development-task panel")
    if any(score is None for row in development for score in row["scores"]):
        raise ValueError("Incomplete development panel; do not manufacture an aggregate")
    dev = summarize(development)
    contribution = []
    for row in development:
        delta = (sum(row["scores"]) / 2 - row["historical"]) * 100
        contribution.append(
            {
                "instance": row["instance"],
                "deltaPP": float(delta),
                "contributionPP": float(delta / len(development)),
                "shareOfObservedGapPercent": float(delta / len(development) / Fraction(dev["deltaPPExact"]) * 100),
                "repeatRangePP": float(abs(row["scores"][1] - row["scores"][0]) * 100),
            }
        )

    calibration = data["protocol"]["referenceCalibration"]
    bounds = [
        sum(sum(Fraction(endpoint) if score is None else score for score in row["scores"]) / 2 for row in rows)
        / len(rows)
        for endpoint in (0, 1)
    ]
    historical_mean = sum(row["historical"] for row in rows) / len(rows)
    elapsed = [
        {
            "assignment": row["id"],
            "nativeMinutesToLastFence": (
                max(execution["fenceTime"] for execution in row["executions"])
                - (row["deadline"] - data["protocol"]["secondsPerOriginal"] * 1000)
            )
            / 60000,
        }
        for row in data["analysis"]["rows"]
    ]
    report = {
        "kind": "post-close-descriptive-measurement-audit-not-new-evaluation",
        "sources": {
            name: {"path": str(path.resolve()), "sha256": hashlib.sha256(raw[name]).hexdigest()}
            for name, path in sources.items()
        },
        "historicalEvidenceTier": "retained-summary-not-replayed; original source files unavailable",
        "development": dev,
        "developmentContributions": contribution,
        "sensitivity": {
            "withoutXh": summarize([row for row in development if row["instance"] != "ducaale__xh.4a6e44f"]),
            "referenceFullDevelopmentSubset": summarize(
                [row for row in development if calibration[row["instance"]][0] == calibration[row["instance"]][1]]
            ),
            "meanReferenceDeficitPPNotAnEnvironmentEffectBound": float(
                sum(1 - Fraction(*calibration[row["instance"]]) for row in development) * 100 / len(development)
            ),
        },
        "nineTaskBounds": {
            "meaning": "Attainable bounds only, not imputation or a completed cohort mean",
            "unknownRepeats": sum(score is None for row in rows for score in row["scores"]),
            "historicalPercent": float(historical_mean * 100),
            "newMinimumPercent": float(bounds[0] * 100),
            "newMaximumPercent": float(bounds[1] * 100),
            "deltaMinimumPP": float((bounds[0] - historical_mean) * 100),
            "deltaMaximumPP": float((bounds[1] - historical_mean) * 100),
        },
        "nativeElapsedObservations": elapsed,
        "formalEvents": {name: data["analysis"][name] for name in ("proposals", "comparisons", "adoptions")},
        "limits": [
            "Historical single observations and new two-repeat means are not a contemporaneous causal comparison",
            "Task runs, not individual assertions, are the experimental units",
            "All nine tasks are exposed; historical confirmation is not a new blind holdout",
            "No hidden test details, model calls, grading, or historical file edits are performed by this script",
        ],
    }
    rendered = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output is None:
        print(rendered, end="")
        return

    output = args.output.resolve()
    protected = (args.cohort.resolve(), args.historical.resolve().parent, Path("/home/duozhou/run-artifacts"))
    if any(output == root or root in output.parents for root in protected):
        parser.error("Output must not be inside a cohort or historical evidence directory")
    with output.open("x") as handle:
        handle.write(rendered)
    print(output)


def summarize(rows):
    historical = sum(row["historical"] for row in rows) / len(rows)
    repeats = [sum(row["scores"][repeat] for row in rows) / len(rows) for repeat in (0, 1)]
    delta = (sum(repeats) / 2 - historical) * 100
    return {
        "instances": [row["instance"] for row in rows],
        "historicalPercent": float(historical * 100),
        "newRepeatPercent": [float(score * 100) for score in repeats],
        "newMeanPercent": float(sum(repeats) / 2 * 100),
        "repeatDeltaPP": [float((score - historical) * 100) for score in repeats],
        "deltaPP": float(delta),
        "deltaPPExact": str(delta),
    }


if __name__ == "__main__":
    main()
