/**
 * Outbound dynamic-VMR test (2026-09-09).
 *
 *   node tools/lab/outbound-vmr-test.cjs [--dest out_30005@…] [--no-teardown] [--force]
 *   node tools/lab/outbound-vmr-test.cjs --watch [--minutes 5]
 *
 * --watch: place the call YOURSELF from the Genesys workspace dialpad and this
 * only observes. Needed because an API-placed outbound call never reaches the
 * hosted WebRTC phone as an answerable interaction — it times out after 60 s
 * with error.ininedgecontrol.connection.timeout (lab 2026-08-31, re-confirmed
 * 2026-09-09). A human workspace dial auto-connects the station.
 *
 * Proves the outbound rendezvous end to end BEFORE the widget is involved:
 *   1. agent (A1) places a Genesys call to the out_ SIP URI over the BYOC trunk
 *   2. the agent's own station (Playwright-hosted WebRTC phone) answers
 *   3. Genesys routes the far leg to Pexip; the local policy should mint a
 *      conference named `out_<device>` and dial the registered device into it
 *   4. the codec (auto-answer OFF) is accepted here via xAPI
 *   5. everything is snapshotted: Genesys participants, Infinity conferences +
 *      participants + media streams, codec calls + media channels
 *
 * Writes tools/lab/runs/outbound-vmr-<ts>/ and prints a verdict.
 */
const fs = require('fs')
const path = require('path')
const genesys = require('./actors/genesys.cjs')
const cisco = require('./actors/cisco.cjs')
const pexip = require('./actors/pexip.cjs')
const app = require('./actors/app.cjs')

const argVal = (flag) => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const DEST = argVal('--dest') ?? '30005@genesys.pexsupport.com'
// Placing the call ON BEHALF OF A QUEUE is what the workspace "Make Call"
// dialog does (it has a queue selector). A personal call rings the agent's
// station and, with no persistent connection, times out unanswered; a
// queue call is an ACD interaction, so acdAutoAnswer connects it.
const QUEUE_ID = argVal('--queue')
// The policy names the room after the DIALED alias (validated 2026-09-10,
// F-28); the device is that alias minus any out_ prefix a dial plan adds.
const DIALED = DEST.replace(/^sips?:/, '').replace(/[@;].*$/, '').toLowerCase()
const ROOM = DIALED
const DEVICE = DIALED.replace(/^out_/, '')

const runDir = path.join(__dirname, 'runs', `outbound-vmr-${new Date().toISOString().replace(/[:.]/g, '-')}`)
fs.mkdirSync(runDir, { recursive: true })
const actions = []
const log = (action, detail) => {
  const entry = { t: new Date().toISOString(), action, detail }
  actions.push(entry)
  console.log(`[out] ${entry.t} ${action} ${JSON.stringify(detail ?? null).slice(0, 300)}`)
  fs.writeFileSync(path.join(runDir, 'actions.json'), JSON.stringify(actions, null, 1))
}
const save = (name, data) => fs.writeFileSync(path.join(runDir, name), JSON.stringify(data, null, 1))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const waitUntilTrue = async (fn, timeoutMs) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn().catch(() => false)) return true
    await sleep(1500)
  }
  return false
}

// /conversations/calls/{id} returns FLAT participants (state at the top level);
// /conversations/{id} nests them under calls[]. Read both.
const brief = (conv) =>
  (conv?.participants ?? []).map((p) => {
    const call = p.calls?.[0] ?? {}
    return {
      purpose: p.purpose,
      name: p.name ?? null,
      userId: p.userId ?? p.user?.id ?? null,
      state: p.state ?? call.state ?? null,
      disconnectType: p.disconnectType ?? call.disconnectType ?? null,
      errorCode: p.errorInfo?.code ?? null,
      ani: p.ani ?? null,
      dnis: p.dnis ?? null,
      other: call.other?.addressNormalized ?? call.other?.addressRaw ?? p.address ?? null
    }
  })

const pexipBrief = (px) => ({
  conferences: (px?.conferences ?? []).map((c) => `${c.name} [${c.tag ?? ''}]`),
  participants: (px?.participants ?? []).map(
    (p) => `${p.conference} | ${p.protocol}:${p.displayName} | ${p.role} ${p.direction} media=${p.hasMedia} src=${p.sourceAlias} dst=${p.destinationAlias}`
  )
})

