/**
 * Prefix of the outbound rendezvous ROOM name. Internal to Pexip: the agent
 * dials the plain device alias, and the room is named `out_<device>` so the
 * room name never equals the device alias — otherwise the room's own dial to
 * the device would resolve back into the room it is already in.
 */
export const OUT_ALIAS_PREFIX = 'out_'

/**
 * Branch video devices are registered in this alias range on Infinity. MUST
 * match the local policy's outbound branch (docs/policies/…): a trunk call
 * landing in this range mints the rendezvous room.
 */
export const BRANCH_DEVICE_MIN = 30000
export const BRANCH_DEVICE_MAX = 31000

/**
 * How long the widget waits, after joining the VMR video-only, for the branch
 * device to appear in the roster before declaring the audio leg failed and
 * refusing to bring video live. Kept under the 20 s connecting watchdog so
 * the agent sees the device-specific message, not "still connecting".
 */
export const DEVICE_JOIN_TIMEOUT_MS = 15000
