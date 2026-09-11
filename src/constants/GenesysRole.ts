export enum GenesysRole {
  AGENT = 'agent',
  CUSTOMER = 'customer',
  IVR = 'ivr',
  ACD = 'acd',
  /** Agent's own leg on an outbound personal call (no callFromQueueId). */
  USER = 'user',
  /** Dialed far end on an outbound personal call. */
  EXTERNAL = 'external'
}
