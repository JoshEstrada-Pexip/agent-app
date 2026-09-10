/**
 * S7.x — duplicate-agent-leg scenarios that own their whole call flow (the
 * embedded workspace widget is the instance under test). Registered from
 * lab.cjs (`customFlows = require('./scenarios/s7.cjs').flows`); each flow is
 * called as flow(run, a1, a2, opts, lab) where `lab` = { preflight, tearDown,
 * waitUntil, sleep } from lab.cjs. Run-package conventions are the standard
 * ones so `assess` applies unchanged.
 *
 * Bug under test: a widget instance that boots while the call is only ALERTING
 * stays subscribed; Genesys loads a fresh instance per (re-)alert; on answer
 * every instance joins the VMR (N misses => N+1 legs) and duplicate legs also
 * defeat the customer-hang-up teardown (F-24). Root cause found live
 * (S7.4, 2026-09-08 20:45): ONE instance receiving two connect events made two
 * request_token calls (fixed build logs lifecycle/join-suppressed instead).
 *
 * Org behaviour (live 2026-09-08): the ACD alert does not time out within
 * 120 s; the unanswered leg ends `terminated/client` only when the agent is
 * re-armed (onQueue), and Genesys removes the widget iframe at that moment and
 * creates a new one for the re-alert (both show the "Incoming call" pane).
 */
const path = require('path')
const pexip = require('../actors/pexip.cjs')
const cisco = require('../actors/cisco.cjs')
const genesys = require('../actors/genesys.cjs')
const app = require('../actors/app.cjs')
const { CHANNEL_RE } = require('../assess.cjs')

// ---------------------------------------------------------------- helpers
const isWidget = (u) => u != null && /agent-app/i.test(u)

/** WebRTC legs in the run's OWN VMR; stale VMRs from earlier runs are never counted. */
const agentLegCount = (px, vmr) => (px?.participants ?? []).filter((p) => p.protocol === 'WebRTC' && (vmr == null || p.conference === vmr)).length

/** The run's VMR from a roster snapshot: the conference holding the customer's (non-Genesys) SIP leg, else the only conference. */
const vmrOf = (px) => {
  const cust = (px?.participants ?? []).find((p) => p.protocol === 'SIP' && !/GENESYS/i.test(p.vendor ?? ''))
  if (cust != null) return cust.conference
  return (px?.conferences ?? []).length === 1 ? px.conferences[0].name : null
}

/** Distinct sessionId values in the widget's structured log lines = app instances seen (production bundle has no capture). */
const sessionIdsOf = (consoleLog) =>
  new Set(
    (consoleLog ?? [])
      .filter((e) => e.src == null || isWidget(e.src))
      .map((e) => {
        try {
          return typeof e.text === 'string' && e.text.startsWith('{"category"') ? JSON.parse(e.text).sessionId : null
        } catch {
          return null
        }
      })
      .filter(Boolean)
  )

/** Console/network of the workspace page scoped to the widget frame (`src` / `frame` recorded by instrument()). */
const widgetScoped = (page) => ({
  net: (page.networkLog ?? []).filter((e) => e.frame == null || isWidget(e.frame)),
  con: (page.consoleLog ?? []).filter((e) => e.src == null || isWidget(e.src)),
  scoped: (page.networkLog ?? []).some((e) => e.frame != null)
})

const count2xx = (net, re) => net.filter((e) => e.method === 'POST' && re.test(e.url ?? '') && e.status >= 200 && e.status < 300).length
const channelsCreated = (net) => count2xx(net, CHANNEL_RE)
const REQUEST_TOKEN_RE = /\/request_token$/

/** Launch the persistent profile and open the workspace with the embedded widget ALLOWED and instrumented. */
const openEmbeddedWorkspace = async (run, opts, note) => {
  const labCtx = await app.launch({ headless: opts.headless })
  const page = await app.openPhoneHost(labCtx, { embedded: true })
  run.appCtxPages = { phone: page }
  run.log('phone-host-ready', { embedded: true, note: note ?? 'embedded widget ALLOWED — it is the instance under test' })
  return { labCtx, page }
}

