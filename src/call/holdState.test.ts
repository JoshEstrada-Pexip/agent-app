import { deriveHoldState, type HoldLegLike } from './holdState'

/* eslint-disable @typescript-eslint/no-var-requires */
const events: Record<
  string,
  { event: { eventBody: { participants: HoldLegLike[] } } }
> = require('../genesys/__fixtures__/replay-snapshots.json')
const rest: Record<
  string,
  { conversation: { participants: HoldLegLike[] } }
> = require('../genesys/__fixtures__/rest-consult-snapshots.json')
/* eslint-enable @typescript-eslint/no-var-requires */

// The agent id the fixtures were remapped to.
const ME = 'e02618ce-1ae8-4429-bdb0-2d55f701a545'

const fromEvent = (label: string): ReturnType<typeof deriveHoldState> =>
  deriveHoldState(events[label].event.eventBody.participants, ME)
const fromRest = (label: string): ReturnType<typeof deriveHoldState> =>
  deriveHoldState(rest[label].conversation.participants, ME)

describe('deriveHoldState', () => {
  describe('recorded notification events', () => {
    it.each([
      ['baseline', false, 'held'],
      ['held', true, 'held'],
      ['unheld', false, 'held'],
      ['muted', false, 'held'],
      ['consulting', true, 'consulting'],
      ['consultCancelled', false, 'held'],
      ['consultExternalActive', true, 'consulting'],
      ['consultBackWithMember', false, 'consulting'],
      ['consultWithTargetAgain', true, 'consulting'],
      ['consultTargetGone', false, 'held']
    ])('%s → held=%s (%s)', (label, held, reason) => {
      expect(fromEvent(label)).toEqual({ held, reason })
    })
  })

  describe('recorded REST conversations (lab S3.8)', () => {
    it('agent speaking to an external consult target → held', () => {
      expect(fromRest('consultActive')).toEqual({
        held: true,
        reason: 'consulting'
      })
    })

    it('agent back with the member, consult still up → not held', () => {
      expect(fromRest('consultBackWithMember').held).toBe(false)
    })
  })

  describe('REST shape, hand-built', () => {
    const agent = (call: object): object => ({
      purpose: 'agent',
      userId: ME,
      calls: [call]
    })
    const customer = { purpose: 'customer', calls: [{ state: 'connected' }] }

    it('plain hold reads held off my connected call', () => {
      expect(
        deriveHoldState(
          [customer, agent({ state: 'connected', held: true })],
          ME
        )
      ).toEqual({ held: true, reason: 'held' })
    })

    it('not held, no consult', () => {
      expect(
        deriveHoldState(
          [customer, agent({ state: 'connected', held: false })],
          ME
        ).held
      ).toBe(false)
    })

    it('no participants or no leg of mine → not held', () => {
      expect(deriveHoldState(undefined, ME).held).toBe(false)
      expect(deriveHoldState([customer], ME).held).toBe(false)
    })
  })
})
