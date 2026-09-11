/**
 * Shared selection of "my" agent participant from a Genesys participants
 * array. Participants accumulate across transfers — the same user can have
 * several legs (old terminated/disconnected ones first, the live one last) —
 * so `find()`-first predicates read a dead leg after any transfer (lab
 * finding F-19: reload after transfer-back showed "No active call" on a live
 * call).
 *
 * Rule: prefer a CONNECTED leg (the newest if several), else the newest
 * non-terminated leg, else undefined. Works for both API shapes:
 * REST conversations (userId + calls[0].state) and notification events
 * (user.id + state).
 */

interface LegLike {
  purpose?: string
  userId?: string
  user?: { id?: string }
  state?: string
  calls?: Array<{ state?: string }>
}

const legState = (p: LegLike): string | undefined =>
  p.state ?? p.calls?.[0]?.state

// Outbound personal calls (no callFromQueueId) use 'user' for the agent and
// 'external' for the far end; with callFromQueueId they are 'agent' and
// 'customer' like inbound. The rest of the app never cares which.
const AGENT_PURPOSES = ['agent', 'user']
const FAR_END_PURPOSES = ['customer', 'external']

/** True for the agent's own side of the call (inbound 'agent' or outbound 'user'). */
export const isAgentPurpose = (purpose?: string): boolean =>
  AGENT_PURPOSES.includes(purpose ?? '')

/** True for the far end (inbound 'customer' or outbound 'external'). */
export const isFarEndPurpose = (purpose?: string): boolean =>
  FAR_END_PURPOSES.includes(purpose ?? '')

const legUserId = (p: LegLike): string | undefined => p.userId ?? p.user?.id

export const selectMyLeg = <T extends LegLike>(
  participants: T[] | undefined,
  myUserId: string | undefined
): T | undefined => {
  if (participants == null || myUserId == null) {
    return undefined
  }
  const mine = participants.filter(
    (p) => isAgentPurpose(p.purpose) && legUserId(p) === myUserId
  )
  const connected = mine.filter((p) => legState(p) === 'connected')
  if (connected.length > 0) {
    return connected[connected.length - 1]
  }
  const alive = mine.filter((p) => legState(p) !== 'terminated')
  return alive.length > 0 ? alive[alive.length - 1] : undefined
}

/**
 * True only when the customer is genuinely gone: at least one customer leg
 * exists and ALL of them have ended. A snapshot where the customer merely
 * isn't "connected" right now — or is missing from the participant list
 * entirely — must NOT count as gone: ending the call on such a transient
 * reading destroys the ephemeral VMR, and rejoining it is impossible
 * (probe E in the 2026-08-27 review).
 */
export const customerLegGone = (
  participants: LegLike[] | undefined
): boolean => {
  const customers = (participants ?? []).filter((p) =>
    isFarEndPurpose(p.purpose)
  )
  if (customers.length === 0) {
    return false
  }
  return customers.every((p) => {
    const state = legState(p)
    return state === 'disconnected' || state === 'terminated'
  })
}

export const legStateOf = legState