/** Genesys transition watcher that can be stopped early (custom flows run for minutes). */
const startWatcher = (a1, conversationId, seconds = 600) => {
  let stopped = false
  const promise = genesys.watchConversation(a1.token, conversationId, seconds, null, () => stopped).catch(() => [])
  return { promise, stop: () => (stopped = true) }
}

/**
 * One probe = Pexip roster + widget iframes + panes + sessionIds, saved as
 * pexip-<label>.json / <label>.png and logged as probe-<label>.
 */
const probe = async (run, page, label, { settleMs = 500 } = {}) => {
  if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs))
  const px = await pexip.summary()
  run.save(`pexip-${label}.json`, px)
  const widgets = await app.widgetStates(page)
  const vmr = run.vmr ?? vmrOf(px)
  const out = {
    agentLegs: agentLegCount(px, vmr),
    widgetFrames: widgets.length,
    panes: widgets.map((w) => w.pane ?? (w.selfview ? 'video' : null)),
    selfview: widgets.some((w) => w.selfview),
    sessionIds: [...sessionIdsOf(page.consoleLog)].map((x) => x.slice(0, 6)),
    allFrames: page.frames().filter((f) => f !== page.mainFrame()).map((f) => f.url().slice(0, 90))
  }
  run.log(`probe-${label}`, out)
  await page.screenshot({ path: path.join(run.dir, `${label}.png`) }).catch(() => {})
  return { ...out, px, widgets }
}

/** Widget-scoped counters for a summary file. */
const telemetry = (page, { dump = null, conversationId = null } = {}) => {
  const { net, con, scoped } = widgetScoped(page)
  const fromDump = Array.isArray(dump) ? dump.filter((s) => (s.entries ?? []).some((e) => e.kind === 'context' && e.data?.conversationId === conversationId)).length : null
  const sessionIds = sessionIdsOf(con)
  return {
    captureInstances: fromDump ?? (sessionIds.size > 0 ? sessionIds.size : null),
    captureInstancesSource: fromDump != null ? 'capture dump' : sessionIds.size > 0 ? 'structured-log sessionIds' : 'unavailable',
    sessionIds: [...sessionIds],
    channelsCreated: channelsCreated(net),
    requestTokens: count2xx(net, REQUEST_TOKEN_RE),
    channelsScope: scoped ? 'widget frame' : 'whole workspace page (frame not recorded)'
  }
}

/** Save the workspace page's console/network and the widget capture dump (if the build exposes it). */
const saveWorkspaceArtifacts = async (run, page) => {
  const dump = await app.widgetCaptureDump(page).catch(() => null)
  run.save('app-capture.json', dump ?? 'unavailable')
  run.save('app-console.json', page.consoleLog ?? [])
  run.save('app-network.json', page.networkLog ?? [])
  return dump
}

/**
 * Select the video tool in the workspace the way a real agent does. Tries a
 * labelled control, the Tools menu, then geometry (left-most icon of the
 * interaction tool strip, searched across same-origin frames). Returns how it
 * clicked or null (logged as tool-strip-controls / tools-menu-items).
 * Live 2026-09-08: NOT FOUND in this org's layout for every attempt so far.
 */
