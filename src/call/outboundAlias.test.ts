import {
  deriveConferenceAliasFromDialedAddress,
  deviceAliasFromConferenceAlias
} from './outboundAlias'

describe('deriveConferenceAliasFromDialedAddress', () => {
  it('uses the dialed branch device alias as the room name', () => {
    expect(
      deriveConferenceAliasFromDialedAddress(
        'sip:30005@pex-simon-conf1.genesys.pexsupport.com'
      )
    ).toBe('30005')
  })

  it('handles sips: / h323: / tel: schemes and is case-insensitive', () => {
    expect(
      deriveConferenceAliasFromDialedAddress('SIPS:30005@Genesys.com')
    ).toBe('30005')
    expect(deriveConferenceAliasFromDialedAddress('h323:30005@x')).toBe('30005')
  })

  it('ignores URI parameters Genesys appends on the trunk', () => {
    expect(
      deriveConferenceAliasFromDialedAddress(
        'sip:30005@genesys.pexsupport.com;language=en-US'
      )
    ).toBe('30005')
  })

  it('handles a bare address with no scheme', () => {
    expect(
      deriveConferenceAliasFromDialedAddress('30005@genesys.pexsupport.com')
    ).toBe('30005')
    expect(deriveConferenceAliasFromDialedAddress('30999')).toBe('30999')
  })

  it('accepts the room name itself when something dials it directly', () => {
    expect(deriveConferenceAliasFromDialedAddress('sip:out_30005@x')).toBe(
      'out_30005'
    )
  })

  it('is undefined outside the branch-device range', () => {
    // Queue / inbound branch VMR range.
    expect(
      deriveConferenceAliasFromDialedAddress('31101@genesys.pexsupport.com')
    ).toBeUndefined()
    expect(deriveConferenceAliasFromDialedAddress('29999@x')).toBeUndefined()
    expect(deriveConferenceAliasFromDialedAddress('31000@x')).toBeUndefined()
  })

  it('is undefined for a PSTN number or a non-numeric alias', () => {
    expect(
      deriveConferenceAliasFromDialedAddress('sip:+19998887777@rbfcu.byoc')
    ).toBeUndefined()
    expect(
      deriveConferenceAliasFromDialedAddress('josh.estrada@pexip.com')
    ).toBeUndefined()
    expect(deriveConferenceAliasFromDialedAddress('out_@x')).toBeUndefined()
  })

  it('is undefined for empty or missing input', () => {
    expect(deriveConferenceAliasFromDialedAddress(undefined)).toBeUndefined()
    expect(deriveConferenceAliasFromDialedAddress('')).toBeUndefined()
    expect(deriveConferenceAliasFromDialedAddress('   ')).toBeUndefined()
  })
})

describe('deviceAliasFromConferenceAlias', () => {
  it('is the room name itself when the room is named after the device', () => {
    expect(deviceAliasFromConferenceAlias('30005')).toBe('30005')
  })

  it('strips an out_ prefix when the dial plan uses one', () => {
    expect(deviceAliasFromConferenceAlias('out_30005')).toBe('30005')
  })
})
