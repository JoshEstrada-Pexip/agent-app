export const initialize = jest.fn()
export const isCallActive = async (): Promise<boolean> =>
  (window as any).testParams?.genesysInactive !== true
export const getMyCallState = async (): Promise<{
  active: boolean
  alerting: boolean
  held: boolean
  muted: boolean
}> => ({
  active: (window as any).testParams?.genesysInactive !== true,
  alerting: (window as any).testParams?.genesysAlerting === true,
  held: false,
  muted: false
})
export const getConversationId = (): string =>
  '62698915-ae56-4efc-b5d7-71d6ad487fae'
export const isDialOut = (): boolean => true
export const addMuteListener = jest.fn()
export const addHoldListener = jest.fn()
export const addEndCallListener = jest.fn()
export const addConnectCallListener = jest.fn()
export const fetchAniName = jest.fn().mockResolvedValue('fake-ani-name')
export const getAgentName = jest.fn(() => 'Agent')
export const isHeld = jest.fn().mockResolvedValue(false)
export const isMuted = jest.fn().mockResolvedValue(false)
export const hasBillingPermission = (): boolean => true
export const addConnectionLossListener = jest.fn()
export const addConnectionRestoredListener = jest.fn()
export const fetchCurrentCallState = jest
  .fn()
  .mockResolvedValue({ held: false, muted: false, active: true })
export const getDroppedForeignEventCount = (): number => 0
export const getUserId = (): string => 'user-a1'
export const addAlertingListener = jest.fn()
export const fetchOutboundAlias = jest.fn().mockResolvedValue(undefined)