/** Observe one live conversation: Genesys legs, Infinity room, codec. */
const observe = async (a1, me, conversationId, rounds) => {
  let acceptedCodec = false
  let roomSeen = false
  let deviceSeen = false
  let farState = null
  for (let i = 0; i < rounds; i++) {
    await sleep(2000)
    const conv = await genesys.api(a1.token, 'GET', `/api/v2/conversations/calls/${conversationId}`).catch(() => null)
    const px = await pexip.summary().catch(() => null)
    const cc = await cisco.calls().catch(() => [])
    const legs = brief(conv)
    const far = legs.find((p) => p.userId !== me.id)
    farState = far?.state ?? null
    if ((px?.conferences ?? []).some((c) => c.name === ROOM)) roomSeen = true
    if ((px?.participants ?? []).some((p) => `${p.destinationAlias ?? ''} ${p.sourceAlias ?? ''}`.includes(DEVICE))) deviceSeen = true
    log(`obs-${i}`, {
      legs: legs.map((p) => `${p.purpose}:${p.state}${p.disconnectType ? '/' + p.disconnectType : ''}${p.other ? ' -> ' + p.other : ''}`),
      pexip: pexipBrief(px),
      cisco: cc.map((c) => `${c.status}/${c.answerState ?? '-'} ${c.remoteNumber ?? c.displayName ?? ''}`)
    })
    const ringing = cc.find((c) => /ringing|alerting/i.test(c.status ?? ''))
    if (ringing != null && !acceptedCodec) {
      const r = await cisco.accept(ringing.item).catch((e) => ({ status: -1, body: String(e.message) }))
      acceptedCodec = true
      log('codec-accept', { item: ringing.item, status: r.status })
    }
    if (far != null && (far.state === 'disconnected' || far.state === 'terminated')) {
      log('far-end-ended', { disconnectType: far.disconnectType })
      break
    }
    if (roomSeen && deviceSeen && cc.some((c) => /connected/i.test(c.status ?? ''))) {
      log('all-up', true)
      await sleep(4000)
      break
    }
  }
  return { roomSeen, deviceSeen, acceptedCodec, farState }
}

/** Snapshot every side and write the verdict. */
const finalEvidence = async (a1, conversationId, obs) => {
  const px = await pexip.summary().catch(() => null)
  save('pexip-final.json', px)
  const streams = []
  for (const p of px?.participants ?? []) {
    streams.push({ participant: `${p.protocol}:${p.displayName}`, media: await pexip.mediaStreams(p.id).catch(() => null) })
  }
  save('pexip-media-streams.json', streams)
  const conv = await genesys.api(a1.token, 'GET', `/api/v2/conversations/calls/${conversationId}`).catch(() => null)
  save('genesys-conversation.json', conv)
  save('cisco-final.json', await cisco.summary().catch(() => null))
  log('final-pexip', pexipBrief(px))
  log('final-genesys', brief(conv))
  const verdict = {
    routedToPexip: obs.roomSeen,
    roomName: ROOM,
    deviceDialed: obs.deviceSeen,
    codecAcceptedByHarness: obs.acceptedCodec,
    farEndState: obs.farState,
    participantsInRoom: (px?.participants ?? []).filter((p) => p.conference === ROOM).length
  }
  save('verdict.json', verdict)
  log('VERDICT', verdict)
  return verdict
}

const watchMode = async () => {
  const a1 = genesys.actors().a1
  const me = await a1.whoAmI()
  log('actor', me)
  log('preflight', {
    cisco: (await cisco.calls().catch(() => [])).length,
    pexip: pexipBrief(await pexip.summary().catch(() => null))
  })
  // --no-browser: observe only, so the human's own workspace session keeps
  // the WebRTC station (two sessions for one user fight over it).
  const headless = process.argv.includes('--no-browser')
  const ctx = headless ? null : await app.launch({ who: 'a1' })
  const page = ctx == null ? null : await app.openPhoneHost(ctx)
  log('WATCHING', {
    instruction: headless
      ? `Dial ${DEST} from your own Genesys workspace (as ${me.name}); nothing here touches your session.`
      : `In the Chromium window that just opened (logged in as ${me.name}), open the dialpad and call ${DEST}`,
    expectRoom: ROOM,
    expectDevice: DEVICE
  })
  const minutes = Number(argVal('--minutes') ?? 5)
  const deadline = Date.now() + minutes * 60000
  let conversationId = null
  while (Date.now() < deadline && conversationId == null) {
    const calls = await genesys.api(a1.token, 'GET', '/api/v2/conversations/calls').catch(() => null)
    const live = (calls?.entities ?? []).find((c) =>
      (c.participants ?? []).some((p) => (p.userId ?? p.user?.id) === me.id)
    )
    if (live != null) {
      conversationId = live.id
      log('conversation-detected', { id: conversationId, participants: brief(live).map((p) => `${p.purpose}:${p.state}`) })
      break
    }
    await sleep(2000)
  }
  if (conversationId == null) throw new Error(`no call placed within ${minutes} min`)
  const obs = await observe(a1, me, conversationId, 40)
  await page?.screenshot({ path: path.join(runDir, 'workspace-during.png') }).catch(() => {})
  await finalEvidence(a1, conversationId, obs)
  log('done', { runDir, note: 'call left up — hang up in the workspace when finished' })
}

