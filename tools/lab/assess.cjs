/**
 * Offline, deterministic assessment of a lab run package (tools/lab/runs/<ID>-<ts>/).
 *
 *   node tools/lab/lab.cjs assess <runDir>          -> <runDir>/report.json + report.md
 *   node tools/lab/lab.cjs assess-all [--no-write]  -> table over every scenario run dir
 *
 * Zero dependencies. Reads only files inside the run dir. Every check records the
 * file it was derived from (`evidence`) so a reader can verify it by hand.
 *
 * Check levels:
 *   fail  - verdict-bearing. ok=false -> FAIL, ok=null -> INCONCLUSIVE.
 *   warn  - reported, never changes the verdict (known harness artifacts, F-08/F-22/F-23).
 *   info  - measurement only.
 *
 * ASSUMPTIONS ABOUT ARTIFACT FIELDS (verified against the 2026-08-28..09-03 runs):
 *   - actions.json: [{t, action, detail}]; 'agent-connected'.detail.conversationId is the
 *     run's conversation; 'actor'.detail.name is the agent's display name; 'step' entries
 *     carry the harness command timestamps (logged immediately BEFORE the API call).
 *   - genesys-timeline.json: [{t, snap:[{purpose,name,state,held,muted,confined,consult}]}].
 *     The customer participant's `name` equals the Pexip VMR name (F-01).
 *   - pexip-*.json: {conferences:[{name,started,tag}], participants:[{conference,displayName,
 *     protocol('WebRTC'|'SIP'),role,direction,hasMedia,txBandwidth,rxBandwidth,vendor,id}]}.
 *     An "agent leg" is protocol==='WebRTC' inside the run's VMR.
 *   - webrtc-<label>.json: [{connState,bytesSent,packetsSent,framesEncoded,ts(ms epoch)}]
 *     one entry per RTCPeerConnection of the app page; [] when no PC exists (page reloaded
 *     or leg torn down). Bitrate = delta bytesSent between two labelled samples.
 *   - app-network.json: [{t,method,url,status,body?}] responses seen by the app page.
 *     Pexip client-API calls carry the join alias: /conferences/app_<vmr>/...; the video
 *     privacy actions are POST .../video_muted and .../video_unmuted; the VMR teardown is
 *     POST /conferences/<alias>/disconnect; joins are POST .../participants/<id>/calls.
 *   - app-console.json: [{t,type('log'|'error'|'warning'|...),text}] — the fixed app logs
 *     structured JSON lines {"category","event",...} (failsafe/video-muted, media/video-restored,
 *     genesys/mic-muted, failsafe/connection-lost, ...).
 *   - app-capture.json: ARRAY OF SESSIONS accumulated in localStorage across ALL runs since
 *     2026-08-28 (not just this run). Filter sessions by their `context` entry's
 *     conversationId. Entries key on `kind` (page-load|context|channel-created|
 *     subscription-added|ws-open|ws-event|console-error|unhandled-rejection|ws-close);
 *     ws-event heartbeats have topicName 'channel.metadata' and must be dropped.
 *   - cisco-*.json: {calls:[{status,...}]|{error}, mediaChannels:[{type,direction,bytes,channelRate}]}.
 *   - cisco-after-teardown.json is written by harness versions >= 2026-09-08 only.
 */
const fs = require('fs')
const path = require('path')

// The phone-host tab started blocking the embedded production widget at this
// time (F-23). Before it, a second/third agent WebRTC leg is a known harness
// artifact (F-22 double load, F-23 workspace widget) and is reported as WARN;
// from here on it is a verdict-bearing FAIL.
const F23_BLOCK_AT = '2026-09-03T18:44:00.000Z'

/** Audio-mute -> video policy in force on the run date (fixes.md / lab-findings). */
const micMutePolicyAt = (iso) => {
  if (iso < '2026-08-30T00:00:00Z') return { policy: 'mic-only', note: 'original app: audio mute never touched video (F-11)' }
  if (iso < '2026-09-03T00:00:00Z') return { policy: 'coupled', note: 'PR-1 coupling policy (decided 2026-08-29), reversed 2026-09-03' }
  return { policy: 'mic-only', note: 'mic-only policy since 2026-09-03' }
}

