import {
  agentCallTag,
  ghostLegsOfMine,
  isMyLeg,
  remainingCounterparties
} from './legIdentity'

const identity = { userId: 'u1', conversationId: 'c1' }
const tag = (instance: string): { call_tag: string } => ({
  call_tag: agentCallTag(identity, instance)
})
const customer = { uuid: 'c', callType: 'video', startTime: 100 }
const customerNamedLikeMe = {
  uuid: 'c2',
  callType: 'video',
  startTime: 100,
  rawData: {}
}
const trunk = { uuid: 't', callType: 'audio', startTime: 100 }
const me = { uuid: 'me', callType: 'video', startTime: 300, rawData: tag('i2') }
const ghost = { uuid: 'g', callType: 'api', startTime: 200, rawData: tag('i1') }
const newer = {
  uuid: 'n',
  callType: 'video',
  startTime: 400,
  rawData: tag('i3')
}
const otherAgent = {
  uuid: 'a2',
  callType: 'video',
  startTime: 250,
  rawData: { call_tag: 'genesys-user:u2;conv:c1;instance:x' }
}
const meOtherCall = {
  uuid: 'oc',
  callType: 'video',
  startTime: 250,
  rawData: { call_tag: 'genesys-user:u1;conv:c9;instance:x' }
}

describe('legIdentity', () => {
  it('builds a tag carrying user, conversation and instance', () => {
    expect(agentCallTag(identity, 'abc')).toBe(
      'genesys-user:u1;conv:c1;instance:abc'
    )
  })

  it('matches only legs tagged with my user AND this conversation', () => {
    expect(isMyLeg(me, identity)).toBe(true)
    expect(isMyLeg(ghost, identity)).toBe(true)
    expect(isMyLeg(otherAgent, identity)).toBe(false)
    expect(isMyLeg(meOtherCall, identity)).toBe(false)
    expect(isMyLeg(customer, identity)).toBe(false)
    expect(isMyLeg(customerNamedLikeMe, identity)).toBe(false)
  })

  describe('ghostLegsOfMine', () => {
    it('returns my older legs only', () => {
      expect(
        ghostLegsOfMine(
          [trunk, customer, ghost, otherAgent, me, newer],
          me,
          identity
        ).map((p) => p.uuid)
      ).toEqual(['g'])
    })

    it('returns nothing until my own start time is known', () => {
      const meUnknown = { ...me, startTime: null }
      expect(ghostLegsOfMine([ghost, meUnknown], meUnknown, identity)).toEqual(
        []
      )
    })

    it('breaks a start-time tie by uuid', () => {
      const a = { ...me, uuid: 'a', startTime: 300 }
      const b = { ...me, uuid: 'b', startTime: 300 }
      expect(ghostLegsOfMine([a, b], b, identity).map((p) => p.uuid)).toEqual([
        'a'
      ])
      expect(ghostLegsOfMine([a, b], a, identity)).toEqual([])
    })

    it('takeover evicts every other leg of mine', () => {
      expect(
        ghostLegsOfMine([ghost, me, newer, otherAgent], me, identity, {
          takeover: true
        }).map((p) => p.uuid)
      ).toEqual(['g', 'n'])
    })
  })

  describe('remainingCounterparties', () => {
    it('ignores the audio trunk and every leg of mine', () => {
      expect(remainingCounterparties([trunk, ghost, me], identity)).toEqual([])
    })

    it('keeps the customer while a ghost of me is present', () => {
      expect(
        remainingCounterparties([trunk, customer, ghost, me], identity)
      ).toEqual([customer])
    })

    it('keeps another agent (consult / conference)', () => {
      expect(
        remainingCounterparties([trunk, otherAgent, me], identity)
      ).toEqual([otherAgent])
    })
  })
})
