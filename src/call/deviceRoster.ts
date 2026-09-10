export interface RosterParticipantLike {
  uri?: string
  protocol?: string
}

/**
 * True when the dialed branch device is present in the Pexip roster. The
 * device joins as a SIP (or H.323) participant whose URI's local part IS its
 * registered alias. Exact-match on the local part: a substring test could
 * match another participant whose URI merely contains the digits, and the
 * agent's own WebRTC/API legs are excluded by protocol.
 */
export const isDeviceInRoster = (
  participants: RosterParticipantLike[] | undefined,
  deviceAlias: string
): boolean => {
  const needle = deviceAlias.trim().toLowerCase()
  if (participants == null || needle === '') {
    return false
  }
  return participants.some((p) => {
    const protocol = (p.protocol ?? '').toLowerCase()
    if (protocol !== 'sip' && protocol !== 'h323' && protocol !== 'mssip') {
      return false
    }
    const local = (p.uri ?? '')
      .toLowerCase()
      .replace(/^(sips?|h323):/, '')
      .replace(/[@;].*$/, '')
    return local === needle
  })
}
