/**
 * The hold-video ("playback") leg. The Infinity policy dials a Media
 * Playback Service into the room when the customer's call creates it, so the
 * customer watches a loop while waiting. Nothing on the Infinity side takes
 * it out again: the agent's widget removes it once the agent's video is in
 * the room. The policy only dials it at room creation, so it never returns
 * for holds, consults or transfers.
 *
 * Convention: the playback alias's local part ends in `.playback`
 * (e.g. `rbfcu.playback@<domain>`), dialed over SIP.
 */

export interface PlaybackLegLike {
  uri?: string
  protocol?: string
}

const PLAYBACK_SUFFIX = '.playback'

export const isPlaybackLeg = (p: PlaybackLegLike): boolean => {
  if ((p.protocol ?? '').toLowerCase() !== 'sip') {
    return false
  }
  const local = (p.uri ?? '')
    .toLowerCase()
    .replace(/^sips?:/, '')
    .replace(/[@;].*$/, '')
  return (
    local.endsWith(PLAYBACK_SUFFIX) && local.length > PLAYBACK_SUFFIX.length
  )
}

export const playbackLegs = <T extends PlaybackLegLike>(
  participants: T[] | undefined
): T[] => (participants ?? []).filter(isPlaybackLeg)
