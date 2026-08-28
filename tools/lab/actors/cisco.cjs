/**
 * Cisco RoomOS endpoint actor (xAPI over HTTPS).
 * Env: CISCO_HOST, CISCO_USER, CISCO_PASS, optional CISCO_DIAL (default alias).
 */
const https = require('https')

const cfg = () => ({
  host: process.env.CISCO_HOST,
  user: process.env.CISCO_USER,
  pass: process.env.CISCO_PASS,
  dial: process.env.CISCO_DIAL ?? '31100@genesys.pexsupport.com'
})

const xapi = async (pathname, { method = 'GET', body } = {}) => {
  const { host, user, pass } = cfg()
  if (host == null) throw new Error('CISCO_HOST not set')
  return await new Promise((resolve, reject) => {
    const req = https.request(
      {
        host,
        path: pathname,
        method,
        rejectUnauthorized: false,
        auth: `${user}:${pass}`,
        headers: body != null ? { 'Content-Type': 'text/xml' } : {},
        timeout: 10000
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => resolve({ status: res.statusCode, body: data }))
      }
    )
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('cisco xapi timeout')))
    if (body != null) req.write(body)
    req.end()
  })
}

const command = async (xml) => await xapi('/putxml', { method: 'POST', body: xml })

const dial = async (number) =>
  await command(`<Command><Dial><Number>${number ?? cfg().dial}</Number></Dial></Command>`)

const sendDtmf = async (dtmf) =>
  await command(`<Command><Call><DTMFSend><DTMFString>${dtmf}</DTMFString></DTMFSend></Call></Command>`)

const disconnect = async (callId) =>
  await command(
    callId != null
      ? `<Command><Call><Disconnect><CallId>${callId}</CallId></Disconnect></Call></Command>`
      : `<Command><Call><Disconnect/></Call></Command>`
  )

/** Very light XML field scraper — pulls repeated <tag>value</tag> pairs. */
const scrape = (xml, tag) =>
  [...xml.matchAll(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'g'))].map((m) => m[1])

/** Active calls with status/callbacks. */
const calls = async () => {
  const res = await xapi('/getxml?location=%2FStatus%2FCall')
  const items = [...res.body.matchAll(/<Call item="(\d+)"[^>]*>([\s\S]*?)<\/Call>/g)]
  return items.map(([, item, inner]) => ({
    item: Number(item),
    status: scrape(inner, 'Status')[0],
    displayName: scrape(inner, 'DisplayName')[0],
    remoteNumber: scrape(inner, 'RemoteNumber')[0],
    duration: scrape(inner, 'Duration')[0],
    direction: scrape(inner, 'Direction')[0]
  }))
}

/**
 * Media channel stats — the customer-side wire truth: per-channel type,
 * direction, and whether video is actually flowing to the endpoint.
 */
const mediaChannels = async () => {
  const res = await xapi('/getxml?location=%2FStatus%2FMediaChannels')
  const chans = [...res.body.matchAll(/<Channel item="\d+"[^>]*>([\s\S]*?)<\/Channel>/g)]
  return chans.map(([, inner]) => ({
    type: scrape(inner, 'Type')[0],
    direction: scrape(inner, 'Direction')[0],
    protocol: scrape(inner, 'Protocol')[0],
    // Netstat lives per channel: bytes/packets tell whether media is flowing
    bytes: scrape(inner, 'Bytes')[0],
    channelRate: scrape(inner, 'ChannelRate')[0],
    frameRate: scrape(inner, 'FrameRate')[0],
    resolutionY: scrape(inner, 'ResolutionY')[0]
  }))
}

const summary = async () => {
  const c = await calls().catch((e) => ({ error: String(e) }))
  const m = Array.isArray(c) && c.length > 0 ? await mediaChannels().catch((e) => ({ error: String(e) })) : []
  return { calls: c, mediaChannels: m }
}

module.exports = { dial, sendDtmf, disconnect, calls, mediaChannels, summary, cfg }
