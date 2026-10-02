import { isPlaybackLeg, playbackLegs } from './playbackLeg'

describe('isPlaybackLeg', () => {
  it('matches a SIP leg whose alias ends in .playback', () => {
    expect(
      isPlaybackLeg({
        protocol: 'sip',
        uri: 'sip:rbfcu.playback@genesys.pexsupport.com'
      })
    ).toBe(true)
  })

  it('is case-insensitive and ignores scheme and URI parameters', () => {
    expect(
      isPlaybackLeg({
        protocol: 'SIP',
        uri: 'SIPS:Branch.Playback@x;user=phone'
      })
    ).toBe(true)
    expect(isPlaybackLeg({ protocol: 'sip', uri: 'rbfcu.playback' })).toBe(true)
  })

  it('does not match a customer, a branch device or the Genesys trunk', () => {
    expect(isPlaybackLeg({ protocol: 'sip', uri: 'sip:30005@x' })).toBe(false)
    expect(
      isPlaybackLeg({ protocol: 'sip', uri: 'sip:+19998887777@byoc.example' })
    ).toBe(false)
    expect(isPlaybackLeg({ protocol: 'sip', uri: 'sip:playback@x' })).toBe(
      false
    )
    expect(isPlaybackLeg({ protocol: 'sip', uri: 'sip:.playback@x' })).toBe(
      false
    )
    expect(
      isPlaybackLeg({ protocol: 'sip', uri: 'sip:rbfcu.playback.room@x' })
    ).toBe(false)
  })

  it('never matches a non-SIP leg (the agent) or a leg with no address', () => {
    expect(
      isPlaybackLeg({ protocol: 'webrtc', uri: 'sip:rbfcu.playback@x' })
    ).toBe(false)
    expect(isPlaybackLeg({ protocol: 'api', uri: 'rbfcu.playback' })).toBe(
      false
    )
    expect(isPlaybackLeg({ protocol: 'sip' })).toBe(false)
    expect(isPlaybackLeg({})).toBe(false)
  })
})

describe('playbackLegs', () => {
  it('returns only the playback legs, and nothing for a missing roster', () => {
    const playback = { protocol: 'sip', uri: 'sip:rbfcu.playback@x' }
    const customer = { protocol: 'sip', uri: 'sip:30005@x' }
    expect(playbackLegs([customer, playback])).toEqual([playback])
    expect(playbackLegs(undefined)).toEqual([])
  })
})
