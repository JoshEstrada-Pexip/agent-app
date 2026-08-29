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

const legState = (p: LegLike): string | undefined => p.state ?? p.calls?.[0]?.state

const legUserId = (p: LegLike): string | undefined => p.userId ?? p.user?.id

export const selectMyLeg = <T extends LegLike>(
  participants: T[] | undefined,
  myUserId: string | undefined
): T | undefined => {
  if (participants == null || myUserId == null) {
    return undefined
  }
  const mine = participants.filter(
    (p) => p.purpose === 'agent' && legUserId(p) === myUserId
  )
  const connected = mine.filter((p) => legState(p) === 'connected')
  if (connected.length > 0) {
    return connected[connected.length - 1]
  }
  const alive = mine.filter((p) => legState(p) !== 'terminated')
  return alive.length > 0 ? alive[alive.length - 1] : undefined
}

export const legStateOf = legState
