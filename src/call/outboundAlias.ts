import {
  BRANCH_DEVICE_MAX,
  BRANCH_DEVICE_MIN,
  OUT_ALIAS_PREFIX
} from '../constants/Outbound'

/** Local part of a dialed address: scheme, domain and `;params` removed. */
const localPart = (address: string): string =>
  address
    .trim()
    .toLowerCase()
    .replace(/^(sips?|h323|tel):/, '')
    .replace(/[@;].*$/, '')

const isBranchDevice = (local: string): boolean => {
  if (!/^\d+$/.test(local)) {
    return false
  }
  const n = Number(local)
  return n >= BRANCH_DEVICE_MIN && n < BRANCH_DEVICE_MAX
}

/**
 * Outbound rendezvous: the agent dials a branch video device
 * (`30010@<pexip domain>`); the Infinity local policy mints a room named
 * after that dialed alias and dials the device into it; the widget joins the
 * room of the same name. Both sides derive it from the dialed address, so no
 * channel between them is needed.
 *
 * The room name IS the dialed alias, so an `out_`-prefixed dial plan works
 * too — whatever was dialed is the room.
 *
 * Returns undefined when the dialed address is not a branch device: an
 * inbound conversation, or an ordinary PSTN number.
 */
export const deriveConferenceAliasFromDialedAddress = (
  address: string | undefined
): string | undefined => {
  if (address == null || address.trim() === '') {
    return undefined
  }
  const local = localPart(address)
  if (isBranchDevice(local)) {
    return local
  }
  return local.startsWith(OUT_ALIAS_PREFIX) &&
    isBranchDevice(local.slice(OUT_ALIAS_PREFIX.length))
    ? local
    : undefined
}

/** The registered Infinity device alias behind a rendezvous room name. */
export const deviceAliasFromConferenceAlias = (
  conferenceAlias: string
): string =>
  conferenceAlias.startsWith(OUT_ALIAS_PREFIX)
    ? conferenceAlias.slice(OUT_ALIAS_PREFIX.length)
    : conferenceAlias
