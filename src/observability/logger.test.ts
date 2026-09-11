import { redact, Logger, createConsoleSink, createBannerSink } from './logger'
import { type LogEntry, type LogSink } from './types'

describe('redact', () => {
  it('removes secret-ish keys but keeps ids and state', () => {
    const input = {
      accessToken: 'abc',
      access_token: 'abc',
      authorization: 'Bearer x',
      password: 'p',
      conversationId: 'conv-1',
      isCameraMuted: true
    }
    expect(redact(input)).toEqual({
      conversationId: 'conv-1',
      isCameraMuted: true
    })
  })

  it('recurses into nested objects and arrays', () => {
    const input = {
      id: 'c1',
      headers: { Authorization: 'Bearer x', 'x-req': 'ok' },
      items: [{ accessToken: 'nope', label: 'keep' }],
      nested: { deep: { clientSecret: 'sh', state: 'held' } }
    }
    expect(redact(input)).toEqual({
      id: 'c1',
      headers: { 'x-req': 'ok' },
      items: [{ label: 'keep' }],
      nested: { deep: { state: 'held' } }
    })
  })

  it('does not over-strip author/authority keys', () => {
    expect(
      redact({ author: 'jane', authority: 'acd', authToken: 'x' })
    ).toEqual({ author: 'jane', authority: 'acd' })
  })
})

describe('Logger + sinks', () => {
  it('stamps ts/sessionId/conversationId and redacts data', () => {
    const captured: LogEntry[] = []
    const capture: LogSink = {
      emit: (e) => captured.push(e),
      flush: async () => {}
    }
    const logger = new Logger({
      sessionId: 's1',
      sinks: [capture],
      conversationId: 'c1'
    })
    logger.log({
      category: 'media',
      event: 'video-muted',
      level: 'info',
      data: { accessToken: 'nope', isCameraMuted: true }
    })
    expect(captured).toHaveLength(1)
    expect(captured[0].sessionId).toBe('s1')
    expect(captured[0].conversationId).toBe('c1')
    expect(typeof captured[0].ts).toBe('string')
    expect(captured[0].data).toEqual({ isCameraMuted: true })
  })

  it('banner sink fires only when reason present', () => {
    const calls: Array<string | null> = []
    const sink = createBannerSink((msg) => calls.push(msg))
    sink.emit({
      ts: 't',
      sessionId: 's',
      category: 'failsafe',
      event: 'x',
      level: 'warn',
      reason: 'Muted — state uncertain'
    })
    sink.emit({
      ts: 't',
      sessionId: 's',
      category: 'media',
      event: 'y',
      level: 'info'
    })
    expect(calls).toEqual(['Muted — state uncertain'])
  })

  it('console sink routes by level', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {})
    const err = jest.spyOn(console, 'error').mockImplementation(() => {})
    const sink = createConsoleSink()
    sink.emit({
      ts: 't',
      sessionId: 's',
      category: 'media',
      event: 'a',
      level: 'info'
    })
    sink.emit({
      ts: 't',
      sessionId: 's',
      category: 'media',
      event: 'b',
      level: 'error'
    })
    expect(log).toHaveBeenCalledTimes(1)
    expect(err).toHaveBeenCalledTimes(1)
    log.mockRestore()
    err.mockRestore()
  })
})
