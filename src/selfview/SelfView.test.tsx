import { render, screen } from '@testing-library/react'

import { SelfView } from './SelfView'

jest.mock('@pexip/components', () => require('../__mocks__/components'))

beforeAll(() => {
  window.MediaStream = jest.fn().mockImplementation(() => ({
    addTrack: jest.fn()
  }))
})

describe('SelfView (docked)', () => {
  it('shows the live preview with the "customer can see you" caption', () => {
    render(
      <SelfView
        localStream={new MediaStream()}
        offTitle="Camera off"
        offDetail="Customer can't see you"
      />
    )
    expect(screen.getByTestId('SelfView').dataset.state).toBe('on')
    expect(screen.getByTestId('self-view-caption')).toHaveTextContent(
      'Customer can see you'
    )
    expect(screen.queryByTestId('self-view-off')).toBeNull()
  })

  it('keeps its place when the camera is off and says why', () => {
    render(
      <SelfView
        localStream={undefined}
        offTitle="Camera off"
        offDetail="Customer can't see you"
      />
    )
    expect(screen.getByTestId('SelfView').dataset.state).toBe('off')
    expect(screen.getByTestId('self-view-off')).toHaveTextContent(
      "Customer can't see you"
    )
    expect(screen.queryByTestId('self-view-caption')).toBeNull()
  })
})
