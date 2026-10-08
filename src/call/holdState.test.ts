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
      ['consultBackWithMember', false, 'held'],
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

  // Flags as Genesys reported them on 2026-10-08 (lab outbound queue dial to a
  // branch device, consult to a second agent, Genesys UI buttons on the
  // initiator's consult row). Only the member's own `confined` says whether
  // the member is parked; the target's flags are irrelevant.
  describe('consult driven from the Genesys UI (lab 2026-10-08)', () => {
    const MEMBER = 'member-leg'
    const TARGET = 'target-agent'
    const consult = (
      member: object,
      target: object,
      mine: object = { state: 'connected', held: false, confined: false }
    ): HoldLegLike[] => [
      {
        id: 'me-leg',
        purpose: 'agent',
        userId: ME,
        consultParticipantId: MEMBER,
        attributes: { consultInitiator: 'true' },
        calls: [mine]
      },
      {
        id: MEMBER,
        purpose: 'customer',
        consultParticipantId: MEMBER,
        calls: [{ state: 'connected', held: false, ...member }]
      },
      {
        id: 'target-leg',
        purpose: 'agent',
        userId: TARGET,
        consultParticipantId: MEMBER,
        calls: [{ state: 'connected', held: false, ...target }]
      }
    ]

    it('consult active: member confined → held (consulting)', () => {
      expect(
        deriveHoldState(consult({ confined: true }, { confined: false }), ME)
      ).toEqual({ held: true, reason: 'consulting' })
    })

    it('consult-row Hold parks the target: member live → not held', () => {
      expect(
        deriveHoldState(consult({ confined: false }, { confined: true }), ME)
          .held
      ).toBe(false)
    })

    it('consult-row Resume: nobody confined, all three talking → not held', () => {
      // The field bug: this was read as "member parked" and video stayed dark.
      expect(
        deriveHoldState(consult({ confined: false }, { confined: false }), ME)
          .held
      ).toBe(false)
    })

    it('target holds its own leg while all three are live → still not held', () => {
      expect(
        deriveHoldState(
          consult({ confined: false }, { confined: false, held: true }),
          ME
        ).held
      ).toBe(false)
    })

    it('target holds its own leg while the member is parked → held', () => {
      expect(
        deriveHoldState(
          consult({ confined: true }, { confined: false, held: true }),
          ME
        ).held
      ).toBe(true)
    })

    it('my own hold during a consult with the member live → held (plain hold)', () => {
      expect(
        deriveHoldState(
          consult(
            { confined: false },
            { confined: false },
            { state: 'connected', held: true, confined: false }
          ),
          ME
        )
      ).toEqual({ held: true, reason: 'held' })
    })
  })
})
