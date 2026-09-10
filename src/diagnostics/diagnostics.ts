/**
 * Support diagnostics, entirely in the agent's browser.
 *
 * Nothing is ever sent anywhere: the widget keeps a rolling log in
 * localStorage and the agent hands it over on request. Two levels:
 *
 *  - NORMAL (always on): state transitions, warnings and failures. A few
 *    dozen entries per call, enough to answer "which build, which room,
 *    what did it decide, what failed".
 *  - VERBOSE (turned on for an investigation): adds debug entries and the
 *    raw Genesys notification stream, so a reproduction can be replayed.
 *
 * localStorage is shared across the widget's iframes on this origin, so the
 * log survives Genesys destroying and recreating the widget between
 * interactions, and one export carries every instance.
 */
import { type LogEntry, type LogSink } from '../observability/types'

const LOG_PREFIX = 'pexip-log:'
const VERBOSE_KEY = 'pexip-diag:verbose'

/** Per-instance caps. localStorage is ~5 MB for the whole origin. */
export const MAX_ENTRIES_PER_SESSION = 500
export const MAX_SESSIONS_KEPT = 6

export interface LogSession {
  instanceId: string
  startedAt: string
  entries: LogEntry[]
}

const readSession = (key: string): LogSession | null => {
  try {
    const raw = localStorage.getItem(key)
    return raw == null ? null : (JSON.parse(raw) as LogSession)
  } catch {
    return null
  }
}

const sessionKeys = (): string[] => {
  const keys: string[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith(LOG_PREFIX) === true) {
        keys.push(key)
      }
    }
  } catch {
    // Storage unavailable (private mode, blocked cookies) — memory only.
  }
  return keys.sort()
}

/** Keep the newest sessions; older widget lifetimes are dropped. */
const pruneSessions = (keepKey: string): void => {
  const keys = sessionKeys().filter((k) => k !== keepKey)
  const sorted = keys
    .map((key) => ({ key, startedAt: readSession(key)?.startedAt ?? '' }))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  const excess = sorted.slice(
    0,
    Math.max(0, sorted.length - (MAX_SESSIONS_KEPT - 1))
  )
  excess.forEach(({ key }) => {
    try {
      localStorage.removeItem(key)
    } catch {
      /* ignore */
    }
  })
}

/** True when the agent (or a widget URL parameter) asked for verbose logs. */
export const isVerbose = (): boolean => {
  try {
    if (new URLSearchParams(window.location.search).get('debug') === '1') {
      return true
    }
    return localStorage.getItem(VERBOSE_KEY) === 'true'
  } catch {
    return false
  }
}

/** Persisted so it survives the reload that applies it. */
export const setVerbose = (on: boolean): void => {
  try {
    if (on) {
      localStorage.setItem(VERBOSE_KEY, 'true')
    } else {
      localStorage.removeItem(VERBOSE_KEY)
    }
  } catch {
    /* ignore */
  }
}

/**
 * Sink that keeps the last MAX_ENTRIES_PER_SESSION entries for this widget
 * instance and mirrors them to localStorage after every entry, so a crash or
 * an iframe teardown never loses the interesting part.
 */
export const createStorageSink = (instanceId: string): LogSink => {
  const key = LOG_PREFIX + instanceId
  const session: LogSession = {
    instanceId,
    startedAt: new Date().toISOString(),
    entries: []
  }
  pruneSessions(key)
  const persist = (): void => {
    try {
      localStorage.setItem(key, JSON.stringify(session))
    } catch {
      // Quota: drop the oldest half and try once more.
      session.entries.splice(0, Math.floor(session.entries.length / 2))
      try {
        localStorage.setItem(key, JSON.stringify(session))
      } catch {
        /* give up; the in-memory copy still exports */
      }
    }
  }
  return {
    emit: (entry) => {
      session.entries.push(entry)
      if (session.entries.length > MAX_ENTRIES_PER_SESSION) {
        session.entries.shift()
      }
      persist()
    },
    flush: async () => {
      persist()
      await Promise.resolve()
    }
  }
}

export interface DiagnosticsContext {
  buildId: string
  instanceId: string
  conversationId?: string
  userId?: string
  state?: Record<string, unknown>
}

export interface DiagnosticsPackage {
  format: 'pexip-genesys-widget-diagnostics'
  version: 1
  collectedAt: string
  verbose: boolean
  build: string
  instanceId: string
  conversationId?: string
  userId?: string
  state?: Record<string, unknown>
  page: { origin: string; path: string; referrerOrigin: string }
  userAgent: string
  sessionCount: number
  entryCount: number
  sessions: LogSession[]
  /** Raw Genesys notification stream; present only in verbose mode. */
  genesysCapture?: Array<Record<string, unknown>>
}

/**
 * Every stored session for this origin, oldest first, plus context. The
 * caller decides what to do with it (copy, download, show).
 */
export const collectDiagnostics = (
  ctx: DiagnosticsContext,
  genesysCapture?: Array<Record<string, unknown>>
): DiagnosticsPackage => {
  const sessions = sessionKeys()
    .map(readSession)
    .filter((s): s is LogSession => s != null)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  return {
    format: 'pexip-genesys-widget-diagnostics',
    version: 1,
    collectedAt: new Date().toISOString(),
    verbose: isVerbose(),
    build: ctx.buildId,
    instanceId: ctx.instanceId,
    conversationId: ctx.conversationId,
    userId: ctx.userId,
    state: ctx.state,
    page: {
      // Query strings carry the access token and the conference PIN.
      origin: window.location.origin,
      path: window.location.pathname,
      referrerOrigin: document.referrer.split('/').slice(0, 3).join('/')
    },
    userAgent: navigator.userAgent,
    sessionCount: sessions.length,
    entryCount: sessions.reduce((n, s) => n + s.entries.length, 0),
    sessions,
    genesysCapture
  }
}

/** Wipes stored logs (all widget instances on this origin). */
export const clearDiagnostics = (): void => {
  sessionKeys().forEach((key) => {
    try {
      localStorage.removeItem(key)
    } catch {
      /* ignore */
    }
  })
}

export const diagnosticsFileName = (pkg: DiagnosticsPackage): string =>
  `pexip-widget-${(pkg.conversationId ?? 'no-call').slice(0, 8)}-${pkg.collectedAt.replace(/[:.]/g, '-')}.json`

/**
 * Best-effort clipboard copy. The widget runs in a Genesys iframe whose
 * sandbox may withhold clipboard access, so the caller must keep a
 * selectable copy on screen as the guaranteed path.
 */
export const copyText = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** Best-effort download; blocked in an iframe without allow-downloads. */
export const downloadText = (name: string, text: string): boolean => {
  try {
    const url = URL.createObjectURL(
      new Blob([text], { type: 'application/json' })
    )
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => {
      URL.revokeObjectURL(url)
    }, 10000)
    return true
  } catch {
    return false
  }
}
