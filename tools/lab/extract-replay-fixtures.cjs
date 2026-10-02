#!/usr/bin/env node
/**
 * Builds src/genesys/__fixtures__/replay-snapshots.json from the live
 * capture: one REAL Genesys notification snapshot per call state the app
 * must render, sanitized (names/addresses/external contacts removed, ids
 * remapped to the unit-test mock agent + conversation) so the replay test
 * can push them through the real genesysService + App.
 *
 *   node tools/lab/extract-replay-fixtures.cjs [capture.jsonl]
 *   node tools/lab/extract-replay-fixtures.cjs --run <runDir>
 *     adds the consult round-trip snapshots (S3.6) from that run's
 *     app-capture.json to the existing file; nothing else is rebuilt.
 */
const fs = require('fs')
const path = require('path')

const CAPTURE = process.argv[2] ?? path.join(__dirname, '..', '..', 'src', 'genesys', '__fixtures__', 'live', 'capture.jsonl')
const OUT = path.join(__dirname, '..', '..', 'src', 'genesys', '__fixtures__', 'replay-snapshots.json')
const LIVE_AGENT = process.env.CAPTURE_AGENT_ID ?? '32f299e0-3e18-4707-ae6c-666dcb89dc47'
const MOCK_AGENT = 'e02618ce-1ae8-4429-bdb0-2d55f701a545' // src/__mocks__/purecloud-platform-client-v2.ts
const MOCK_CONVERSATION = 'fake-conversation-id'

const RUN_DIR = process.argv[2] === '--run' ? process.argv[3] : null
// app-capture.json accumulates every capture session of the lab profile:
// keep only this run's conversation.
const runConversation =
  RUN_DIR != null
    ? JSON.parse(fs.readFileSync(path.join(RUN_DIR, 'actions.json'), 'utf8')).find((a) => a.action === 'agent-connected')?.detail?.conversationId
    : null
const events =
  RUN_DIR != null
    ? JSON.parse(fs.readFileSync(path.join(RUN_DIR, 'app-capture.json'), 'utf8')).flatMap((session) =>
        (session.entries ?? [])
          .filter((e) => e.kind === 'ws-event' && e.data?.eventBody?.id === runConversation)
          .map((e) => ({ ...e, session: session.startedAt }))
      )
    : fs
        .readFileSync(CAPTURE, 'utf8')
        .split('\n')
        .filter((l) => l.includes('"ws-event"'))
        .map((l) => JSON.parse(l))

const userId = (p) => p.userId ?? p.user?.id
const myLeg = (parts) => {
  const mine = parts.filter((p) => p.purpose === 'agent' && userId(p) === LIVE_AGENT)
  return mine.find((p) => p.state === 'connected') ?? mine[mine.length - 1]
}
const customerConnected = (parts) => parts.some((p) => p.purpose === 'customer' && p.state === 'connected')
const customerGone = (parts) => {
  const cust = parts.filter((p) => p.purpose === 'customer')
  return cust.length > 0 && cust.every((p) => p.state === 'disconnected' || p.state === 'terminated')
}
const consulting = (a) => a?.attributes?.consultInitiator === 'true'

/** Pick the first event (after `afterIdx` within the same session) matching predicate. */
const pick = (pred, { session, afterIdx = -1 } = {}) => {
  for (let i = afterIdx + 1; i < events.length; i++) {
    const e = events[i]
    if (session != null && e.session !== session) continue
    const parts = e.data.eventBody?.participants ?? []
    const a = myLeg(parts)
    if (pred(a, parts)) return { idx: i, e }
  }
  return null
}

const sanitize = (e) => {
  const body = JSON.parse(JSON.stringify(e.data.eventBody))
  body.id = MOCK_CONVERSATION
  body.address = 'tel:+15550000000'
  delete body.divisions
  delete body.utilizationLabelId
  let otherUser = 0
  const userMap = new Map([[LIVE_AGENT, MOCK_AGENT]])
  for (const p of body.participants ?? []) {
    if (p.name != null) p.name = `${p.purpose}-name`
    if (p.address != null) p.address = `sip:${p.purpose}@example.invalid`
    delete p.externalContact
    delete p.externalContactInitialDivisionId
    if (p.user?.id != null) {
      if (!userMap.has(p.user.id)) userMap.set(p.user.id, `other-user-${++otherUser}`)
      p.user.id = userMap.get(p.user.id)
    }
    if (p.userId != null) {
      if (!userMap.has(p.userId)) userMap.set(p.userId, `other-user-${++otherUser}`)
      p.userId = userMap.get(p.userId)
    }
  }
  return {
    source: { session: e.session, seq: e.seq, t: e.t },
    event: {
      topicName: `v2.users.${MOCK_AGENT}.conversations.calls`,
      version: e.data.version ?? '2',
      eventBody: body
    }
  }
}

