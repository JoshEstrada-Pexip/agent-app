/**
 * Agent-app actor — runs the app under Playwright in a persistent Chrome
 * profile with a FAKE camera (deterministic test video) and auto-granted
 * media permissions. Records console + capture + screenshots per run.
 *
 * One-time bootstrap: `lab app login` opens Genesys for a manual agent login;
 * the session persists in .lab-profile/ afterwards.
 */
const path = require('path')

const PROFILE_DIR = path.join(__dirname, '..', '.lab-profile')
/** One persistent profile per agent: a1 -> .lab-profile, a2 -> .lab-profile-a2 */
const profileDir = (who = 'a1') =>
  who === 'a1' ? PROFILE_DIR : path.join(__dirname, '..', `.lab-profile-${who}`)
const APP_BASE = process.env.APP_BASE ?? 'https://localhost:3000/telecom/agent-app/'

const loadPlaywright = () => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('playwright')
  } catch {
    throw new Error('playwright not installed — run: npm i -D playwright && npx playwright install chromium')
  }
}

const launch = async ({ headless = false, who = 'a1' } = {}) => {
  const { chromium } = loadPlaywright()
  const ctx = await chromium.launchPersistentContext(profileDir(who), {
    headless,
    ignoreHTTPSErrors: true,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--ignore-certificate-errors'
    ]
  })
  return ctx
}

/** One-time: open Genesys so the agent can log in; session persists. */
const loginBootstrap = async (env, who = 'a1') => {
  const ctx = await launch({ headless: false, who })
  const page = await ctx.newPage()
  await page.goto(`https://apps.${env ?? process.env.GENESYS_ENV}`)
  console.log(`[app] Log agent '${who}' in, complete MFA, then close the browser window.`)
  await new Promise((resolve) => ctx.on('close', resolve))
}

/**
 * Answers an alerting call by clicking the workspace's Answer control —
 * needed for direct (non-ACD) consults/transfers, which never auto-answer.
 * SHAKEDOWN: selector validated on first live use.
 */