const BENIGN_CONSOLE_ERRORS = [
  /^Failed to load resource: the server responded with a status of \d+/, // resource-load noise (the URL is not in the text; HTTP errors are checked from app-network.json instead)
  /^Can't request theme\./, // Pexip theme/ 404 wording
  /^Conference connection already in progress/, // F-03 guard noise (counted separately)
  /^\{"category":/ // the app's own structured log lines (failsafe/* are logged at level error on purpose)
]
const BENIGN_HTTP_ERRORS = [/\/theme\/$/]

// Structured console event names: current design (Web Lock per conversation,
// call-tag ghost kick) and the legacy names from the 2026-09-08 morning builds.
const EV = {
  passive: /^(passive|leg-owned-elsewhere|superseded|duplicate-leg-evicted|leg-dropped|video-leg-dropped)$/, // this instance yielded / never joined
  takeover: /^(auto-takeover|leg-owned-elsewhere|duplicate-leg-evicted)$/, // an instance took (or found) the leg elsewhere
  kicked: /^(ghost-leg-kicked|duplicate-leg-kick-result)$/, // a stale leg of this agent was kicked after join
  yielded: /^(superseded|passive|leg-dropped|leg-owned-elsewhere)$/ // the older instance announced it lost the leg
}
const hasEvent = (structured, re) => structured.some((e) => re.test(e.event ?? ''))
const PASSIVE_PANE = /another window|connecting video in this window|superseded/i
const parseStructuredLines = (log) =>
  (log ?? [])
    .map((e) => {
      if (typeof e.text !== 'string' || !e.text.startsWith('{"category"')) return null
      try {
        return { t: e.t, ...JSON.parse(e.text) }
      } catch {
        return null
      }
    })
    .filter(Boolean)

const DARK_KBPS = 10 // <= this over a sample window counts as "no video on the wire"
const LIVE_KBPS = 50 // >= this counts as video flowing

const RUN_DIR_RE = /^(S\d+(?:_\d+)?)-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/

const parseRunDirName = (name) => {
  const m = RUN_DIR_RE.exec(name)
  if (m == null) return null
  return { scenario: m[1].replace('_', '.'), startedAt: `${m[2]}T${m[3]}:${m[4]}:${m[5]}.${m[6]}Z` }
}

const ms = (iso) => (iso == null ? NaN : Date.parse(iso))

// --------------------------------------------------------------------------
// Run package loader
// --------------------------------------------------------------------------
const loadRun = (dir) => {
  const abs = path.resolve(dir)
  const name = path.basename(abs)
  const meta = parseRunDirName(name)
  const cache = {}
  const has = (f) => fs.existsSync(path.join(abs, f))
  const json = (f) => {
    if (f in cache) return cache[f]
    try {
      cache[f] = JSON.parse(fs.readFileSync(path.join(abs, f), 'utf8'))
    } catch {
      cache[f] = null
    }
    return cache[f]
  }
  const files = fs.existsSync(abs) ? fs.readdirSync(abs).sort() : []
  const actions = json('actions.json') ?? []
  const action = (name) => actions.find((a) => a.action === name) ?? null
  const actionsNamed = (name) => actions.filter((a) => a.action === name)
  const step = (re) => actions.find((a) => a.action === 'step' && re.test(String(a.detail))) ?? null
  const connected = action('agent-connected')?.detail ?? null
  const conversationId = connected?.conversationId ?? null
  const agentName = action('actor')?.detail?.name ?? null
  const agentUserId = action('actor')?.detail?.id ?? null
  const timeline = json('genesys-timeline.json') ?? []
  // S7.1 instruments the whole Genesys workspace page (embedded widget under
  // test). When the entries carry `src`/`frame` (harness >= 2026-09-08 19:40)
  // scope them to the widget; otherwise the console/network hygiene checks are
  // downgraded to warnings (workspace noise is not the app's).
  const embedded = action('phone-host-ready')?.detail?.embedded === true
  const rawNetwork = json('app-network.json') ?? []
  const rawConsole = json('app-console.json') ?? []
  const widgetScoped = embedded && (rawConsole.some((e) => e.src != null) || rawNetwork.some((e) => e.frame != null))
  const network = widgetScoped ? rawNetwork.filter((e) => e.frame == null || /agent-app/i.test(e.frame)) : rawNetwork
  const consoleLog = widgetScoped ? rawConsole.filter((e) => e.src == null || /agent-app/i.test(e.src)) : rawConsole
  const withVideo = has('app-console.json') || action('app-state-after-join') != null
  // Embedded-widget probes (S7.4 runs before the flow logged app-state-after-join)
  // synthesize the join state from the first probe: a widget iframe existed.
  const firstProbe = actions.find((a) => /^probe-/.test(a.action)) ?? null
  const joinState = action('app-state-after-join')?.detail ?? (firstProbe != null ? { selfview: (firstProbe.detail?.widgetFrames ?? 0) >= 1, found: [], synthesizedFrom: firstProbe.action } : null)
  const appJoined = withVideo && joinState != null && joinState.timeout !== true && joinState.selfview === true
  // Steps that make Genesys emit conversation events (S2.4 reload-only runs emit none).
  const expectsEvents = actions.some((a) => a.action === 'step' && /hold|mute|consult|transfer|hangup|hangs up|round/i.test(String(a.detail)))

  // The run's VMR: customer aniName == VMR name (F-01); fall back to the app's join
  // alias in the network log, then to the conference holding the Cisco SIP leg.
  let callConf = timeline[0]?.snap?.find((p) => p.purpose === 'customer')?.name ?? null
  if (callConf == null) {
    const m = network.map((e) => /\/conferences\/([^/]+)\//.exec(e.url ?? '')).find(Boolean)
    if (m != null) callConf = m[1].replace(/^app_/, '')
  }
  if (callConf == null) {
    for (const f of ['pexip-after-video-join.json', 'pexip-after-connect.json', 'pexip-after-steps.json']) {
      const cisco = (json(f)?.participants ?? []).find((p) => p.protocol === 'SIP' && !/GENESYS/i.test(p.vendor ?? ''))
      if (cisco != null) {
        callConf = cisco.conference
        break
      }
    }
  }

  // Capture sessions belonging to THIS run (the dump is cumulative across runs).
  const captureRaw = json('app-capture.json')
  const captureSessions = Array.isArray(captureRaw) ? captureRaw : []
  const t0 = ms(actions[0]?.t ?? meta?.startedAt) - 5000
  const t1 = ms(actions[actions.length - 1]?.t) + 60000
  const runSessions = captureSessions.filter((s) => {
    const ctx = (s.entries ?? []).find((e) => e.kind === 'context')
    if (ctx != null && conversationId != null) return ctx.data?.conversationId === conversationId
    const st = ms(s.startedAt)
    return conversationId == null && st >= t0 && st <= t1
  })
  const captureEvents = runSessions
    .flatMap((s) => s.entries ?? [])
    .filter((e) => e.kind === 'ws-event' && /conversations\.calls/.test(e.data?.topicName ?? ''))
    .sort((a, b) => ms(a.t) - ms(b.t))
  const heartbeats = runSessions.flatMap((s) => s.entries ?? []).filter((e) => e.kind === 'ws-event' && !/conversations\.calls/.test(e.data?.topicName ?? '')).length

  const structured = parseStructuredLines(consoleLog)

  return {
    dir: abs,
    name,
    scenario: meta?.scenario ?? null,
    startedAt: meta?.startedAt ?? actions[0]?.t ?? null,
    files,
    has,
    json,
    actions,
    action,
    actionsNamed,
    step,
    connected,
    conversationId,
    agentName,
    agentUserId,
    timeline,
    network,
    consoleLog,
    structured,
    withVideo,
    joinState,
    embedded,
    widgetScoped,
    appJoined,
    expectsEvents,
    callConf,
    captureSessions,
    runSessions,
    captureEvents,
    heartbeats
  }
}

// --------------------------------------------------------------------------
// Small analysis helpers (exported for tests and for ad-hoc scripts)
// --------------------------------------------------------------------------
const agentLegs = (snap, conf) =>
  (snap?.participants ?? []).filter((p) => p.protocol === 'WebRTC' && (conf == null || p.conference === conf))
const sipLegs = (snap, conf) =>
  (snap?.participants ?? []).filter((p) => p.protocol === 'SIP' && (conf == null || p.conference === conf))
const legSummary = (legs) => legs.map((p) => `${p.protocol}:${p.displayName ?? '?'}${p.hasMedia ? '+media' : '-media'}`)

/** Best single outbound-rtp sample from a webrtc-<label>.json array. */
const pickSample = (arr) => {
  if (!Array.isArray(arr) || arr.length === 0) return null
  return arr.reduce((best, s) => (best == null || (s.bytesSent ?? 0) > (best.bytesSent ?? 0) ? s : best), null)
}

/** Wire bitrate between two labelled samples of the same run. */
const wireDelta = (run, fromLabel, toLabel) => {
  const a = pickSample(run.json(`webrtc-${fromLabel}.json`))
  const b = pickSample(run.json(`webrtc-${toLabel}.json`))
  if (a == null || b == null) return { ok: null, deltaBytes: null, dtMs: null, kbps: null, missing: a == null ? fromLabel : toLabel }
  const deltaBytes = b.bytesSent - a.bytesSent
  const dtMs = b.ts - a.ts
  const kbps = dtMs > 0 ? Math.round((deltaBytes * 8) / dtMs) : null
  return { deltaBytes, dtMs, kbps }
}

const firstNetwork = (run, re, afterIso, { method = 'POST', okOnly = true } = {}) =>
  run.network.find(
    (e) => (method == null || e.method === method) && re.test(e.url ?? '') && (!okOnly || (e.status >= 200 && e.status < 300)) && (afterIso == null || ms(e.t) >= ms(afterIso))
  ) ?? null

const countNetwork = (run, re, { method = 'POST', fromIso = null, toIso = null } = {}) =>
  run.network.filter(
    (e) => e.method === method && re.test(e.url ?? '') && e.status >= 200 && e.status < 300 && (fromIso == null || ms(e.t) >= ms(fromIso)) && (toIso == null || ms(e.t) <= ms(toIso))
  ).length

const VIDEO_MUTED_RE = /\/video_muted$/
const VIDEO_UNMUTED_RE = /\/video_unmuted$/
const JOIN_RE = /\/participants\/[^/]+\/calls$/
const CHANNEL_RE = /\/api\/v2\/notifications\/channels$/

/** First captured calls-topic event after `afterIso` whose participants satisfy `pred`. */
const firstEvent = (run, afterIso, pred) =>
  run.captureEvents.find((e) => ms(e.t) >= ms(afterIso) && pred(e.data?.eventBody?.participants ?? [], e.data?.eventBody)) ?? null

// Raw ws-event agent participants carry user.id (no name); match on the actor id.
const isMyAgent = (run, p) => p.purpose === 'agent' && (run.agentUserId == null || p.user?.id === run.agentUserId || p.userId === run.agentUserId)
const agentHeld = (run) => (parts) => parts.some((p) => isMyAgent(run, p) && p.state === 'connected' && p.held === true)
const agentUnheld = (run) => (parts) => parts.some((p) => isMyAgent(run, p) && p.state === 'connected' && p.held === false)
const consultActive = () => (parts) => parts.some((p) => p.consultParticipantId != null)

/**
 * Command -> event -> privacy action latency.
 *   stepRe: which harness step starts the clock; pred: the event that should trigger
 *   the action; urlRe: the Pexip client-API call that proves the action landed.
 */
const latency = (run, stepRe, pred, urlRe) => {
  const st = run.step(stepRe)
  if (st == null) return { missing: 'step' }
  const evt = firstEvent(run, st.t, pred)
  const from = evt?.t ?? st.t
  const act = firstNetwork(run, urlRe, from)
  return {
    stepT: st.t,
    eventT: evt?.t ?? null,
    actionT: act?.t ?? null,
    cmdToActionMs: act != null ? ms(act.t) - ms(st.t) : null,
    eventToActionMs: act != null && evt != null ? ms(act.t) - ms(evt.t) : null,
    cmdToEventMs: evt != null ? ms(evt.t) - ms(st.t) : null
  }
}

// --------------------------------------------------------------------------
// Check collector
// --------------------------------------------------------------------------
const makeChecks = () => {
  const checks = []
  const notes = []
  const add = (id, { ok, level = 'fail', expected, actual, evidence, note }) => {
    checks.push({ id, ok, level, expected: String(expected ?? ''), actual: typeof actual === 'string' ? actual : JSON.stringify(actual ?? null), evidence: evidence ?? '', note: note ?? '' })
    return ok
  }
  return { checks, notes, add, note: (s) => notes.push(s) }
}

const verdictOf = (checks) => {
  const bearing = checks.filter((c) => c.level === 'fail')
  if (bearing.some((c) => c.ok === false)) return 'FAIL'
  if (bearing.length === 0 || bearing.some((c) => c.ok == null)) return 'INCONCLUSIVE'
  return 'PASS'
}

// --------------------------------------------------------------------------
// Wire-profile checks: [fromLabel, toLabel, 'dark'|'live', level]
// --------------------------------------------------------------------------
const addWire = (c, run, profile) => {
  for (const [from, to, expect, level = 'fail'] of profile) {
    const w = wireDelta(run, from, to)
    const id = `wire.${from}->${to}`
    if (w.ok === null) {
      c.add(id, { ok: null, level, expected: expect, actual: `sample missing: webrtc-${w.missing}.json`, evidence: `webrtc-${w.missing}.json` })
      continue
    }
    const ok = expect === 'dark' ? w.kbps <= DARK_KBPS : w.kbps >= LIVE_KBPS
    c.add(id, {
      ok,
      level,
      expected: expect === 'dark' ? `dark (<= ${DARK_KBPS} kbps)` : `live (>= ${LIVE_KBPS} kbps)`,
      actual: `${w.kbps} kbps (${w.deltaBytes} B over ${w.dtMs} ms)`,
      evidence: `webrtc-${from}.json, webrtc-${to}.json`
    })
  }
}

/** webrtc-<label>.json must show NO live sender (leg torn down). */
const addNoSender = (c, run, label, level = 'fail') => {
  const arr = run.json(`webrtc-${label}.json`)
  if (arr == null) return c.add(`wire.${label}-no-sender`, { ok: null, level, expected: 'no outbound video sender', actual: 'sample missing', evidence: `webrtc-${label}.json` })
  const live = arr.filter((s) => s.connState === 'connected')
  return c.add(`wire.${label}-no-sender`, { ok: live.length === 0, level, expected: 'no connected outbound-rtp sender', actual: live.length === 0 ? 'none' : legSummaryRtc(live), evidence: `webrtc-${label}.json` })
}
const legSummaryRtc = (arr) => arr.map((s) => `${s.connState}:${s.bytesSent}B`).join(', ')

const addLatency = (c, run, id, stepRe, pred, urlRe, { evtLimitMs = 1000, cmdLimitMs = null, level = 'fail', label = 'video_muted' } = {}) => {
  if (!run.has('app-network.json')) return c.add(id, { ok: null, level, expected: `${label} within ${evtLimitMs} ms of the event`, actual: 'app-network.json missing (run aborted)', evidence: 'app-network.json' })
  const l = latency(run, stepRe, pred, urlRe)
  if (l.missing === 'step') return c.add(id, { ok: null, level, expected: `${label} within ${evtLimitMs} ms of the event`, actual: 'harness step not found in actions.json', evidence: 'actions.json' })
  if (l.actionT == null) return c.add(id, { ok: false, level, expected: `${label} POST after ${l.stepT}`, actual: `no ${label} call after the step (event ${l.eventT ?? 'not captured'})`, evidence: 'app-network.json, app-capture.json' })
  if (l.eventT == null) {
    // Event not in the capture (capture off / starvation): judge from the command.
    const lim = cmdLimitMs ?? evtLimitMs + 1000
    return c.add(id, { ok: l.cmdToActionMs <= lim, level, expected: `${label} within ${lim} ms of the command (event not captured)`, actual: `${l.cmdToActionMs} ms after command`, evidence: 'actions.json, app-network.json', note: 'no matching ws-event in app-capture for this run' })
  }
  c.add(id, {
    ok: l.eventToActionMs <= evtLimitMs && (cmdLimitMs == null || l.cmdToActionMs <= cmdLimitMs),
    level,
    expected: `${label} <= ${evtLimitMs} ms after the Genesys event` + (cmdLimitMs != null ? ` and <= ${cmdLimitMs} ms after the command` : ''),
    actual: `${l.eventToActionMs} ms after event, ${l.cmdToActionMs} ms after command (event ${l.cmdToEventMs} ms after command)`,
    evidence: 'actions.json, app-capture.json, app-network.json'
  })
  return l
}

const stateOf = (run, actionName) => {
  const a = run.action(actionName)
  const d = a?.detail
  if (d == null) return null
  return d.timeout ? { timeout: true, ...(d.last ?? {}) } : d
}

const addState = (c, run, actionName, id, pred, expected, { level = 'fail' } = {}) => {
  const s = stateOf(run, actionName)
  if (s == null) return c.add(id, { ok: null, level, expected, actual: `${actionName} not recorded`, evidence: 'actions.json' })
  return c.add(id, { ok: pred(s), level, expected, actual: { found: s.found, selfview: s.selfview, pane: s.pane?.heading ?? undefined, toast: s.pane?.toast, timeout: s.timeout }, evidence: `actions.json#${actionName}` })
}

// --------------------------------------------------------------------------
// Generic checks (every scenario)
// --------------------------------------------------------------------------
const HANGUP_SCENARIOS = /^(S1\.1|S6\.1|S7\.3)$/ // customer leaves first: 0 agent legs expected after the steps
const APP_TEARDOWN_SCENARIOS = /^(S1\.1|S6\.1|S7\.1|S7\.3|S7\.4)$/ // the app itself must end the call: a leftover leg is a defect, not the F-08 ghost
const RELOAD_SCENARIOS = /^(S2\.4|S4\.6|S7\.2)$/ // the pre-reload leg lingers until Infinity times it out
const NO_APP_SCENARIOS = /^(S4\.0)$/ // designed to run without --video

const genericChecks = (c, run) => {
  const post = run.startedAt >= F23_BLOCK_AT
  const s7 = /^S7\./.test(run.scenario ?? '')
  const legLevel = post || s7 ? 'fail' : 'warn'
  const legNote = post || s7 ? '' : 'pre-F-23 run: duplicate legs are the known harness artifacts (F-22 double load / F-23 workspace widget), not verdict-bearing'
  const conf = run.callConf

  // Call bring-up
  c.add('run.call-connected', { ok: run.connected?.state === 'connected' ? true : null, level: 'fail', expected: 'agent leg connected (actions: agent-connected)', actual: run.connected ?? 'missing', evidence: 'actions.json' })
  if (run.connected == null) c.note('call never connected — run aborted before the scenario steps; most checks are inconclusive')

  if (!run.withVideo && !NO_APP_SCENARIOS.test(run.scenario) && run.scenario !== 'S0') {
    c.add('app.present', { ok: null, level: 'fail', expected: 'run made with --video (app under test attached)', actual: 'no app artifacts', evidence: 'actions.json#app-state-after-join' })
    c.note('run without --video: app/wire checks not applicable')
  }
  if (run.withVideo) {
    const join = stateOf(run, 'app-state-after-join') ?? run.joinState
    c.add('app.joined', { ok: join == null ? null : run.appJoined ? true : join.timeout ? null : false, level: 'fail', expected: 'app selfview mounted after join', actual: join ?? 'missing', evidence: 'actions.json#app-state-after-join', note: join?.timeout ? 'app never reached the call (login/MFA bounce F-25, or bootstrap failure) — scenario evidence is void' : '' })
    if (!run.appJoined) c.note('app never joined the call; wire/latency/UI checks are not evaluated')
  }

  // Pexip roster: exactly one agent leg while the call is up
  c.add('pexip.vmr-identified', { ok: conf != null ? true : null, level: 'fail', expected: 'run VMR name derivable (customer aniName == VMR, F-01)', actual: conf ?? 'unknown', evidence: 'genesys-timeline.json / app-network.json' })
  if (run.withVideo && run.has('pexip-after-video-join.json')) {
    const legs = agentLegs(run.json('pexip-after-video-join.json'), conf)
    c.add('pexip.single-agent-leg@after-video-join', { ok: run.appJoined ? legs.length === 1 : null, level: legLevel, expected: '1 WebRTC agent leg in the VMR', actual: `${legs.length}: ${legSummary(legs).join(', ')}`, evidence: 'pexip-after-video-join.json', note: legs.length !== 1 ? legNote : '' })
  }
  if (run.has('pexip-after-steps.json')) {
    const hangup = HANGUP_SCENARIOS.test(run.scenario)
    const expectedLegs = run.scenario === 'S3.2' || hangup ? 0 : 1
    const reload = RELOAD_SCENARIOS.test(run.scenario)
    const legs = agentLegs(run.json('pexip-after-steps.json'), conf)
    const tolerated = legs.length > expectedLegs && (reload || hangup || legLevel === 'warn')
    c.add('pexip.agent-legs@after-steps', {
      ok: !run.withVideo || !run.appJoined || run.scenario === 'S0' ? null : legs.length === expectedLegs,
      level: !run.withVideo || run.scenario === 'S0' ? 'info' : tolerated ? 'warn' : 'fail',
      expected: `${expectedLegs} WebRTC agent leg(s) in the VMR after the steps`,
      actual: `${legs.length}: ${legSummary(legs).join(', ')}`,
      evidence: 'pexip-after-steps.json',
      note: legs.length > expectedLegs ? (reload ? 'reload scenario: the pre-reload leg lingers until Infinity times it out (S7.2 measures this)' : hangup ? 'snapshot taken < 1 s after the app\'s /disconnect; pexip-after-teardown is the definitive roster' : legNote) : ''
    })
    const stale = (run.json('pexip-after-steps.json')?.conferences ?? []).filter((x) => x.name !== conf)
    if (stale.length > 0) c.add('pexip.stale-conferences', { ok: false, level: 'warn', expected: 'only the run VMR exists', actual: stale.map((x) => x.name), evidence: 'pexip-after-steps.json', note: 'stale VMR from an earlier run (F-08 ghost) — never counted as this run\'s leg; preflight/tearDown clear it via pexip.clearAll() since 2026-09-08' })
  }

  // Teardown
  const tdName = run.has('pexip-after-teardown.json') ? 'pexip-after-teardown.json' : run.scenario === 'S7.4' && run.has('pexip-after-agent-hangup.json') ? 'pexip-after-agent-hangup.json' : 'pexip-after-teardown.json'
  const td = run.json(tdName)
  if (td == null) {
    c.add('pexip.teardown', { ok: null, level: 'fail', expected: 'pexip-after-teardown.json present', actual: 'missing (run aborted before teardown)', evidence: 'pexip-after-teardown.json' })
  } else {
    const sip = sipLegs(td, conf)
    c.add('pexip.teardown-sip-legs-gone', { ok: sip.length === 0, level: tdName === 'pexip-after-teardown.json' ? 'fail' : 'info', expected: 'no SIP legs (customer + Genesys trunk) after teardown', actual: sip.length === 0 ? 'none' : legSummary(sip), evidence: tdName, note: tdName !== 'pexip-after-teardown.json' ? 'early S7.4 package: snapshot taken 10 s after the AGENT hang-up, before the codec was disconnected' : '' })
    const web = agentLegs(td, conf)
    const vmrGone = !(td.conferences ?? []).some((x) => x.name === conf)
    const ghostOnly = !vmrGone && sip.length === 0 && web.length > 0
    // In customer-hang-up scenarios the APP must have torn the VMR down (F-24); a
    // surviving agent leg there is the defect, not the F-08 harness artifact.
    const level = ghostOnly && !APP_TEARDOWN_SCENARIOS.test(run.scenario) && run.appJoined ? 'warn' : 'fail'
    c.add('pexip.teardown-vmr-gone', {
      ok: vmrGone && web.length === 0,
      level,
      expected: 'VMR gone and no WebRTC legs after teardown',
      actual: vmrGone ? 'VMR gone' : `VMR still up with ${legSummary([...web, ...sip]).join(', ') || 'no participants'}`,
      evidence: tdName,
      note: ghostOnly ? (level === 'warn' ? 'F-08 ghost: the harness closed the app page ~3 s earlier without a client-side disconnect and Infinity had not timed the leg out yet (harness artifact)' : 'the app never ended the call after the customer left (F-24: last-participant check defeated by a duplicate agent leg?)') : ''
    })
  }
  const cd = run.action('cisco-disconnected')
  c.add('cisco.disconnect-command', { ok: cd == null ? null : cd.detail === true, level: 'info', expected: 'harness cisco disconnect accepted', actual: cd?.detail ?? 'missing', evidence: 'actions.json#cisco-disconnected' })
  const cat = run.json('cisco-after-teardown.json')
  if (cat == null) c.add('cisco.no-calls-after-teardown', { ok: null, level: 'info', expected: 'no calls on the endpoint after teardown', actual: 'cisco-after-teardown.json not captured by this harness version (added 2026-09-08)', evidence: 'cisco-after-teardown.json' })
  else c.add('cisco.no-calls-after-teardown', { ok: Array.isArray(cat.calls) && cat.calls.length === 0, level: 'fail', expected: 'calls: []', actual: cat.calls, evidence: 'cisco-after-teardown.json' })

  if (!run.withVideo || !run.appJoined) return

  // App console hygiene (null when the artifact was never written — aborted run)
  if (!run.has('app-console.json')) {
    c.add('app.no-foreign-events', { ok: null, level: 'fail', expected: '0 dropped foreign-conversation events', actual: 'app-console.json missing', evidence: 'app-console.json' })
    c.add('app.no-uncaught-errors', { ok: null, level: 'fail', expected: 'no console errors outside the benign allowlist', actual: 'app-console.json missing', evidence: 'app-console.json' })
  } else {
    const foreign = run.consoleLog.filter((e) => /Ignoring event for other conversation/.test(e.text ?? ''))
    c.add('app.no-foreign-events', { ok: foreign.length === 0, level: 'fail', expected: '0 dropped foreign-conversation events', actual: foreign.length, evidence: 'app-console.json', note: foreign[0]?.text?.slice(0, 120) ?? '' })
    const errs = run.consoleLog.filter((e) => e.type === 'error' && !BENIGN_CONSOLE_ERRORS.some((re) => re.test(e.text ?? '')))
    const distinct = [...new Set(errs.map((e) => e.text.replace(/\s+/g, ' ').slice(0, 100)))]
    const unscoped = run.embedded && !run.widgetScoped
    c.add('app.no-uncaught-errors', { ok: errs.length === 0, level: unscoped ? 'warn' : 'fail', expected: 'no console errors outside the benign allowlist', actual: errs.length === 0 ? 'none' : `${errs.length}: ${distinct.slice(0, 3).join(' | ')}`, evidence: 'app-console.json', note: unscoped ? 'embedded-widget run recorded without src/frame fields: the console is the whole Genesys workspace, not just the widget — warning only' : run.widgetScoped ? 'scoped to the widget frame (src matches /agent-app/)' : '' })
    const guard = run.consoleLog.filter((e) => /^Conference connection already in progress/.test(e.text ?? '')).length
    c.add('app.rejoin-guard-hits', { ok: true, level: 'info', expected: 'F-03: one guard hit per steady-state calls event', actual: guard, evidence: 'app-console.json' })
  }
  const rej = run.runSessions.flatMap((s) => s.entries ?? []).filter((e) => e.kind === 'unhandled-rejection').length
  if (rej > 0) c.add('app.unhandled-rejections', { ok: false, level: 'warn', expected: 0, actual: rej, evidence: 'app-capture.json (kind=unhandled-rejection, this run\'s sessions)' })
  if (run.has('app-network.json')) {
    const superseded = hasEvent(run.structured, EV.yielded)
    const http = run.network.filter((e) => e.status >= 400 && !BENIGN_HTTP_ERRORS.some((re) => re.test(e.url ?? '')) && !(superseded && e.status === 403 && /\/release_token$/.test(e.url ?? '')))
    if (http.length > 0) c.add('app.http-errors', { ok: false, level: 'warn', note: run.embedded && !run.widgetScoped ? 'unscoped workspace page' : '', expected: 'no 4xx/5xx API responses (theme/ 404 excluded)', actual: http.map((e) => `${e.status} ${e.method} ${(e.url ?? '').replace(/^https?:\/\/[^/]+/, '').slice(0, 80)}`).slice(0, 4), evidence: 'app-network.json' })
    const channels = countNetwork(run, CHANNEL_RE)
    const expectedChannels = /^(S5\.1|S2\.4|S4\.6|S7\.2)$/.test(run.scenario) ? 2 : 1
    c.add('app.channels-created', { ok: channels <= expectedChannels, level: 'info', expected: `${expectedChannels} POST /api/v2/notifications/channels (20/user/app daily cap, F-22)`, actual: channels, evidence: 'app-network.json', note: run.embedded && !run.widgetScoped ? 'workspace page: includes the Genesys workspace\'s own channels (not scoped to the widget)' : '' })
    c.add('app.conference-joins', { ok: true, level: 'info', expected: 'POST .../participants/<id>/calls per join', actual: countNetwork(run, JOIN_RE), evidence: 'app-network.json' })
  }

  // Instances and events (capture is cumulative — this run's sessions only)
  const captureMissing = !run.has('app-capture.json') || !Array.isArray(run.json('app-capture.json'))
  const instances = run.runSessions.filter((s) => (s.entries ?? []).some((e) => e.kind === 'context')).length
  const expectedInstances = run.scenario === 'S7.3' ? 2 : 1 // S7.3 opens a second page on purpose
  c.add('app.instances', { ok: captureMissing ? null : instances === expectedInstances, level: instances > expectedInstances ? (post ? 'fail' : 'warn') : 'info', expected: `${expectedInstances} app instance(s) for the conversation`, actual: captureMissing ? 'capture unavailable' : instances, evidence: 'app-capture.json (sessions with a context entry for this conversation)', note: instances > expectedInstances ? 'F-22 double app load: every instance joins the VMR and burns a notification channel' : '' })
  const noSession = captureMissing || run.runSessions.length === 0
  c.add('capture.events-received', {
    ok: noSession ? null : run.captureEvents.length > 0,
    // No capture session at all = capture disabled in this build (production bundle): a
    // measurement, not a verdict. A session with heartbeats and zero events IS the F-22 defect.
    level: run.expectsEvents && run.scenario !== 'S0' && !noSession ? 'fail' : 'info',
    expected: run.expectsEvents ? '>= 1 conversations.calls event delivered to the app during the run' : 'measurement (no event-producing step in this run)',
    actual: noSession ? 'no capture session for this conversation' : `${run.captureEvents.length} events, ${run.heartbeats} heartbeats, ${run.runSessions.length} capture session(s)`,
    evidence: 'app-capture.json (kind=ws-event, topicName conversations.calls)',
    note: noSession ? 'capture disabled in this build (production bundle) or dump unavailable — event-based latencies fall back to command timestamps' : run.captureEvents.length === 0 && run.heartbeats > 0 ? 'F-22 signature: channel created, subscribed, heartbeats flowing, ZERO conversation events (channel starvation)' : ''
  })
  const foreignCaptured = run.captureEvents.filter((e) => e.data?.eventBody?.id != null && e.data.eventBody.id !== run.conversationId).length
  if (foreignCaptured > 0) c.add('capture.foreign-events-seen', { ok: true, level: 'info', expected: 'foreign-conversation events are dropped by the app (fix #4)', actual: foreignCaptured, evidence: 'app-capture.json' })
}

// --------------------------------------------------------------------------
// Scenario checks
// --------------------------------------------------------------------------
const heldPane = (s) => Array.isArray(s.found) && s.found.includes('call-on-hold') && s.selfview === false
const livePane = (s) => Array.isArray(s.found) && s.found.length === 0 && s.selfview === true
const endedPane = (s) => Array.isArray(s.found) && s.found.includes('no-active-call') && s.selfview === false

const scenarioChecks = {
  'S2.1': (c, run) => {
    addWire(c, run, [
      ['baseline-a', 'baseline-b', 'live', 'info'],
      ['hold-2s', 'hold-6s', 'dark'],
      ['hold-6s', 'hold-10s', 'dark'],
      ['unhold-3s', 'unhold-6s', 'live']
    ])
    addLatency(c, run, 'hold.event-to-mute', /^hold$/, agentHeld(run), VIDEO_MUTED_RE)
    addLatency(c, run, 'unhold.event-to-unmute', /^unhold$/, agentUnheld(run), VIDEO_UNMUTED_RE, { evtLimitMs: 5000, level: 'info', label: 'video_unmuted' })
    addState(c, run, 'app-state-during-hold', 'ui.hold-pane', heldPane, 'hold pane shown, selfview unmounted')
    const s = stateOf(run, 'app-state-during-hold')
    if (s?.pane != null) c.add('ui.hold-pane-text', { ok: s.pane.heading === 'Call on hold' && /video is muted/i.test(s.pane.detail ?? ''), level: 'fail', expected: '"Call on hold" + "Your video is muted…"', actual: s.pane, evidence: 'actions.json#app-state-during-hold' })
    addState(c, run, 'app-state-after-steps', 'ui.live-after-unhold', livePane, 'no pane, selfview mounted after unhold')
  },
  'S6.1': (c, run) => {
    addState(c, run, 'pane-on-hold', 'ui.hold-pane', (s) => s.pane?.heading === 'Call on hold' && /video is muted/i.test(s.pane?.detail ?? ''), '"Call on hold" / "Your video is muted…" within 5 s')
    addLatency(c, run, 'hold.event-to-mute', /^hold$/, agentHeld(run), VIDEO_MUTED_RE)
    addState(c, run, 'toast-after-unhold', 'ui.restore-toast', (s) => s.pane?.toast === true, '"Video restored" toast after unhold')
    addWire(c, run, [['unhold-4s', 'muted-3s', 'live']])
    addState(c, run, 'pane-while-muted', 'ui.mic-mute-no-pane', (s) => s.pane?.heading == null && s.selfview === true, 'mic mute: no pane, selfview stays')
    const mm = run.step(/mic-mute/)
    const hu = run.step(/hangs up/)
    if (mm != null && hu != null) c.add('mic-mute.no-video-mute', { ok: countNetwork(run, VIDEO_MUTED_RE, { fromIso: mm.t, toIso: hu.t }) === 0, level: 'fail', expected: 'no video_muted between mic-mute and hang-up (mic-only policy)', actual: countNetwork(run, VIDEO_MUTED_RE, { fromIso: mm.t, toIso: hu.t }), evidence: 'app-network.json' })
    addState(c, run, 'pane-after-customer-hangup', 'ui.call-ended-pane', (s) => s.pane?.heading === 'Call ended', '"Call ended" pane after the customer hangs up (F-24)')
    if (hu != null) {
      const disc = firstNetwork(run, /\/conferences\/[^/]+\/disconnect$/, hu.t)
      c.add('teardown.app-disconnect', { ok: disc != null, level: 'fail', expected: 'app POSTs /disconnect after the customer leaves', actual: disc != null ? `${ms(disc.t) - ms(hu.t)} ms after hang-up` : 'no /disconnect call', evidence: 'app-network.json' })
      const pane = run.action('pane-after-customer-hangup')
      if (pane != null) c.add('teardown.hangup-to-pane-ms', { ok: true, level: 'info', expected: '< 10000 ms', actual: ms(pane.t) - ms(hu.t), evidence: 'actions.json' })
    }
    const px = run.json('pexip-after-customer-hangup.json')
    if (px != null) {
      const legs = agentLegs(px, run.callConf)
      c.add('teardown.agent-legs-at-hangup-snapshot', { ok: legs.length <= 1, level: legs.length > 1 ? 'fail' : 'info', expected: '<= 1 WebRTC agent leg at the snapshot (taken < 1 s after the pane; pexip.teardown-vmr-gone is definitive)', actual: `${legs.length}: ${legSummary(legs).join(', ')}`, evidence: 'pexip-after-customer-hangup.json', note: legs.length > 1 ? 'F-24: with 2+ agent instances the last-participant check never fires' : '' })
    }
    const cs = run.json('cisco-after-steps.json')
    if (cs != null) c.add('cisco.customer-hung-up', { ok: Array.isArray(cs.calls) && cs.calls.length === 0, level: 'fail', expected: 'calls: [] after the customer hang-up', actual: cs.calls, evidence: 'cisco-after-steps.json' })
  },
  'S2.5': (c, run) => {
    const { policy, note } = micMutePolicyAt(run.startedAt)
    c.add('mic-mute.policy', { ok: true, level: 'info', expected: 'policy in force on the run date', actual: policy, evidence: 'run dir timestamp', note })
    const mute = run.step(/^audio-mute$/)
    const unmute = run.step(/^unmute$/)
    if (policy === 'mic-only') {
      addWire(c, run, [
        ['baseline-a', 'baseline-b', 'live', 'info'],
        ['muted-4s', 'muted-8s', 'live'],
        ['muted-8s', 'unmuted-4s', 'live']
      ])
      if (mute != null && unmute != null) c.add('mic-mute.no-video-mute', { ok: countNetwork(run, VIDEO_MUTED_RE, { fromIso: mute.t, toIso: unmute.t }) === 0, level: 'fail', expected: 'no video_muted during the mic mute', actual: countNetwork(run, VIDEO_MUTED_RE, { fromIso: mute.t, toIso: unmute.t }), evidence: 'app-network.json' })
      addState(c, run, 'app-state-muted', 'ui.mic-mute-no-pane', livePane, 'no pane, selfview stays during mic mute')
      const logged = run.structured.some((e) => e.category === 'genesys' && e.event === 'mic-muted')
      c.add('mic-mute.logged', { ok: logged, level: run.startedAt >= '2026-09-03' ? 'fail' : 'info', expected: 'genesys/mic-muted structured log', actual: logged, evidence: 'app-console.json', note: run.startedAt < '2026-09-03' ? 'structured mic-mute log only exists in builds >= 2026-09-03' : '' })
    } else {
      addWire(c, run, [
        ['baseline-a', 'baseline-b', 'live', 'info'],
        ['muted-4s', 'muted-8s', 'dark'],
        ['muted-8s', 'unmuted-4s', 'live']
      ])
      addLatency(c, run, 'mute.event-to-video-mute', /^audio-mute$/, (parts) => parts.some((p) => isMyAgent(run, p) && p.state === 'connected' && p.muted === true), VIDEO_MUTED_RE)
      addState(c, run, 'app-state-muted', 'ui.mute-indication', (s) => Array.isArray(s.found) && (s.found.includes('state-banner') || s.found.includes('call-on-hold')), 'privacy banner/pane while audio-muted (coupled policy)')
    }
  },
  'S2.6': (c, run) => {
    addWire(c, run, [
      ['baseline-a', 'baseline-b', 'live', 'info'],
      ['held-4s', 'held-8s', 'dark'],
      ['held-8s', 'unheld-4s', 'live'],
      ['unheld-4s', 'unmuted-3s', 'live']
    ])
    addLatency(c, run, 'hold.event-to-mute', /^hold/, agentHeld(run), VIDEO_MUTED_RE)
  },
  'S2.2': (c, run) => {
    addWire(c, run, [
      ['baseline-a', 'baseline-b', 'live', 'info'],
      ['after-flap-4s', 'after-flap-8s', 'live'],
      ['hold-again-3s', 'hold-again-7s', 'dark'],
      ['hold-again-7s', 'final-unhold-4s', 'live']
    ])
    addState(c, run, 'app-state-final', 'ui.live-final', livePane, 'no pane, selfview mounted at the end')
  },
  'S2.4': (c, run) => {
    addWire(c, run, [['after-reload', 'after-reload-4s', 'live']])
    addState(c, run, 'app-state-after-reload', 'ui.rejoined-after-reload', livePane, 'live view after reload on a normal call')
  },
  'S2.7': (c, run) => {
    const clicked = run.action('self-mute-clicked')?.detail
    if (clicked !== true) {
      c.add('self-mute.clicked', { ok: null, level: 'fail', expected: 'camera button found and clicked', actual: clicked ?? 'missing', evidence: 'actions.json#self-mute-clicked', note: 'scenario could not run its steps (selector not found)' })
      return
    }
    addWire(c, run, [
      ['baseline-a', 'baseline-b', 'live', 'info'],
      ['self-muted-3s', 'held-6s', 'dark'],
      ['held-6s', 'after-unhold-5s', 'dark']
    ])
  },
  'S3.1': (c, run) => {
    addWire(c, run, [
      ['baseline-a', 'baseline-b', 'live', 'info'],
      ['consulting-3s', 'consulting-6s', 'dark'],
      ['after-cancel-3s', 'after-cancel-6s', 'live']
    ])
    addLatency(c, run, 'consult.event-to-mute', /consult-start/, consultActive(), VIDEO_MUTED_RE)
    addLatency(c, run, 'consult-cancel.event-to-unmute', /consult-cancel/, (parts) => !parts.some((p) => p.consultParticipantId != null) && parts.some((p) => isMyAgent(run, p) && p.state === 'connected' && p.held === false), VIDEO_UNMUTED_RE, { evtLimitMs: 5000, level: 'info', label: 'video_unmuted' })
    addState(c, run, 'app-state-consulting', 'ui.consult-pane', heldPane, 'privacy pane during the consult')
    const s = stateOf(run, 'app-state-consulting')
    if (s?.pane != null) c.add('ui.consult-pane-text', { ok: /Consulting/.test(s.pane.heading ?? ''), level: 'fail', expected: '"Consulting — customer on hold"', actual: s.pane, evidence: 'actions.json#app-state-consulting' })
    addState(c, run, 'app-state-after-cancel', 'ui.live-after-cancel', livePane, 'live view restored after cancel')
    const consultSeen = run.has('genesys-timeline.json') ? run.timeline.some((e) => e.snap.some((p) => p.consult === true)) : null
    c.add('genesys.consult-observed', { ok: consultSeen, level: 'fail', expected: 'timeline shows consultParticipantId on the customer/agent', actual: consultSeen, evidence: 'genesys-timeline.json' })
  },
  'S3.2': (c, run) => {
    const answered = run.action('a2-answer-click')?.detail ?? run.action('a2-answered')?.detail
    c.add('precondition.a2-answered', { ok: answered === true ? true : null, level: 'fail', expected: 'A2 answered the consult', actual: answered ?? 'missing', evidence: 'actions.json' })
    addState(c, run, 'app-state-consult-active', 'ui.consult-pane', heldPane, 'privacy pane while consult is active')
    const cs = run.step(/consult-start/)
    if (cs != null) c.add('consult.video-muted', { ok: run.has('app-network.json') ? firstNetwork(run, VIDEO_MUTED_RE, cs.t) != null : null, level: 'fail', expected: 'video_muted after consult start', actual: firstNetwork(run, VIDEO_MUTED_RE, cs.t)?.t ?? 'none', evidence: 'app-network.json' })
    addState(c, run, 'app-state-after-complete', 'ui.no-ghost-after-complete', endedPane, 'after consult-complete: "no active call", selfview unmounted (F-15)')
    addNoSender(c, run, 'after-complete-5s')
    const f17 = run.consoleLog.filter((e) => /Request 'mute' threw/.test(e.text ?? '')).length
    c.add('app.no-post-disconnect-mute-throw', { ok: f17 === 0, level: 'fail', expected: 'no mute() on a dead client after leaving (F-17)', actual: f17, evidence: 'app-console.json' })
  },
  'S3.3': (c, run) => {
    addWire(c, run, [
      ['baseline-a', 'baseline-b', 'live', 'info'],
      ['after-cancel-4s', 'after-cancel-8s', 'live']
    ])
    addState(c, run, 'app-state-consult-active', 'ui.consult-pane', heldPane, 'privacy pane while consult is active')
    addState(c, run, 'app-state-after-cancel', 'ui.live-after-cancel', livePane, 'live view after taking the call back')
  },
  'S4.6': (c, run) => {
    const a1 = run.action('a1-answered')?.detail
    c.add('precondition.a1-answered-return', { ok: a1 === true ? true : null, level: 'fail', expected: 'A1 answered the transfer-back', actual: a1 ?? 'missing', evidence: 'actions.json#a1-answered' })
    addState(c, run, 'app-state-after-reload', 'ui.rejoined-after-reload', livePane, 'after reload: live view, NOT "no active call" (F-19)')
    addWire(c, run, [['after-reload', 'after-reload-5s', 'live']])
    const rl = run.step(/RELOAD/)
    if (rl != null) {
      const join = firstNetwork(run, JOIN_RE, rl.t)
      const dt = join != null ? ms(join.t) - ms(rl.t) : null
      c.add('reload.rejoin-latency', { ok: dt != null && dt <= 10000, level: 'fail', expected: 'VMR re-join <= 10 s after reload (no event-dependent rescue)', actual: dt != null ? `${dt} ms` : 'no join after reload', evidence: 'actions.json, app-network.json', note: dt != null && dt > 10000 ? 'F-19: bootstrap misread the terminated first leg; rescued only by a later event' : '' })
    }
    addState(c, run, 'app-state-final', 'ui.live-final', livePane, 'live view at the end')
  },
  'S4.2': (c, run) => {
    const a2 = run.action('a2-answered')?.detail ?? run.action('a2-answer-click')?.detail
    if (c.add('precondition.a2-answered', { ok: a2 === true ? true : null, level: 'fail', expected: 'A2 answered the blind transfer', actual: a2 ?? 'missing', evidence: 'actions.json' }) !== true) return
    addNoSender(c, run, 'a1-transferred-away-4s')
    addState(c, run, 'a1-app-after-transfer', 'ui.no-call-after-transfer-away', endedPane, 'A1 app shows no active call after transferring away')
    addWire(c, run, [['a1-returned-5s', 'a1-returned-8s', 'live']])
    addState(c, run, 'a1-app-after-return', 'ui.live-after-return', livePane, 'A1 app live after transfer-back')
  },
  'S4.3': (c, run) => {
    addState(c, run, 'app-state-after-return', 'ui.live-after-return', livePane, 'A1 app live after transfer-back (wrap-up completed first)')
    const s = pickSample(run.json('webrtc-a1-returned-6s.json'))
    c.add('wire.a1-returned-6s-sender', { ok: s == null ? null : s.connState === 'connected' && s.bytesSent > 0, level: 'fail', expected: 'connected sender with bytes after return', actual: s ?? 'missing', evidence: 'webrtc-a1-returned-6s.json' })
  },
  'S4.4': (c, run) => {
    addWire(c, run, [['hold-final-7s', 'after-unhold-4s', 'live']])
    addState(c, run, 'app-state-final', 'ui.live-final', livePane, 'live view at the end')
  },
  'S4.5': (c, run) => {
    addWire(c, run, [
      ['hold-after-return-3s', 'hold-after-return-7s', 'dark'],
      ['hold-after-return-7s', 'after-unhold-4s', 'live']
    ])
    addState(c, run, 'app-state-held', 'ui.hold-pane', heldPane, 'hold pane right after transfer-back')
    addState(c, run, 'app-state-final', 'ui.live-final', livePane, 'live view after unhold')
  },
  'S5.1': (c, run) => {
    const kill = run.action('sockets-killed')
    c.add('precondition.socket-killed', { ok: Array.isArray(kill?.detail) && kill.detail.length > 0 ? true : null, level: 'fail', expected: 'notifications socket closed by the harness', actual: kill?.detail ?? 'missing', evidence: 'actions.json#sockets-killed' })
    const lost = run.structured.find((e) => e.category === 'failsafe' && e.event === 'connection-lost')
    c.add('failsafe.connection-lost-logged', { ok: lost != null, level: 'fail', expected: 'failsafe/connection-lost on socket close', actual: lost?.reason ?? 'not logged', evidence: 'app-console.json' })
    if (kill != null) {
      const m = firstNetwork(run, VIDEO_MUTED_RE, kill.t)
      const dt = m != null ? ms(m.t) - ms(kill.t) : null
      c.add('failsafe.mute-on-socket-loss', { ok: dt != null && dt <= 2000, level: 'fail', expected: 'video_muted <= 2 s after the socket died', actual: dt != null ? `${dt} ms` : 'never muted', evidence: 'app-network.json' })
      const re = countNetwork(run, CHANNEL_RE, { fromIso: kill.t })
      c.add('failsafe.reconnect', { ok: re >= 1, level: 'fail', expected: 'a new notifications channel after the loss', actual: `${re} channel POST(s) after kill`, evidence: 'app-network.json' })
      const restored = run.structured.find((e) => e.category === 'failsafe' && e.event === 'connection-restored')
      c.add('failsafe.connection-restored-logged', { ok: restored != null, level: 'info', expected: 'failsafe/connection-restored', actual: restored?.data ?? 'not logged', evidence: 'app-console.json' })
    }
    addLatency(c, run, 'hold.honoured-on-new-channel', /^hold/, agentHeld(run), VIDEO_MUTED_RE, { cmdLimitMs: 3000 })
    addWire(c, run, [
      ['held-4s-socket-dead', 'held-10s-socket-dead', 'dark'],
      ['held-10s-socket-dead', 'held-20s-socket-dead', 'dark'],
      ['held-20s-socket-dead', 'after-unhold', 'live']
    ])
    addState(c, run, 'app-state-held-socket-dead', 'ui.hold-pane', heldPane, 'hold pane shown although the original socket died')
  },
  'S1.1': (c, run) => {
    const hu = run.step(/customer-hangup/)
    if (hu != null && run.withVideo) {
      const disc = firstNetwork(run, /\/conferences\/[^/]+\/disconnect$/, hu.t)
      c.add('teardown.app-disconnect', { ok: disc != null, level: 'fail', expected: 'app POSTs /disconnect after the customer leaves', actual: disc != null ? `${ms(disc.t) - ms(hu.t)} ms after hang-up` : 'no /disconnect call', evidence: 'app-network.json' })
      addState(c, run, 'app-state-after-steps', 'ui.call-ended', endedPane, '"no active call"/"Call ended" after the customer hang-up')
    }
    const last = run.timeline[run.timeline.length - 1]
    const custTerminated = last?.snap?.some((p) => p.purpose === 'customer' && p.state === 'terminated') ?? null
    c.add('genesys.customer-terminated', { ok: custTerminated, level: 'fail', expected: 'customer leg terminated by the end of the timeline', actual: custTerminated, evidence: 'genesys-timeline.json' })
  },
  'S4.0': (c, run) => {
    const legsLogged = run.actions.filter((a) => /^t\+\d+s$/.test(a.action))
    c.add('discriminator.samples', { ok: legsLogged.length > 0 ? true : null, level: 'info', expected: 'per-4 s leg/VMR samples', actual: legsLogged.map((a) => `${a.action}: ${JSON.stringify(a.detail).slice(0, 80)}`), evidence: 'actions.json' })
  },
  S0: (c, run) => {
    const samples = run.json('manual-webrtc-samples.json') ?? []
    c.add('manual.samples', { ok: true, level: 'info', expected: 'continuous 3 s webrtc samples', actual: samples.length, evidence: 'manual-webrtc-samples.json' })
  },
  // ---- S7.x: UNVALIDATED (written 2026-09-08 offline; artifact names per lab.cjs S7 steps) ----
  'S7.1': (c, run) => {
    // FIXED-app expectations (first live run S7_1-2026-09-08T19-18-29-913Z):
    // 1 agent leg and 1 widget iframe after the answer, "Incoming call" pane
    // while alerting, and the app tears the VMR down itself at teardown
    // (pexip.teardown-vmr-gone is fail-level via APP_TEARDOWN_SCENARIOS).
    const s = run.json('s71-summary.json')
    if (s == null) return c.add('s71.summary', { ok: null, level: 'fail', expected: 's71-summary.json', actual: 'missing', evidence: 's71-summary.json' })
    c.add('s71.missed-then-answered', { ok: s.missedLeg != null && s.answered === true ? true : null, level: 'fail', expected: 'first alert left unanswered, re-alert answered', actual: { missedLeg: s.missedLeg?.state, answered: s.answered }, evidence: 's71-summary.json' })
    c.add('s71.missed-leg-disconnectType', { ok: true, level: 'info', expected: 'recorded (this org: terminated/client when the agent is re-armed; F-16 tolerant matching)', actual: `${s.missedLeg?.state ?? '?'}/${s.missedLeg?.disconnectType ?? 'unknown'}`, evidence: 's71-summary.json' })
    const px = run.json('pexip-after-answer.json')
    const legs = px != null ? agentLegs(px, run.callConf) : null
    c.add('s71.single-agent-leg', { ok: legs == null ? null : legs.length === 1 && (s.agentLegsAfterAnswer == null || s.agentLegsAfterAnswer === 1), level: 'fail', expected: '1 WebRTC agent leg in the run VMR after the answer (original app: 2 = one per widget instance)', actual: legs == null ? 'pexip-after-answer.json missing' : `${legs.length}: ${legSummary(legs).join(', ')} (harness count ${s.agentLegsAfterAnswer})`, evidence: 'pexip-after-answer.json, s71-summary.json' })
    c.add('s71.single-widget-frame', { ok: s.widgetFramesAfterAnswer == null ? null : s.widgetFramesAfterAnswer === 1, level: 'fail', expected: '1 live widget iframe after the answer', actual: { duringFirstAlert: s.widgetFramesDuringAlert, afterMiss: (run.action('widgets-after-miss')?.detail ?? []).length, duringReAlert: s.widgetFramesDuringReAlert, afterAnswer: s.widgetFramesAfterAnswer }, evidence: 's71-summary.json, actions.json#widgets-*', note: 'Genesys removes the widget iframe when the missed leg ends and creates a new one for the re-alert' })
    const panes = [1, 2].map((n) => (run.action(`widgets-during-alert-${n}`)?.detail ?? []).map((w) => w.pane))
    c.add('s71.alert-pane', { ok: panes.every((p) => p.length > 0) ? panes.every((p) => p.every((h) => h === 'Incoming call')) : null, level: 'fail', expected: '"Incoming call" pane in every widget frame while alerting (both alerts)', actual: { alert1: panes[0], alert2: panes[1] }, evidence: 'actions.json#widgets-during-alert-1/2' })
    // Instances: capture dump when available, else distinct sessionId values in
    // the widget's structured log lines (production bundle has no capture).
    const sessionIds = new Set(run.structured.map((e) => e.sessionId).filter(Boolean))
    const instances = s.captureInstances ?? (sessionIds.size > 0 ? sessionIds.size : null)
    c.add('s71.app-instances', { ok: instances == null ? null : instances >= 1, level: 'info', expected: 'app instances seen for the interaction (one per widget iframe load)', actual: { instances, source: s.captureInstancesSource ?? (s.captureInstances != null ? 'capture dump' : sessionIds.size > 0 ? 'structured-log sessionIds' : 'unavailable') }, evidence: 's71-summary.json, app-console.json' })
    const channels = run.widgetScoped ? countNetwork(run, CHANNEL_RE) : s.channelsCreated
    const frames = Math.max(1, (s.widgetFramesDuringAlert ?? 0) + (s.widgetFramesDuringReAlert ?? 0))
    c.add('s71.channels-created', { ok: channels == null ? null : channels <= frames, level: run.widgetScoped ? 'fail' : 'warn', expected: `<= ${frames} notification channel(s) (one per widget iframe load; F-22 cap 20/day)`, actual: channels, evidence: run.widgetScoped ? 'app-network.json (frame = widget)' : 's71-summary.json', note: run.widgetScoped ? 'widget-frame requests only' : 'counted on the whole workspace page (includes Genesys\' own channels) — warning only until the harness records frame URLs' })
  },
  'S7.2': (c, run) => {
    const s = run.json('s72-summary.json')
    if (s == null) return c.add('s72.summary', { ok: null, level: 'fail', expected: 's72-summary.json', actual: 'missing', evidence: 's72-summary.json' })
    for (const at of [2, 10, 40]) {
      const px = run.json(`pexip-reload-${at}s.json`)
      const legs = px != null ? agentLegs(px, run.callConf) : null
      c.add(`s72.agent-legs@+${at}s`, { ok: legs == null ? null : at === 2 ? true : legs.length === 1, level: at === 2 ? 'info' : 'fail', expected: at === 2 ? 'measurement' : '1 WebRTC agent leg (the fix kicks its own older leg)', actual: legs == null ? 'snapshot missing' : `${legs.length}: ${legSummary(legs).join(', ')}`, evidence: `pexip-reload-${at}s.json` })
    }
    c.add('s72.ghost-survival', { ok: true, level: 'info', expected: 'seconds after reload until the roster was back at 1 leg (null = still >= 2 at +40 s); legsTimeline is the eviction-latency evidence', actual: { ghostSurvivedS: s.ghostSurvivedS ?? null, newLegJoinedAtS: s.newLegJoinedAtS ?? null, legsTimeline: (s.legsTimeline ?? []).map((x) => `${x.at}s:${x.legs}`).join(' ') }, evidence: 's72-summary.json' })
    const kicked = run.structured.some((e) => EV.kicked.test(e.event ?? '') && (e.data?.status === 200 || e.data?.result?.status === 200 || e.status === 200))
    c.add('s72.kick-result-logged', { ok: run.has('app-console.json') ? kicked : null, level: 'fail', expected: 'ghost-leg-kicked (legacy: duplicate-leg-kick-result) with status 200 — the new instance kicked its own older leg by call tag', actual: kicked, evidence: 'app-console.json' })
    addState(c, run, 'app-state-after-reload', 'ui.rejoined-after-reload', livePane, 'live view after reload')
    addWire(c, run, [['after-reload-10s', 'after-reload-40s', 'live']])
  },
  'S7.3': (c, run, opts = {}) => {
    const conf = run.callConf
    const roster = run.json('s73-roster-timeline.json')
    const two = run.json('pexip-two-instances.json')
    const legsAtPeakSnap = two != null ? agentLegs(two, conf).length : null
    const peak = Array.isArray(roster) && roster.length > 0 ? Math.max(...roster.map((r) => r.legs ?? 0), legsAtPeakSnap ?? 0) : legsAtPeakSnap
    const net2 = run.json('app2-network.json') ?? []
    const con2 = run.json('app2-console.json') ?? []
    const hu = run.step(/hangs up/)
    const disc = (net) => net.find((e) => e.method === 'POST' && /\/conferences\/[^/]+\/disconnect$/.test(e.url ?? '') && e.status >= 200 && e.status < 300 && (hu == null || ms(e.t) >= ms(hu.t))) ?? null
    if (opts.s73Mode === 'original') {
      // ORIGINAL app semantics (F-24): both legs persist, the hang-up never ends the call.
      c.add('s73.precondition-two-legs', { ok: legsAtPeakSnap == null ? null : legsAtPeakSnap === 2, level: 'fail', expected: '2 WebRTC agent legs in the run VMR (both instances stay)', actual: legsAtPeakSnap == null ? 'pexip-two-instances.json missing' : `${legsAtPeakSnap}: ${legSummary(agentLegs(two, conf)).join(', ')}`, evidence: 'pexip-two-instances.json' })
      const px = run.json('pexip-after-customer-hangup.json')
      const legs = px != null ? agentLegs(px, conf) : null
      c.add('s73.teardown-with-duplicate', { ok: legs == null ? null : legs.length === 0, level: 'fail', expected: 'no agent legs in the run VMR after the customer hang-up despite 2 legs (F-24)', actual: legs == null ? 'snapshot missing' : `${legs.length} agent legs, run VMR ${(px.conferences ?? []).some((x) => x.name === conf) ? 'still up' : 'gone'}`, evidence: 'pexip-after-customer-hangup.json' })
      c.add('teardown.app-disconnect', { ok: disc(run.network) != null || disc(net2) != null, level: 'fail', expected: 'an instance POSTs /disconnect after the hang-up', actual: (disc(run.network) ?? disc(net2))?.t ?? 'none', evidence: 'app-network.json, app2-network.json' })
      return
    }
    // FIXED app semantics (Web Lock design, 2026-09-08 evening): the second
    // instance never joins while another holds the lock; it takes the leg over
    // after ~2 s (once per call), the previous holder drops its own leg and
    // shows the passive pane. Both Playwright pages count as visible, so the
    // leg may hand over up to twice — either page may end up with the video.
    // Legacy names from the morning builds (duplicate-leg-evicted / kick-result
    // / superseded) are accepted so S7_3-2026-09-08T19-14-51-877Z still reads.
    const str2 = parseStructuredLines(con2)
    const both = [...run.structured, ...str2]
    const legsSeries = Array.isArray(roster) ? roster.map((r) => r.legs ?? 0) : legsAtPeakSnap != null ? [legsAtPeakSnap] : null
    c.add('s73.legs-never-exceed-two', { ok: legsSeries == null ? null : Math.max(...legsSeries) <= 2, level: 'fail', expected: '1 agent leg in the run VMR at every 500 ms sample, at most a brief 2 during a hand-over, never > 2', actual: legsSeries == null ? 's73-roster-timeline.json / pexip-two-instances.json missing' : `samples: ${Array.isArray(roster) ? roster.map((r) => `${r.atMs}ms:${r.legs}`).join(' ') : `single snapshot ${legsAtPeakSnap}`}`, evidence: 's73-roster-timeline.json, pexip-two-instances.json' })
    const lastLegs = legsSeries != null ? legsSeries[legsSeries.length - 1] : null
    c.add('s73.single-leg-at-end', { ok: lastLegs == null ? null : lastLegs === 1, level: 'fail', expected: 'exactly ONE WebRTC leg for the agent once the hand-over settled (last sample before the hang-up)', actual: lastLegs == null ? 'no sample' : `${lastLegs} leg(s)`, evidence: 's73-roster-timeline.json' })
    const summary = run.json('s73-summary.json')
    if (summary != null) c.add('s73.hand-over-latency', { ok: true, level: 'info', expected: 'ms from app2 join to the roster settling / to the older pane', actual: { evictedAtMs: summary.evictedAtMs, supersededAfterMs: summary.supersededAfterMs, peakLegs: summary.peakLegs }, evidence: 's73-summary.json' })
    const takeover = hasEvent(both, EV.takeover)
    c.add('s73.takeover-logged', { ok: both.length === 0 ? null : takeover, level: 'fail', expected: 'leg-owned-elsewhere or auto-takeover in either console (legacy: duplicate-leg-evicted)', actual: [...new Set(both.filter((e) => EV.takeover.test(e.event ?? '') || EV.kicked.test(e.event ?? '')).map((e) => e.event))], evidence: 'app-console.json, app2-console.json' })
    const kicked = str2.some((e) => EV.kicked.test(e.event ?? ''))
    c.add('s73.ghost-kick', { ok: true, level: 'info', expected: 'ghost-leg-kicked only when a stale leg existed at join (legacy design kicked the live older leg)', actual: kicked, evidence: 'app2-console.json' })
    // Pages before the hang-up: each must be passive-or-video, and the older
    // one must have announced it yielded (pane or structured line) within 5 s.
    const join2 = run.action('app2-state-after-join')
    const sup = run.action('pane-superseded') ?? run.action('pane-after-customer-hangup')
    const pageOk = (st) => st != null && (PASSIVE_PANE.test(st.pane?.heading ?? '') || st.selfview === true)
    const supMs = sup != null && join2 != null ? ms(sup.t) - ms(join2.t) : null
    c.add('s73.older-instance-passive-or-video', { ok: sup == null ? null : pageOk(sup.detail) && (run.action('pane-superseded') == null || supMs == null || supMs <= 5000 || sup.detail?.selfview === true), level: 'fail', expected: 'older page shows the passive pane ("Video is running in another window" / "Connecting video in this window") within 5 s, or holds the video after a hand-over', actual: sup == null ? 'no pane sample recorded' : `${sup.detail?.pane?.heading ?? (sup.detail?.selfview ? 'video' : 'no pane')} (${supMs} ms after app2 join, sampled at ${sup.action})`, evidence: `actions.json#${sup?.action ?? 'pane-superseded'}` })
    const app2State = run.action('app2-state-after-join')?.detail
    c.add('s73.newer-instance-passive-or-video', { ok: app2State == null ? null : pageOk(app2State) || /Connecting/i.test(app2State.pane?.step ?? app2State.pane?.heading ?? ''), level: 'fail', expected: 'newer page holds the video or shows the connecting/passive pane', actual: app2State == null ? 'not recorded' : { selfview: app2State.selfview, pane: app2State.pane?.heading ?? null }, evidence: 'actions.json#app2-state-after-join' })
    const yielded = hasEvent(run.structured, EV.yielded)
    c.add('s73.older-yield-logged', { ok: yielded, level: 'fail', expected: 'older instance logs passive / leg-owned-elsewhere / leg-dropped (legacy: superseded)', actual: [...new Set(run.structured.filter((e) => EV.yielded.test(e.event ?? '')).map((e) => e.event))], evidence: 'app-console.json' })
    const survivor = run.action('pane-after-customer-hangup-2')?.detail?.pane?.heading === 'Call ended' ? 'pane-after-customer-hangup-2' : 'pane-after-customer-hangup'
    addState(c, run, survivor, 'ui.call-ended-pane', (s) => s.pane?.heading === 'Call ended', 'the surviving page shows "Call ended" after the customer hang-up')
    c.add('teardown.app-disconnect', { ok: net2.length === 0 && run.network.length === 0 ? null : disc(net2) != null || disc(run.network) != null, level: 'fail', expected: 'the survivor POSTs /disconnect after the hang-up', actual: (disc(net2) ?? disc(run.network))?.t ?? 'none', evidence: 'app2-network.json, app-network.json' })
    // pexip.teardown-vmr-gone (generic, fail-level for hang-up scenarios) proves the run VMR is gone.
  },
  // S7.4 (live 2026-09-08): fixed-app expectations. Root cause = one instance,
  // two connect events, two request_token calls (20-45-39); fixed build makes one
  // and logs lifecycle/join-suppressed (20-50-57).
  'S7.4': (c, run) => {
    const conf = run.callConf
    const instances = new Set(run.structured.map((e) => e.sessionId).filter(Boolean)).size || 1
    const tokens = countNetwork(run, /\/request_token$/)
    c.add('s74.request-token-per-instance', { ok: run.has('app-network.json') ? tokens === instances : null, level: 'fail', expected: `exactly 1 request_token POST from the widget frame per instance (${instances} instance(s) seen)`, actual: `${tokens} request_token, ${instances} instance(s)`, evidence: 'app-network.json (frame = widget), app-console.json sessionIds', note: tokens > instances ? 'one instance joined twice (two connect events) — the S7 root cause' : '' })
    const suppressed = run.structured.some((e) => e.category === 'lifecycle' && e.event === 'join-suppressed')
    const connectEvents = run.captureEvents.filter((e) => (e.data?.eventBody?.participants ?? []).some((p) => isMyAgent(run, p) && p.state === 'connected')).length
    const needSuppress = run.captureEvents.length > 0 ? connectEvents > 1 : tokens > 1 || suppressed
    c.add('s74.join-suppressed', { ok: needSuppress ? suppressed : true, level: needSuppress ? 'fail' : 'info', expected: 'lifecycle/join-suppressed when more than one connect event reaches the instance', actual: { joinSuppressed: suppressed, connectEventsCaptured: run.captureEvents.length > 0 ? connectEvents : 'capture unavailable' }, evidence: 'app-console.json, app-capture.json' })
    const probes = run.actions.filter((a) => /^probe-after-(answer-no-click|tool-click|tool-click-2)$/.test(a.action))
    const legsOk = probes.length > 0 && probes.every((p) => p.detail?.agentLegs === 1 && p.detail?.widgetFrames === 1)
    c.add('s74.single-leg-single-frame', { ok: probes.length > 0 ? legsOk : null, level: 'fail', expected: '1 agent leg in the run VMR and 1 widget iframe at every probe before the hang-up', actual: probes.map((p) => `${p.action.replace('probe-', '')}: legs ${p.detail?.agentLegs} frames ${p.detail?.widgetFrames} pane ${JSON.stringify(p.detail?.panes)}`), evidence: 'actions.json#probe-*' })
    const px = run.json('pexip-after-agent-hangup.json')
    const legs = px != null ? agentLegs(px, conf) : null
    c.add('s74.vmr-gone-after-agent-hangup', { ok: px == null ? null : legs.length === 0 && !(px.conferences ?? []).some((x) => x.name === conf), level: 'fail', expected: 'run VMR gone and no agent leg 10 s after the AGENT hang-up', actual: px == null ? 'pexip-after-agent-hangup.json missing' : `${legs.length} agent leg(s), VMR ${(px.conferences ?? []).some((x) => x.name === conf) ? 'still up' : 'gone'}`, evidence: 'pexip-after-agent-hangup.json' })
    const dropped = run.structured.filter((e) => e.category === 'failsafe' && /^(video-leg-dropped|superseded|auto-takeover)$/.test(e.event)).map((e) => `${e.event}: ${e.reason ?? ''}`)
    if (dropped.length > 0) c.add('s74.self-superseded', { ok: false, level: 'warn', expected: 'no failsafe/video-leg-dropped|superseded|auto-takeover on a single instance', actual: dropped, evidence: 'app-console.json', note: 'the instance evicted its own first leg — symptom of the double join' })
    c.add('s74.tool-click', { ok: true, level: 'info', expected: 'how the video tool was selected (null = not found in this layout)', actual: [run.action('tool-click')?.detail, run.action('tool-click-2')?.detail], evidence: 'actions.json#tool-click' })
  }
}

// --------------------------------------------------------------------------
// Entry points
// --------------------------------------------------------------------------
const assessRun = (dir, { write = true, s73Mode = 'fixed' } = {}) => {
  const run = loadRun(dir)
  const c = makeChecks()
  if (run.scenario == null) {
    return { scenario: null, runDir: run.dir, verdict: 'INCONCLUSIVE', checks: [], notes: [`not a scenario run dir (${run.name})`] }
  }
  genericChecks(c, run)
  const sc = scenarioChecks[run.scenario]
  const appNeeded = !NO_APP_SCENARIOS.test(run.scenario) && run.scenario !== 'S0'
  if (sc == null) c.note(`no scenario-specific checks defined for ${run.scenario}; generic checks only`)
  else if (appNeeded && !run.appJoined) c.note(`scenario checks for ${run.scenario} skipped: app not attached or never joined`)
  else sc(c, run, { s73Mode })
  if (run.scenario === 'S7.1') c.note('S7.1: fixed-app expectations (1 leg, 1 iframe after a missed alert) validated live 2026-09-08 — see s71-summary.json')
  if (run.scenario === 'S7.3' && s73Mode === 'original') c.note('S7.3 judged with ORIGINAL-app semantics (--s73-original): duplicate legs persist, F-24 teardown expected to fail')
  const verdict = verdictOf(c.checks)
  const report = {
    scenario: run.scenario,
    runDir: run.dir,
    startedAt: run.startedAt,
    conversationId: run.conversationId,
    vmr: run.callConf,
    withVideo: run.withVideo,
    verdict,
    assessedAt: new Date().toISOString(),
    checks: c.checks,
    notes: c.notes
  }
  if (write) {
    fs.writeFileSync(path.join(run.dir, 'report.json'), JSON.stringify(report, null, 1))
    fs.writeFileSync(path.join(run.dir, 'report.md'), renderMarkdown(run, report))
  }
  return report
}

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 160)
const resultWord = (ch) => (ch.ok === true ? (ch.level === 'info' ? 'INFO' : 'PASS') : ch.ok === false ? (ch.level === 'fail' ? 'FAIL' : ch.level === 'warn' ? 'WARN' : 'INFO') : ch.level === 'fail' ? 'INCONCLUSIVE' : 'N/A')

const renderMarkdown = (run, report) => {
  const existing = run.has('report.md') ? fs.readFileSync(path.join(run.dir, 'report.md'), 'utf8') : ''
  const cut = existing.indexOf('\n## Assessment')
  let header = (cut >= 0 ? existing.slice(0, cut) : existing).trimEnd()
  if (header.length === 0) header = [`# Run report — ${report.scenario}`, `Run dir: ${run.dir}`, `Conversation: ${run.conversationId ?? 'unknown'}`, `Actions: ${run.actions.length} (actions.json)`].join('\n')
  const rows = report.checks.map((ch) => `| ${ch.id} | ${resultWord(ch)} | ${cell(ch.expected)} | ${cell(ch.actual)} | ${cell(ch.evidence)} | ${cell(ch.note)} |`)
  const counts = { fail: report.checks.filter((x) => x.level === 'fail' && x.ok === false).length, inconclusive: report.checks.filter((x) => x.level === 'fail' && x.ok == null).length, warn: report.checks.filter((x) => x.level === 'warn' && x.ok === false).length }
  return [
    header,
    '',
    `## Assessment — **${report.verdict}**`,
    `Assessed ${report.assessedAt} by \`lab.cjs assess\` (offline). VMR: ${report.vmr ?? 'unknown'}. Failing: ${counts.fail}, inconclusive: ${counts.inconclusive}, warnings: ${counts.warn}.`,
    ...(report.notes.length > 0 ? ['', ...report.notes.map((n) => `- ${n}`)] : []),
    '',
    '| check | result | expected | actual | evidence | note |',
    '|---|---|---|---|---|---|',
    ...rows,
    ''
  ].join('\n')
}

const listRunDirs = (runsRoot) =>
  fs
    .readdirSync(runsRoot)
    .filter((n) => parseRunDirName(n) != null && fs.statSync(path.join(runsRoot, n)).isDirectory())
    .sort()

const assessAll = (runsRoot, { write = true, filter = null } = {}) => {
  const rows = []
  for (const n of listRunDirs(runsRoot)) {
    if (filter != null && !n.startsWith(filter)) continue
    let r
    try {
      r = assessRun(path.join(runsRoot, n), { write })
    } catch (e) {
      r = { scenario: parseRunDirName(n)?.scenario ?? null, runDir: path.join(runsRoot, n), verdict: 'ERROR', checks: [], notes: [String(e.message)] }
    }
    rows.push(r)
  }
  return rows
}

const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n)
const renderTable = (rows) => {
  const lines = [`${pad('run', 34)} ${pad('scenario', 9)} ${pad('verdict', 13)} ${pad('fail', 5)} ${pad('warn', 5)} failing checks / notes`, '-'.repeat(120)]
  for (const r of rows) {
    const fails = r.checks.filter((x) => x.level === 'fail' && x.ok === false).map((x) => x.id)
    const inc = r.checks.filter((x) => x.level === 'fail' && x.ok == null).map((x) => x.id)
    const warns = r.checks.filter((x) => x.level === 'warn' && x.ok === false).length
    const tail = r.verdict === 'FAIL' ? fails.join(', ') : r.verdict === 'INCONCLUSIVE' ? `inconclusive: ${inc.slice(0, 3).join(', ')}${inc.length > 3 ? ` (+${inc.length - 3})` : ''}` : r.notes[0] ?? ''
    lines.push(`${pad(path.basename(r.runDir), 34)} ${pad(r.scenario, 9)} ${pad(r.verdict, 13)} ${pad(fails.length, 5)} ${pad(warns, 5)} ${tail.slice(0, 110)}`)
  }
  const tally = rows.reduce((m, r) => ((m[r.verdict] = (m[r.verdict] ?? 0) + 1), m), {})
  lines.push('-'.repeat(120), Object.entries(tally).map(([k, v]) => `${k}: ${v}`).join('  '))
  return lines.join('\n')
}

module.exports = {
  assessRun,
  assessAll,
  renderTable,
  loadRun,
  parseRunDirName,
  listRunDirs,
  wireDelta,
  latency,
  agentLegs,
  sipLegs,
  verdictOf,
  micMutePolicyAt,
  countNetwork,
  firstNetwork,
  F23_BLOCK_AT,
  BENIGN_CONSOLE_ERRORS,
  DARK_KBPS,
  LIVE_KBPS,
  CHANNEL_RE
}
