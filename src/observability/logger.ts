import { type LogEntry, type LogSink } from './types'

const SECRET_KEY_PATTERN =
  /(token|password|secret|authorization|apikey|api[_-]?key)/i

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype

const redactValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(redactValue)
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value)) {
      if (SECRET_KEY_PATTERN.test(key)) {
        continue
      }
      out[key] = redactValue(v)
    }
    return out
  }
  return value
}

export const redact = (
  data: Record<string, unknown>
): Record<string, unknown> => redactValue(data) as Record<string, unknown>

export const createConsoleSink = (): LogSink => ({
  emit: (entry) => {
    const line = JSON.stringify(entry)
    if (entry.level === 'error') {
      console.error(line)
    } else if (entry.level === 'warn') {
      console.warn(line)
    } else {
      console.log(line)
    }
  },
  flush: async () => {
    await Promise.resolve()
  }
})

export const createBannerSink = (
  onBanner: (msg: string | null, level: LogEntry['level']) => void
): LogSink => ({
  emit: (entry) => {
    if (entry.reason != null && entry.reason !== '') {
      onBanner(entry.reason, entry.level)
    }
  },
  flush: async () => {
    await Promise.resolve()
  }
})

export class Logger {
  private readonly sessionId: string
  private readonly sinks: LogSink[]
  private conversationId?: string

  constructor(opts: {
    sessionId: string
    sinks: LogSink[]
    conversationId?: string
  }) {
    this.sessionId = opts.sessionId
    this.sinks = opts.sinks
    this.conversationId = opts.conversationId
  }

  setConversationId(id: string): void {
    this.conversationId = id
  }

  log(partial: Omit<LogEntry, 'ts' | 'sessionId' | 'conversationId'>): void {
    const entry: LogEntry = {
      ...partial,
      data: partial.data != null ? redact(partial.data) : undefined,
      ts: new Date().toISOString(),
      sessionId: this.sessionId,
      conversationId: this.conversationId
    }
    for (const sink of this.sinks) {
      sink.emit(entry)
    }
  }

  async flush(): Promise<void> {
    await Promise.all(
      this.sinks.map(async (s) => {
        await s.flush()
      })
    )
  }
}
