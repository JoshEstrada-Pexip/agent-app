/**
 * One video leg per agent per call, decided BEFORE joining.
 *
 * Every widget instance for a conversation runs on the same origin in the
 * same browser (Genesys preloads one iframe for the alert and renders
 * another when the tool is opened; reloads and second tabs add more). The
 * Web Locks API gives them a shared, crash-safe mutex: the holder joins the
 * VMR, the others stay out. A lock is released automatically when its
 * iframe unloads or crashes, and `steal` lets the window the agent is
 * looking at take the leg over: the previous holder's `lost` resolves.
 *
 * Without the API (very old browsers, jsdom) the caller is treated as the
 * sole instance.
 */

export interface LegLock {
  /** Give the lock back (call ended). */
  release: () => void
  /** Resolves when another instance stole the lock. */
  lost: Promise<void>
}

export const legLockName = (conversationId: string, userId: string): string =>
  `pexip-video:${conversationId}:${userId}`

export const acquireLegLock = async (
  name: string,
  options: { steal?: boolean; locks?: LockManager | undefined } = {}
): Promise<LegLock | null> => {
  const locks =
    options.locks ??
    (typeof navigator !== 'undefined' ? navigator.locks : undefined)
  if (locks == null) {
    return { release: () => undefined, lost: new Promise(() => undefined) }
  }
  return await new Promise<LegLock | null>((resolve) => {
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let markLost: () => void = () => undefined
    const lost = new Promise<void>((resolve) => {
      markLost = resolve
    })
    const request =
      options.steal === true ? { steal: true } : { ifAvailable: true }
    locks
      .request(name, request, async (lock) => {
        if (lock == null) {
          resolve(null)
          return
        }
        resolve({ release, lost })
        await held
      })
      .catch((err: unknown) => {
        if ((err as { name?: string })?.name === 'AbortError') {
          markLost()
        } else {
          resolve(null)
        }
      })
  })
}
