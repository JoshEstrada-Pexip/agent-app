/**
 * Joining a call that is ALREADY held (widget reload during a hold or a
 * consult): the REST read says held, and the camera must really stop. The
 * real genesysService and App run; only the transports are mocked.
 */
import './__mocks__/test-params'

import { render, screen, waitFor } from '@testing-library/react'

import { App } from './App'

const mockMuteVideo = jest.fn<Promise<{ status: number }>, [unknown]>(
  async () => ({ status: 200 })
)

require('./__mocks__/mediaDevices')

jest.mock('@pexip/components', () => require('./__mocks__/components'))
jest.mock('@pexip/media-components', () => ({ StreamQuality: jest.fn() }))
jest.mock(
  '@pexip/media-processor',
  () => require('./__mocks__/media-processor'),
  { virtual: true }
)
jest.mock(
  '@pexip/infinity',
  () => {
    const mockInfinity = { ...require('./__mocks__/infinity') }
    const createClient = mockInfinity.createInfinityClient
    mockInfinity.createInfinityClient = () => ({
      ...createClient(),
      muteVideo: mockMuteVideo,
      setStream: jest.fn()
    })
    return mockInfinity
  },
  { virtual: true }
)
jest.mock('./genesys/notificationsController', () => ({
  addSubscription: jest.fn(),
  createChannel: async (): Promise<void> => {
    await Promise.resolve()
  }
}))
jest.mock('./toolbar/Toolbar', () => require('./__mocks__/toolbar'))
jest.mock('./selfview/SelfView', () => ({
  SelfView: () => <div data-testid="SelfView" />
}))
jest.mock('./error-panel/ErrorPanel', () => ({
  ErrorPanel: (props: { error: string }) => (
    <div data-testid="ErrorPanel">
      <p>{props.error}</p>
    </div>
  )
}))

describe('App joining an already-held call', () => {
  beforeAll(() => {
    const params = new URLSearchParams({ access_token: 'secret' })
    params.set(
      'state',
      JSON.stringify({
        pcEnvironment: 'fake-environment',
        pcConversationId: 'fake-conversation-id',
        pexipNode: 'fake-node',
        pexipAgentPin: '2021',
        pexipAppPrefix: 'agent'
      })
    )
    window.location.hash = params.toString()
    ;(window as any).testParams.genesysHeld = true
  })

  afterAll(() => {
    ;(window as any).testParams.genesysHeld = false
  })

  it('shows the hold pane, mutes, and stops the camera track', async () => {
    // One stop() per camera stream: the first stream is the device probe
    // (always stopped), the second is the one sent into the call.
    const stops: jest.Mock[] = []
    const realGetUserMedia = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices
    )
    navigator.mediaDevices.getUserMedia = jest.fn(async () => {
      const stream = await realGetUserMedia({})
      const stop = jest.fn()
      stops.push(stop)
      stream.getTracks = () => [{ stop } as unknown as MediaStreamTrack]
      return stream
    })

    render(<App />)

    const pane = await screen.findByTestId('call-on-hold')
    expect(pane.querySelector('h1')?.textContent).toBe('Call on hold')
    await waitFor(() => {
      expect(mockMuteVideo).toHaveBeenLastCalledWith({ muteVideo: true })
      expect(stops).toHaveLength(2)
      expect(stops[1]).toHaveBeenCalled()
    })
  })
})