const clickTool = async (run, page) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const main = page.mainFrame()
  const byText = main.locator('button, [role=button], [role=tab]').filter({ hasText: /pexip|video/i }).first()
  if (await byText.isVisible({ timeout: 1000 }).catch(() => false)) {
    await byText.click()
    return 'text-match'
  }
  const byLabel = main.locator('[aria-label*="exip" i], [title*="exip" i], [aria-label*="ideo" i], [title*="ideo" i]').first()
  if (await byLabel.isVisible({ timeout: 1000 }).catch(() => false)) {
    await byLabel.click()
    return 'label-match'
  }
  const tools = page.getByText(/^Tools$/).first()
  if (await tools.isVisible({ timeout: 1000 }).catch(() => false)) {
    await tools.click()
    await sleep(800)
    await page.screenshot({ path: path.join(run.dir, 'tools-menu.png') }).catch(() => {})
    run.log('tools-menu-items', await page.evaluate(() => Array.from(document.querySelectorAll('[role=menuitem], [role=option], li, label')).map((e) => (e.textContent || '').trim().slice(0, 60)).filter((t) => t !== '').slice(0, 40)))
    const item = page.locator('[role=menuitem], [role=option], li, label').filter({ hasText: /pexip|video/i }).first()
    if (await item.isVisible({ timeout: 1000 }).catch(() => false)) {
      await item.click()
      return 'tools-menu'
    }
  }
  const SEL = 'button, [role=button], [role=tab], a, div[tabindex]'
  for (const frame of page.frames()) {
    const strip = await frame
      .evaluate(
        (sel) =>
          Array.from(document.querySelectorAll(sel))
            .map((b, i) => {
              const r = b.getBoundingClientRect()
              return { i, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), label: (b.getAttribute('aria-label') || b.getAttribute('title') || b.textContent || '').trim().slice(0, 40), tag: b.tagName }
            })
            .filter((b) => b.w > 0 && b.h > 0 && b.y > 100 && b.y < 170 && b.x > 850 && b.w <= 70),
        SEL
      )
      .catch(() => [])
    if (strip.length === 0) continue
    run.log('tool-strip-controls', { frame: frame.url().slice(0, 60), strip })
    const target = strip.sort((a, b) => a.x - b.x)[0]
    await frame
      .locator(SEL)
      .nth(target.i)
      .click({ timeout: 5000 })
      .catch(async () => {
        const box = await frame.frameElement().then((el) => el?.boundingBox()).catch(() => null)
        await page.mouse.click((box?.x ?? 0) + target.x + target.w / 2, (box?.y ?? 0) + target.y + target.h / 2)
      })
    return `geometry:${target.label || target.tag}@${target.x},${target.y} in ${frame.url().slice(0, 40)}`
  }
  return null
}

const helpers = { isWidget, agentLegCount, vmrOf, sessionIdsOf, widgetScoped, channelsCreated, count2xx, REQUEST_TOKEN_RE, openEmbeddedWorkspace, startWatcher, probe, telemetry, saveWorkspaceArtifacts, clickTool }

