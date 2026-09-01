/**
 * Outbound-redesign mechanics probe (docs/outbound-review.md §7).
 *
 * E1: real agent-originated outbound — POST /api/v2/conversations/calls from
 *     A1 to the branch device URI; agent's hosted WebRTC phone answers; the
 *     device auto-answers. Captures the outbound conversation shape (the
 *     brief's [VERIFY] purpose values) as fixtures.
 * E2: while E1's audio call is live, a Pexip VMR dials the device as a
 *     SECOND (video) call via the management dialout command. xAPI shows
 *     whether the device auto-answers and whether the first call is held —
 *     THE go/no-go question for the two-call model.
 * E3: teardown both legs, observing the device after each step.
 *
 * Usage: node tools/lab/outbound-probe.cjs [--dest sip.uri] [--calltype video|video-only|audio]
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const genesys = require('./actors/genesys.cjs')
const cisco = require('./actors/cisco.cjs')
const pexip = require('./actors/pexip.cjs')
const app = require('./actors/app.cjs')

const DEST = argVal('--dest') ?? 'josh.estrada@pexip.com'
const CALL_TYPE = argVal('--calltype') ?? 'video'
const APP_PREFIX = process.env.PEXIP_APP_PREFIX ?? 'app_'

function argVal (flag) {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const runDir = path.join(
  __dirname, 'runs',
  `outbound-probe-${new Date().toISOString().replace(/[:.]/g, '-')}`
)
fs.mkdirSync(runDir, { recursive: true })
const log = (tag, data) => {
  const line = JSON.stringify({ t: new Date().toISOString(), tag, data })
  console.log(line)
  fs.appendFileSync(path.join(runDir, 'probe-log.jsonl'), line + '\n')
}
const save = (name, data) =>
  fs.writeFileSync(path.join(runDir, name), JSON.stringify(data, null, 1))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Management-API command POST (pexip.cjs is read-only; commands live here).
const pexipHost = () => {
  if (process.env.PEXIP_HOST) return process.env.PEXIP_HOST
  const cfg = JSON.parse(fs.readFileSync(path.join(require('os').homedir(), '.claude.json'), 'utf8'))
  for (const scope of [cfg, ...Object.values(cfg.projects ?? {})]) {
    const s = scope.mcpServers?.['pexip-mgmt']
    if (s?.env?.PEXIP_HOST) return s.env.PEXIP_HOST
  }
  throw new Error('no PEXIP_HOST')
}
const pexipCommand = async (cmdPath, body) => {
  const token = await pexip.getToken()
  const res = await fetch(`https://${pexipHost()}${cmdPath}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  const text = await res.text()
  return { status: res.status, body: text.slice(0, 500) }
}

const ciscoCallsBrief = async () => {
  const calls = await cisco.calls().catch(() => [])
  return (Array.isArray(calls) ? calls : []).map((c) => ({
    id: c.id ?? c.CallId,
    status: c.Status ?? c.status,
    type: c.CallType ?? c.type,
    direction: c.Direction ?? c.direction,
    remote: c.RemoteNumber ?? c.CallbackNumber ?? c.DisplayName ?? c.remote,
    hold: c.PlacedOnHold ?? c.Hold ?? c.hold
  }))
}

const briefParticipants = (conv) =>
  (conv.participants ?? []).map((p) => ({
    purpose: p.purpose,
    state: p.calls?.[0]?.state ?? p.state,
    userId: p.userId ?? p.user?.id,
    direction: p.calls?.[0]?.direction,
    self: p.calls?.[0]?.self?.addressNormalized ?? p.calls?.[0]?.self?.addressRaw,
    other: p.calls?.[0]?.other?.addressNormalized ?? p.calls?.[0]?.other?.addressRaw,
    held: p.calls?.[0]?.held ?? p.held
  }))

// If the env token is dead, harvest a fresh implicit-grant token from the
// widget's own OAuth redirect inside the logged-in lab profile.
const harvestToken = async (ctx) => {
  const page = await ctx.newPage()
  try {
    await page.goto(app.appUrl('token-harvest'), { waitUntil: 'domcontentloaded' })
    for (let i = 0; i < 60; i++) {
      const url = page.url()
      if (i % 5 === 0) log('harvest-url', url.slice(0, 140))
      const m = /access_token=([^&]+)/.exec(new URL(url).hash)
      if (m != null) return decodeURIComponent(m[1])
      await sleep(1000)
    }
    throw new Error(`no access_token in app URL hash after 60s; last url: ${page.url().slice(0, 200)}`)
  } finally {
    await page.close().catch(() => {})
  }
}

const QUEUE_ID = argVal('--queue') // on-behalf-of-queue outbound when set

/**
 * Answer the agent's OWN outbound leg on the hosted WebRTC phone. The
 * workspace "Answer" button used for ACD alerts does not appear for a
 * self-placed call — census every control, log what exists, click anything
 * answer-like (incl. the top-bar phone panel), verify by call state.
 */
