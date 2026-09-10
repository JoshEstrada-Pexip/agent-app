/**
 * Offline unit tests for the run-package assessor and the suite planner.
 *   node --test 'tools/lab/*.test.cjs'   (Node 26: pass a glob, not a directory)
 * Real run dirs under tools/lab/runs/ are gitignored; those cases skip when absent.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const assess = require('./assess.cjs')
const suite = require('./suite.cjs')
const s7 = require('./scenarios/s7.cjs')

const RUNS = path.join(__dirname, 'runs')
const runDir = (name) => path.join(RUNS, name)
const skipUnless = (t, name) => {
  if (!fs.existsSync(runDir(name))) {
    t.skip(`run dir ${name} not present`)
    return false
  }
  return true
}
const byId = (report, id) => report.checks.find((c) => c.id === id)

// ---------------------------------------------------------------- pure helpers
test('parseRunDirName derives scenario id and ISO timestamp', () => {
  assert.deepEqual(assess.parseRunDirName('S2_1-2026-09-03T18-31-09-302Z'), { scenario: 'S2.1', startedAt: '2026-09-03T18:31:09.302Z' })
  assert.deepEqual(assess.parseRunDirName('S0-2026-08-29T01-16-51-677Z'), { scenario: 'S0', startedAt: '2026-08-29T01:16:51.677Z' })
  assert.equal(assess.parseRunDirName('bootstrap-2026-09-03T18-17-40-171Z'), null)
  assert.equal(assess.parseRunDirName('suite-2026-09-08T10-00-00-000Z.json'), null)
})

test('verdictOf: fail-level checks decide; warn/info never do', () => {
  const ok = { level: 'fail', ok: true }
  assert.equal(assess.verdictOf([ok, { level: 'warn', ok: false }, { level: 'info', ok: null }]), 'PASS')
  assert.equal(assess.verdictOf([ok, { level: 'fail', ok: false }]), 'FAIL')
  assert.equal(assess.verdictOf([ok, { level: 'fail', ok: null }]), 'INCONCLUSIVE')
  assert.equal(assess.verdictOf([ok, { level: 'fail', ok: null }, { level: 'fail', ok: false }]), 'FAIL')
  assert.equal(assess.verdictOf([]), 'INCONCLUSIVE')
})

test('micMutePolicyAt reflects the policy history', () => {
  assert.equal(assess.micMutePolicyAt('2026-08-28T19:57:37.213Z').policy, 'mic-only')
  assert.equal(assess.micMutePolicyAt('2026-08-31T18:04:24.785Z').policy, 'coupled')
  assert.equal(assess.micMutePolicyAt('2026-09-03T18:33:41.462Z').policy, 'mic-only')
})

test('wireDelta on a synthetic package: dark vs live, missing sample', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-assess-'))
  const w = (label, bytes, ts) => fs.writeFileSync(path.join(dir, `webrtc-${label}.json`), JSON.stringify([{ connState: 'connected', bytesSent: bytes, ts }]))
  w('a', 1000, 1000000)
  w('b', 1000, 1004000)
  w('c', 201000, 1008000)
  fs.writeFileSync(path.join(dir, 'actions.json'), '[]')
  const run = assess.loadRun(dir)
  const dark = assess.wireDelta(run, 'a', 'b')
  assert.equal(dark.deltaBytes, 0)
  assert.equal(dark.kbps, 0)
  const live = assess.wireDelta(run, 'b', 'c')
  assert.equal(live.kbps, 400) // 200000 B * 8 / 4000 ms
  assert.equal(assess.wireDelta(run, 'c', 'nope').ok, null)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('loadRun filters the cumulative capture down to this conversation and drops heartbeats', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-assess-'))
  const session = (conv, t) => ({
    startedAt: t,
    entries: [
      { seq: 0, t, kind: 'page-load', data: {} },
      { seq: 1, t, kind: 'context', data: { userId: 'u', conversationId: conv } },
      { seq: 2, t, kind: 'ws-event', data: { topicName: 'channel.metadata', eventBody: { message: 'WebSocket Heartbeat' } } },
      { seq: 3, t, kind: 'ws-event', data: { topicName: 'v2.users.u.conversations.calls', eventBody: { id: conv, participants: [] } } }
    ]
  })
  fs.writeFileSync(path.join(dir, 'actions.json'), JSON.stringify([{ t: '2026-09-08T10:00:00.000Z', action: 'agent-connected', detail: { conversationId: 'mine', state: 'connected' } }]))
  fs.writeFileSync(path.join(dir, 'app-capture.json'), JSON.stringify([session('older', '2026-09-01T00:00:00.000Z'), session('mine', '2026-09-08T10:00:01.000Z')]))
  const run = assess.loadRun(dir)
  assert.equal(run.captureSessions.length, 2)
  assert.equal(run.runSessions.length, 1)
  assert.equal(run.captureEvents.length, 1)
  assert.equal(run.heartbeats, 1)
  fs.rmSync(dir, { recursive: true, force: true })
})

// ------------------------------------------------------------ real run dirs
test('documented PASS run: S2.1 2026-09-03 (hold privacy) assesses PASS with sub-second mute', (t) => {
  const name = 'S2_1-2026-09-03T18-31-09-302Z'
  if (!skipUnless(t, name)) return
  const r = assess.assessRun(runDir(name), { write: false })
  assert.equal(r.verdict, 'PASS', JSON.stringify(r.checks.filter((c) => c.ok !== true), null, 1))
  assert.equal(byId(r, 'wire.hold-2s->hold-6s').ok, true)
  assert.equal(byId(r, 'wire.unhold-3s->unhold-6s').ok, true)
  assert.match(byId(r, 'hold.event-to-mute').actual, /^\d{1,3} ms after event/)
  assert.equal(byId(r, 'app.no-foreign-events').ok, true)
  assert.equal(byId(r, 'pexip.single-agent-leg@after-video-join').ok, true)
  // The harness closes the page before teardown: the F-08 ghost is a warning, never a verdict.
  assert.equal(byId(r, 'pexip.teardown-vmr-gone').level, 'warn')
})

test('original-app baseline: S2.1 2026-08-28 flips to FAIL on the 1 s hold timer (F-02)', (t) => {
  const name = 'S2_1-2026-08-28T19-16-39-409Z'
  if (!skipUnless(t, name)) return
  const r = assess.assessRun(runDir(name), { write: false })
  assert.equal(r.verdict, 'FAIL')
  const lat = byId(r, 'hold.event-to-mute')
  assert.equal(lat.ok, false)
  assert.match(lat.actual, /^1[0-9]{3} ms after event/)
  // the wire itself was fine on the original (F-02): dark by +2 s
  assert.equal(byId(r, 'wire.hold-2s->hold-6s').ok, true)
})

test('S6.1 customer hang-up: 1 agent leg PASSes, 2 legs FAIL on teardown (F-24)', (t) => {
  const good = 'S6_1-2026-09-03T18-44-03-734Z'
  const bad = 'S6_1-2026-09-03T18-38-36-313Z'
  if (!skipUnless(t, good) || !skipUnless(t, bad)) return
  const g = assess.assessRun(runDir(good), { write: false })
  assert.equal(g.verdict, 'PASS', JSON.stringify(g.checks.filter((c) => c.ok !== true), null, 1))
  assert.equal(byId(g, 'ui.call-ended-pane').ok, true)
  assert.equal(byId(g, 'teardown.app-disconnect').ok, true)
  const b = assess.assessRun(runDir(bad), { write: false })
  assert.equal(b.verdict, 'FAIL')
  assert.equal(byId(b, 'pexip.teardown-vmr-gone').ok, false)
  assert.equal(byId(b, 'pexip.teardown-vmr-gone').level, 'fail')
  assert.equal(byId(b, 'ui.call-ended-pane').ok, false)
})

test('S5.1 socket kill: fixed app PASSes (fail-safe mute + reconnect), original FAILs', (t) => {
  const fixed = 'S5_1-2026-08-31T18-12-37-399Z'
  const orig = 'S5_1-2026-08-29T01-10-12-661Z'
  if (!skipUnless(t, fixed) || !skipUnless(t, orig)) return
  const f = assess.assessRun(runDir(fixed), { write: false })
  assert.equal(f.verdict, 'PASS', JSON.stringify(f.checks.filter((c) => c.ok !== true), null, 1))
  assert.equal(byId(f, 'failsafe.mute-on-socket-loss').ok, true)
  assert.equal(byId(f, 'failsafe.reconnect').ok, true)
  const o = assess.assessRun(runDir(orig), { write: false })
  assert.equal(o.verdict, 'FAIL')
  assert.equal(byId(o, 'failsafe.connection-lost-logged').ok, false)
  assert.equal(byId(o, 'wire.held-4s-socket-dead->held-10s-socket-dead').ok, false)
})

test('run where the app never joined (MFA bounce) is INCONCLUSIVE, not FAIL', (t) => {
  const name = 'S1_1-2026-08-31T18-52-21-814Z'
  if (!skipUnless(t, name)) return
  const r = assess.assessRun(runDir(name), { write: false })
  assert.equal(r.verdict, 'INCONCLUSIVE')
  assert.equal(byId(r, 'app.joined').ok, null)
})

test('S7.2 reload (live 2026-09-08): PASS, the new instance kicked its older leg by +4 s', (t) => {
  const name = 'S7_2-2026-09-08T19-12-30-069Z'
  if (!skipUnless(t, name)) return
  const r = assess.assessRun(runDir(name), { write: false })
  assert.equal(r.verdict, 'PASS', JSON.stringify(r.checks.filter((c) => c.ok !== true), null, 1))
  assert.equal(byId(r, 's72.agent-legs@+10s').ok, true)
  assert.equal(byId(r, 's72.kick-result-logged').ok, true)
  assert.match(byId(r, 's72.ghost-survival').actual, /2s:2 4s:1/)
})

test('S7.3 duplicate instance (live 2026-09-08): fixed-app semantics PASS, original semantics FAIL, stale VMR only a warning', (t) => {
  const name = 'S7_3-2026-09-08T19-14-51-877Z'
  if (!skipUnless(t, name)) return
  const r = assess.assessRun(runDir(name), { write: false })
  assert.equal(r.verdict, 'PASS', JSON.stringify(r.checks.filter((c) => c.ok !== true), null, 1))
  assert.equal(byId(r, 's73.legs-never-exceed-two').ok, true)
  assert.equal(byId(r, 's73.single-leg-at-end').ok, true)
  assert.equal(byId(r, 's73.takeover-logged').ok, true) // legacy duplicate-leg-evicted accepted
  assert.equal(byId(r, 's73.older-instance-passive-or-video').ok, true)
  assert.equal(byId(r, 'ui.call-ended-pane').ok, true)
  assert.equal(byId(r, 'teardown.app-disconnect').ok, true)
  assert.equal(byId(r, 'pexip.teardown-vmr-gone').ok, true) // scoped to the run VMR; the S7.2 ghost is elsewhere
  assert.equal(byId(r, 'pexip.stale-conferences').level, 'warn')
  assert.equal(byId(r, 'app.http-errors'), undefined) // evicted instance's release_token 403 is allowlisted (superseded)
  const o = assess.assessRun(runDir(name), { write: false, s73Mode: 'original' })
  assert.equal(o.verdict, 'FAIL')
  assert.equal(byId(o, 's73.precondition-two-legs').ok, false)
})

test('S7.1 miss-then-answer (live 2026-09-08): fixed app PASSes; unscoped workspace noise is warning-only', (t) => {
  const name = 'S7_1-2026-09-08T19-18-29-913Z'
  if (!skipUnless(t, name)) return
  const r = assess.assessRun(runDir(name), { write: false })
  assert.equal(r.verdict, 'PASS', JSON.stringify(r.checks.filter((c) => c.ok !== true), null, 1))
  assert.equal(byId(r, 's71.single-agent-leg').ok, true)
  assert.equal(byId(r, 's71.single-widget-frame').ok, true)
  assert.equal(byId(r, 's71.alert-pane').ok, true)
  assert.equal(byId(r, 'pexip.teardown-vmr-gone').ok, true)
  assert.equal(byId(r, 'pexip.teardown-vmr-gone').level, 'fail') // the app must end the call itself in S7.1
  assert.equal(byId(r, 'app.no-uncaught-errors').level, 'warn') // recorded before src/frame scoping existed
  assert.match(byId(r, 's71.missed-leg-disconnectType').actual, /terminated\/client/)
})

test('S7.4 workspace probe (live 2026-09-08): fixed build PASSes, root-cause run FAILs on two request_token + VMR still up', (t) => {
  const good = fs.existsSync(RUNS) ? fs.readdirSync(RUNS).find((n) => n.startsWith('S7_4-2026-09-08T20-50-')) : null
  const bad = 'S7_4-2026-09-08T20-45-39-076Z'
  if (good == null || !skipUnless(t, bad)) {
    t.skip('S7.4 run dirs not present')
    return
  }
  const g = assess.assessRun(runDir(good), { write: false })
  assert.equal(g.verdict, 'PASS', JSON.stringify(g.checks.filter((c) => c.ok !== true), null, 1))
  assert.match(byId(g, 's74.request-token-per-instance').actual, /^1 request_token, 1 instance/)
  assert.equal(byId(g, 's74.join-suppressed').actual.includes('"joinSuppressed":true'), true)
  assert.equal(byId(g, 's74.single-leg-single-frame').ok, true)
  assert.equal(byId(g, 's74.vmr-gone-after-agent-hangup').ok, true)
  const b = assess.assessRun(runDir(bad), { write: false })
  assert.equal(b.verdict, 'FAIL')
  assert.equal(byId(b, 's74.request-token-per-instance').ok, false)
  assert.match(byId(b, 's74.request-token-per-instance').actual, /^3 request_token, 1 instance/)
  assert.equal(byId(b, 's74.vmr-gone-after-agent-hangup').ok, false)
  assert.equal(byId(b, 'pexip.teardown-vmr-gone').ok, false)
  assert.equal(byId(b, 's74.self-superseded').level, 'warn')
})

test('s7 helpers: leg counting is scoped to the run VMR; sessionIds and channels are widget-scoped', () => {
  const px = {
    conferences: [{ name: 'live' }, { name: 'stale' }],
    participants: [
      { protocol: 'WebRTC', conference: 'live' },
      { protocol: 'WebRTC', conference: 'stale' },
      { protocol: 'SIP', conference: 'live', vendor: 'TANDBERG/529 Cisco-RoomKit' },
      { protocol: 'SIP', conference: 'live', vendor: 'GENESYS-SIPSERVICE/9831' }
    ]
  }
  assert.equal(s7.helpers.vmrOf(px), 'live')
  assert.equal(s7.helpers.agentLegCount(px, 'live'), 1)
  assert.equal(s7.helpers.agentLegCount(px, null), 2)
  const con = [
    { text: '{"category":"pexip","event":"x","sessionId":"aaa"}', src: 'https://x/agent-app/assets/i.js' },
    { text: '{"category":"pexip","event":"x","sessionId":"bbb"}', src: 'https://apps.usw2.pure.cloud/hub.js' },
    { text: 'plain', src: 'https://x/agent-app/assets/i.js' }
  ]
  assert.deepEqual([...s7.helpers.sessionIdsOf(con)], ['aaa'])
  const page = {
    networkLog: [
      { method: 'POST', url: 'https://api.usw2.pure.cloud/api/v2/notifications/channels', status: 200, frame: 'https://apps.usw2.pure.cloud/' },
      { method: 'POST', url: 'https://api.usw2.pure.cloud/api/v2/notifications/channels', status: 200, frame: 'https://x/agent-app/' },
      { method: 'POST', url: 'https://node/api/client/v2/conferences/app_v/request_token', status: 200, frame: 'https://x/agent-app/' }
    ],
    consoleLog: con
  }
  const t = s7.helpers.telemetry(page)
  assert.equal(t.channelsCreated, 1)
  assert.equal(t.requestTokens, 1)
  assert.equal(t.captureInstances, 1)
  assert.equal(t.channelsScope, 'widget frame')
  assert.deepEqual(Object.keys(s7.flows).sort(), ['S7.1', 'S7.4'])
})

test('event-name compatibility: current Web Lock names and legacy names both satisfy the S7 checks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-assess-'))
  const run = path.join(dir, 'S7_2-2026-09-09T10-00-00-000Z')
  fs.mkdirSync(run)
  const line = (event, extra = {}) => ({ t: '2026-09-09T10:00:05.000Z', type: 'log', text: JSON.stringify({ category: 'pexip', event, sessionId: 's1', ...extra }) })
  fs.writeFileSync(path.join(run, 'actions.json'), JSON.stringify([{ t: '2026-09-09T10:00:00.000Z', action: 'agent-connected', detail: { conversationId: 'c', state: 'connected' } }, { t: '2026-09-09T10:00:01.000Z', action: 'app-state-after-join', detail: { selfview: true, found: [] } }]))
  fs.writeFileSync(path.join(run, 's72-summary.json'), JSON.stringify({ legsTimeline: [{ at: 2, legs: 2 }, { at: 4, legs: 1 }], ghostSurvivedS: 4 }))
  fs.writeFileSync(path.join(run, 'app-console.json'), JSON.stringify([line('ghost-leg-kicked', { data: { status: 200 } })]))
  const r1 = assess.assessRun(run, { write: false })
  assert.equal(r1.checks.find((c) => c.id === 's72.kick-result-logged').ok, true)
  fs.writeFileSync(path.join(run, 'app-console.json'), JSON.stringify([line('duplicate-leg-kick-result', { data: { status: 200 } })]))
  assert.equal(assess.assessRun(run, { write: false }).checks.find((c) => c.id === 's72.kick-result-logged').ok, true)
  fs.writeFileSync(path.join(run, 'app-console.json'), JSON.stringify([line('ghost-leg-kicked', { data: { status: 500 } })]))
  assert.equal(assess.assessRun(run, { write: false }).checks.find((c) => c.id === 's72.kick-result-logged').ok, false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('assessRun with write:false leaves the run dir untouched', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-assess-'))
  const run = path.join(dir, 'S2_1-2026-09-08T10-00-00-000Z')
  fs.mkdirSync(run)
  fs.writeFileSync(path.join(run, 'actions.json'), '[]')
  const r = assess.assessRun(run, { write: false })
  assert.equal(r.verdict, 'INCONCLUSIVE')
  assert.deepEqual(fs.readdirSync(run), ['actions.json'])
  assess.assessRun(run, { write: true })
  assert.deepEqual(fs.readdirSync(run).sort(), ['actions.json', 'report.json', 'report.md'])
  fs.rmSync(dir, { recursive: true, force: true })
})

test('assessAll skips non-scenario dirs and renders a table', (t) => {
  if (!fs.existsSync(RUNS)) {
    t.skip('no runs dir')
    return
  }
  const rows = assess.assessAll(RUNS, { write: false, filter: 'S6_1' })
  assert.ok(rows.length >= 1)
  assert.ok(rows.every((r) => r.scenario === 'S6.1'))
  const table = assess.renderTable(rows)
  assert.match(table, /verdict/)
  assert.match(table, /S6_1-/)
})

// ------------------------------------------------------------------ suite
test('parseSuiteArgs: defaults, ids, flags, pause', () => {
  const d = suite.parseSuiteArgs([])
  assert.deepEqual(d.ids, suite.DEFAULT_SUITE)
  assert.equal(d.withVideo, false)
  assert.equal(d.dryRun, false)
  assert.equal(d.pauseSec, 20)
  const c = suite.parseSuiteArgs(['--video', '--dry-run', '--pause', '5', '--alert-wait', '60', 'S2.1', 'S7.1'])
  assert.deepEqual(c.ids, ['S2.1', 'S7.1'])
  assert.equal(c.alertWaitSec, 60)
  assert.equal(c.withVideo, true)
  assert.equal(c.dryRun, true)
  assert.equal(c.pauseSec, 5)
})

test('planSuite flags unknown ids, marks S7.x unvalidated, and projects the channel budget', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-suite-'))
  const today = new Date().toISOString().slice(0, 10)
  const mk = (name, channels) => {
    fs.mkdirSync(path.join(root, name))
    const net = Array.from({ length: channels }, (_, i) => ({ t: `${today}T10:00:0${i}.000Z`, method: 'POST', url: 'https://api.usw2.pure.cloud/api/v2/notifications/channels', status: 200 }))
    net.push({ t: `${today}T10:00:09.000Z`, method: 'POST', url: 'https://api.usw2.pure.cloud/api/v2/notifications/channels/x/subscriptions', status: 200 })
    fs.writeFileSync(path.join(root, name, 'app-network.json'), JSON.stringify(net))
  }
  mk(`S2_1-${today}T10-00-00-000Z`, 2)
  mk(`S5_1-${today}T10-05-00-000Z`, 12)
  mk('S2_1-2026-01-01T10-00-00-000Z', 9) // another day: not counted
  const budget = suite.channelBudget(root)
  assert.equal(budget.total, 14)
  assert.equal(budget.level, 'ok')
  const plan = suite.planSuite(suite.parseSuiteArgs(['--video', 'S2.1', 'S7.2', 'S9.9']), { runsRoot: root, knownScenarios: ['S2.1', 'S7.2'] })
  assert.deepEqual(plan.unknown, ['S9.9'])
  assert.equal(plan.steps[1].unvalidated, true)
  assert.equal(plan.projectedTotal, 17)
  const text = suite.renderPlan(plan)
  assert.match(text, /UNKNOWN scenario ids/)
  assert.match(text, /S7\.2 \[UNVALIDATED scenario\]/)
  mk(`S6_1-${today}T10-10-00-000Z`, 6)
  assert.equal(suite.channelBudget(root).level, 'cap-reached')
  assert.match(suite.budgetMessage(suite.channelBudget(root)), /CAP REACHED/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('renderSuiteTable lists verdicts and the stopping error', () => {
  const table = suite.renderSuiteTable([
    { id: 'S2.1', runDir: '/x/S2_1-2026-09-08T10-00-00-000Z', verdict: 'PASS', channels: 1, report: { checks: [] } },
    { id: 'S2.5', verdict: 'ERROR', error: 'preflight never became clean before S2.5' }
  ])
  assert.match(table, /S2\.1 +PASS/)
  assert.match(table, /preflight never became clean/)
})