// ------------------------------------------------------------------ flows
const flows = {
  /**
   * S7.1 MISS-THEN-ANSWER. Auto-answer OFF; alert 1 left unanswered (up to
   * --alert-wait s) -> re-arm -> re-alert -> answer -> count legs, iframes,
   * instances, channels; record the missed leg's disconnectType.
   * Expected fixed: 1 leg + 1 iframe (live PASS S7_1-2026-09-08T19-18-29-913Z).
   * Artifacts: pexip-after-miss.json, pexip-after-answer.json, s71-summary.json.
   */
  'S7.1': async (run, a1, a2, opts, lab) => {
    const { labCtx, page } = await openEmbeddedWorkspace(run, opts)
    await a1.setAutoAnswer(false)
    run.log('a1-auto-answer', false)
    let watcher = null
    try {
      await lab.preflight(run)
      run.log('agent-onqueue', await a1.onQueue())
      run.log('cisco-dial', (await cisco.dial(opts.dialTarget)).status)
      const alert1 = await a1.waitLegState('alerting', 60000)
      run.log('alert-1', alert1)
      watcher = startWatcher(a1, alert1.conversationId)
      await lab.sleep(3000)
      const w1 = await app.widgetStates(page)
      run.log('widgets-during-alert-1', w1)
      await page.screenshot({ path: path.join(run.dir, 'alert-1.png') }).catch(() => {})
      const alertWaitMs = (opts.alertWaitSec ?? 120) * 1000
      run.log('step', `let alert 1 go unanswered (up to ${alertWaitMs / 1000} s)`)
      const missed = await lab.waitUntil(async () => (await a1.legs()).find((l) => l.id === alert1.id && l.state !== 'alerting'), alertWaitMs, 2000)
      run.log('alert-1-timed-out', missed ?? `still alerting after ${alertWaitMs / 1000} s (this org: the leg ends only when the agent is re-armed)`)
      run.save('pexip-after-miss.json', await pexip.summary())
      run.log('widgets-after-miss', await app.widgetStates(page))
      run.log('step', 'agent back on queue (re-arm) -> wait for re-alert')
      run.log('agent-onqueue-again', await a1.onQueue())
      const alert2 = await a1.waitLegState('alerting', 120000, alert1.id)
      run.log('alert-2', alert2)
      await lab.sleep(3000)
      const w2 = await app.widgetStates(page)
      run.log('widgets-during-alert-2', w2)
      await page.screenshot({ path: path.join(run.dir, 'alert-2.png') }).catch(() => {})
      run.log('step', 'answer alert 2 (UI click, PATCH fallback)')
      let answered = await app.answerViaUi(page, 20000, async () => (await a1.findCall())?.state === 'connected')
      if (!answered) {
        await a1.answer().catch((e) => run.log('answer-patch-error', String(e.message).slice(0, 160)))
        answered = (await a1.waitConnected(20000).catch(() => null))?.state === 'connected'
      }
      run.log('answered', answered)
      const connected = await a1.findCall()
      run.log('agent-connected', connected)
      const px0 = await pexip.summary()
      run.save('pexip-after-connect.json', px0)
      run.vmr = vmrOf(px0)
      await lab.sleep(10000) // let every armed widget instance join the VMR
      const after = await probe(run, page, 'after-answer', { settleMs: 0 })
      run.log('app-state-after-join', { selfview: after.selfview, found: [], widgets: after.widgets })
      run.save('pexip-after-video-join.json', after.px)
      const dump = await saveWorkspaceArtifacts(run, page)
      const t = telemetry(page, { dump, conversationId: connected?.conversationId })
      const legs = await a1.legs()
      const summary = {
        alert1,
        alert2,
        missedLeg: legs.find((l) => l.id === alert1.id) ?? missed ?? null,
        answered,
        agentLegsAfterAnswer: after.agentLegs,
        widgetFramesDuringAlert: w1.length,
        widgetFramesDuringReAlert: w2.length,
        widgetFramesAfterAnswer: after.widgetFrames,
        alertPanes: { alert1: w1.map((w) => w.pane), alert2: w2.map((w) => w.pane) },
        ...t,
        expected: { fixed: '1 agent leg, 1 widget frame', original: '2 agent legs (one per widget instance)' }
      }
      run.save('s71-summary.json', summary)
      run.log('s71-summary', summary)
      await lab.sleep(3000)
      run.save('pexip-after-steps.json', await pexip.summary())
      run.save('cisco-after-steps.json', await cisco.summary())
    } finally {
      await saveWorkspaceArtifacts(run, page).catch(() => {})
      await a1.setAutoAnswer(true).catch(() => {})
      run.log('a1-auto-answer', true)
      await lab.tearDown(run, a1)
      watcher?.stop()
      await labCtx.close().catch(() => {})
      if (watcher != null) run.save('genesys-timeline.json', await watcher.promise)
    }
    return { conversationId: a1.conversationId }
  },

  /**
   * S7.4 WIDGET-TAB PROBE (live 2026-09-08 20:42-20:51). Auto-answer ON; the
   * workspace preloads the widget for the alert. After the answer: does
   * selecting the video tool (what a real agent does) create a second instance?
   * Probes roster/frames/panes/sessionIds after answer, after the tool click,
   * after a second click, then the AGENT ends the call from Genesys and the VMR
   * must go down. Root cause reproduced in 20-45-39: ONE instance made TWO
   * request_token calls (two connect events) -> superseded itself -> VMR left
   * up after the agent hang-up; fixed build (20-50-57): one request_token,
   * lifecycle/join-suppressed, VMR gone. Artifacts: pexip-after-answer-no-click /
   * after-tool-click / after-tool-click-2 / after-agent-hangup .json, s74-summary.json.
   */
  'S7.4': async (run, a1, a2, opts, lab) => {
    const { labCtx, page } = await openEmbeddedWorkspace(run, opts, 'embedded widget ALLOWED — workspace tool-strip probe')
    await a1.setAutoAnswer(true)
    let watcher = null
    try {
      await lab.preflight(run)
      run.log('agent-onqueue', await a1.onQueue())
      run.log('cisco-dial', (await cisco.dial(opts.dialTarget)).status)
      const connected = await a1.waitConnected(90000)
      run.log('agent-connected', connected)
      watcher = startWatcher(a1, connected.conversationId)
      const px0 = await pexip.summary()
      run.save('pexip-after-connect.json', px0)
      run.vmr = vmrOf(px0)
      await lab.sleep(10000)
      const first = await probe(run, page, 'after-answer-no-click')
      run.log('app-state-after-join', { selfview: first.selfview, found: [], widgets: first.widgets })
      run.save('pexip-after-video-join.json', first.px)
      run.log('step', 'select the video tool in the workspace (like a real agent)')
      run.log('tool-click', (await clickTool(run, page)) ?? 'NOT FOUND')
      await lab.sleep(10000)
      const second = await probe(run, page, 'after-tool-click')
      run.log('step', 'click the tool again (deselect/reselect)')
      run.log('tool-click-2', (await clickTool(run, page)) ?? 'NOT FOUND')
      await lab.sleep(6000)
      const third = await probe(run, page, 'after-tool-click-2')
      run.save('pexip-after-steps.json', third.px)
      run.save('cisco-after-steps.json', await cisco.summary())
      run.log('step', 'AGENT ends the call from Genesys (API disconnect) — does the VMR go down?')
      await a1.disconnect().catch((e) => run.log('agent-disconnect-error', String(e.message).slice(0, 160)))
      await lab.sleep(10000)
      const last = await probe(run, page, 'after-agent-hangup')
      run.log('vmr-after-agent-hangup', { conferences: last.px.conferences.map((c) => c.name), participants: last.px.participants.map((p) => `${p.protocol}:${p.displayName}`) })
      const dump = await saveWorkspaceArtifacts(run, page)
      const t = telemetry(page, { dump, conversationId: connected.conversationId })
      run.save('s74-summary.json', {
        vmr: run.vmr,
        legsAtProbes: { afterAnswer: first.agentLegs, afterToolClick: second.agentLegs, afterToolClick2: third.agentLegs, afterAgentHangup: last.agentLegs },
        widgetFramesAtProbes: [first.widgetFrames, second.widgetFrames, third.widgetFrames, last.widgetFrames],
        joinSuppressed: (page.consoleLog ?? []).some((e) => /"event":"join-suppressed"/.test(e.text ?? '')),
        vmrGoneAfterAgentHangup: !last.px.conferences.some((c) => c.name === run.vmr),
        ...t,
        expected: { fixed: 'one request_token per instance, join-suppressed on a second connect event, 1 leg, VMR gone after the agent hang-up' }
      })
      return { conversationId: connected.conversationId }
    } finally {
      await saveWorkspaceArtifacts(run, page).catch(() => {})
      await lab.tearDown(run, a1)
      await a1.setAutoAnswer(true).catch(() => {})
      watcher?.stop()
      await labCtx.close().catch(() => {})
      if (watcher != null) run.save('genesys-timeline.json', await watcher.promise)
    }
  }
}

module.exports = { flows, helpers }
