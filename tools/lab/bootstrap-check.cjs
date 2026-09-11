#!/usr/bin/env node
/**
 * Bootstrap / connecting-state checks — real browser, real bundle (dev
 * server), real Genesys API where a token is involved. No call needed.
 *
 *   set -a; source tools/lab/.env.lab; set +a
 *   node tools/lab/bootstrap-check.cjs [--headed]
 *
 * Cases: direct open (no launch), OAuth error in fragment, bogus token
 * (live 401), missing Pexip config, stalled step (watchdog), and a control
 * with the real A1 token on a finished conversation -> "No active call".
 */
const fs = require('fs')
const path = require('path')
const { chromium } = require('playwright')

const APP_BASE = process.env.APP_BASE ?? 'https://localhost:3000/telecom/agent-app/'
const ENV = process.env.GENESYS_ENV
const TOKEN = process.env.GENESYS_TOKEN_A1
const FINISHED_CONV = process.env.FINISHED_CONVERSATION_ID ?? 'e8fe145f-e753-4d5f-8cbb-0181588a8830'
const headed = process.argv.includes('--headed')

const launchState = {
  pcEnvironment: ENV,
  pcConversationId: FINISHED_CONV,
  pexipNode: process.env.PEXIP_NODE ?? 'pex-simon-conf1.genesys.pexsupport.com',
  pexipAgentPin: process.env.PEXIP_AGENT_PIN ?? '2021',
  pexipAppPrefix: process.env.PEXIP_APP_PREFIX ?? 'app_'
}
const url = (params, state) => {
  const q = new URLSearchParams(params)
  if (state != null) q.set('state', JSON.stringify(state))
  const s = q.toString()
  return s === '' ? APP_BASE : `${APP_BASE}#${s}`
}

const ERR = {
  notLaunched: 'This app must be opened from a Genesys interaction',
  signIn: 'Genesys sign-in failed',
  connection: 'Could not connect to Genesys call state',
  missing: 'missing Pexip configuration'
}

const cases = [
  {
    id: 'direct-open',
    url: url({}),
    until: (s) => s.error != null,
    expect: (s) => s.error?.includes(ERR.notLaunched)
  },
  {
    id: 'oauth-error-fragment',
    url: url({ error: 'invalid_request', error_description: 'redirect_uri mismatch' }),
    until: (s) => s.error != null,
    expect: (s) => s.error?.includes(ERR.signIn)
  },
  {
    id: 'bogus-token-live-401',
    url: url({ access_token: 'bogus-token' }, launchState),
    until: (s) => s.error != null,
    expect: (s, seen) => s.error?.includes(ERR.signIn) && seen.steps.includes('Signing in to Genesys')
  },
  {
    id: 'missing-pexip-config',
    url: url({ access_token: 'bogus-token' }, { ...launchState, pexipNode: '' }),
    until: (s) => s.error != null,
    expect: (s) => s.error?.includes(ERR.missing)
  },
  {
    // A hung Genesys API call is caught by the SDK's own 16 s timeout and
    // must surface as the connection-failed panel (not an endless spinner).
    id: 'hung-genesys-api-sdk-timeout',
    url: url({ access_token: 'bogus-token' }, launchState),
    route: async (page) => {
      await page.route('**/api/v2/users/me*', () => {
        /* never answer */
      })
    },
    timeoutMs: 30000,
    until: (s) => s.error != null || s.stalled != null,
    expect: (s, seen) =>
      s.error?.includes(ERR.connection) &&
      seen.steps.includes('Signing in to Genesys') &&
      seen.console.some((c) => c.includes('"event":"bootstrap-failed"'))
  },
  {
    // A step with NO SDK timeout behind it (camera enumeration hangs, e.g. an
    // unanswered permission prompt) must trip the 20 s watchdog pane.
    id: 'stalled-step-watchdog',
    url: url({ access_token: 'bogus-token' }, launchState),
    init: async (page) => {
      await page.addInitScript(() => {
        navigator.mediaDevices.enumerateDevices = () => new Promise(() => {})
      })
    },
    timeoutMs: 35000,
    until: (s) => s.stalled != null || s.error != null,
    expect: (s, seen) =>
      s.stalled?.includes('Still connecting') &&
      s.stalled?.includes('Checking camera') &&
      s.hasReload === true &&
      seen.console.some((c) => c.includes('"event":"connecting-stalled"'))
  },
  {
    id: 'real-token-finished-conversation',
    skip: TOKEN == null || ENV == null ? 'GENESYS_TOKEN_A1 / GENESYS_ENV not set' : null,
    url: url({ access_token: TOKEN ?? '' }, launchState),
    timeoutMs: 40000,
    until: (s) => s.noActiveCall != null || s.error != null,
    expect: (s, seen) =>
      s.noActiveCall?.includes('No active call') &&
      s.noActiveCall?.includes('Waiting for a video interaction') &&
      seen.steps.includes('Signing in to Genesys')
    // 'Checking call state' is a ~150 ms step on a finished conversation;
    // recorded in stepsSeen when caught, but not required.
  }
]