const answerViaUi = async (page, timeoutMs = 30000, isConnected = null) => {
  const deadline = Date.now() + timeoutMs
  // Toasts are transient and sometimes native (not DOM); the reliable Answer
  // control lives in Agent Workspace. Enter it first (idempotent).
  try {
    const ws = page.getByRole('button', { name: /agent workspace/i }).first()
    if (await ws.isVisible({ timeout: 1500 }).catch(() => false)) {
      await ws.click()
      await new Promise((r) => setTimeout(r, 1500))
    }
  } catch {
    /* already there or different chrome */
  }
  // Strict candidates only — a loose text match once clicked a phantom
  // "answer" before the alert existed. Success is verified by CALL STATE
  // (isConnected callback), never by the click itself.
  const candidates = (frame) => [
    frame.getByRole('button', { name: /^answer( call)?$/i }).first(),
    frame.locator('[data-testid*="answer" i]').first(),
    frame.locator('gux-button:has-text("Answer")').first()
  ]
  let clicked = false
  while (Date.now() < deadline) {
    if (isConnected != null && (await isConnected().catch(() => false))) return true
    for (const frame of page.frames()) {
      for (const btn of candidates(frame)) {
        try {
          if (await btn.isVisible({ timeout: 150 }).catch(() => false)) {
            await btn.click()
            clicked = true
          }
        } catch {
          /* frame navigating */
        }
      }
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  return isConnected == null ? clicked : false
}

const appUrl = (conversationId) => {
  const params = new URLSearchParams({
    pcEnvironment: process.env.GENESYS_ENV,
    pcConversationId: conversationId,
    pexipNode: process.env.PEXIP_NODE ?? 'pex-simon-conf1.genesys.pexsupport.com',
    pexipAgentPin: process.env.PEXIP_AGENT_PIN ?? '2021',
    pexipAppPrefix: process.env.PEXIP_APP_PREFIX ?? 'app_'
  })
  return `${APP_BASE}?${params}`
}

/**
 * Opens the app for a conversation and waits for a terminal UI state.
 * Returns handles for state polling, console log, capture dump, screenshots.
 */
const instrument = (page) => {
  const consoleLog = []
  const networkLog = []
  // `src` (script URL of the console call) and `frame` (initiator frame URL) let
  // an embedded-widget run (S7.1: the whole Genesys workspace is the page) be
  // scoped to the widget's own console/network lines in assess.
  page.on('console', (msg) => {
    let src = null
    try {
      src = msg.location()?.url?.slice(0, 160) ?? null
    } catch {
      /* not available on this Playwright version */
    }
    consoleLog.push({ t: new Date().toISOString(), type: msg.type(), text: msg.text().slice(0, 500), src })
  })
  // Full API request/response record — Genesys platform calls and the Pexip
  // client API. Bodies kept for JSON responses (capped) so every API answer
  // the app acted on is in the run artifacts.
  page.on('response', (res) => {
    void (async () => {
      const url = res.url()
      if (!/api\.|pure\.cloud|pexsupport\.com|\/api\/client\//.test(url)) return
      let frame = null
      try {
        frame = res.frame()?.url()?.slice(0, 160) ?? null
      } catch {
        /* detached frame */
      }
      const entry = {
        t: new Date().toISOString(),
        method: res.request().method(),
        url: url.slice(0, 200),
        status: res.status(),
        frame
      }
      try {
        const ct = res.headers()['content-type'] ?? ''
        if (ct.includes('json')) entry.body = (await res.text()).slice(0, 4000)
      } catch {
        /* response body unavailable (redirect/aborted) */
      }
      networkLog.push(entry)
    })()
  })
  return { consoleLog, networkLog }
}

/**
 * Hosts the agent's WebRTC phone: opens the Genesys workspace in the given
 * context so ACD auto-answer has a phone to answer with. Must be up BEFORE
 * the inbound call is placed.
 */
const openPhoneHost = async (ctx, { embedded = false } = {}) => {
  const page = await ctx.newPage()
  // The workspace embeds the widget for the selected interaction, which would
  // join the VMR as a second agent leg next to the instance the harness opens
  // itself (seen 2026-09-03: two "agent" WebRTC legs, which defeats the app's
  // last-participant check on customer hang-up). This tab exists only to host
  // the phone, so block EVERY agent-app URL here — including APP_BASE itself,
  // which matters when the harness is pointed at the Pages build. Logged so
  // the source is on record. (Workspace-mode runs use openWorkspace instead.)
  //
  // `embedded: true` (S7.1, UNVALIDATED 2026-09-08) does the opposite: the
  // embedded widget IS the instance under test, so nothing is blocked and the
  // page is instrumented (console/network) like openForConversation's page.
  if (!embedded) {
    await page.route(
      (url) => /agent-app/i.test(url.href),
      (route) => {
        console.log(`[app] blocked embedded widget in phone host: ${route.request().url().slice(0, 120)}`)
        route.abort().catch(() => {})
      }
    )
  } else {
    const { consoleLog, networkLog } = instrument(page)
    page.consoleLog = consoleLog
    page.networkLog = networkLog
  }
  await page.goto(`https://apps.${process.env.GENESYS_ENV}`, { waitUntil: 'domcontentloaded' })
  // Give the embedded WebRTC phone time to register (heuristic; shakedown).
  await new Promise((r) => setTimeout(r, 10000))
  return page
}

/**
 * Embedded-widget helpers for a workspace page opened with `embedded: true`.
 * Genesys renders one widget iframe per interaction render; Playwright pierces
 * cross-origin frames so each iframe's DOM and window are reachable.
 * UNVALIDATED (2026-09-08): frame URL matching and the capture hook reachability
 * (production bundles ship without VITE_CAPTURE_EVENTS) are to be confirmed live.
 */
const widgetFrames = (page) => page.frames().filter((f) => /agent-app/i.test(f.url()) && f !== page.mainFrame())

const widgetStates = async (page) => {
  const out = []
  for (const frame of widgetFrames(page)) {
    try {
      out.push(
        await frame.evaluate(() => ({
          url: location.href.slice(0, 120),
          selfview: document.querySelector('[data-testid="SelfView"], .self-view') != null,
          noActiveCall: document.querySelector('[data-testid="no-active-call"]') != null,
          onHold: document.querySelector('[data-testid="call-on-hold"]') != null,
          pane: document.querySelector('.state-pane h1')?.textContent?.trim() ?? null,
          pcs: (window.__pcs ?? []).length
        }))
      )
    } catch {
      out.push({ url: frame.url().slice(0, 120), navigating: true })
    }
  }
  return out
}

/** Capture dump via the first widget frame that exposes __captureDumpAll (same-origin localStorage = all sessions). */
const widgetCaptureDump = async (page) => {
  for (const frame of widgetFrames(page)) {
    try {
      const dump = await frame.evaluate(() => (window.__captureDumpAll != null ? window.__captureDumpAll() : null))
      if (dump != null) return dump
    } catch {
      /* frame navigating or cross-origin evaluation refused */
    }
  }
  return null
}

const openForConversation = async (conversationId, { headless = false, runDir, ctx: existingCtx } = {}) => {
  const ctx = existingCtx ?? (await launch({ headless }))
  const page = await ctx.newPage()
  const { consoleLog, networkLog } = instrument(page)
  // Hook RTCPeerConnection so webrtcStats() can read the app's own
  // getStats(): outbound-rtp video bytesSent is the definitive wire truth
  // for "is video actually being transmitted right now".
  await page.addInitScript(() => {
    window.__pcs = []
    const OrigPC = window.RTCPeerConnection
    window.RTCPeerConnection = function (...args) {
      const pc = new OrigPC(...args)
      window.__pcs.push(pc)
      return pc
    }
    window.RTCPeerConnection.prototype = OrigPC.prototype
    Object.setPrototypeOf(window.RTCPeerConnection, OrigPC)
    // Track WebSockets so S5.1 can surgically kill the notifications socket
    // (simulating silent event loss) without touching anything else.
    window.__sockets = []
    const OrigWS = window.WebSocket
    window.WebSocket = function (...args) {
      const ws = new OrigWS(...args)
      window.__sockets.push(ws)
      return ws
    }
    window.WebSocket.prototype = OrigWS.prototype
    Object.setPrototypeOf(window.WebSocket, OrigWS)
  })
  await page.goto(appUrl(conversationId), { waitUntil: 'domcontentloaded' })

  const state = async () => {
    // The OAuth redirect navigates away and back; guard evaluate() calls.
    try {
      return await page.evaluate(() => {
        const ids = ['no-active-call', 'call-on-hold', 'ErrorPanel', 'state-banner']
        const found = ids.filter((id) => document.querySelector(`[data-testid="${id}"], .${id}`) != null)
        const selfview = document.querySelector('[data-testid="SelfView"], .self-view') != null
        const video = document.querySelector('#remoteVideo') != null
        // Agent-facing text (state panes, connecting step, restore toast).
        const text = (sel) => document.querySelector(sel)?.textContent?.trim() ?? null
        const pane = {
          heading: text('.state-pane h1'),
          detail: text('.state-pane p'),
          step: text('[data-testid="connecting-step"]'),
          stalled: text('[data-testid="connecting-stalled"]') != null,
          toast: /Video restored/.test(document.body.innerText ?? '')
        }
        return { url: location.pathname + location.hash.slice(0, 20), found, selfview, remoteVideo: video, pane }
      })
    } catch {
      return { navigating: true, url: page.url().slice(0, 90) }
    }
  }

  const waitForState = async (predicate, timeoutMs = 40000) => {
    const deadline = Date.now() + timeoutMs
    let last = null
    while (Date.now() < deadline) {
      last = await state()
      if (predicate(last)) return last
      await new Promise((r) => setTimeout(r, 1000))
    }
    return { timeout: true, last }
  }

  /** One sample of outbound video stats per peer connection (diff bytesSent across samples for live bitrate). */
  const webrtcStats = async () => {
    try {
      return await page.evaluate(async () => {
        const out = []
        for (const pc of window.__pcs ?? []) {
          try {
            const stats = await pc.getStats()
            stats.forEach((r) => {
              if (r.type === 'outbound-rtp' && (r.kind === 'video' || r.mediaType === 'video')) {
                out.push({
                  connState: pc.connectionState,
                  bytesSent: r.bytesSent,
                  packetsSent: r.packetsSent,
                  framesEncoded: r.framesEncoded,
                  ts: Math.round(r.timestamp)
                })
              }
            })
          } catch {
            /* pc closed */
          }
        }
        return out
      })
    } catch {
      return null
    }
  }

  const captureDump = async () => {
    try {
      return await page.evaluate(() => (window.__captureDumpAll != null ? window.__captureDumpAll() : null))
    } catch {
      return null
    }
  }

  const screenshot = async (name) => {
    if (runDir == null) return null
    const file = path.join(runDir, `${name}.png`)
    await page.screenshot({ path: file })
    return file
  }

  const close = async () => {
    if (existingCtx == null) await ctx.close()
    else await page.close()
  }

  return { page, ctx, state, waitForState, captureDump, webrtcStats, screenshot, consoleLog, networkLog, close }
}

/**
 * Workspace mode: the REAL Genesys Agent Workspace in the instrumented
 * profile — the WebRTC phone, the interaction panes (hold/transfer/consult
 * buttons), and the actual widget IFRAME all live inside Playwright, which
 * pierces cross-origin frames: the widget iframe's DOM/console/network are
 * directly readable via frames(). Used for S0 UI-fidelity runs and the
 * iframe-lifecycle scenarios; NOTE: while this runs, no other browser should
 * be logged in as the same agent (WebRTC phone contention).
 */
const openWorkspace = async ({ headless = false, runDir } = {}) => {
  const ctx = await launch({ headless })
  const page = await ctx.newPage()
  const { consoleLog, networkLog } = instrument(page)
  await page.goto(`https://apps.${process.env.GENESYS_ENV}`, { waitUntil: 'domcontentloaded' })

  const widgetFrame = () =>
    page.frames().find((f) => f.url().startsWith(APP_BASE.replace(/\/$/, ''))) ?? null

  const widgetState = async () => {
    const frame = widgetFrame()
    if (frame == null) return { widgetFrame: false }
    try {
      return await frame.evaluate(() => ({
        widgetFrame: true,
        selfview: document.querySelector('[data-testid="SelfView"], .self-view') != null,
        noActiveCall: document.querySelector('[data-testid="no-active-call"]') != null,
        onHold: document.querySelector('[data-testid="call-on-hold"]') != null,
        banner: document.querySelector('[data-testid="state-banner"]')?.textContent ?? null
      }))
    } catch {
      return { widgetFrame: true, navigating: true }
    }
  }

  const screenshot = async (name) => {
    if (runDir == null) return null
    const file = path.join(runDir, `${name}.png`)
    await page.screenshot({ path: file })
    return file
  }

  return { page, ctx, widgetFrame, widgetState, screenshot, consoleLog, networkLog, close: async () => await ctx.close() }
}

module.exports = { launch, loginBootstrap, openPhoneHost, openForConversation, openWorkspace, answerViaUi, appUrl, widgetFrames, widgetStates, widgetCaptureDump, PROFILE_DIR, profileDir }
