/**
 * Which Pexip roster participants are THIS agent, and which are the
 * customer side. Identity travels in the join call tag, which Infinity
 * echoes back on every roster participant (`rawData.call_tag`), so a SIP
 * room named like the agent can never match (field bug 2026-09-08).
 */

export interface RosterLegLike {
  uuid: string
  callType?: string
  startTime?: number | null
  rawData?: { call_tag?: string }
}

export interface AgentIdentity {
  userId: string
  conversationId: string
}

const TAG_PREFIX = 'genesys-user:'

/** Tag sent on join. The conversation id proves the leg belongs to THIS call. */
export const agentCallTag = (
  identity: AgentIdentity,
  instanceId: string
): string => `${identityTag(identity)};instance:${instanceId}`

const identityTag = (identity: AgentIdentity): string =>
  `${TAG_PREFIX}${identity.userId};conv:${identity.conversationId}`

const isVideoOrApi = (p: RosterLegLike): boolean =>
  p.callType === 'video' || p.callType === 'api'

export const isMyLeg = (p: RosterLegLike, identity: AgentIdentity): boolean =>
  (p.rawData?.call_tag ?? '').startsWith(`${identityTag(identity)};`)

/**
 * Legs of mine other than `me` that started BEFORE me. With the join lock
 * there is no other live instance in this browser, so these are ghosts
 * (reload, crashed iframe) — evict them. "Older only" keeps a second
 * browser from ping-ponging with this one: the newest instance wins there.
 * `takeover` evicts every other leg of mine (agent chose this window).
 */
export const ghostLegsOfMine = (
  participants: RosterLegLike[],
  me: RosterLegLike | undefined,
  identity: AgentIdentity,
  options: { takeover?: boolean } = {}
): RosterLegLike[] => {
  if (me == null) {
    return []
  }
  const others = participants.filter(
    (p) => p.uuid !== me.uuid && isMyLeg(p, identity)
  )
  if (options.takeover === true) {
    return others
  }
  if (me.startTime == null) {
    return []
  }
  const mine = me.startTime
  return others.filter(
    (p) =>
      p.startTime != null &&
      (p.startTime < mine || (p.startTime === mine && p.uuid < me.uuid))
  )
}

/**
 * Video/api participants that are not this agent. The call is over when
 * none remain — never when only a duplicate of the agent left (customer
 * hang-up is only visible on this roster, lab F-24).
 */
export const remainingCounterparties = (
  participants: RosterLegLike[],
  identity: AgentIdentity
): RosterLegLike[] =>
  participants.filter((p) => isVideoOrApi(p) && !isMyLeg(p, identity))
