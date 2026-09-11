#!/usr/bin/env node
/**
 * Scenario runner (PR 0) — drives Genesys agent call-control via the Platform
 * API so capture sessions need no human clicking. Pairs with the in-app
 * capture harness (VITE_CAPTURE_EVENTS): the app records what Genesys SENDS,
 * this runner records what the operator DID, both with ISO timestamps so the
 * two logs merge into one fixture.
 *
 * Usage:
 *   GENESYS_ENV=usw2.pure.cloud \
 *   GENESYS_TOKEN_A1=<agent1 token> \
 *   [GENESYS_TOKEN_A2=<agent2 token>] \
 *   [CISCO_HOST=<roomos ip> CISCO_USER=admin CISCO_PASS=... CISCO_DIAL=<alias@domain>] \
 *   node tools/scenario-runner/index.cjs <scenario-id>
 *
 * Scenarios: list with `node tools/scenario-runner/index.cjs --list`.
 * Tokens: easiest source is Genesys developer tools — log in as the agent at
 * https://developer.genesys.cloud/devapps/api-explorer (or
 * apps.<env>/developer-tools) and copy the bearer token shown for your user.
 *
 * NOTE (shakedown): the consult/replace request bodies are validated on the
 * first live run (S2.1 then S3.1); the runner prints full API error bodies so
 * any shape mismatch is a one-line fix here.
 */
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const ENV = process.env.GENESYS_ENV
const TOKEN_A1 = process.env.GENESYS_TOKEN_A1
const TOKEN_A2 = process.env.GENESYS_TOKEN_A2
const WRAPUP_CODE_ID = process.env.GENESYS_WRAPUP_CODE_ID // optional; else first org code

const actions = []
const log = (action, detail) => {
  const entry = { t: new Date().toISOString(), action, detail }
  actions.push(entry)
  console.log(`[runner] ${entry.t} ${action}`, detail ?? '')
}

const sleep = async (ms) => {
  log('wait', { ms })
  await new Promise((resolve) => setTimeout(resolve, ms))
}

