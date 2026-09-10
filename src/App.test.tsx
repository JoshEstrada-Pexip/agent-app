import './__mocks__/test-params'

import { act, render, screen, waitFor } from '@testing-library/react'

import { App } from './App'
import { ErrorId } from './constants/ErrorId'
import * as GenesysService from './genesys/genesysService'
import { createFakeLockManager } from './__mocks__/locks'

// eslint-disable-next-line no-var
var setMockParticipants: (participants: any[]) => void
// eslint-disable-next-line no-var
var mockDisconnect: jest.Mock
// eslint-disable-next-line no-var
var mockDisconnectAll: jest.Mock
// eslint-disable-next-line no-var
var triggerParticipantLeft: () => void
// eslint-disable-next-line no-var
var triggerParticipantJoined: () => void
// eslint-disable-next-line no-var
var triggerInfinityDisconnected: (error: string) => void
// eslint-disable-next-line no-var
var setMockMe: (me: any) => void
// eslint-disable-next-line no-var
var mockKick: jest.Mock
// eslint-disable-next-line no-var
var resetInfinityMock: () => void
// eslint-disable-next-line no-var
var mockCall: jest.Mock
// eslint-disable-next-line no-var
var triggerParticipantLeftAll: (events?: any[]) => void
// eslint-disable-next-line no-var
var mockDial: jest.Mock

// Create a mocks
require('./__mocks__/mediaDevices')

jest.mock('@pexip/components', () => require('./__mocks__/components'))

jest.mock('@pexip/media-components', () => {
  return {
    StreamQuality: jest.fn()
  }
})

jest.mock(
  '@pexip/media-processor',
  () => require('./__mocks__/media-processor'),
  { virtual: true }
)

jest.mock(
  '@pexip/infinity',
  () => {
    const mockInfinity = { ...require('./__mocks__/infinity') }
    setMockParticipants = mockInfinity.setMockParticipants
    mockDisconnect = mockInfinity.mockDisconnect
    mockDisconnectAll = mockInfinity.mockDisconnectAll
    triggerParticipantLeft = mockInfinity.triggerParticipantLeft
    triggerParticipantJoined = mockInfinity.triggerParticipantJoined
    triggerInfinityDisconnected = mockInfinity.triggerInfinityDisconnected
    setMockMe = mockInfinity.setMockMe
    mockKick = mockInfinity.mockKick
    resetInfinityMock = mockInfinity.resetInfinityMock
    mockCall = mockInfinity.mockCall
    triggerParticipantLeftAll = mockInfinity.triggerParticipantLeftAll
    mockDial = mockInfinity.mockDial
    return mockInfinity
  },
  { virtual: true }
)

const mockGenesysServiceInitialize = jest.fn()
jest.mock('./genesys/genesysService', () => ({
  ...require('./__mocks__/genesys-service'),
  initialize: () => {
    mockGenesysServiceInitialize()
  }
}))

jest.mock('./error-panel/ErrorPanel', () => {
  return {
    ErrorPanel: (props: any) => {
      return (
        <div data-testid="ErrorPanel" className="ErrorPanel">
          <h3>Cannot connect</h3>
          <p>{props.error}</p>
        </div>
      )
    }
  }
})

// Outbound device gate: a short timeout keeps the "device never joins" test
// fast without faking timers across the whole join chain.
jest.mock('./constants/Outbound', () => ({
  OUT_ALIAS_PREFIX: 'out_',
  DEVICE_JOIN_TIMEOUT_MS: 300
}))

jest.mock('./toolbar/Toolbar', () => {
  return require('./__mocks__/toolbar')
})

jest.mock('./selfview/SelfView', () => {
  return {
    SelfView: () => <div data-testid="SelfView" />
  }
})

// The app reads the OAuth return leg from the URL fragment (access_token +
// launch state). Tests set it on jsdom's real location before each render.
const launchState = {
  pcEnvironment: 'usw2.pure.cloud',
  pcConversationId: '62698915-ae56-4efc-b5d7-71d6ad487fae',
  pexipNode: 'pexipdemo.com',
  pexipAgentPin: '2021',
  pexipAppPrefix: 'agent'
}
const setLaunchHash = (
  params: Record<string, string>,
  state: object | null = launchState
): void => {
  const query = new URLSearchParams(params)
  if (state != null) {
    query.set('state', JSON.stringify(state))
  }
  window.location.hash = query.toString()
}

