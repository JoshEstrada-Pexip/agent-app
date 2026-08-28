/**
 * PR 0 — capture module. The load-bearing assertions are the disabled-path
 * ones: with the flag off (the production default) capture must record
 * nothing and must not touch window.
 */

const loadCapture = (flag: string | undefined): typeof import('./capture') => {
  let mod: typeof import('./capture') | undefined
  jest.isolateModules(() => {
    jest.doMock('../env', () => ({
      BASE_URL: 'http://localhost',
      VITE_GENESYS_OAUTH_CLIENT_ID: 'mock-client-id',
      VITE_CAPTURE_EVENTS: flag
    }))
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mod = require('./capture')
  })
  if (mod == null) {
    throw new Error('capture module failed to load')
  }
  return mod
}

describe('capture', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {})
    delete (window as unknown as Record<string, unknown>).__captureMark
    delete (window as unknown as Record<string, unknown>).__captureDump
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('is disabled by default: records nothing, installs no window helpers', () => {
    const capture = loadCapture(undefined)
    expect(capture.isCaptureEnabled()).toBe(false)
    capture.captureRecord('ws-event', { topicName: 't' })
    capture.captureMark('hold pressed')
    const dump = capture.captureDump()
    expect(dump.entryCount).toBe(0)
    expect(
      (window as unknown as Record<string, unknown>).__captureMark
    ).toBeUndefined()
    expect(
      (window as unknown as Record<string, unknown>).__captureDump
    ).toBeUndefined()
  })

  it('persists to localStorage so the log survives iframe teardown, and clears on demand', () => {
    const capture = loadCapture('true')
    capture.captureRecord('ws-event', { topicName: 'x' })
    const sessions = capture.captureDumpAll()
    expect(sessions.length).toBeGreaterThanOrEqual(1)
    const last = sessions[sessions.length - 1]
    expect((last.entries as unknown[]).length).toBe(1)
    capture.captureClear()
    const after = capture.captureDumpAll()
    const total = after.reduce(
      (n, s) => n + ((s.entries as unknown[])?.length ?? 0),
      0
    )
    expect(total).toBe(0)
  })

  it('when enabled: records entries in order with kind, data and timestamps', () => {
    const capture = loadCapture('true')
    expect(capture.isCaptureEnabled()).toBe(true)
    capture.captureRecord('subscription-added', { topic: 'x' })
    capture.captureRecord('ws-event', { topicName: 'x', eventBody: { id: 1 } })
    capture.captureMark('S2.1 hold pressed')

    const dump = capture.captureDump()
    expect(dump.format).toBe('genesys-call-event-capture')
    expect(dump.entryCount).toBe(3)
    const entries = dump.entries as Array<Record<string, unknown>>
    expect(entries.map((e) => e.kind)).toEqual([
      'subscription-added',
      'ws-event',
      'mark'
    ])
    expect(entries.map((e) => e.seq)).toEqual([0, 1, 2])
    expect(entries[2].data).toEqual({ label: 'S2.1 hold pressed' })
    expect(typeof entries[0].t).toBe('string')
    expect(typeof entries[0].ms).toBe('number')
  })

  it('when enabled: installs window.__captureMark and window.__captureDump', () => {
    const capture = loadCapture('true')
    const w = window as unknown as Record<string, unknown>
    expect(typeof w.__captureMark).toBe('function')
    expect(typeof w.__captureDump).toBe('function')
    ;(w.__captureMark as (l: string) => void)('via window')
    const dump = capture.captureDump()
    const entries = dump.entries as Array<Record<string, unknown>>
    expect(entries.some((e) => e.kind === 'mark')).toBe(true)
  })
})
