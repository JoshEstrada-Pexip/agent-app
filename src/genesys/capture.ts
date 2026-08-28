/**
 * Dev-only capture of the raw Genesys notification stream (PR 0).
 *
 * Records every WebSocket payload, socket lifecycle event, and operator mark
 * so that real event sequences from lab scenarios can be saved as JSON
 * fixtures and replayed deterministically in tests.
 *
 * Enabled only when VITE_CAPTURE_EVENTS === 'true' (e.g. via .env.local).
 * When disabled (the default, and always in production builds without the
 * flag), every function is a no-op and nothing is attached to window.
 */
import { VITE_CAPTURE_EVENTS } from '../env'

export type CaptureKind =
  | 'channel-created'
  | 'subscription-added'
  | 'ws-open'
  | 'ws-event'
  | 'ws-parse-error'
  | 'ws-close'
  | 'ws-error'
  | 'context'
  | 'mark'
  | 'page-load'
  | 'console-error'
  | 'unhandled-error'
  | 'unhandled-rejection'

export interface CaptureEntry {
  seq: number
  t: string
  ms: number
  kind: CaptureKind
  data: unknown
}

const enabled = VITE_CAPTURE_EVENTS === 'true'
const entries: CaptureEntry[] = []
const startedAt = new Date().toISOString()
let seq = 0

/**
 * Every entry is also persisted synchronously to localStorage (same-origin,
 * one key per page load). The widget iframe is torn down on transfer, which
 * would otherwise destroy the in-memory log at the most interesting moment;
 * localStorage survives, and any same-origin tab can harvest all sessions
 * via __captureDumpAll().
 */
const STORAGE_PREFIX = 'pexip-capture:'
const storageKey = STORAGE_PREFIX + startedAt

const persist = (): void => {
  try {
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        format: 'genesys-call-event-capture',
        version: 1,
        startedAt,
        userAgent: navigator.userAgent,
        entries
      })
    )
  } catch {
    // Quota/unavailable — in-memory log still works; dump manually.
  }
}

export const isCaptureEnabled = (): boolean => enabled

/**
 * Appends one entry to the capture log. No-op unless capture is enabled.
 */
export const captureRecord = (kind: CaptureKind, data: unknown): void => {
  if (!enabled) {
    return
  }
  const entry = {
    seq: seq++,
    t: new Date().toISOString(),
    ms: Math.round(performance.now()),
    kind,
    data
  }
  entries.push(entry)
  persist()
  // Dev-server sink: entries also land on disk as JSONL (vite capture-sink
  // middleware) so fixtures need no browser-side harvesting. Fire-and-forget.
  void fetch('/__capture', {
    method: 'POST',
    keepalive: true,
    body: JSON.stringify({ session: startedAt, ...entry })
  }).catch(() => {})
}

/**
 * Operator annotation: call right before each scripted action (hold pressed,
 * transfer initiated, ...) so the fixture correlates actions with events.
 */
export const captureMark = (label: string): void => {
  captureRecord('mark', { label })
}

/**
 * Returns the full capture and prints it as a single JSON line so it can be
 * copied from the console into a fixture file.
 */
export const captureDump = (): Record<string, unknown> => {
  const dump = {
    format: 'genesys-call-event-capture',
    version: 1,
    startedAt,
    dumpedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    entryCount: entries.length,
    entries
  }
  console.log(
    `[capture] ${entries.length} entries — copy the JSON below into a fixture file (see docs/capture-runbook.md)`
  )
  console.log(JSON.stringify(dump))
  return dump
}

/**
 * Collects every persisted capture session (this page load and any earlier
 * iframe lifetimes) from localStorage, oldest first. Callable from ANY
 * same-origin tab — this is the harvest entry point.
 */
export const captureDumpAll = (): Array<Record<string, unknown>> => {
  const sessions: Array<Record<string, unknown>> = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key != null && key.startsWith(STORAGE_PREFIX)) {
      try {
        sessions.push(JSON.parse(localStorage.getItem(key) ?? '{}'))
      } catch {
        sessions.push({ corrupt: key })
      }
    }
  }
  sessions.sort((a, b) =>
    String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? ''))
  )
  return sessions
}

/** Wipes all persisted capture sessions — call between scenarios. */
export const captureClear = (): void => {
  const keys: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key != null && key.startsWith(STORAGE_PREFIX)) {
      keys.push(key)
    }
  }
  keys.forEach((key) => {
    localStorage.removeItem(key)
  })
  entries.length = 0
  persist()
}

const stringifyArg = (a: unknown): string => {
  if (typeof a === 'string') {
    return a
  }
  try {
    return JSON.stringify(a)
  } catch {
    return String(a)
  }
}

if (enabled) {
  ;(window as unknown as Record<string, unknown>).__captureMark = captureMark
  ;(window as unknown as Record<string, unknown>).__captureDump = captureDump
  ;(window as unknown as Record<string, unknown>).__captureDumpAll =
    captureDumpAll
  ;(window as unknown as Record<string, unknown>).__captureClear = captureClear

  // Every page load leaves a breadcrumb (URL sans query — query params carry
  // pins/tokens on some legs, so they are deliberately not recorded).
  captureRecord('page-load', {
    url: window.location.origin + window.location.pathname,
    hasQuery: window.location.search.length > 0,
    referrerOrigin: document.referrer.split('/').slice(0, 3).join('/')
  })

  // Mirror failures into the capture so a same-origin tab can diagnose a
  // widget iframe it cannot otherwise reach (cross-window, cross-origin).
  const origConsoleError = console.error.bind(console)
  console.error = (...args: unknown[]): void => {
    captureRecord('console-error', {
      message: args.map(stringifyArg).join(' ').slice(0, 2000)
    })
    origConsoleError(...args)
  }
  window.addEventListener('error', (e) => {
    captureRecord('unhandled-error', {
      message: String(e.message).slice(0, 1000),
      source: `${e.filename ?? ''}:${e.lineno ?? ''}`
    })
  })
  window.addEventListener('unhandledrejection', (e) => {
    captureRecord('unhandled-rejection', {
      reason: stringifyArg(e.reason).slice(0, 2000)
    })
  })

  console.log(
    '[capture] Genesys event capture ENABLED. Marks: __captureMark("S<x> <action>"). Harvest all sessions (any same-origin tab): __captureDumpAll(). Reset between scenarios: __captureClear().'
  )
}