const answerOwnLeg = async (page, timeoutMs, isConnected) => {
  const deadline = Date.now() + timeoutMs
  let censusDone = false
  // The ringing call UI lives behind the top-nav "Calls" (handset) panel —
  // the Home page shows nothing clickable for a self-placed call.
  const callsNav = page.getByRole('button', { name: /^calls$/i }).first()
  if (await callsNav.isVisible({ timeout: 2000 }).catch(() => false)) {
    await callsNav.click().catch(() => {})
    log('answer-opened-calls-panel', true)
    await sleep(1500)
  }
  while (Date.now() < deadline) {
    if (await isConnected().catch(() => false)) return true
    for (const frame of page.frames()) {
      try {
        const controls = await frame
          .locator('button, gux-button, [role="button"], a[title]')
          .evaluateAll((els) =>
            els
              .filter((el) => el.offsetParent != null)
              .map((el) => (el.getAttribute('aria-label') ?? el.getAttribute('title') ?? el.textContent ?? '').trim().slice(0, 60))
              .filter((s) => s.length > 0)
          )
          .catch(() => [])
        if (!censusDone && controls.length > 3) {
          log('answer-census', [...new Set(controls)].slice(0, 40))
          censusDone = true
        }
        for (const name of controls) {
          if (/answer|pick.?up|accept/i.test(name) && !/auto.?answer/i.test(name)) {
            const btn = frame
              .locator(`button, gux-button, [role="button"], a[title]`)
              .filter({ hasText: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') })
              .first()
            const byAria = frame.locator(`[aria-label="${name}"], [title="${name}"]`).first()
            for (const cand of [byAria, btn]) {
              if (await cand.isVisible({ timeout: 100 }).catch(() => false)) {
                await cand.click().catch(() => {})
                log('answer-clicked', name)
              }
            }
          }
        }
      } catch { /* frame navigating */ }
    }
    await sleep(1200)
  }
  return await isConnected().catch(() => false)
}

// --manual: host the phone, open the Calls panel, then WATCH ONLY —
// Josh places the call by hand from the workspace UI. Records conversation
// state + codec state for 4 minutes.
const manualMode = async () => {
  let a1 = genesys.actors().a1
  let me = await a1.whoAmI().catch(() => null)
  if (me == null && fs.existsSync('/tmp/.a1token')) {
    a1 = genesys.makeActor('a1', fs.readFileSync('/tmp/.a1token', 'utf8').trim())
    me = await a1.whoAmI()
  }
  log('actor', me)
  const ctx = await app.launch({ who: 'a1' })
  try {
    const page = await app.openPhoneHost(ctx)
    await page.getByRole('button', { name: /^calls$/i }).first().click().catch(() => {})
    log('MANUAL', 'phone hosted + Calls panel open — Josh: Start a new call → dial josh.estrada@pexip.com')
    let lastSig = ''
    for (let i = 0; i < 120; i++) {
      await sleep(2000)
      const calls = await genesys.api(a1.token, 'GET', '/api/v2/conversations/calls').catch(() => null)
      const convs = (calls?.entities ?? []).map((c) => ({ id: c.id.slice(0, 8), parts: briefParticipants(c) }))
      const codec = await ciscoCallsBrief()
      const sig = JSON.stringify({ convs, codec })
      if (sig !== lastSig) {
        log('manual-obs', { convs, codec })
        lastSig = sig
        for (const c of calls?.entities ?? []) save(`manual-conv-${c.id.slice(0, 8)}.json`, c)
      }
    }
  } finally {
    await ctx.close().catch(() => {})
  }
}

const main = async () => {
  if (process.argv.includes('--manual')) return await manualMode()
  let a1 = genesys.actors().a1
  let me = await a1.whoAmI().catch(() => null)
  if (me == null && fs.existsSync('/tmp/.a1token')) {
    a1 = genesys.makeActor('a1', fs.readFileSync('/tmp/.a1token', 'utf8').trim())
    me = await a1.whoAmI().catch(() => null)
    if (me != null) log('token', 'stashed token OK')
  }
  if (me == null) {
    log('token', 'env token dead — harvesting fresh implicit token from lab profile')
    const ctx0 = await app.launch({ who: 'a1' })
    try {
      const token = await harvestToken(ctx0)
      a1 = genesys.makeActor('a1', token)
      me = await a1.whoAmI()
      log('token', 'harvested OK')
    } finally {
      await ctx0.close().catch(() => {})
    }
  }
  log('actor', me)
  log('preflight-cisco', await ciscoCallsBrief())
  log('preflight-pexip', await pexip.summary())

  // ---- E1: real outbound from the agent ----
  const ctx = await app.launch({ who: 'a1' })
  let conversationId = null
  try {
    const phonePage = await app.openPhoneHost(ctx)
    log('phone-hosted', true)
    await sleep(3000)

    let resp = null
    for (const target of [DEST, `sip:${DEST}`]) {
      const body = { phoneNumber: target }
      if (QUEUE_ID != null) body.callFromQueueId = QUEUE_ID
      const r = await genesys
        .api(a1.token, 'POST', '/api/v2/conversations/calls', body)
        .then((j) => ({ ok: true, j }))
        .catch((e) => ({ ok: false, err: String(e.message).slice(0, 300) }))
      log('e1-post-calls', { target, queue: QUEUE_ID ?? null, ok: r.ok, id: r.j?.id, err: r.err })
      if (r.ok) { resp = r.j; break }
    }
    if (resp == null) throw new Error('E1 FAILED: POST /conversations/calls rejected all target forms')
    conversationId = resp.id

    // Answer the agent's own station via the hosted phone UI. Success is
    // verified by call state, not by the click.
    const agentConnected = async () => {
      const c = await genesys.api(a1.token, 'GET', `/api/v2/conversations/calls/${conversationId}`).catch(() => null)
      const mine = (c?.participants ?? []).find((p) => (p.userId ?? p.user?.id) === me.id)
      return (mine?.calls?.[0]?.state ?? mine?.state) === 'connected'
    }
    log('HUMAN-ACTION', 'Josh: click ANSWER on the call widget in the popped-up workspace window NOW')
    const answered = await answerOwnLeg(phonePage, 60000, agentConnected)
    log('e1-agent-answer-click', answered)
    await phonePage.screenshot({ path: path.join(runDir, answered ? 'e1-answered.png' : 'e1-answer-FAILED.png') }).catch(() => {})

    // Watch until far end connects (device auto-answer) or fails.
    let conv = null
    let farConnected = false
    for (let i = 0; i < 25; i++) {
      await sleep(2000)
      conv = await genesys.api(a1.token, 'GET', `/api/v2/conversations/calls/${conversationId}`).catch(() => null)
      if (conv == null) continue
      const brief = briefParticipants(conv)
      log(`e1-conv-${i}`, brief)
      const far = brief.find((p) => p.userId !== me.id)
      if (far?.state === 'connected') { farConnected = true; break }
      if (far?.state === 'disconnected' || far?.state === 'terminated') break
    }
    save('e1-conversation-fixture.json', conv)
    log('e1-far-end-connected', farConnected)
    log('e1-cisco-during-call', await ciscoCallsBrief())
    if (!farConnected) throw new Error('E1 FAILED: far end never connected — see e1-conv snapshots')

    await sleep(3000)

    // ---- E2: second (video) call from a VMR while audio is live ----
    const probeAlias = `31100_probe${crypto.randomUUID().slice(0, 4)}`
    let dialout = null
    for (const alias of [probeAlias, `${APP_PREFIX}${probeAlias}`, 'outbound_probe']) {
      const r = await pexipCommand('/api/admin/command/v1/participant/dialout/', {
        conference_alias: alias,
        destination: DEST,
        protocol: 'sip',
        role: 'guest',
        call_type: CALL_TYPE
      })
      log('e2-dialout-attempt', { alias, callType: CALL_TYPE, status: r.status, body: r.body })
      if (r.status >= 200 && r.status < 300) { dialout = { alias, r }; break }
    }
    if (dialout == null) {
      log('e2-SKIPPED', 'no alias accepted by policy — record and continue to teardown')
    } else {
      // THE observation: what does the device do with call #2?
      for (let i = 0; i < 10; i++) {
        await sleep(2000)
        const calls = await ciscoCallsBrief()
        const pex = await pexip.summary().catch(() => null)
        log(`e2-obs-${i}`, { ciscoCalls: calls, pexipParticipants: pex?.participants?.map((p) => `${p.protocol}:${p.displayName}`) })
      }
      const convDuring = await genesys.api(a1.token, 'GET', `/api/v2/conversations/calls/${conversationId}`).catch(() => null)
      log('e2-genesys-call-during', briefParticipants(convDuring ?? {}))
      save('e2-conversation-during-video.json', convDuring)

      // ---- E3a: tear down the VMR leg, watch the device ----
      const confs = (await pexip.conferences().catch(() => [])).filter((c) => c.name?.includes('probe'))
      for (const c of confs) {
        const r = await pexipCommand('/api/admin/command/v1/conference/disconnect/', { conference_id: c.id })
        log('e3-vmr-disconnect', { name: c.name, status: r.status })
      }
      await sleep(4000)
      log('e3-cisco-after-vmr-teardown', await ciscoCallsBrief())
      const convAfter = await genesys.api(a1.token, 'GET', `/api/v2/conversations/calls/${conversationId}`).catch(() => null)
      log('e3-genesys-after-vmr-teardown', briefParticipants(convAfter ?? {}))
    }

    // ---- E3b: hang up the Genesys call ----
    await a1.findCall().catch(() => null)
    await a1.disconnect().catch((e) => log('e3-genesys-disconnect-err', String(e.message)))
    await sleep(4000)
    log('e3-cisco-after-genesys-hangup', await ciscoCallsBrief())
    log('e3-final-pexip', await pexip.summary().catch(() => null))
    await a1.completeWrapup().catch(() => {})
    log('done', { runDir })
  } finally {
    await ctx.close().catch(() => {})
  }
}

main().catch((e) => {
  log('PROBE-ERROR', String(e.message))
  process.exit(1)
})
