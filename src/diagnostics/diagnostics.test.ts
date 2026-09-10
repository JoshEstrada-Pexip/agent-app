import {
  clearDiagnostics,
  collectDiagnostics,
  createStorageSink,
  isVerbose,
  MAX_ENTRIES_PER_SESSION,
  setVerbose
} from './diagnostics'
import { type LogEntry } from '../observability/types'

const entry = (event: string): LogEntry => ({
  ts: new Date().toISOString(),
  sessionId: 'i1',
  category: 'lifecycle',
  event,
  level: 'info'
})

describe('diagnostics store', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('keeps entries across a widget instance and exports them', () => {
    const sink = createStorageSink('i1')
    sink.emit(entry('join-start'))
    sink.emit(entry('passive'))
    const pkg = collectDiagnostics({ buildId: 'b1', instanceId: 'i1' })
    expect(pkg.entryCount).toBe(2)
    expect(pkg.sessions[0].entries.map((e) => e.event)).toEqual([
      'join-start',
      'passive'
    ])
  })

  it('gathers every widget instance on this origin, oldest first', () => {
    createStorageSink('i1').emit(entry('first'))
    createStorageSink('i2').emit(entry('second'))
    const pkg = collectDiagnostics({ buildId: 'b1', instanceId: 'i2' })
    expect(pkg.sessionCount).toBe(2)
    expect(pkg.entryCount).toBe(2)
  })

  it('caps a session so localStorage cannot grow without bound', () => {
    const sink = createStorageSink('i1')
    for (let i = 0; i < MAX_ENTRIES_PER_SESSION + 25; i++) {
      sink.emit(entry(`e${i}`))
    }
    const pkg = collectDiagnostics({ buildId: 'b1', instanceId: 'i1' })
    expect(pkg.entryCount).toBe(MAX_ENTRIES_PER_SESSION)
    // The newest entries survive, the oldest are dropped.
    expect(pkg.sessions[0].entries[0].event).toBe('e25')
  })

  it('never records the query string (it carries the token and PIN)', () => {
    const pkg = collectDiagnostics({ buildId: 'b1', instanceId: 'i1' })
    expect(JSON.stringify(pkg)).not.toContain('access_token')
    expect(pkg.page).not.toHaveProperty('search')
  })

  it('clear removes every stored session', () => {
    createStorageSink('i1').emit(entry('x'))
    clearDiagnostics()
    expect(
      collectDiagnostics({ buildId: 'b1', instanceId: 'i1' }).sessionCount
    ).toBe(0)
  })

  it('verbose is off by default and persists when turned on', () => {
    expect(isVerbose()).toBe(false)
    setVerbose(true)
    expect(isVerbose()).toBe(true)
    setVerbose(false)
    expect(isVerbose()).toBe(false)
  })
})
