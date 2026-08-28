/**
 * Genesys Cloud agent actor. Tokens via GENESYS_TOKEN_A1 / GENESYS_TOKEN_A2
 * (implicit-grant tokens; refresh per session). Env: GENESYS_ENV.
 */
const ENV = () => {
  if (process.env.GENESYS_ENV == null) throw new Error('GENESYS_ENV not set')
  return process.env.GENESYS_ENV
}

const api = async (token, method, apiPath, body) => {
  const res = await fetch(`https://api.${ENV()}${apiPath}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body != null ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let json = null
  try {
    json = text.length > 0 ? JSON.parse(text) : null
  } catch {
    json = { raw: text.slice(0, 300) }
  }
  if (!res.ok) {
    const err = new Error(`${method} ${apiPath} -> ${res.status} ${JSON.stringify(json).slice(0, 300)}`)
    err.status = res.status
    throw err
  }
  return json
}

const ON_QUEUE_PRESENCE = 'e08eaf1b-ee47-4fa9-a231-1200e284798f'
const AVAILABLE_PRESENCE = '6a3af858-942f-489d-9700-5f9bcdcdae9b'

const makeActor = (name, token) => {
  const a = { name, token, userId: null, conversationId: null, participantId: null }

  a.whoAmI = async () => {
    const me = await api(token, 'GET', '/api/v2/users/me')
    a.userId = me.id
    return { id: me.id, name: me.name }
  }

  a.setPresence = async (presenceId) =>
    await api(token, 'PATCH', `/api/v2/users/${a.userId}/presences/PURECLOUD`, {
      presenceDefinition: { id: presenceId }
    })
  a.onQueue = async () => {
    await a.setPresence(ON_QUEUE_PRESENCE)
    // Clear a lingering NOT_RESPONDING (presence alone does not reset it)
    const rs = await api(token, 'GET', `/api/v2/users/${a.userId}/routingstatus`)
    if (rs.status === 'NOT_RESPONDING') {
      await api(token, 'PUT', `/api/v2/users/${a.userId}/routingstatus`, { status: 'IDLE' })
    }
    return rs.status
  }
  a.offQueue = async () => await a.setPresence(AVAILABLE_PRESENCE)
  a.setAutoAnswer = async (on) => {
    const u = await api(token, 'GET', `/api/v2/users/${a.userId}`)
    await api(token, 'PATCH', `/api/v2/users/${a.userId}`, { acdAutoAnswer: on, version: u.version })
  }

  /** Newest non-terminated leg for this user (the stale-leg-safe selection). */
  const myLiveLeg = (conv) => {
    const mine = (conv.participants ?? []).filter(
      (p) =>
        (p.purpose === 'agent' || p.purpose === 'user') &&
        (p.user?.id === a.userId || p.userId === a.userId)
    )
    const connected = mine.filter((p) => p.state === 'connected')
    return connected[connected.length - 1] ?? mine.filter((p) => p.state !== 'terminated').pop()
  }

  a.findCall = async () => {
    const res = await api(token, 'GET', '/api/v2/conversations/calls')
    for (const conv of res.entities ?? []) {
      const leg = myLiveLeg(conv)
      if (leg != null) {
        a.conversationId = conv.id
        a.participantId = leg.id
        return { conversationId: conv.id, participantId: leg.id, state: leg.state, held: leg.held }
      }
    }
    return null
  }

  /** Waits for auto-answer to land (or an alert if auto-answer is off). */
  a.waitConnected = async (timeoutMs = 45000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found = await a.findCall()
      if (found?.state === 'connected') return found
      await new Promise((r) => setTimeout(r, 1000))
    }
    throw new Error(`${name}: not connected within ${timeoutMs}ms`)
  }

  const patchSelf = async (body) =>
    await api(token, 'PATCH', `/api/v2/conversations/calls/${a.conversationId}/participants/${a.participantId}`, body)

  a.hold = async (held) => await patchSelf({ held })
  a.mute = async (muted) => await patchSelf({ muted })
  a.disconnect = async () => await patchSelf({ state: 'disconnected' })
  /** Consult/transfer act on the CUSTOMER participant (the consultation subject), not the agent's own leg. */
  a.customerParticipantId = async () => {
    const conv = await api(token, 'GET', `/api/v2/conversations/calls/${a.conversationId}`)
    const cust = (conv.participants ?? []).find(
      (p) => (p.purpose === 'customer' || p.purpose === 'external') && p.state === 'connected'
    )
    if (cust == null) throw new Error('no connected customer participant')
    return cust.id
  }
  a.consultStart = async (destUserId) => {
    a.consultTargetId = await a.customerParticipantId()
    return await api(token, 'POST', `/api/v2/conversations/calls/${a.conversationId}/participants/${a.consultTargetId}/consult`, {
      speakTo: 'destination',
      destination: { userId: destUserId }
    })
  }
  a.consultCancel = async () =>
    await api(token, 'DELETE', `/api/v2/conversations/calls/${a.conversationId}/participants/${a.consultTargetId ?? (await a.customerParticipantId())}/consult`)
  /** Complete the consult: connect customer to destination, then leave. */
  a.consultComplete = async () => {
    const target = a.consultTargetId ?? (await a.customerParticipantId())
    await api(token, 'PATCH', `/api/v2/conversations/calls/${a.conversationId}/participants/${target}/consult`, {
      speakTo: 'destination'
    })
    await a.disconnect()
  }
  /**
   * Blind transfer: replace targets the agent's OWN leg ("replace this
   * participant with X"). NOTE: opposite of consult, which targets the
   * customer — validated empirically both ways (S4.0 discriminator).
   */
  a.blindTransferTo = async (destUserId) =>
    await api(token, 'POST', `/api/v2/conversations/calls/${a.conversationId}/participants/${a.participantId}/replace`, {
      userId: destUserId
    })
  /** Blind transfer to a queue — ACD routes it, so auto-answer works on the receiver. */
  a.blindTransferToQueue = async (queueName) => {
    const target = await a.customerParticipantId()
    const queueId = await getQueueId(token, queueName)
    return await api(token, 'POST', `/api/v2/conversations/calls/${a.conversationId}/participants/${target}/replace`, {
      queueId
    })
  }

  /**
   * Wrap-up completion. Queue may define no codes — the working path found in
   * the lab is the communication-level wrapup (SHAKEDOWN: verify body shape).
   */
  a.completeWrapup = async (notes = 'lab run') => {
    const conv = await api(token, 'GET', `/api/v2/conversations/${a.conversationId}`)
    const legs = (conv.participants ?? []).filter(
      (p) => p.purpose === 'agent' && p.userId === a.userId && p.wrapupRequired === true && p.wrapup == null
    )
    if (legs.length === 0) return []
    // The org requires a code ("Wrapup code is required for non-provisional
    // wrapup") — resolve one from the queue, falling back to any org code.
    const acd = (conv.participants ?? []).find((p) => p.purpose === 'acd')
    let code =
      acd?.queueId != null
        ? (await api(token, 'GET', `/api/v2/routing/queues/${acd.queueId}/wrapupcodes`).catch(() => null))?.entities?.[0]
        : null
    code ??= (await api(token, 'GET', '/api/v2/routing/wrapupcodes?pageSize=1').catch(() => null))?.entities?.[0]
    if (code == null) {
      return [{ ok: false, error: 'no wrap-up code available — assign one to the queue (Admin > Routing > Wrap-Up Codes)' }]
    }
    const results = []
    for (const p of legs) {
      const commId = p.calls?.[0]?.id
      try {
        await api(
          token,
          'POST',
          `/api/v2/conversations/calls/${a.conversationId}/participants/${p.id}/communications/${commId}/wrapup`,
          { code: code.id, notes }
        )
        results.push({ leg: p.id, ok: true, code: code.name })
      } catch (e) {
        results.push({ leg: p.id, ok: false, error: String(e.message).slice(0, 200) })
      }
    }
    return results
  }

  return a
}

/**
 * Polls a conversation and returns a timestamped timeline of participant
 * state transitions — the Genesys-side record for every scenario run.
 */
const watchConversation = async (token, conversationId, seconds, onTick) => {
  const timeline = []
  let last = ''
  const until = Date.now() + seconds * 1000
  while (Date.now() < until) {
    const conv = await api(token, 'GET', `/api/v2/conversations/${conversationId}`).catch(() => null)
    if (conv != null) {
      const snap = (conv.participants ?? []).map((p) => ({
        purpose: p.purpose,
        name: p.name,
        state: p.calls?.[0]?.state,
        held: p.calls?.[0]?.held,
        muted: p.calls?.[0]?.muted,
        confined: p.calls?.[0]?.confined,
        consult: p.consultParticipantId != null
      }))
      const key = JSON.stringify(snap)
      if (key !== last) {
        last = key
        const entry = { t: new Date().toISOString(), snap }
        timeline.push(entry)
        if (onTick != null) onTick(entry)
      }
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  return timeline
}

/** Queue id lookup by name (cached). */
const queueIds = {}
const getQueueId = async (token, name) => {
  if (queueIds[name] == null) {
    const res = await api(token, 'GET', `/api/v2/routing/queues?name=${encodeURIComponent(name)}`)
    queueIds[name] = res.entities?.[0]?.id
    if (queueIds[name] == null) throw new Error(`queue not found: ${name}`)
  }
  return queueIds[name]
}

const actors = () => {
  const out = {}
  if (process.env.GENESYS_TOKEN_A1 != null) out.a1 = makeActor('A1', process.env.GENESYS_TOKEN_A1)
  if (process.env.GENESYS_TOKEN_A2 != null) out.a2 = makeActor('A2', process.env.GENESYS_TOKEN_A2)
  if (out.a1 == null) throw new Error('GENESYS_TOKEN_A1 not set')
  return out
}

module.exports = { makeActor, actors, watchConversation, api }