const readState = async (page) =>
  await page.evaluate(() => {
    const t = (sel) => document.querySelector(sel)?.textContent?.trim() ?? null
    return {
      error: t('[data-testid="ErrorPanel"] p'),
      step: t('[data-testid="connecting-step"]'),
      stalled: t('[data-testid="connecting-stalled"]'),
      hasReload: Array.from(document.querySelectorAll('[data-testid="connecting-stalled"] button')).some(
        (b) => /reload/i.test(b.textContent ?? '')
      ),
      noActiveCall: t('[data-testid="no-active-call"]'),
      onHold: t('[data-testid="call-on-hold"]'),
      banner: t('[data-testid="state-banner"]')
    }
  })

const main = async () => {
  const runDir = path.join(__dirname, 'runs', `bootstrap-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  fs.mkdirSync(runDir, { recursive: true })
  const browser = await chromium.launch({
    headless: !headed,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--ignore-certificate-errors']
  })
  const results = []
  for (const c of cases) {
    if (c.skip != null) {
      results.push({ id: c.id, result: 'SKIP', reason: c.skip })
      continue
    }
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera'] })
    const page = await ctx.newPage()
    const seen = { steps: [], console: [] }
    page.on('console', (m) => seen.console.push(m.text().slice(0, 400)))
    if (c.init != null) await c.init(page)
    if (c.route != null) await c.route(page)
    const t0 = Date.now()
    await page.goto(c.url, { waitUntil: 'domcontentloaded' })
    const deadline = t0 + (c.timeoutMs ?? 15000)
    let last = null
    while (Date.now() < deadline) {
      try {
        last = await readState(page)
      } catch {
        last = null
      }
      if (last?.step != null && !seen.steps.includes(last.step)) seen.steps.push(last.step)
      if (last != null && c.until(last)) break
      await new Promise((r) => setTimeout(r, 100))
    }
    const elapsedMs = Date.now() - t0
    const pass = last != null && c.until(last) && c.expect(last, seen) === true
    await new Promise((r) => setTimeout(r, 500)) // let the terminal state paint before the screenshot
    await page.screenshot({ path: path.join(runDir, `${c.id}.png`) }).catch(() => {})
    fs.writeFileSync(path.join(runDir, `${c.id}.console.json`), JSON.stringify(seen.console, null, 1))
    results.push({ id: c.id, result: pass ? 'PASS' : 'FAIL', elapsedMs, stepsSeen: seen.steps, final: last })
    console.log(`[${pass ? 'PASS' : 'FAIL'}] ${c.id} (${elapsedMs} ms) steps=${JSON.stringify(seen.steps)}`)
    if (!pass) console.log('   final:', JSON.stringify(last))
    await ctx.close()
  }
  await browser.close()
  fs.writeFileSync(path.join(runDir, 'results.json'), JSON.stringify(results, null, 1))
  const lines = ['# Bootstrap check', `Run dir: ${runDir}`, `App: ${APP_BASE}`, '', '| case | result | ms | steps seen |', '|---|---|---|---|']
  for (const r of results) lines.push(`| ${r.id} | ${r.result} | ${r.elapsedMs ?? ''} | ${(r.stepsSeen ?? []).join(' → ')} |`)
  fs.writeFileSync(path.join(runDir, 'report.md'), lines.join('\n'))
  console.log('\n' + lines.join('\n'))
  const failed = results.filter((r) => r.result === 'FAIL').length
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