const out = RUN_DIR != null ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {}
const note = (label, picked, why) => {
  if (picked == null) throw new Error(`no snapshot for ${label}`)
  out[label] = { why, ...sanitize(picked.e) }
  console.log(`${label.padEnd(16)} <- session ${picked.e.session} seq ${picked.e.seq}`)
}

if (RUN_DIR != null) {
  // Consult round trip to an EXTERNAL target (S3.6, field defect C7). The
  // consult subject (the member) is the far-end leg whose id every consult
  // party carries as consultParticipantId; the target is the other one.
  const subject = (a, parts) => parts.find((p) => p.id === a?.consultParticipantId)
  const target = (a, parts) => parts.find((p) => p.purpose !== 'agent' && p.state === 'connected' && p.consultParticipantId != null && p.id !== a?.consultParticipantId)
  const active = pick((a, parts) => consulting(a) && target(a, parts)?.confined === false && subject(a, parts)?.confined === true)
  note('consultExternalActive', active, 'external consult target answered: member confined, agent speaks to the target')
  const back = pick((a, parts) => consulting(a) && target(a, parts)?.confined === true && subject(a, parts)?.confined === false, { session: active.e.session, afterIdx: active.idx })
  note('consultBackWithMember', back, 'consult still up, agent speaks to the member: member unconfined, target confined')
  const again = pick((a, parts) => consulting(a) && target(a, parts)?.confined === false && subject(a, parts)?.confined === true, { session: back.e.session, afterIdx: back.idx })
  note('consultWithTargetAgain', again, 'agent speaks to the target again: member confined')
  const gone = pick((a, parts) => a?.state === 'connected' && !consulting(a) && a.consultParticipantId == null && customerConnected(parts), { session: again.e.session, afterIdx: again.idx })
  note('consultTargetGone', gone, 'consult target left: consult flags cleared, member connected')
} else {
  // Hold cycle from one session.
  const baseline = pick((a, parts) => a?.state === 'connected' && !a.held && !a.muted && !consulting(a) && customerConnected(parts))
  note('baseline', baseline, 'agent connected, not held/muted, customer connected')
  const held = pick((a, parts) => a?.state === 'connected' && a.held === true && !a.muted && customerConnected(parts), { session: baseline.e.session, afterIdx: baseline.idx })
  note('held', held, 'agent leg held=true (Genesys hold)')
  const unheld = pick((a, parts) => a?.state === 'connected' && a.held === false && customerConnected(parts), { session: held.e.session, afterIdx: held.idx })
  note('unheld', unheld, 'agent leg back to held=false')

  // Mic mute cycle.
  const muted = pick((a, parts) => a?.state === 'connected' && a.muted === true && !a.held && !consulting(a) && customerConnected(parts))
  note('muted', muted, 'agent leg muted=true, not held (Genesys mic mute)')
  const unmuted = pick((a, parts) => a?.state === 'connected' && a.muted === false && !a.held && customerConnected(parts), { session: muted.e.session, afterIdx: muted.idx })
  note('unmuted', unmuted, 'agent leg muted=false again')

  // Consult start then cancel (initiator attribute set, then cleared, customer stays).
  const consultStart = pick((a, parts) => a?.state === 'connected' && consulting(a) && customerConnected(parts))
  note('consulting', consultStart, 'agent is consult initiator (Genesys forces customer on hold)')
  const consultCancel = pick((a, parts) => a?.state === 'connected' && !consulting(a) && a.consultParticipantId == null && customerConnected(parts), { session: consultStart.e.session, afterIdx: consultStart.idx })
  note('consultCancelled', consultCancel, 'consult cancelled: initiator cleared, customer still connected')

  // Customer hangs up.
  const gone = pick((a, parts) => customerGone(parts) && (a?.state === 'connected' || a?.state === 'disconnected'))
  note('customerGone', gone, 'every customer leg disconnected/terminated (customer hung up)')
}

fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n')
console.log(`\nwrote ${path.relative(process.cwd(), OUT)} (${Object.keys(out).length} snapshots)`)
