export interface LogEntry {
  ts: string
  sessionId: string
  conversationId?: string
  category:
    'lifecycle' | 'media' | 'genesys' | 'pexip' | 'reconnect' | 'failsafe'
  event: string
  fromState?: string
  toState?: string
  reason?: string
  data?: Record<string, unknown>
  level: 'debug' | 'info' | 'warn' | 'error'
}

export interface LogSink {
  emit: (entry: LogEntry) => void
  flush: () => Promise<void>
}
