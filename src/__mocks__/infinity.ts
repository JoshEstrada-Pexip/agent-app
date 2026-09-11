import './test-params'

export enum ClientCallType {
  Audio = 'audio',
  Video = 'video',
  None = 'none'
}

export enum CallType {
  audio = 'audio',
  video = 'video',
  api = 'api'
}

let mockParticipants: any[] = []
let mockMe: any
let participantLeftCallback: () => void
const participantJoinedCallbacks: Array<(event: any) => void> = []
const participantLeftCallbacks: Array<() => void> = []
let disconnectedCallback: (event: { error: string }) => void

export const createCallSignals = (): unknown => ({
  onRemoteStream: {
    add: jest.fn(),
    remove: jest.fn()
  },
  onRemotePresentationStream: {
    add: jest.fn(),
    remove: jest.fn()
  },
  onPresentationConnectionChange: {
    add: jest.fn(),
    remove: jest.fn()
  }
})
export const createInfinityClientSignals = (): unknown => ({
  onParticipantJoined: {
    add: (callback: (event: any) => void) => {
      participantJoinedCallbacks.push(callback)
    },
    remove: (callback: (event: any) => void) => {
      const i = participantJoinedCallbacks.indexOf(callback)
      if (i >= 0) participantJoinedCallbacks.splice(i, 1)
    }
  },
  onParticipantLeft: {
    add: (callback: () => void) => {
      participantLeftCallback = callback
      participantLeftCallbacks.push(callback)
    },
    remove: jest.fn()
  },
  onDisconnected: {
    add: (callback: (event: { error: string }) => void) => {
      disconnectedCallback = callback
    },
    remove: jest.fn()
  },
  onMe: {
    add: (callback: (event: any) => void) => {
      participantJoinedCallbacks.push(callback)
    },
    remove: jest.fn()
  },
  onParticipants: {
    add: (callback: (event: any) => void) => {
      participantJoinedCallbacks.push(callback)
    },
    remove: (callback: (event: any) => void) => {
      const i = participantJoinedCallbacks.indexOf(callback)
      if (i >= 0) participantJoinedCallbacks.splice(i, 1)
    }
  }
})
export const mockCall = jest.fn(() => {
  if ((window as any).testParams.infinityUnavailable === true) {
    return undefined
  }
  if ((window as any).testParams.conferenceNotFound === true) {
    return {
      status: 404,
      data: {
        status: 'failed',
        result: 'Neither conference nor gateway found'
      }
    }
  }
  if ((window as any).testParams.conferenceWrongPIN === true) {
    return {
      status: 403,
      data: {
        status: 'failed',
        result: 'Invalid PIN'
      }
    }
  }
  return {
    status: 200,
    data: {
      status: 'success',
      result: {
        token: '1234'
      }
    }
  }
})
export const createInfinityClient = (): unknown => ({
  call: mockCall,
  mute: jest.fn(),
  muteVideo: jest.fn().mockResolvedValue(null),
  disconnect: mockDisconnect,
  disconnectAll: mockDisconnectAll,
  kick: mockKick,
  dial: mockDial,
  getParticipants: jest.fn(() => mockParticipants),
  getMe: jest.fn(() => mockMe)
})
export const setMockParticipants = (participants: any[]): void => {
  mockParticipants = participants
}
export const setMockMe = (me: any): void => {
  mockMe = me
}
export const mockDisconnect = jest.fn()
export const mockDisconnectAll = jest.fn()
export const mockKick = jest.fn().mockResolvedValue(undefined)
export const mockDial = jest.fn().mockResolvedValue({ status: 200 })
export const triggerParticipantLeft = (): void => {
  participantLeftCallback()
}
/** Fire every registered participant-left callback (roster + teardown). */
export const triggerParticipantLeftAll = (events: any[] = []): void => {
  participantLeftCallbacks.forEach((cb) => {
    ;(cb as (e: any[]) => void)(events)
  })
}
export const triggerParticipantJoined = (
  event: any = { id: 'main', participant: { uri: 'sip:x@y', uuid: 'x' } }
): void => {
  participantJoinedCallbacks.forEach((cb) => {
    cb(event)
  })
}
export const triggerInfinityDisconnected = (error: string): void => {
  disconnectedCallback({ error })
}
export const resetInfinityMock = (): void => {
  mockParticipants = []
  mockMe = undefined
  participantJoinedCallbacks.length = 0
  participantLeftCallbacks.length = 0
}
