/**
 * Offline helpers for `lab.cjs suite`: the plan, the notification-channel budget
 * and the summary table. No network access here — lab.cjs owns the live parts
 * (preflight, scenario runner, assess) so these stay unit-testable.
 */
const fs = require('fs')
const path = require('path')
const { parseRunDirName, CHANNEL_RE } = require('./assess.cjs')

const DEFAULT_SUITE = ['S2.1', 'S2.5', 'S3.1', 'S3.2', 'S4.6', 'S5.1', 'S6.1']

/** Genesys creates at most 20 notification channels per user per OAuth app per 24 h (F-22). */
const CHANNEL_CAP = 20
const CHANNEL_WARN_AT = 15

/** Count POST /api/v2/notifications/channels (2xx) in one run's app-network.json (0 when absent). */
const channelsCreatedIn = (runDir) => {
  try {
    const net = JSON.parse(fs.readFileSync(path.join(runDir, 'app-network.json'), 'utf8'))
    return net.filter((e) => e.method === 'POST' && CHANNEL_RE.test(e.url ?? '') && e.status >= 200 && e.status < 300).length
  } catch {
    return 0
  }
}

/**
 * Running total of channels created by run dirs dated `day` (YYYY-MM-DD, UTC).
 * Only run dirs are counted — channels created by other tools (get-token, manual
 * sessions) are invisible here, so treat the total as a lower bound.
 */
const channelBudget = (runsRoot, day = new Date().toISOString().slice(0, 10)) => {
  const dirs = fs.existsSync(runsRoot) ? fs.readdirSync(runsRoot) : []
  const todays = dirs.filter((n) => parseRunDirName(n)?.startedAt?.startsWith(day))
  const perRun = todays.map((n) => ({ run: n, channels: channelsCreatedIn(path.join(runsRoot, n)) }))
  const total = perRun.reduce((s, r) => s + r.channels, 0)
  return { day, total, cap: CHANNEL_CAP, warnAt: CHANNEL_WARN_AT, perRun, level: total >= CHANNEL_CAP ? 'cap-reached' : total >= CHANNEL_WARN_AT ? 'approaching' : 'ok' }
}

const budgetMessage = (b) => {
  if (b.level === 'cap-reached') return `channel budget: ${b.total}/${b.cap} created today by run dirs — CAP REACHED; new channels evict the oldest idle one and the app goes deaf (F-22). Stop and wait for the 24 h expiry.`
  if (b.level === 'approaching') return `channel budget: ${b.total}/${b.cap} created today — approaching the per-user-per-app cap (F-22); each --video run burns ~1-2.`
  return `channel budget: ${b.total}/${b.cap} created today by run dirs`
}

const parseSuiteArgs = (args) => {
  const flags = new Set(args.filter((a) => a.startsWith('--')))
  const pauseIdx = args.indexOf('--pause')
  const awIdx = args.indexOf('--alert-wait')
  const ids = args.filter((a, i) => !a.startsWith('--') && i !== pauseIdx + 1 && i !== awIdx + 1)
  return {
    ids: ids.length > 0 ? ids : [...DEFAULT_SUITE],
    withVideo: flags.has('--video'),
    headless: flags.has('--headless'),
    dryRun: flags.has('--dry-run'),
    pauseSec: pauseIdx >= 0 ? Number(args[pauseIdx + 1]) : 20,
    alertWaitSec: awIdx >= 0 ? Number(args[awIdx + 1]) : 120
  }
}

const planSuite = (opts, { runsRoot, knownScenarios }) => {
  const unknown = opts.ids.filter((id) => !knownScenarios.includes(id))
  const budget = channelBudget(runsRoot)
  const perRunChannels = opts.withVideo ? 1 : 0
  return {
    ids: opts.ids,
    unknown,
    withVideo: opts.withVideo,
    headless: opts.headless,
    pauseSec: opts.pauseSec,
    budget,
    projectedTotal: budget.total + opts.ids.length * perRunChannels,
    steps: opts.ids.map((id, i) => ({ order: i + 1, id, preflight: true, pauseBeforeSec: i === 0 ? 0 : opts.pauseSec, assess: true, unvalidated: /^S7\./.test(id) }))
  }
}

const renderPlan = (plan) => {
  const lines = [
    `suite plan: ${plan.ids.join(' ')} (${plan.withVideo ? '--video' : 'no video'}${plan.headless ? ', --headless' : ''}; pause ${plan.pauseSec} s + preflight between scenarios)`,
    budgetMessage(plan.budget),
    `projected after this suite: ~${plan.projectedTotal}/${plan.budget.cap} channels today`,
    ...(plan.unknown.length > 0 ? [`UNKNOWN scenario ids (will abort): ${plan.unknown.join(' ')}`] : []),
    ...plan.steps.map((s) => `  ${s.order}. ${s.id}${s.unvalidated ? ' [UNVALIDATED scenario]' : ''}: preflight -> scenario -> assess${s.pauseBeforeSec > 0 ? ` (after ${s.pauseBeforeSec} s pause)` : ''}`)
  ]
  if (!plan.withVideo) lines.push('note: without --video the app under test is not attached; every scenario except S4.0 assesses INCONCLUSIVE')
  return lines.join('\n')
}

const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n)
const renderSuiteTable = (results) => {
  const lines = [`${pad('#', 3)} ${pad('scenario', 9)} ${pad('verdict', 13)} ${pad('chan', 5)} ${pad('run dir', 34)} failing checks / error`, '-'.repeat(110)]
  results.forEach((r, i) => {
    const fails = (r.report?.checks ?? []).filter((c) => c.level === 'fail' && c.ok === false).map((c) => c.id).join(', ')
    lines.push(`${pad(i + 1, 3)} ${pad(r.id, 9)} ${pad(r.verdict ?? 'ERROR', 13)} ${pad(r.channels ?? '-', 5)} ${pad(r.runDir != null ? path.basename(r.runDir) : '-', 34)} ${(r.error ?? fails).slice(0, 60)}`)
  })
  return lines.join('\n')
}

module.exports = { DEFAULT_SUITE, CHANNEL_CAP, CHANNEL_WARN_AT, channelsCreatedIn, channelBudget, budgetMessage, parseSuiteArgs, planSuite, renderPlan, renderSuiteTable }
