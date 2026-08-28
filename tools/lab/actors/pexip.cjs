/**
 * Pexip Infinity Management API actor — OAuth2 client-credentials with an
 * ES256 client-assertion JWT (same mechanism as the pexip-mgmt MCP server).
 *
 * Config resolution order: PEXIP_* env vars, else the pexip-mgmt entry in
 * ~/.claude.json (so the lab shares the MCP server's credentials).
 * SHAKEDOWN: the token endpoint path (/oauth/token/) is verified on first run.
 */
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const loadConfig = () => {
  let host = process.env.PEXIP_HOST
  let clientId = process.env.PEXIP_OAUTH2_CLIENT_ID
  let privateKey = process.env.PEXIP_OAUTH2_PRIVATE_KEY
  if (host == null || clientId == null || privateKey == null) {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'))
    const scopes = [cfg, ...Object.values(cfg.projects ?? {})]
    for (const scope of scopes) {
      const s = scope.mcpServers?.['pexip-mgmt']
      if (s?.env != null) {
        host ??= s.env.PEXIP_HOST
        clientId ??= s.env.PEXIP_OAUTH2_CLIENT_ID
        privateKey ??= s.env.PEXIP_OAUTH2_PRIVATE_KEY
        break
      }
    }
  }
  if (host == null || clientId == null || privateKey == null) {
    throw new Error('Pexip oauth2 config not found (env or ~/.claude.json pexip-mgmt)')
  }
  return { host, clientId, privateKey }
}

const b64url = (buf) => Buffer.from(buf).toString('base64url')

let cachedToken = null // { token, exp }

const getToken = async () => {
  if (cachedToken != null && cachedToken.exp - 30 > Date.now() / 1000) return cachedToken.token
  const { host, clientId, privateKey } = loadConfig()
  const tokenUrl = process.env.PEXIP_TOKEN_URL ?? `https://${host}/oauth/token/`
  const now = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: 'ES256', typ: 'JWT' }))
  const claims = b64url(
    JSON.stringify({
      iss: clientId,
      sub: clientId,
      aud: tokenUrl,
      iat: now,
      exp: now + 300,
      jti: crypto.randomUUID()
    })
  )
  const signature = crypto
    .sign('sha256', Buffer.from(`${header}.${claims}`), {
      key: privateKey,
      dsaEncoding: 'ieee-p1363'
    })
    .toString('base64url')
  const assertion = `${header}.${claims}.${signature}`
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: assertion
    })
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok || j.access_token == null) {
    throw new Error(`pexip token failed: ${res.status} ${JSON.stringify(j).slice(0, 300)}`)
  }
  cachedToken = { token: j.access_token, exp: now + (j.expires_in ?? 300) }
  return cachedToken.token
}

const api = async (apiPath) => {
  const { host } = loadConfig()
  const token = await getToken()
  const res = await fetch(`https://${host}${apiPath}`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!res.ok) throw new Error(`pexip ${apiPath} -> ${res.status}`)
  return await res.json()
}

const conferences = async () =>
  (await api('/api/admin/status/v1/conference/?limit=20')).objects

const participants = async (conferenceName) => {
  const q = conferenceName != null ? `&conference=${encodeURIComponent(conferenceName)}` : ''
  const objs = (await api(`/api/admin/status/v1/participant/?limit=50${q}`)).objects
  return objs.map((p) => ({
    conference: p.conference,
    displayName: p.display_name,
    protocol: p.protocol,
    role: p.role,
    direction: p.call_direction,
    isMuted: p.is_muted,
    isPresenting: p.is_presenting,
    hasMedia: p.has_media,
    txBandwidth: p.tx_bandwidth,
    rxBandwidth: p.rx_bandwidth,
    sourceAlias: p.source_alias,
    destinationAlias: p.destination_alias,
    vendor: p.vendor,
    id: p.id
  }))
}

/** Per-participant media streams — is VIDEO actually being transmitted? */
const mediaStreams = async (participantId) =>
  (await api(`/api/admin/status/v1/media_stream/?participant=${participantId}&limit=20`)).objects

const summary = async () => {
  const confs = await conferences()
  const parts = confs.length > 0 ? await participants() : []
  return { conferences: confs.map((c) => ({ name: c.name, started: c.is_started, tag: c.tag })), participants: parts }
}

/**
 * LIVE per-stream bitrates for the agent's WebRTC leg — the actual wire
 * truth for "is video transmitting right now" (participant tx_bandwidth is
 * only the negotiated rate and never changes on mute).
 */
const agentVideoStreams = async () => {
  const parts = await participants()
  const out = []
  for (const p of parts.filter((x) => x.protocol === 'WebRTC')) {
    // Raw objects — field names differ per Infinity version; keep everything.
    const streams = await mediaStreams(p.id).catch((e) => ({ error: String(e.message) }))
    out.push({ displayName: p.displayName, participantId: p.id, streams })
  }
  return out
}

module.exports = { conferences, participants, mediaStreams, summary, agentVideoStreams, getToken }
