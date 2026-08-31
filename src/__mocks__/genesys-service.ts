export const initialize = jest.fn()
export const isCallActive = (): boolean => true
export const isDialOut = (): boolean => true
export const addMuteListener = jest.fn()
export const addHoldListener = jest.fn()
export const addEndCallListener = jest.fn()
export const addConnectCallListener = jest.fn()
export const fetchAniName = jest.fn().mockResolvedValue('fake-ani-name')
export const getAgentName = jest.fn()
export const isHeld = jest.fn().mockResolvedValue(false)
export const isMuted = jest.fn().mockResolvedValue(false)
export const hasBillingPermission = (): boolean => true
export const addConnectionLossListener = jest.fn()
export const addConnectionRestoredListener = jest.fn()
export const fetchCurrentCallState = jest
  .fn()
  .mockResolvedValue({ held: false, muted: false, active: true })
export const getDroppedForeignEventCount = (): number => 0