const api = async (token, method, apiPath, body) => {
  const res = await fetch(`https://api.${ENV}${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: body != null ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let json
  try {
    json = text.length > 0 ? JSON.parse(text) : null
  } catch {
    json = { raw: text }
  }
  if (!res.ok) {
    log('api-error', { method, apiPath, status: res.status, body: json })
    throw new Error(`${method} ${apiPath} -> ${res.status}`)
  }
  log('api', { method, apiPath, status: res.status })
  return json
}

/** An "actor" wraps one agent token with self-aware call-control actions. */
const makeActor = (name, token) => {
  const actor = { name, token, userId: null, conversationId: null, participantId: null }

  actor.whoAmI = async () => {
    const me = await api(token, 'GET', '/api/v2/users/me')
    actor.userId = me.id
    log('actor-identity', { name, userId: me.id, userName: me.name })
    return me
  }

  /** Finds the active call conversation and this agent's LIVE leg. */
  actor.findCall = async () => {
    const res = await api(token, 'GET', '/api/v2/conversations/calls')
    const convs = res.entities ?? []
    for (const conv of convs) {
      const mine = (conv.participants ?? []).filter(
        (p) =>
          (p.purpose === 'agent' || p.purpose === 'user') &&
          (p.user?.id === actor.userId || p.userId === actor.userId)
      )
      // Prefer the connected leg; else the LAST (newest) non-terminated one.
      // This is the leg-selection rule the app itself needs (stale-leg fix).
      const connected = mine.filter((p) => p.state === 'connected')
      const live =
        connected[connected.length - 1] ??
        mine.filter((p) => p.state !== 'terminated').pop()
      if (live != null) {
        actor.conversationId = conv.id
        actor.participantId = live.id
        log('actor-call-found', {
          name,
          conversationId: conv.id,
          participantId: live.id,
          state: live.state,
          held: live.held
        })
        return conv
      }
    }
    throw new Error(`${name}: no active call conversation found`)
  }

  /**
   * Waits for an inbound leg (transfer/consult/ACD) to alert this agent and
   * answers it via the API — the same PATCH the Agent UI answer button sends.
   * Media lands on the agent's registered WebRTC station. This removes any
   * dependency on auto-answer (which only covers ACD-routed calls anyway).
   */
  actor.answerWhenAlerting = async (timeoutMs = 30000) => {
    log('action', { name, do: 'answer-when-alerting' })
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const res = await api(token, 'GET', '/api/v2/conversations/calls')
      for (const conv of res.entities ?? []) {
        const alerting = (conv.participants ?? []).find(
          (p) =>
            (p.purpose === 'agent' || p.purpose === 'user') &&
            (p.user?.id === actor.userId || p.userId === actor.userId) &&
            p.state === 'alerting'
        )
        if (alerting != null) {
          actor.conversationId = conv.id
          actor.participantId = alerting.id
          await api(
            token,
            'PATCH',
            `/api/v2/conversations/calls/${conv.id}/participants/${alerting.id}`,
            { state: 'connected' }
          )
          log('action', { name, do: 'answered', conversationId: conv.id })
          return
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    throw new Error(`${name}: nothing alerting within ${timeoutMs}ms`)
  }

  const patchSelf = async (body) =>
    await api(
      token,
      'PATCH',
      `/api/v2/conversations/calls/${actor.conversationId}/participants/${actor.participantId}`,
      body
    )

  actor.hold = async (held) => {
    log('action', { name, do: held ? 'hold' : 'unhold' })
    await patchSelf({ held })
  }
  actor.mute = async (muted) => {
    log('action', { name, do: muted ? 'mute' : 'unmute' })
    await patchSelf({ muted })
  }
  actor.disconnect = async () => {
    log('action', { name, do: 'disconnect-self' })
    await patchSelf({ state: 'disconnected' })
  }
  actor.consultStart = async (destUserId) => {
    log('action', { name, do: 'consult-start', destUserId })
    await api(
      token,
      'POST',
      `/api/v2/conversations/calls/${actor.conversationId}/participants/${actor.participantId}/consult`,
      { speakTo: 'destination', destination: { userId: destUserId } }
    )
  }
  actor.consultCancel = async () => {
    log('action', { name, do: 'consult-cancel' })
    await api(
      token,
      'DELETE',
      `/api/v2/conversations/calls/${actor.conversationId}/participants/${actor.participantId}/consult`
    )
  }
  /** Complete the consult: connect customer to destination, then leave. */
  actor.consultComplete = async () => {
    log('action', { name, do: 'consult-complete' })
    await api(
      token,
      'PATCH',
      `/api/v2/conversations/calls/${actor.conversationId}/participants/${actor.participantId}/consult`,
      { speakTo: 'destination' }
    )
    await actor.disconnect()
  }
  actor.blindTransferTo = async (destUserId) => {
    log('action', { name, do: 'blind-transfer', destUserId })
    await api(
      token,
      'POST',
      `/api/v2/conversations/calls/${actor.conversationId}/participants/${actor.participantId}/replace`,
      { userId: destUserId }
    )
  }
  actor.completeWrapup = async () => {
    let codeId = WRAPUP_CODE_ID
    if (codeId == null) {
      const codes = await api(token, 'GET', '/api/v2/routing/wrapupcodes?pageSize=1')
      codeId = codes.entities?.[0]?.id
    }
    log('action', { name, do: 'wrapup', codeId })
    await api(
      token,
      'POST',
      `/api/v2/conversations/calls/${actor.conversationId}/participants/${actor.participantId}/wrapup`,
      { code: codeId, notes: 'capture-session' }
    )
  }
  return actor
}

/** Customer endpoint control via Cisco RoomOS xAPI (curl -k for self-signed). */
const cisco = {
  configured: process.env.CISCO_HOST != null,
  xcommand: (xml, label) => {
    log('customer', { do: label })
    const cmd = `curl -sk -u '${process.env.CISCO_USER}:${process.env.CISCO_PASS}' -H 'Content-Type: text/xml' -d '${xml}' https://${process.env.CISCO_HOST}/putxml`
    const out = execSync(cmd, { encoding: 'utf8' })
    log('customer-result', { label, out: out.slice(0, 300) })
  },
  dial: () =>
    cisco.xcommand(
      `<Command><Dial><Number>${process.env.CISCO_DIAL}</Number></Dial></Command>`,
      'dial'
    ),
  hangup: () =>
    cisco.xcommand('<Command><Call><DisconnectAll/></Call></Command>', 'hangup')
}

const promptCustomer = async (what) => {
  if (cisco.configured) {
    if (what === 'dial') cisco.dial()
    else cisco.hangup()
    return
  }
  log('customer-manual', { needed: what })
  console.log(`\n>>> CUSTOMER STEP: ${what === 'dial' ? `join the conference now (Pexip webapp or endpoint)` : 'hang up the customer endpoint now'} — press Enter when done.`)
  await new Promise((resolve) => process.stdin.once('data', resolve))
}

