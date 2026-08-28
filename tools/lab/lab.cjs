#!/usr/bin/env node
/**
 * Lab harness CLI — one command per operation, everything logged to a run
 * directory, one report to read at the end. Supersedes ad-hoc driving.
 *
 * Usage:
 *   node tools/lab/lab.cjs status                     # snapshot all 3 systems
 *   node tools/lab/lab.cjs call start|stop|stats
 *   node tools/lab/lab.cjs agent a1 on|off|whoami|auto-answer-on
 *   node tools/lab/lab.cjs do a1 hold|unhold|mute|unmute|disconnect|wrapup
 *   node tools/lab/lab.cjs watch <convId> <seconds>
 *   node tools/lab/lab.cjs app login                  # one-time Playwright profile bootstrap
 *   node tools/lab/lab.cjs scenario S2.1 [--video] [--headless] [--pin 2021]
 *
 * Env: GENESYS_ENV, GENESYS_TOKEN_A1 [, GENESYS_TOKEN_A2],
 *      CISCO_HOST/USER/PASS [, CISCO_DIAL], (Pexip creds auto-read from
 *      ~/.claude.json pexip-mgmt or PEXIP_* env).
 */
const fs = require('fs')
const path = require('path')
const cisco = require('./actors/cisco.cjs')
const pexip = require('./actors/pexip.cjs')
const genesys = require('./actors/genesys.cjs')

const RUNS = path.join(__dirname, 'runs')

const out = (obj) => console.log(JSON.stringify(obj, null, 1))

const makeRun = (label) => {
  const dir = path.join(RUNS, `${label}-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  fs.mkdirSync(dir, { recursive: true })
  const actions = []
  const log = (action, detail) => {
    const entry = { t: new Date().toISOString(), action, detail }
    actions.push(entry)
    console.log(`[lab] ${entry.t} ${action}`, detail != null ? JSON.stringify(detail).slice(0, 200) : '')
    fs.writeFileSync(path.join(dir, 'actions.json'), JSON.stringify(actions, null, 1))
  }
  const save = (name, data) =>
    fs.writeFileSync(path.join(dir, name), typeof data === 'string' ? data : JSON.stringify(data, null, 1))
  return { dir, log, save, actions }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Preflight+dial+connect: the standard call bring-up used by every scenario. */
const bringUpCall = async (run, a1, opts) => {
  run.log('preflight-pexip', await pexip.summary())
  const pre = await cisco.summary()
  if (Array.isArray(pre.calls) && pre.calls.length > 0) {
    run.log('preflight-cisco-CLEARING-stale-calls', pre.calls)
    await cisco.disconnect().catch(() => {})
    await sleep(3000)
  }
  run.log('preflight-cisco', await cisco.summary())
  run.log('agent-onqueue', await a1.onQueue())
  run.log('cisco-dial', await cisco.dial(opts.dialTarget).then((r) => r.status))
  // PIN fallback: policy normally admits without it; send only if the Genesys
  // leg has not appeared in time (ADP fires once the conference starts).
  const connected = await Promise.race([
    a1.waitConnected(30000).catch(() => null),
    (async () => {
      await sleep(12000)
      if (a1.conversationId == null && opts.pin != null) {
        run.log('pin-fallback', opts.pin)
        await cisco.sendDtmf(`${opts.pin}#`)
      }
      return null
    })()
  ])
  const final = connected ?? (await a1.waitConnected(30000))
  run.log('agent-connected', final)
  run.save('pexip-after-connect.json', await pexip.summary())
  return final
}

const tearDown = async (run, a1) => {
  await cisco.disconnect().catch(() => {})
  run.log('cisco-disconnected', true)
  await a1.disconnect().catch(() => {})
  await sleep(2000)
  run.log('wrapup', await a1.completeWrapup().catch((e) => String(e.message)))
  await a1.offQueue().catch(() => {})
  run.log('agent-offqueue', true)
  run.save('pexip-after-teardown.json', await pexip.summary())
}

