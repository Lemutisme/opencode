#!/usr/bin/env bun

import { Schema } from "effect"

const NonNegative = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))
const Proposed = Schema.Struct({
  type: Schema.Literal("proposed"),
  node: Schema.NonEmptyString,
  parents: Schema.Array(Schema.NonEmptyString),
  mutation: Schema.NonEmptyString,
})
const Evaluated = Schema.Struct({
  type: Schema.Literal("evaluated"),
  node: Schema.NonEmptyString,
  campaign: Schema.NonEmptyString,
  capability: Schema.Number,
  regression: NonNegative,
  cost: NonNegative,
  valid: Schema.Boolean,
})
const Rejected = Schema.Struct({
  type: Schema.Literal("rejected"),
  node: Schema.NonEmptyString,
  falsifier: Schema.NonEmptyString,
})
const Closed = Schema.Struct({
  type: Schema.Literal("closed"),
  node: Schema.NonEmptyString,
  reason: Schema.NonEmptyString,
})
const Promoted = Schema.Struct({
  type: Schema.Literal("promoted"),
  node: Schema.NonEmptyString,
  assurance: Schema.NonEmptyString,
})
const Event = Schema.Union([Proposed, Evaluated, Rejected, Closed, Promoted])
const [searchFile, policy = "ucb", limitSource = "3", explorationSource = `${Math.SQRT2}`] = Bun.argv.slice(2)

if (!searchFile || !["linear", "ucb"].includes(policy))
  throw new Error(
    "usage: bun run script/select-improvement-search.ts <search.jsonl> [linear|ucb] [limit] [exploration]",
  )

const limit = Number(limitSource)
const exploration = Number(explorationSource)
if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer")
if (!Number.isFinite(exploration) || exploration < 0) throw new Error("exploration must be non-negative")

const events = (await Bun.file(searchFile).text())
  .split(/\r?\n/)
  .filter((line) => line.trim().length > 0)
  .map((line) => Schema.decodeUnknownSync(Schema.fromJsonString(Event))(line))
const nodes = new Map<
  string,
  {
    proposal: typeof Proposed.Type
    evaluations: Map<string, typeof Evaluated.Type>
    rejections: Set<string>
    closed?: string
  }
>()
let incumbent: string | undefined

events.forEach((event) => {
  if (event.type === "proposed") {
    const existing = nodes.get(event.node)
    if (existing) {
      if (JSON.stringify(existing.proposal) !== JSON.stringify(event))
        throw new Error(`conflicting proposal for node ${event.node}`)
      return
    }
    event.parents.forEach((parent) => {
      if (!nodes.has(parent)) throw new Error(`node ${event.node} has unknown parent ${parent}`)
    })
    nodes.set(event.node, { proposal: event, evaluations: new Map(), rejections: new Set() })
    return
  }

  const node = nodes.get(event.node)
  if (!node) throw new Error(`${event.type} references unknown node ${event.node}`)
  if (event.type === "evaluated") {
    const existing = node.evaluations.get(event.campaign)
    if (existing && JSON.stringify(existing) !== JSON.stringify(event))
      throw new Error(`conflicting evaluation for ${event.node}/${event.campaign}`)
    node.evaluations.set(event.campaign, event)
    return
  }
  if (event.type === "rejected") {
    node.rejections.add(event.falsifier)
    return
  }
  if (event.type === "closed") {
    if (node.closed && node.closed !== event.reason) throw new Error(`conflicting closure for node ${event.node}`)
    node.closed = event.reason
    return
  }
  incumbent = event.node
})
if (nodes.size === 0) throw new Error("search graph has no nodes")

const totalVisits = [...nodes.values()].reduce((total, node) => total + node.evaluations.size, 0)
const candidates = [...nodes.entries()]
  .filter(([, node]) => !node.closed)
  .map(([node, value]) => {
    const evaluations = [...value.evaluations.values()]
    const visits = evaluations.length
    const capability = visits ? evaluations.reduce((total, item) => total + item.capability, 0) / visits : 0
    const regression = visits ? Math.max(...evaluations.map((item) => item.regression)) : 0
    const cost = visits ? evaluations.reduce((total, item) => total + item.cost, 0) / visits : 0
    const invalid = evaluations.filter((item) => !item.valid).length
    const valueEstimate = visits
      ? evaluations.reduce(
          (total, item) => total + (item.valid ? item.capability - item.regression : -1 - item.regression),
          0,
        ) / visits
      : 0
    const score = visits
      ? valueEstimate + exploration * Math.sqrt(Math.log(Math.max(2, totalVisits)) / visits)
      : Number.POSITIVE_INFINITY
    return {
      node,
      parents: value.proposal.parents,
      mutation: value.proposal.mutation,
      visits,
      capability,
      worstRegression: regression,
      meanCost: cost,
      invalid,
      rejections: [...value.rejections].sort(),
      score,
    }
  })
const linearBase = incumbent ?? candidates.find((item) => item.parents.length === 0)?.node

const selected =
  policy === "linear"
    ? candidates.filter((item) => item.node === linearBase).slice(0, 1)
    : candidates
        .sort(
          (a, b) =>
            b.score - a.score ||
            b.capability - a.capability ||
            a.worstRegression - b.worstRegression ||
            a.meanCost - b.meanCost ||
            a.node.localeCompare(b.node),
        )
        .slice(0, limit)

process.stdout.write(
  `${JSON.stringify(
    {
      version: 1,
      policy,
      incumbent: incumbent ?? null,
      linearBase,
      graph: {
        nodes: nodes.size,
        edges: [...nodes.values()].reduce((total, node) => total + node.proposal.parents.length, 0),
        evaluations: totalVisits,
      },
      selected: selected.map(({ score, ...item }) => ({
        ...item,
        searchScore: policy === "linear" || !Number.isFinite(score) ? null : score,
        reason: policy === "linear" ? "incumbent" : Number.isFinite(score) ? "ucb" : "unvisited",
      })),
    },
    null,
    2,
  )}\n`,
)
