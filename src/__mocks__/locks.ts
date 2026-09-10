/** In-memory Web Locks manager with ifAvailable + steal semantics (tests). */
export const createFakeLockManager = (): LockManager => {
  const holders = new Map<string, { reject: (e: Error) => void }>()
  const request = async (
    name: string,
    opts: LockOptions,
    cb: (lock: Lock | null) => Promise<unknown>
  ): Promise<unknown> => {
    const current = holders.get(name)
    if (current != null && opts.ifAvailable === true) {
      return await cb(null)
    }
    if (current != null && opts.steal === true) {
      const abort = new Error('stolen')
      abort.name = 'AbortError'
      current.reject(abort)
    }
    return await new Promise((resolve, reject) => {
      holders.set(name, { reject })
      cb({ name, mode: 'exclusive' })
        .then((v) => {
          if (holders.get(name)?.reject === reject) holders.delete(name)
          resolve(v)
        })
        .catch(reject)
    })
  }
  return { request, query: async () => ({}) } as unknown as LockManager
}
