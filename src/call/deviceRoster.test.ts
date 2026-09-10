import { isDeviceInRoster } from './deviceRoster'

describe('isDeviceInRoster', () => {
  it('is true when a SIP participant uri local part equals the device alias', () => {
    const roster = [
      { uri: 'sip:agent@pexip.com', protocol: 'webrtc' },
      { uri: 'sip:30005@genesys.pexsupport.com', protocol: 'sip' }
    ]
    expect(isDeviceInRoster(roster, '30005')).toBe(true)
  })

  it('is case-insensitive and ignores scheme and URI parameters', () => {
    expect(
      isDeviceInRoster(
        [{ uri: 'SIP:Room30005@x;transport=tls', protocol: 'sip' }],
        'room30005'
      )
    ).toBe(true)
  })

  it('does not match on a substring of another participant uri', () => {
    expect(
      isDeviceInRoster(
        [{ uri: 'sip:130005@genesys.pexsupport.com', protocol: 'sip' }],
        '30005'
      )
    ).toBe(false)
  })

  it('ignores non-SIP legs even when the uri matches (the agent, the trunk api leg)', () => {
    expect(
      isDeviceInRoster([{ uri: 'sip:30005@x', protocol: 'webrtc' }], '30005')
    ).toBe(false)
    expect(isDeviceInRoster([{ uri: 'sip:30005@x' }], '30005')).toBe(false)
  })

  it('is false when the device is not present', () => {
    expect(
      isDeviceInRoster(
        [{ uri: 'sip:agent@pexip.com', protocol: 'sip' }],
        '30005'
      )
    ).toBe(false)
  })

  it('is false for an empty roster, missing roster, or empty alias', () => {
    expect(isDeviceInRoster([], '30005')).toBe(false)
    expect(isDeviceInRoster(undefined, '30005')).toBe(false)
    expect(
      isDeviceInRoster([{ uri: 'sip:30005@x', protocol: 'sip' }], '')
    ).toBe(false)
  })
})