// --------------------------------------------------------------------------
// Scenarios: each = timed steps against a brought-up call, with a Genesys
// watcher recording every transition in parallel.
// --------------------------------------------------------------------------
const scenarioSteps = {
  'S2.1': async (run, a1) => {
    // Wire truth = the app's own WebRTC outbound-rtp video stats: bytesSent
    // deltas between samples. Two baseline samples 2s apart measure live tx.
    const rtc = async (label) => {
      if (run.app != null) run.save(`webrtc-${label}.json`, await run.app.webrtcStats())
    }
    await rtc('baseline-a')
    await sleep(2000)
    await rtc('baseline-b')
    run.log('step', 'hold')
    await a1.hold(true)
    await sleep(2000)
    await rtc('hold-2s')
    if (run.app != null) {
      run.log('app-state-during-hold', await run.app.state())
      await run.app.screenshot('during-hold')
    }
    await sleep(4000)
    await rtc('hold-6s')
    run.save('cisco-during-hold.json', await cisco.summary())
    await sleep(4000)
    await rtc('hold-10s')
    run.log('step', 'unhold')
    await a1.hold(false)
    await sleep(3000)
    await rtc('unhold-3s')
    await sleep(3000)
    await rtc('unhold-6s')
  },
  'S2.2': async (run, a1) => {
    // Rapid flaps with NO settle — the out-of-order/last-write-wins race
    // (review findings P1/R5). Final wire state must match final command.
    const rtc = async (label) => {
      if (run.app != null) run.save(`webrtc-${label}.json`, await run.app.webrtcStats())
    }
    await rtc('baseline-a')
    await sleep(2000)
    await rtc('baseline-b')
    run.log('step', 'rapid-flap hold/unhold x2')
    await a1.hold(true)
    await a1.hold(false)
    await a1.hold(true)
    await a1.hold(false)
    await sleep(4000)
    await rtc('after-flap-4s')
    await sleep(4000)
    await rtc('after-flap-8s') // ends UNHELD: video must be LIVE here
    // Hold AGAIN and stay held — the "hold back on" edge: must end dark.
    run.log('step', 'hold-again')
    await a1.hold(true)
    await sleep(3000)
    await rtc('hold-again-3s')
    await sleep(4000)
    await rtc('hold-again-7s') // must be DARK here
    run.log('step', 'final-unhold')
    await a1.hold(false)
    await sleep(4000)
    await rtc('final-unhold-4s') // must be LIVE again
    if (run.app != null) run.log('app-state-final', await run.app.state())
  },
  'S2.5': async (run, a1) => {
    const rtc = async (label) => {
      if (run.app != null) run.save(`webrtc-${label}.json`, await run.app.webrtcStats())
    }
    await rtc('baseline-a')
    await sleep(2000)
    await rtc('baseline-b')
    run.log('step', 'audio-mute')
    await a1.mute(true)
    await sleep(4000)
    await rtc('muted-4s') // original: video should be UNAFFECTED by audio mute
    if (run.app != null) run.log('app-state-muted', await run.app.state())
    await sleep(4000)
    await rtc('muted-8s')
    run.log('step', 'unmute')
    await a1.mute(false)
    await sleep(4000)
    await rtc('unmuted-4s')
  },
  'S2.6': async (run, a1) => {
    // Mute × hold interplay: the original SUPPRESSES mute events while held
    // (callsCallback `if (!onHoldState)`) — measure what the wire does.
    const rtc = async (label) => {
      if (run.app != null) run.save(`webrtc-${label}.json`, await run.app.webrtcStats())
    }
    await rtc('baseline-a')
    await sleep(2000)
    await rtc('baseline-b')
    run.log('step', 'mute')
    await a1.mute(true)
    await sleep(3000)
    await rtc('muted-3s')
    run.log('step', 'hold (while muted)')
    await a1.hold(true)
    await sleep(4000)
    await rtc('held-4s') // must be DARK
    await sleep(4000)
    await rtc('held-8s')
    run.log('step', 'unhold (still muted)')
    await a1.hold(false)
    await sleep(4000)
    await rtc('unheld-4s') // original: video should come BACK even though audio-muted
    run.log('step', 'unmute')
    await a1.mute(false)
    await sleep(3000)
    await rtc('unmuted-3s')
  },
  'S3.1': async (run, a1, a2) => {
    // Consult initiated then CANCELED before A2 answers. A2 never picks up,
    // so no A2 phone needed. Measures: does video mute during the consult
    // (the held=false flap window), and does it restore after cancel?
    const rtc = async (label) => {
      if (run.app != null) run.save(`webrtc-${label}.json`, await run.app.webrtcStats())
    }
    await rtc('baseline-a')
    await sleep(2000)
    await rtc('baseline-b')
    run.log('step', 'consult-start -> A2')
    await a1.consultStart(a2.userId)
    await sleep(3000)
    await rtc('consulting-3s')
    if (run.app != null) run.log('app-state-consulting', await run.app.state())
    await sleep(3000)
    await rtc('consulting-6s') // original: consult => treated as hold => DARK expected
    run.log('step', 'consult-cancel')
    await a1.consultCancel()
    await sleep(3000)
    await rtc('after-cancel-3s')
    await sleep(3000)
    await rtc('after-cancel-6s') // video must RESTORE
    if (run.app != null) run.log('app-state-after-cancel', await run.app.state())
  },
  'S3.2': async (run, a1, a2) => {
    // Answered consult, then COMPLETE (becomes a transfer to A2). A2's phone
    // is hosted in its own Playwright profile and answered via UI click
    // (direct consults are non-ACD: no auto-answer).
    const app = require('./actors/app.cjs')
    const rtc = async (label) => {
      if (run.app != null) run.save(`webrtc-${label}.json`, await run.app.webrtcStats())
    }
    const ctx2 = await app.launch({ who: 'a2' })
    try {
      const page2 = await app.openPhoneHost(ctx2)
      run.log('a2-phone-hosted', true)
      await rtc('baseline-a')
      await sleep(2000)
      await rtc('baseline-b')
      run.log('step', 'consult-start -> A2')
      await a1.consultStart(a2.userId)
      const answered = await app.answerViaUi(page2, 10000)
      run.log('a2-answer-click', answered)
      if (!answered) {
        await page2.screenshot({ path: require('path').join(run.dir, 'a2-screen-no-answer.png') }).catch(() => {})
      }
      await sleep(4000)
      await rtc('consult-active-4s') // A1 video must be DARK (customer held)
      if (run.app != null) run.log('app-state-consult-active', await run.app.state())
      await sleep(3000)
      run.log('step', 'consult-complete (transfer to A2)')
      await a1.consultComplete()
      await sleep(5000)
      await rtc('after-complete-5s')
      if (run.app != null) {
        run.log('app-state-after-complete', await run.app.state())
        await run.app.screenshot('after-complete')
      }
      await sleep(3000)
    } finally {
      await a2.findCall().catch(() => null)
      await a2.disconnect().catch(() => {})
      await sleep(1500)
      run.log('a2-wrapup', await a2.completeWrapup().catch((e) => String(e.message)))
      await ctx2.close().catch(() => {})
    }
  },
  'S4.0': async (run, a1, a2) => {
    // DISCRIMINATOR: direct transfer with NO app video leg connected. If the
    // call survives (A2 alerts / voicemail), the app's transfer teardown is
    // the killer in S4.2; if it still collapses, the cause is elsewhere.
    await sleep(2000)
    run.log('step', 'blind-transfer -> A2 (direct, no app)')
    await a1.blindTransferTo(a2.userId)
    for (let i = 1; i <= 5; i++) {
      await sleep(4000)
      const conv = await genesys.api(a1.token, 'GET', `/api/v2/conversations/${a1.conversationId}`).catch(() => null)
      const legs = conv == null ? 'gone' : (conv.participants ?? []).map((p) => `${p.purpose}:${p.calls?.[0]?.state}:${p.calls?.[0]?.disconnectType ?? ''}`)
      const px = await pexip.summary()
      run.log(`t+${i * 4}s`, { legs, vmr: px.conferences.map((c) => c.name), pexipLegs: px.participants.map((p) => `${p.protocol}:${p.displayName?.slice(0, 18)}`) })
    }
  },
  'S4.2': async (run, a1, a2) => {
    // THE STALE-LEG SCENARIO: blind transfer A1->A2, then transfer BACK while
    // A1's wrap-up is still open (old leg lingers 'disconnected'). Prediction
    // from code analysis: A1's app/bootstrap misreads the stale leg — video
    // torn down or never re-established. A1 answers the return via UI click
    // (direct transfer = non-ACD, no auto-answer). Watch everything.
    const app = require('./actors/app.cjs')
    const path2 = require('path')
    const rtc = async (label) => {
      if (run.app != null) run.save(`webrtc-${label}.json`, await run.app.webrtcStats())
    }
    const ctx2 = await app.launch({ who: 'a2' })
    try {
      const page2 = await app.openPhoneHost(ctx2)
      run.log('a2-phone-hosted', true)
      await a2.setAutoAnswer(true).catch(() => {})
      run.log('a2-onqueue', await a2.onQueue())
      await rtc('baseline-a')
      await sleep(2000)
      await rtc('baseline-b')
      // Direct-to-user transfer (queue replace errored the conversation in
      // shakedown). Non-ACD, so A2 answers via UI click on ITS hosted phone —
      // A2 must not be logged in anywhere else or the alert renders there.
      run.log('step', 'blind-transfer -> A2 (direct)')
      await a1.blindTransferTo(a2.userId)
      const a2answered = await app.answerViaUi(page2, 30000, async () => (await a2.findCall())?.state === 'connected')
      run.log('a2-answered', a2answered)
      if (!a2answered) await page2.screenshot({ path: path2.join(run.dir, 'a2-no-answer.png') }).catch(() => {})
      run.log('a2-connected', await a2.findCall())
      await sleep(4000)
      await rtc('a1-transferred-away-4s') // A1's video leg must be GONE (no sender)
      if (run.app != null) {
        run.log('a1-app-after-transfer', await run.app.state())
        await run.app.screenshot('a1-after-transfer-away')
      }
      run.log('note', 'A1 wrap-up deliberately left OPEN — stale-leg window active')
      run.save('a1-conv-legs-before-return.json', await genesys.api(a1.token, 'GET', `/api/v2/conversations/${a1.conversationId}`).then((c) => (c.participants ?? []).filter((p) => p.purpose === 'agent').map((p) => ({ name: p.name, state: p.calls?.[0]?.state, wrapupRequired: p.wrapupRequired }))))
      run.log('step', 'transfer BACK -> A1 (wrap-up still open)')
      await a2.blindTransferTo(a1.userId)
      // A1's phone is hosted in run's main Playwright ctx (phone host page = first page)
      const a1Page = run.appCtxPages?.phone
      const a1answered = a1Page != null ? await app.answerViaUi(a1Page, 30000, async () => (await a1.findCall())?.state === 'connected') : false
      run.log('a1-answered', a1answered)
      if (!a1answered && a1Page != null) await a1Page.screenshot({ path: path2.join(run.dir, 'a1-no-answer.png') }).catch(() => {})
      await sleep(5000)
      run.log('a1-after-return', await a1.findCall())
      await rtc('a1-returned-5s')
      if (run.app != null) {
        run.log('a1-app-after-return', await run.app.state())
        await run.app.screenshot('a1-after-return')
      }
      // Does a FRESH app load (reload path / isCallActive predicate) see the call?
      await sleep(3000)
      await rtc('a1-returned-8s')
    } finally {
      await a2.findCall().catch(() => null)
      if (a2.conversationId != null) {
        await a2.disconnect().catch(() => {})
        await sleep(1500)
        run.log('a2-wrapup', await a2.completeWrapup().catch((e) => String(e.message).slice(0, 120)))
      }
      await a2.offQueue().catch(() => {})
      await ctx2.close().catch(() => {})
    }
  },
  'S1.1': async (run) => {
    run.log('step', 'talk-30s')
    await sleep(30000)
    run.log('step', 'customer-hangup')
    await cisco.disconnect()
    await sleep(6000)
  }
}

