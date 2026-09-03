/**
 * Replay integration test: REAL recorded Genesys notification snapshots
 * (src/genesys/__fixtures__/replay-snapshots.json, extracted from the live
 * capture by tools/lab/extract-replay-fixtures.cjs) are pushed through the
 * real genesysService into the real App. Only the transport layers are
 * mocked: the Genesys platform client, the notifications channel, Pexip
 * Infinity, and browser media.
 *
 * Validates the agent-facing state panes and the video policy against what
 * Genesys actually sends for hold, mic-mute, consult and customer hang-up.
 */
import './__mocks__/test-params'

import { act, render, screen, waitFor } from '@testing-library/react'
import { notificationToastSignal } from '@pexip/components'

import { App } from './App'

// eslint-disable-next-line no-var
var triggerEvent: (event: unknown) => void
// eslint-disable-next-line no-var
var mockDisconnectAll: jest.Mock
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
    mockDisconnectAll = mockInfinity.mockDisconnectAll
    return mockInfinity
  },
  { virtual: true }
)
jest.mock('./genesys/notificationsController', () => ({
  addSubscription: jest.fn((_topic: string, callback: () => void): void => {
    triggerEvent = callback
  }),
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

interface Snapshot {
  why: string
  source: { session: string; seq: number }
  event: unknown
}
/* eslint-disable @typescript-eslint/no-var-requires */
const snapshots: Record<
  string,
  Snapshot
> = require('./genesys/__fixtures__/replay-snapshots.json')
/* eslint-enable @typescript-eslint/no-var-requires */

const replay = (label: string): void => {
  const snap = snapshots[label]
  if (snap == null) throw new Error(`missing snapshot ${label}`)
  act(() => {
    triggerEvent(snap.event)
  })
}

const settle = async (ms: number): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

const lastMuteVideoArg = (): unknown =>
  mockMuteVideo.mock.calls[mockMuteVideo.mock.calls.length - 1]?.[0]

const toastMessages = (): string[] =>
  (notificationToastSignal.emit as jest.Mock).mock.calls.map(
    (call) => call[0]?.[0]?.message
  )

describe('App replay (real Genesys snapshots)', () => {
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
  })

  it('renders the right pane for every recorded call state', async () => {
    render(<App />)

    // Joined the video call: live view, no pane.
    await screen.findByTestId('SelfView')
    replay('baseline')
    await settle(50)
    expect(screen.queryByTestId('call-on-hold')).toBeNull()
    expect(screen.queryByTestId('state-banner')).toBeNull()

    // --- Genesys HOLD: pane with explicit privacy line, video muted.
    mockMuteVideo.mockClear()
    replay('held')
    const holdPane = await screen.findByTestId('call-on-hold')
    expect(holdPane.querySelector('h1')?.textContent).toBe('Call on hold')
    expect(holdPane.textContent).toContain(
      'Your video is muted. The customer cannot see you.'
    )
    await waitFor(() => {
      expect(lastMuteVideoArg()).toEqual({ muteVideo: true })
    })
    expect(screen.queryByTestId('state-banner')).toBeNull()

    // --- UNHOLD: settle window, then live again with a confirmation toast.
    ;(notificationToastSignal.emit as jest.Mock).mockClear()
    replay('unheld')
    // Still held during the settle window (a held=false flap must not expose video).
    await settle(300)
    expect(screen.queryByTestId('call-on-hold')).not.toBeNull()
    await waitFor(
      () => {
        expect(screen.queryByTestId('call-on-hold')).toBeNull()
      },
      { timeout: 3000 }
    )
    await screen.findByTestId('SelfView')
    await waitFor(() => {
      expect(lastMuteVideoArg()).toEqual({ muteVideo: false })
      expect(toastMessages()).toContain(
        'Video restored — the customer can see you'
      )
    })

    // --- Genesys MIC MUTE: mic-only. No pane, no banner, video untouched.
    mockMuteVideo.mockClear()
    replay('muted')
    await settle(300)
    expect(screen.queryByTestId('call-on-hold')).toBeNull()
    expect(screen.queryByTestId('state-banner')).toBeNull()
    expect(screen.queryByTestId('SelfView')).not.toBeNull()
    expect(mockMuteVideo).not.toHaveBeenCalled()
    replay('unmuted')
    await settle(300)
    expect(mockMuteVideo).not.toHaveBeenCalled()
    expect(screen.queryByTestId('call-on-hold')).toBeNull()

    // --- CONSULT started by this agent: consult wording, video muted.
    replay('consulting')
    const consultPane = await screen.findByTestId('call-on-hold')
    expect(consultPane.querySelector('h1')?.textContent).toBe(
      'Consulting — customer on hold'
    )
    expect(consultPane.textContent).toContain('Your video is muted')
    await waitFor(() => {
      expect(lastMuteVideoArg()).toEqual({ muteVideo: true })
    })

    // --- CONSULT cancelled: back to live with the toast.
    ;(notificationToastSignal.emit as jest.Mock).mockClear()
    replay('consultCancelled')
    await waitFor(
      () => {
        expect(screen.queryByTestId('call-on-hold')).toBeNull()
      },
      { timeout: 3000 }
    )
    await waitFor(() => {
      expect(lastMuteVideoArg()).toEqual({ muteVideo: false })
      expect(toastMessages()).toContain(
        'Video restored — the customer can see you'
      )
    })

    // --- CUSTOMER hangs up: "Call ended" pane, conference torn down.
    replay('customerGone')
    const endedPane = await screen.findByTestId('no-active-call')
    expect(endedPane.querySelector('h1')?.textContent).toBe('Call ended')
    expect(endedPane.textContent).toContain('Video has been disconnected.')
    expect(mockDisconnectAll).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('SelfView')).toBeNull()
  })
})
