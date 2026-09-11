import { acquireLegLock, legLockName } from './videoLegLock'

import { createFakeLockManager as fakeLocks } from '../__mocks__/locks'

describe('videoLegLock', () => {
  it('names the lock per conversation and user', () => {
    expect(legLockName('conv', 'user')).toBe('pexip-video:conv:user')
  })

  it('first instance acquires, second instance is refused', async () => {
    const locks = fakeLocks()
    const a = await acquireLegLock('x', { locks })
    expect(a).not.toBeNull()
    const b = await acquireLegLock('x', { locks })
    expect(b).toBeNull()
  })

  it('releasing lets the next instance in', async () => {
    const locks = fakeLocks()
    const a = await acquireLegLock('x', { locks })
    a?.release()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(await acquireLegLock('x', { locks })).not.toBeNull()
  })

  it('steal takes the lock and the previous holder learns it was lost', async () => {
    const locks = fakeLocks()
    const a = await acquireLegLock('x', { locks })
    let lost = false
    void a?.lost.then(() => {
      lost = true
    })
    const b = await acquireLegLock('x', { locks, steal: true })
    expect(b).not.toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(lost).toBe(true)
  })

  it('behaves as the sole instance when the API is missing', async () => {
    const a = await acquireLegLock('x', { locks: undefined })
    expect(a).not.toBeNull()
  })
})
