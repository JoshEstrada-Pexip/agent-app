import { selectMyLeg, customerLegGone } from './legSelection'

const ME = 'agent-1'

describe('selectMyLeg', () => {
  it('single connected leg (event shape) → selected', () => {
    const leg = { purpose: 'agent', state: 'connected', user: { id: ME } }
    expect(selectMyLeg([leg], ME)).toBe(leg)
  })

  it('F-19 case: terminated leg FIRST, connected leg after (REST shape) → picks the connected one', () => {
    const dead = { purpose: 'agent', userId: ME, calls: [{ state: 'terminated' }] }
    const live = { purpose: 'agent', userId: ME, calls: [{ state: 'connected' }] }
    expect(selectMyLeg([dead, live], ME)).toBe(live)
  })

  it('probe-A case: disconnected leg first, connected leg after → picks connected', () => {
    const stale = { purpose: 'agent', state: 'disconnected', user: { id: ME } }
    const live = { purpose: 'agent', state: 'connected', user: { id: ME } }
    expect(selectMyLeg([stale, live], ME)).toBe(live)
  })

  it('no connected leg → newest non-terminated (alerting) leg', () => {
    const dead = { purpose: 'agent', state: 'terminated', user: { id: ME } }
    const alerting = { purpose: 'agent', state: 'alerting', user: { id: ME } }
    expect(selectMyLeg([dead, alerting], ME)).toBe(alerting)
  })

  it('all my legs terminated → undefined (I am truly off the call)', () => {
    const legs = [
      { purpose: 'agent', state: 'terminated', user: { id: ME } },
      { purpose: 'agent', state: 'terminated', user: { id: ME } }
    ]
    expect(selectMyLeg(legs, ME)).toBeUndefined()
  })

  it('ignores other agents and other purposes', () => {
    const other = { purpose: 'agent', state: 'connected', user: { id: 'agent-2' } }
    const customer = { purpose: 'customer', state: 'connected' }
    expect(selectMyLeg([other, customer], ME)).toBeUndefined()
  })

  it('several connected legs of mine → newest wins', () => {
    const a = { purpose: 'agent', state: 'connected', user: { id: ME }, tag: 'old' }
    const b = { purpose: 'agent', state: 'connected', user: { id: ME }, tag: 'new' }
    expect(selectMyLeg([a, b], ME)).toBe(b)
  })
})

describe('customerLegGone', () => {
  it('connected customer → not gone', () => {
    expect(customerLegGone([{ purpose: 'customer', state: 'connected' }])).toBe(false)
  })

  it('customer in a transient non-connected state (dialing) → NOT gone (probe E: must not destroy the VMR)', () => {
    expect(customerLegGone([{ purpose: 'customer', state: 'dialing' }])).toBe(false)
  })

  it('no customer leg in the snapshot at all → NOT gone (ambiguous snapshot)', () => {
    expect(customerLegGone([{ purpose: 'agent', state: 'connected', user: { id: ME } }])).toBe(false)
  })

  it('undefined participants → not gone', () => {
    expect(customerLegGone(undefined)).toBe(false)
  })

  it('single disconnected customer → gone (normal call end)', () => {
    expect(customerLegGone([{ purpose: 'customer', state: 'disconnected' }])).toBe(true)
  })

  it('all customer legs ended (disconnected + terminated mix) → gone', () => {
    const legs = [
      { purpose: 'customer', state: 'terminated' },
      { purpose: 'customer', state: 'disconnected' }
    ]
    expect(customerLegGone(legs)).toBe(true)
  })

  it('old ended customer leg but a live one exists → not gone', () => {
    const legs = [
      { purpose: 'customer', state: 'disconnected' },
      { purpose: 'customer', state: 'connected' }
    ]
    expect(customerLegGone(legs)).toBe(false)
  })

  it('REST shape (calls[0].state) → gone when ended', () => {
    expect(customerLegGone([{ purpose: 'customer', calls: [{ state: 'disconnected' }] }])).toBe(true)
  })

  it('agent legs never count toward the customer verdict', () => {
    const legs = [
      { purpose: 'agent', state: 'disconnected', user: { id: ME } },
      { purpose: 'customer', state: 'connected' }
    ]
    expect(customerLegGone(legs)).toBe(false)
  })
})
