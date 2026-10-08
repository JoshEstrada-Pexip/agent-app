/**
 * The one rule for "is my video call held, and why", shared by the event
 * path (notification snapshots) and the REST path (join, reload, socket
 * reconnect). Two copies of this rule disagreed before: a reload in the
 * middle of a consult read `held: false` off the agent's own call and showed
 * video to a member who was on hold (lab S3.8).
 *
 * Works on both API shapes: notification events carry state/held/confined
 * on the participant, REST conversations carry them on `calls[]`.
 */
import { isAgentPurpose, isFarEndPurpose, selectMyLeg } from './legSelection'

export type HoldReason = 'held' | 'consulting'

interface CallLike {
  state?: string
  held?: boolean
  confined?: boolean
}

export interface HoldLegLike {
  id?: string
  purpose?: string
  userId?: string
  user?: { id?: string }
  state?: string
  held?: boolean
  confined?: boolean
  consultParticipantId?: string
  attributes?: Record<string, string>
  calls?: CallLike[]
}

export interface HoldState {
  held: boolean
  reason: HoldReason
}

const CONNECTED = 'connected'

/** The leg's live call on the REST shape; the leg itself on the event shape. */
const liveCall = (p: HoldLegLike): CallLike | undefined =>
  p.calls != null
    ? (p.calls.find((call) => call?.state === CONNECTED) ?? p.calls[0])
    : p

const isConnected = (p: HoldLegLike): boolean =>
  liveCall(p)?.state === CONNECTED
const isHeld = (p: HoldLegLike): boolean => liveCall(p)?.held === true
const isConfined = (p: HoldLegLike): boolean => liveCall(p)?.confined === true

export const deriveHoldState = (
  participants: HoldLegLike[] | undefined,
  myUserId: string | undefined
): HoldState => {
  const me = selectMyLeg(participants, myUserId)
  const connectedAgents = (participants ?? []).filter(
    (p) => isAgentPurpose(p.purpose) && isConnected(p)
  )

  // During a consult transfer, Genesys sends held=false even though the
  // member is on hold. Initiator: flagged on my leg. Consulted agent: named
  // in the consult while another agent is connected.
  const consulting =
    me?.attributes?.consultInitiator === 'true' ||
    (me?.consultParticipantId !== undefined && connectedAgents.length > 1)

  // Who the consult initiator is speaking to shows only in `confined`
  // (nobody's `held` changes, and the consult flags stay set until the
  // consult ends): Genesys confines the party that is parked. The member is
  // the leg every consult party names in consultParticipantId; the consult
  // target can be an agent, or a far-end leg when an extension or external
  // contact was dialed (lab S3.6).
  const consultSubject =
    participants?.find(
      (p) => p.id != null && p.id === me?.consultParticipantId
    ) ?? participants?.find((p) => isFarEndPurpose(p.purpose) && isConnected(p))

  // Only the MEMBER's own confined flag says whether the member is parked.
  // The target's flags do not: the consult row's Hold then Resume leaves
  // nobody confined (all three talking, the same shape as a conference),
  // and the target holding its own leg changes nothing for the member.
  // Reading "target not confined" as "member parked" kept video dark while
  // the member was live (field report 2026-10-08, lab outbound consult probe).
  const memberParked = consultSubject != null && isConfined(consultSubject)
  const held = (consulting && memberParked) || (me != null && isHeld(me))
  return { held, reason: consulting && memberParked ? 'consulting' : 'held' }
}