// ---------------------------------------------------------------------------
// Scenarios. Each assumes: A1 already on the call with video escalated
// (runner verifies via findCall), capture enabled in the browser.
// ---------------------------------------------------------------------------
const scenarios = {
  'S2.1': async (a1) => {
    await a1.hold(true)
    await sleep(10000)
    await a1.hold(false)
  },
  'S2.2': async (a1) => {
    for (let i = 0; i < 2; i++) {
      await a1.hold(true)
      await a1.hold(false)
    }
  },
  'S2.5': async (a1) => {
    await a1.mute(true)
    await sleep(8000)
    await a1.mute(false)
  },
  'S2.6': async (a1) => {
    await a1.mute(true)
    await sleep(3000)
    await a1.hold(true)
    await sleep(8000)
    await a1.hold(false)
    await sleep(3000)
    await a1.mute(false)
  },
  'S3.1': async (a1, a2) => {
    await a1.consultStart(a2.userId)
    await sleep(4000) // cancel before A2 answers (A2 auto-answer OFF for this one)
    await a1.consultCancel()
  },
  'S3.2': async (a1, a2) => {
    await a1.consultStart(a2.userId)
    await a2.answerWhenAlerting()
    await sleep(6000)
    await a1.consultComplete()
  },
  'S3.3': async (a1, a2) => {
    await a1.consultStart(a2.userId)
    await a2.answerWhenAlerting()
    await sleep(6000)
    await a1.consultCancel() // take the call back
  },
  'S4.2': async (a1, a2) => {
    // Transfer away, DO NOT complete wrap-up, transfer back inside the window.
    await a1.blindTransferTo(a2.userId)
    await a2.answerWhenAlerting()
    await sleep(5000)
    await a2.blindTransferTo(a1.userId)
    await a1.answerWhenAlerting() // rebinds A1 to the NEW leg
    await sleep(10000)
    log('note', { msg: 'A1 wrap-up deliberately left open — the stale-leg window' })
  },
  'S4.3': async (a1, a2) => {
    await a1.blindTransferTo(a2.userId)
    await a2.answerWhenAlerting()
    await a1.completeWrapup() // close the old leg FIRST
    await sleep(3000)
    await a2.blindTransferTo(a1.userId)
    await a1.answerWhenAlerting()
    await sleep(10000)
  },
  'S4.4': async (a1, a2) => {
    await a1.blindTransferTo(a2.userId)
    await a2.answerWhenAlerting()
    await sleep(5000)
    await a2.blindTransferTo(a1.userId)
    await a1.answerWhenAlerting() // rebinds A1 to the NEW leg
    await sleep(5000)
    await a1.hold(true)
    await sleep(6000)
    await a1.hold(false)
  },
  'S4.5': async (a1, a2) => {
    await a1.blindTransferTo(a2.userId)
    await a2.answerWhenAlerting()
    await sleep(5000)
    await a2.blindTransferTo(a1.userId)
    await a1.answerWhenAlerting()
    await a1.hold(true) // hold IMMEDIATELY after transfer-back
    await sleep(8000)
    await a1.hold(false)
  },
  'S1.1': async (a1) => {
    await sleep(15000)
    await promptCustomer('hangup')
  },
  'S1.2': async (a1) => {
    await sleep(8000)
    await a1.disconnect()
  }
}

const main = async () => {
  const scenarioId = process.argv[2]
  if (scenarioId === '--list' || scenarioId == null) {
    console.log('Scenarios:', Object.keys(scenarios).join(', '))
    console.log('(S2.4, S2.7, S5.x involve the browser/endpoint — run those with the browser operator.)')
    process.exit(0)
  }
  const scenario = scenarios[scenarioId]
  if (scenario == null) throw new Error(`Unknown scenario ${scenarioId}`)
  if (ENV == null || TOKEN_A1 == null) throw new Error('GENESYS_ENV and GENESYS_TOKEN_A1 are required')

  log('scenario-start', { scenarioId })
  const a1 = makeActor('A1', TOKEN_A1)
  await a1.whoAmI()
  const needsA2 = scenario.length > 1
  let a2 = null
  if (needsA2) {
    if (TOKEN_A2 == null) throw new Error(`${scenarioId} needs GENESYS_TOKEN_A2`)
    a2 = makeActor('A2', TOKEN_A2)
    await a2.whoAmI()
  }
  await a1.findCall()

  await scenario(a1, a2)

  log('scenario-end', { scenarioId })
  const outDir = path.join(__dirname, '..', '..', 'src', 'genesys', '__fixtures__')
  const outFile = path.join(outDir, `runner-log-${scenarioId.replace('.', '_')}-${Date.now()}.json`)
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(outFile, JSON.stringify({ scenarioId, actions }, null, 2))
  console.log(`\n[runner] action log written: ${outFile}`)
  console.log('[runner] now run __captureDump() in each capture browser and save alongside this log.')
  process.exit(0)
}

main().catch((err) => {
  console.error('[runner] FAILED:', err.message)
  const outFile = path.join(__dirname, `runner-log-failed-${Date.now()}.json`)
  fs.writeFileSync(outFile, JSON.stringify({ actions, error: err.message }, null, 2))
  process.exit(1)
})
