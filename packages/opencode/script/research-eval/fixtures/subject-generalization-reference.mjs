// Private deterministic fixture, not a supplied Researcher solution or an oracle for every valid method.
export function analyze(data, design = "leave-one-code-out") {
  const subjects = [...new Set(data.rows.map((row) => row.subject))].sort().map((subject) => {
    const rows = data.rows.filter((row) => row.subject === subject)
    return {
      subject,
      label: rows[0].label,
      x: data.features.map((_, j) => rows.reduce((sum, row) => sum + row.x[j], 0) / rows.length),
    }
  })
  const groups =
    design === "leave-one-code-out"
      ? subjects.map((s) => [s.subject])
      : [
          subjects.filter((_, i) => i % 2 === 0).map((s) => s.subject),
          subjects.filter((_, i) => i % 2 === 1).map((s) => s.subject),
        ]
  const folds = groups.map((testSubjects, fold) => {
    const train = subjects.filter((s) => !testSubjects.includes(s.subject))
    const test = subjects.filter((s) => testSubjects.includes(s.subject))
    const mean = data.features.map((_, j) => train.reduce((sum, row) => sum + row.x[j], 0) / train.length)
    const scale = mean.map(
      (m, j) => Math.sqrt(train.reduce((sum, row) => sum + (row.x[j] - m) ** 2, 0) / train.length) || 1,
    )
    const normalized = (row) => row.x.map((x, j) => (x - mean[j]) / scale[j])
    const centers = [0, 1].map((label) => {
      const rows = train.filter((s) => s.label === label).map(normalized)
      if (!rows.length) throw new Error("Fixture training fold lacks a class")
      return mean.map((_, j) => rows.reduce((sum, x) => sum + x[j], 0) / rows.length)
    })
    const baseline = train.filter((s) => s.label === 1).length >= train.length / 2 ? 1 : 0
    return {
      fold,
      trainSubjects: train.map((s) => s.subject),
      testSubjects,
      predictions: test.map((s) => {
        const x = normalized(s)
        const distance = centers.map((c) => c.reduce((sum, value, j) => sum + (value - x[j]) ** 2, 0))
        return { subject: s.subject, label: s.label, predicted: distance[1] < distance[0] ? 1 : 0, baseline }
      }),
    }
  })
  const predictions = folds.flatMap((fold) => fold.predictions)
  const score = (field) =>
    [0, 1].reduce((sum, label) => {
      const rows = predictions.filter((s) => s.label === label)
      return sum + rows.filter((s) => s[field] === label).length / rows.length
    }, 0) / 2
  return {
    design,
    method:
      "Subject mean of acoustic features, training-only z scaling and nearest class centroid; no parameter search; ties predict 0. Same-fold training-subject majority baseline; baseline ties predict 1.",
    folds,
    evaluatedSubjects: predictions.length,
    balancedAccuracy: score("predicted"),
    baselineBalancedAccuracy: score("baseline"),
    limitation:
      "Illustrative fixture only, no sampling interval or external-population/clinical claim; physical-person mapping remains uncertain.",
  }
}