const participantSipTrunk = {
  uuid: '1',
  callType: 'audio',
  role: 'chair',
  displayName: 'sipTrunk'
}

const participantCustomer = {
  uuid: '2',
  callType: 'video',
  role: 'guest',
  displayName: 'customer'
}

// Legs of THIS agent carry the identity tag Infinity echoes back on the roster.
const myTag = (instance: string): { call_tag: string } => ({
  call_tag: `genesys-user:user-a1;conv:${launchState.pcConversationId};instance:${instance}`
})

const participantAgentApi = {
  uuid: '3',
  callType: 'api',
  protocol: 'api',
  role: 'chair',
  displayName: 'agent',
  rawData: myTag('i3')
}

const participantAgentVideo = {
  uuid: '4',
  callType: 'video',
  protocol: 'webrtc',
  role: 'chair',
  displayName: 'agent',
  rawData: myTag('i4')
}

describe('App component', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    setLaunchHash({ access_token: 'secret' })
  })

  describe('Bootstrap', () => {
    it('should explain when the page is opened without a Genesys launch', async () => {
      window.location.hash = ''
      render(<App />)
      const errorPanel = await screen.findByTestId('ErrorPanel')
      expect(errorPanel.getElementsByTagName('p')[0].innerHTML).toBe(
        ErrorId.NOT_LAUNCHED_FROM_GENESYS
      )
      expect(mockGenesysServiceInitialize).not.toHaveBeenCalled()
    })

    it('should surface an OAuth error returned in the fragment', async () => {
      setLaunchHash(
        { error: 'invalid_request', error_description: 'redirect mismatch' },
        null
      )
      render(<App />)
      const errorPanel = await screen.findByTestId('ErrorPanel')
      expect(errorPanel.getElementsByTagName('p')[0].innerHTML).toBe(
        ErrorId.GENESYS_SIGN_IN_FAILED
      )
      expect(mockGenesysServiceInitialize).not.toHaveBeenCalled()
    })

    it('should report missing Pexip configuration in the launch state', async () => {
      setLaunchHash(
        { access_token: 'secret' },
        { ...launchState, pexipNode: '' }
      )
      render(<App />)
      const errorPanel = await screen.findByTestId('ErrorPanel')
      expect(errorPanel.getElementsByTagName('p')[0].innerHTML).toBe(
        ErrorId.MISSING_CONFIG
      )
    })

    it('should show the current connecting step under the spinner', async () => {
      render(<App />)
      const step = await screen.findByTestId('connecting-step')
      expect(step.textContent).not.toBe('')
    })
  })

  it('should render', async () => {
    render(<App />)
    const app = await screen.findByTestId('App')
    expect(app).toBeInTheDocument()
  })

  describe('Error panel', () => {
    beforeEach(() => {
      ;(window as any).testParams.enumerateDevicesEmpty = false
      ;(window as any).testParams.rejectGetUserMedia = false
      ;(window as any).testParams.infinityUnavailable = false
      ;(window as any).testParams.conferenceNotFound = false
      ;(window as any).testParams.conferenceWrongPIN = false
    })

    it("shouldn't display the panel if there isn't an error", async () => {
      render(<App />)
      const app = await screen.findByTestId('App')
      expect(app.getElementsByClassName('ErrorPanel').length).toBe(0)
    })

    it("should display an error if the camera isn't connected", async () => {
      ;(window as any).testParams.enumerateDevicesEmpty = true
      ;(window as any).testParams.rejectGetUserMedia = true
      render(<App />)
      const errorPanel = await screen.findByTestId('ErrorPanel')
      expect(errorPanel.getElementsByTagName('p')[0].innerHTML).toBe(
        ErrorId.CAMERA_NOT_CONNECTED
      )
    })

    it("should display an error if the user didn't grant camera permission", async () => {
      ;(window as any).testParams.rejectGetUserMedia = true
      render(<App />)
      const errorPanel = await screen.findByTestId('ErrorPanel')
      expect(errorPanel.getElementsByTagName('p')[0].innerHTML).toBe(
        ErrorId.CAMERA_ACCESS_DENIED
      )
    })

    it('should display an error if there is not a connection with the Infinity server', async () => {
      ;(window as any).testParams.infinityUnavailable = true
      render(<App />)
      const errorPanel = await screen.findByTestId('ErrorPanel')
      expect(errorPanel.getElementsByTagName('p')[0].innerHTML).toBe(
        ErrorId.INFINITY_SERVER_UNAVAILABLE
      )
    })

    it('should display an error if the conference cannot be found', async () => {
      ;(window as any).testParams.conferenceNotFound = true
      render(<App />)
      const errorPanel = await screen.findByTestId('ErrorPanel')
      expect(errorPanel.getElementsByTagName('p')[0].innerHTML).toBe(
        ErrorId.CONFERENCE_NOT_FOUND
      )
    })

    it('should display an error if the conference PIN is wrong', async () => {
      ;(window as any).testParams.conferenceWrongPIN = true
      render(<App />)
      const errorPanel = await screen.findByTestId('ErrorPanel')
      expect(errorPanel.getElementsByTagName('p')[0].innerHTML).toBe(
        ErrorId.CONFERENCE_AUTHENTICATION_FAILED
      )
    })

    it('should display the video-unavailable error instead of joining an empty room when the ANI name cannot be fetched', async () => {
      ;(GenesysService.fetchAniName as jest.Mock).mockResolvedValueOnce(
        undefined
      )
      render(<App />)
      const errorPanel = await screen.findByTestId('ErrorPanel')
      expect(errorPanel.getElementsByTagName('p')[0].innerHTML).toBe(
        ErrorId.VIDEO_UNAVAILABLE
      )
    })
  })

  describe('Genesys service', () => {
    it('should call to initialize once', async () => {
      await act(async () => {
        render(<App />)
      })
      expect(mockGenesysServiceInitialize).toHaveBeenCalledTimes(1)
    })
  })

  describe('Agent disconnect behavior', () => {
    beforeEach(() => {
      resetInfinityMock()
      setMockParticipants([])
    })

    it("should stay when participants >= 1 with callType == api or video (agent.callType == 'api')", async () => {
      setMockParticipants([
        participantSipTrunk,
        participantCustomer,
        participantAgentApi
      ])
      await act(async () => {
        render(<App />)
      })
      triggerParticipantLeft()
      expect(mockDisconnect).not.toHaveBeenCalled()
      expect(mockDisconnectAll).not.toHaveBeenCalled()
    })

    it("should stay when participants >= 1 with callType == api or video (agent.callType == 'video')", async () => {
      setMockParticipants([
        participantSipTrunk,
        participantCustomer,
        participantAgentVideo
      ])
      await act(async () => {
        render(<App />)
      })
      triggerParticipantLeft()
      expect(mockDisconnect).not.toHaveBeenCalled()
      expect(mockDisconnectAll).not.toHaveBeenCalled()
    })

    it("should leave when callType == api and it's only one with callType == api or video", async () => {
      setMockParticipants([participantSipTrunk, participantAgentApi])
      setMockMe(participantAgentApi)
      await act(async () => {
        render(<App />)
      })
      triggerParticipantLeft()
      const noActiveCallPanel = await screen.findAllByTestId('no-active-call')
      expect(noActiveCallPanel.length).toBe(1)
      expect(mockDisconnect).toHaveBeenCalledTimes(1)
      expect(mockDisconnectAll).toHaveBeenCalledTimes(1)
    })

    it("should leave when callType == video and it's only one with callType == api or video", async () => {
      setMockParticipants([participantSipTrunk, participantAgentVideo])
      setMockMe(participantAgentVideo)
      await act(async () => {
        render(<App />)
      })
      triggerParticipantLeft()
      const noActiveCallPanel = await screen.findAllByTestId('no-active-call')
      expect(noActiveCallPanel.length).toBe(1)
      expect(mockDisconnect).toHaveBeenCalledTimes(1)
      expect(mockDisconnectAll).toHaveBeenCalledTimes(1)
    })
  })

  // One video leg per agent per call (field bug 2026-09-08: N missed alerts
  // = N+1 legs). Root cause was a re-entrant join; the election lock and the
  // ghost-leg kick cover real multi-instance cases. The mocked agent's
  // identity is user-a1 on the launch conversation.
  describe('Video leg ownership', () => {
    const customer = {
      uuid: 'cust',
      callType: 'video',
      protocol: 'sip',
      displayName: 'customer',
      startTime: 100
    }
    // A SIP room that happens to carry the agent's display name is NOT mine.
    const customerNamedLikeMe = {
      uuid: 'cust2',
      callType: 'video',
      protocol: 'sip',
      displayName: 'Agent',
      startTime: 100
    }
    const ghost = {
      uuid: 'ghost',
      callType: 'video',
      protocol: 'webrtc',
      displayName: 'Agent',
      startTime: 200,
      rawData: myTag('older')
    }
    const me = {
      uuid: 'me',
      callType: 'video',
      protocol: 'webrtc',
      displayName: 'Agent',
      startTime: 300,
      rawData: myTag('me')
    }
    const newerMe = {
      uuid: 'new',
      callType: 'video',
      protocol: 'webrtc',
      displayName: 'Agent',
      startTime: 400,
      rawData: myTag('newer')
    }
    const otherAgent = {
      uuid: 'a2',
      callType: 'video',
      protocol: 'webrtc',
      displayName: 'Agent Two',
      startTime: 250,
      rawData: { call_tag: 'genesys-user:u2;conv:x;instance:y' }
    }
    const lockName = `pexip-video:${launchState.pcConversationId}:user-a1`

    const renderJoined = async (roster: any[]): Promise<void> => {
      setMockParticipants(roster)
      setMockMe(me)
      await act(async () => {
        render(<App />)
      })
      await screen.findByTestId('SelfView')
    }
    const setVisibility = (state: 'visible' | 'hidden'): void => {
      Object.defineProperty(document, 'visibilityState', {
        value: state,
        configurable: true
      })
      document.dispatchEvent(new Event('visibilitychange'))
    }

    beforeEach(() => {
      resetInfinityMock()
      ;(window as any).testParams.genesysInactive = false
      ;(window as any).testParams.genesysAlerting = false
      delete (navigator as any).locks
    })
    afterEach(() => {
      setVisibility('visible')
    })

    it('joins the VMR exactly once even when connect events burst during the join', async () => {
      await renderJoined([participantSipTrunk, customer, me])
      expect(mockCall).toHaveBeenCalledTimes(1)
      const connectCalls = (GenesysService.addConnectCallListener as jest.Mock)
        .mock.calls
      const connectListener = connectCalls[
        connectCalls.length - 1
      ][0] as () => Promise<void>
      await act(async () => {
        void connectListener()
        void connectListener()
        await connectListener()
      })
      expect(mockCall).toHaveBeenCalledTimes(1)
    })

    it('sends its identity as the call tag', async () => {
      await renderJoined([participantSipTrunk, customer, me])
      expect(mockCall.mock.calls[0][0].callTag).toMatch(
        new RegExp(
          `^genesys-user:user-a1;conv:${launchState.pcConversationId};instance:`
        )
      )
    })

    it('kicks my OLDER ghost legs after joining, never other agents, newer legs or SIP rooms', async () => {
      await renderJoined([
        participantSipTrunk,
        customer,
        customerNamedLikeMe,
        ghost,
        otherAgent,
        me,
        newerMe
      ])
      await waitFor(() => {
        expect(mockKick).toHaveBeenCalledWith({ participantUuid: 'ghost' })
      })
      expect(mockKick).toHaveBeenCalledTimes(1)
      expect(mockDisconnectAll).not.toHaveBeenCalled()
    })

    it('kicks a ghost that appears on the roster after the join', async () => {
      await renderJoined([participantSipTrunk, customer, me])
      expect(mockKick).not.toHaveBeenCalled()
      setMockParticipants([participantSipTrunk, customer, ghost, me])
      await act(async () => {
        triggerParticipantJoined()
      })
      await waitFor(() => {
        expect(mockKick).toHaveBeenCalledWith({ participantUuid: 'ghost' })
      })
    })

    it('still ends the call on customer hang-up while a ghost of me is present', async () => {
      await renderJoined([participantSipTrunk, customer, ghost, me])
      setMockParticipants([participantSipTrunk, ghost, me])
      await act(async () => {
        triggerParticipantLeft()
      })
      expect(mockDisconnectAll).toHaveBeenCalledTimes(1)
      await screen.findByTestId('no-active-call')
    })

    it('does not end the call when only my own ghost leaves', async () => {
      await renderJoined([participantSipTrunk, customer, ghost, me])
      setMockParticipants([participantSipTrunk, customer, me])
      await act(async () => {
        triggerParticipantLeftAll([{ participant: ghost }])
      })
      expect(mockDisconnectAll).not.toHaveBeenCalled()
      expect(mockDisconnect).not.toHaveBeenCalled()
    })

    it('stays out when another instance holds the leg, and a hidden window offers the button', async () => {
      const locks = createFakeLockManager()
      ;(navigator as any).locks = locks
      // The other instance's request rejects with AbortError when stolen.
      locks
        .request(lockName, {}, async () => await new Promise(() => undefined))
        .catch(() => undefined)
      setVisibility('hidden')
      setMockParticipants([participantSipTrunk, customer, newerMe])
      await act(async () => {
        render(<App />)
      })
      await screen.findByTestId('superseded')
      expect(mockCall).not.toHaveBeenCalled()
      // Take it back: steal the lock, join, evict every other leg of mine.
      setMockMe(me)
      setMockParticipants([participantSipTrunk, customer, newerMe, me])
      await act(async () => {
        screen.getByTestId('take-over').click()
      })
      await screen.findByTestId('SelfView')
      expect(mockCall).toHaveBeenCalledTimes(1)
      await waitFor(() => {
        expect(mockKick).toHaveBeenCalledWith({ participantUuid: 'new' })
      })
    })

    it('a VISIBLE window that lost the election takes the leg back by itself', async () => {
      const locks = createFakeLockManager()
      ;(navigator as any).locks = locks
      // The other instance's request rejects with AbortError when stolen.
      locks
        .request(lockName, {}, async () => await new Promise(() => undefined))
        .catch(() => undefined)
      setMockParticipants([participantSipTrunk, customer])
      await act(async () => {
        render(<App />)
      })
      await screen.findByTestId('superseded-connecting')
      expect(screen.queryByTestId('superseded')).toBeNull()
      setMockMe(me)
      await waitFor(
        () => {
          expect(mockCall).toHaveBeenCalledTimes(1)
        },
        { timeout: 5000 }
      )
      await screen.findByTestId('SelfView')
    }, 10000)

    it('takes over automatically only ONCE per call; a second loss shows the button', async () => {
      const locks = createFakeLockManager()
      ;(navigator as any).locks = locks
      locks
        .request(lockName, {}, async () => await new Promise(() => undefined))
        .catch(() => undefined)
      setMockParticipants([participantSipTrunk, customer])
      await act(async () => {
        render(<App />)
      })
      await screen.findByTestId('superseded-connecting')
      setMockMe(me)
      await waitFor(
        () => {
          expect(mockCall).toHaveBeenCalledTimes(1)
        },
        { timeout: 5000 }
      )
      await screen.findByTestId('SelfView')
      // Another instance steals the leg back.
      await act(async () => {
        locks
          .request(
            lockName,
            { steal: true },
            async () => await new Promise(() => undefined)
          )
          .catch(() => undefined)
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      await screen.findByTestId('superseded')
      await new Promise((resolve) => setTimeout(resolve, 2500))
      expect(mockCall).toHaveBeenCalledTimes(1)
      expect(mockDisconnectAll).not.toHaveBeenCalled()
    }, 15000)

    it('steps aside without touching the VMR when Infinity says another participant removed it', async () => {
      await renderJoined([participantSipTrunk, customer, me])
      setVisibility('hidden')
      await act(async () => {
        triggerInfinityDisconnected('Disconnected by another participant')
      })
      await screen.findByTestId('superseded')
      expect(mockDisconnectAll).not.toHaveBeenCalled()
      expect(mockCall).toHaveBeenCalledTimes(1)
    })

    it('rejoins once after an unexpected drop, VMR untouched', async () => {
      await renderJoined([participantSipTrunk, customer, me])
      await act(async () => {
        triggerInfinityDisconnected('Connection lost')
      })
      expect(screen.queryByTestId('no-active-call')).toBeNull()
      await waitFor(
        () => {
          expect(mockCall).toHaveBeenCalledTimes(2)
        },
        { timeout: 5000 }
      )
      await screen.findByTestId('SelfView')
      expect(mockDisconnectAll).not.toHaveBeenCalled()
    }, 10000)

    it('talks to Infinity once when Genesys repeats the end-of-call snapshot', async () => {
      await renderJoined([participantSipTrunk, customer, me])
      const endCalls = (GenesysService.addEndCallListener as jest.Mock).mock
        .calls
      const endCall = endCalls[endCalls.length - 1][0] as (
        all: boolean
      ) => Promise<void>
      await act(async () => {
        await endCall(true)
        await endCall(true)
      })
      expect(mockDisconnectAll).toHaveBeenCalledTimes(1)
      expect(mockDisconnect).toHaveBeenCalledTimes(1)
      await screen.findByTestId('no-active-call')
    })

    it('offers support diagnostics from the build stamp, with logs from this call', async () => {
      await renderJoined([participantSipTrunk, customer, me])
      expect(screen.queryByTestId('diagnostics-panel')).toBeNull()
      await act(async () => {
        screen.getByTestId('build-stamp').click()
      })
      const panel = await screen.findByTestId('diagnostics-panel')
      expect(panel).toBeTruthy()
      // The join wrote entries, and the export carries them plus the build.
      expect(
        Number(
          screen.getByTestId('diag-entries').textContent?.match(/\d+/)?.[0]
        )
      ).toBeGreaterThan(0)
      const exported =
        screen.getByTestId<HTMLTextAreaElement>('diag-text').value
      expect(exported).toContain('pexip-genesys-widget-diagnostics')
      expect(exported).toContain('join-start')
      expect(exported).not.toContain('access_token')
      await act(async () => {
        screen.getByTestId('diag-close').click()
      })
      expect(screen.queryByTestId('diagnostics-panel')).toBeNull()
    })

    it('shows "Incoming call" instead of "No active call" while my leg is alerting', async () => {
      ;(window as any).testParams.genesysInactive = true
      ;(window as any).testParams.genesysAlerting = true
      await act(async () => {
        render(<App />)
      })
      await screen.findByTestId('incoming-call')
      expect(screen.queryByTestId('no-active-call')).toBeNull()
      expect(mockCall).not.toHaveBeenCalled()
    })
  })

  // Outbound: the agent dialed out_<device>@…; Pexip minted a room of that
  // name; the widget joins it unprefixed and brings video live only once the
  // branch device is in the roster (audio first).
  describe('Outbound dynamic VMR', () => {
    const me = {
      uuid: 'me',
      callType: 'video',
      protocol: 'webrtc',
      displayName: 'Agent',
      startTime: 300,
      rawData: myTag('me')
    }
    const device = {
      uuid: 'dev',
      callType: 'video',
      protocol: 'sip',
      uri: 'sip:30005@genesys.pexsupport.com',
      displayName: 'Branch 30005',
      startTime: 100
    }

    beforeEach(() => {
      resetInfinityMock()
      ;(window as any).testParams.genesysInactive = false
      ;(window as any).testParams.genesysAlerting = false
      ;(GenesysService.fetchOutboundAlias as jest.Mock).mockResolvedValue(
        '30005'
      )
      setMockMe(me)
    })
    afterEach(() => {
      ;(GenesysService.fetchOutboundAlias as jest.Mock).mockResolvedValue(
        undefined
      )
    })

    it('joins the outbound rendezvous alias with no app prefix', async () => {
      setMockParticipants([participantSipTrunk, device, me])
      await act(async () => {
        render(<App />)
      })
      await screen.findByTestId('SelfView')
      expect(mockCall.mock.calls[0][0].conferenceAlias).toBe('30005')
      expect(mockDial).not.toHaveBeenCalled()
    })

    it('dials the device once when it is absent, then goes live when it joins', async () => {
      setMockParticipants([participantSipTrunk, me])
      await act(async () => {
        render(<App />)
      })
      await waitFor(() => {
        expect(mockDial).toHaveBeenCalledTimes(1)
      })
      expect(mockDial.mock.calls[0][0]).toMatchObject({
        destination: '30005',
        protocol: 'sip'
      })
      expect(screen.queryByTestId('SelfView')).toBeNull()
      expect(screen.queryByTestId('ErrorPanel')).toBeNull()
      setMockParticipants([participantSipTrunk, device, me])
      await act(async () => {
        triggerParticipantJoined()
      })
      await screen.findByTestId('SelfView')
    })

    it('refuses video and leaves its own leg if the device never joins; audio untouched', async () => {
      setMockParticipants([participantSipTrunk, me])
      await act(async () => {
        render(<App />)
      })
      const errorPanel = await screen.findByTestId('ErrorPanel', undefined, {
        timeout: 3000
      })
      expect(errorPanel.getElementsByTagName('p')[0].innerHTML).toBe(
        ErrorId.DEVICE_NO_ANSWER
      )
      expect(mockDisconnect).toHaveBeenCalledTimes(1)
      expect(mockDisconnectAll).not.toHaveBeenCalled()
      expect(screen.queryByTestId('SelfView')).toBeNull()
    })
  })
})