const main = async () => {
  const [cmd, ...args] = process.argv.slice(2)

  if (cmd === 'status') {
    let g = 'no GENESYS_TOKEN_A1 (cisco/pexip only)'
    try {
      const acts = genesys.actors()
      await acts.a1.whoAmI()
      g = await genesys
        .api(acts.a1.token, 'GET', '/api/v2/conversations/calls')
        .then((r) => (r.entities ?? []).map((c) => ({ id: c.id, participants: (c.participants ?? []).map((p) => ({ purpose: p.purpose, state: p.state, held: p.held })) })))
    } catch (e) {
      g = `genesys unavailable: ${String(e.message).slice(0, 120)}`
    }
    out({ cisco: await cisco.summary(), pexip: await pexip.summary(), genesysActiveCalls: g })
    return
  }

  if (cmd === 'connect-test') {
    // T1: dial -> observe VMR + trunk leg raw -> disconnect. No agent needed.
    const run = makeRun('connect-test')
    run.log('preflight-cisco', await cisco.summary())
    run.log('preflight-pexip', await pexip.summary())
    run.log('dial', (await cisco.dial(args[0])).body.slice(0, 200))
    for (let i = 0; i < 6; i++) {
      await sleep(5000)
      const snap = { cisco: await cisco.summary(), pexip: await pexip.summary() }
      run.log(`snapshot-${i * 5}s`, {
        ciscoCalls: Array.isArray(snap.cisco.calls) ? snap.cisco.calls.map((c) => c.status) : snap.cisco.calls,
        vmrs: snap.pexip.conferences.map((c) => c.name),
        legs: snap.pexip.participants.map((p) => `${p.protocol}:${p.direction}:${p.displayName}:${p.hasMedia ? 'media' : 'nomedia'}`)
      })
      run.save(`raw-snapshot-${i * 5}s.json`, snap)
    }
    await cisco.disconnect()
    run.log('disconnected', true)
    await sleep(4000)
    run.save('raw-after-teardown.json', { cisco: await cisco.summary(), pexip: await pexip.summary() })
    run.save('report.md', `# connect-test\nRun dir: ${run.dir}\nRead raw-snapshot-*.json for full participant objects each 5s.`)
    console.log(`\n[lab] connect-test complete — artifacts in ${run.dir}`)
    return
  }

  if (cmd === 'call') {
    const sub = args[0]
    if (sub === 'start') return out(await cisco.dial(args[1]))
    if (sub === 'stop') return out(await cisco.disconnect())
    if (sub === 'stats') return out(await cisco.summary())
  }

  if (cmd === 'agent') {
    const acts = genesys.actors()
    const a = acts[args[0]]
    await a.whoAmI()
    const sub = args[1]
    if (sub === 'on') return out(await a.onQueue())
    if (sub === 'off') return out(await a.offQueue())
    if (sub === 'whoami') return out(await a.whoAmI())
    if (sub === 'auto-answer-on') return out(await a.setAutoAnswer(true))
    if (sub === 'auto-answer-off') return out(await a.setAutoAnswer(false))
  }

  if (cmd === 'do') {
    const acts = genesys.actors()
    const a = acts[args[0]]
    await a.whoAmI()
    const found = await a.findCall()
    if (found == null && args[1] !== 'wrapup') return out({ error: 'no active call' })
    const sub = args[1]
    if (sub === 'hold') return out(await a.hold(true))
    if (sub === 'unhold') return out(await a.hold(false))
    if (sub === 'mute') return out(await a.mute(true))
    if (sub === 'unmute') return out(await a.mute(false))
    if (sub === 'disconnect') return out(await a.disconnect())
    if (sub === 'wrapup') {
      if (a.conversationId == null) {
        const convs = await genesys.api(a.token, 'GET', '/api/v2/conversations')
        a.conversationId = convs.entities?.[0]?.id
      }
      return out(await a.completeWrapup())
    }
  }

  if (cmd === 'watch') {
    const acts = genesys.actors()
    const timeline = await genesys.watchConversation(acts.a1.token, args[0], Number(args[1] ?? 60), (e) =>
      console.log(JSON.stringify(e))
    )
    return out({ transitions: timeline.length })
  }

  if (cmd === 'app') {
    const app = require('./actors/app.cjs')
    if (args[0] === 'login') return await app.loginBootstrap(undefined, args[1] ?? 'a1')
  }

  if (cmd === 'scenario') {
    const id = args[0]
    const steps = scenarioSteps[id]
    if (steps == null) return out({ error: `unknown scenario ${id}`, known: Object.keys(scenarioSteps) })
    const withVideo = args.includes('--video')
    const headless = args.includes('--headless')
    const pinIdx = args.indexOf('--pin')
    const opts = { pin: pinIdx >= 0 ? args[pinIdx + 1] : null, dialTarget: undefined }

    const run = makeRun(id.replace('.', '_'))
    const acts = genesys.actors()
    const a1 = acts.a1
    run.log('actor', await a1.whoAmI())
    const a2 = acts.a2 ?? null
    if (a2 != null) run.log('actor2', await a2.whoAmI())

    // --video: the Playwright browser must host the agent's WebRTC phone
    // BEFORE the call arrives, or auto-answer has nothing to answer with.
    // A1's WebRTC phone must ALWAYS be hosted or nothing can answer (F-05).
    const app = require('./actors/app.cjs')
    const labCtx = await app.launch({ headless })
    const phonePage = await app.openPhoneHost(labCtx)
    run.appCtxPages = { phone: phonePage }
    run.log('phone-host-ready', true)

    const connected = await bringUpCall(run, a1, opts)

    // Parallel: Genesys transition watcher for the whole scenario window
    const watcher = genesys.watchConversation(a1.token, connected.conversationId, 90)

    let appHandle = null
    if (withVideo) {
      const app = require('./actors/app.cjs')
      appHandle = await app.openForConversation(connected.conversationId, { headless, runDir: run.dir, ctx: labCtx })
      const joined = await appHandle.waitForState((s) => s.selfview === true || (s.found ?? []).length > 0, 45000)
      run.log('app-state-after-join', joined)
      await appHandle.screenshot('after-join')
      run.save('pexip-after-video-join.json', await pexip.summary())
      run.app = appHandle
    }

    await steps(run, a1, a2)

    run.save('pexip-after-steps.json', await pexip.summary())
    run.save('cisco-after-steps.json', await cisco.summary())
    if (appHandle != null) {
      run.log('app-state-after-steps', await appHandle.state())
      await appHandle.screenshot('after-steps')
      run.save('app-capture.json', (await appHandle.captureDump()) ?? 'unavailable')
      run.save('app-console.json', appHandle.consoleLog)
      run.save('app-network.json', appHandle.networkLog)
      await appHandle.close()
    }

    await tearDown(run, a1)
    await labCtx.close().catch(() => {})
    run.save('genesys-timeline.json', await watcher)

    const report = [
      `# Run report — ${id}`,
      `Run dir: ${run.dir}`,
      `Conversation: ${connected.conversationId}`,
      `Actions: ${run.actions.length} (actions.json)`,
      `Artifacts: genesys-timeline.json, pexip-*.json, cisco-after-steps.json` +
        (withVideo ? ', app-capture.json, app-console.json, screenshots' : ''),
      `NOTE: read genesys-timeline.json for held/muted transitions; compare with app-capture ws-events.`
    ].join('\n')
    run.save('report.md', report)
    console.log('\n' + report)
    return
  }

  console.log('commands: status | call start|stop|stats | agent <a1|a2> on|off|whoami|auto-answer-on|auto-answer-off | do <a1|a2> hold|unhold|mute|unmute|disconnect|wrapup | watch <convId> <sec> | app login | scenario <id> [--video] [--headless] [--pin 2021]')
}

main().catch((err) => {
  console.error('[lab] FAILED:', err.message)
  process.exit(1)
})