const main = async () => {
  if (process.argv.includes('--watch')) return await watchMode()
  const a1 = genesys.actors().a1
  const me = await a1.whoAmI()
  log('actor', me)
  log('target', { dest: DEST, expectRoom: ROOM, expectDevice: DEVICE })

  const pre = { cisco: await cisco.summary(), pexip: await pexip.summary() }
  log('preflight', { ciscoCalls: pre.cisco.calls, pexip: pexipBrief(pre.pexip) })
  if (
    !process.argv.includes('--force') &&
    ((pre.cisco.calls ?? []).length > 0 || (pre.pexip.conferences ?? []).length > 0)
  ) {
    throw new Error('lab not idle (codec call or live conference) — clear it or pass --force')
  }

  const ctx = await app.launch({ who: 'a1' })
  let conversationId = null
  try {
    const phonePage = await app.openPhoneHost(ctx)
    log('phone-hosted', true)
    await sleep(3000)

    // acdAutoAnswer only applies to an ON QUEUE agent, and only to an ACD
    // interaction — i.e. a call placed on behalf of a queue.
    if (QUEUE_ID != null) {
      log('agent-onqueue', await a1.onQueue().catch((e) => String(e.message).slice(0, 80)))
      await sleep(2000)
    }

    // ---- place the outbound call ----
    let resp = null
    for (const target of [`sip:${DEST}`, DEST]) {
      const body = { phoneNumber: target }
      if (QUEUE_ID != null) body.callFromQueueId = QUEUE_ID
      const r = await genesys
        .api(a1.token, 'POST', '/api/v2/conversations/calls', body)
        .then((j) => ({ ok: true, j }))
        .catch((e) => ({ ok: false, err: String(e.message).slice(0, 300) }))
      log('post-calls', { target, queue: QUEUE_ID ?? null, ok: r.ok, id: r.j?.id, err: r.err })
      if (r.ok) { resp = r.j; break }
    }
    if (resp == null) throw new Error('POST /conversations/calls rejected every target form')
    conversationId = resp.id
    a1.conversationId = conversationId

    // ---- answer the agent's own station ----
    const agentConnected = async () => {
      const c = await genesys.api(a1.token, 'GET', `/api/v2/conversations/calls/${conversationId}`).catch(() => null)
      const mine = (c?.participants ?? []).find((p) => (p.userId ?? p.user?.id) === me.id)
      return (mine?.calls?.[0]?.state ?? mine?.state) === 'connected'
    }
    // With a queue call + acdAutoAnswer the station answers itself; only fall
    // back to clicking if it has not connected shortly.
    let answered = await waitUntilTrue(agentConnected, 15000)
    log('agent-auto-answered', answered)
    if (!answered) {
      answered = await app.answerViaUi(phonePage, 30000, agentConnected)
      log('agent-station-answered-by-click', answered)
    }
    await phonePage.screenshot({ path: path.join(runDir, 'workspace.png') }).catch(() => {})

    const obs = await observe(a1, me, conversationId, 30)
    await finalEvidence(a1, conversationId, obs)

    if (!process.argv.includes('--no-teardown')) {
      await cisco.disconnect().catch(() => {})
      await a1.findCall().catch(() => null)
      await a1.disconnect().catch((e) => log('genesys-disconnect-err', String(e.message).slice(0, 120)))
      await sleep(4000)
      log('after-teardown', { pexip: pexipBrief(await pexip.summary().catch(() => null)), cisco: (await cisco.calls().catch(() => [])).length })
      await a1.completeWrapup().catch(() => {})
      if (QUEUE_ID != null) await a1.offQueue().catch(() => {})
    } else {
      log('LEFT UP', 'call still live (--no-teardown)')
    }
    log('done', { runDir })
  } finally {
    if (!process.argv.includes('--no-teardown')) await ctx.close().catch(() => {})
  }
}

main().catch((e) => {
  log('ERROR', String(e.message))
  process.exit(1)
})
