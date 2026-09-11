import { dropAudio } from './dropAudio'

const track = (kind: 'audio' | 'video'): MediaStreamTrack =>
  ({ kind, enabled: true }) as unknown as MediaStreamTrack

const streamOf = (...tracks: MediaStreamTrack[]): MediaStream => {
  const held = [...tracks]
  return {
    getAudioTracks: () => held.filter((t) => t.kind === 'audio'),
    getVideoTracks: () => held.filter((t) => t.kind === 'video'),
    getTracks: () => [...held],
    removeTrack: (t: MediaStreamTrack) => {
      const i = held.indexOf(t)
      if (i >= 0) {
        held.splice(i, 1)
      }
    }
  } as unknown as MediaStream
}

describe('dropAudio', () => {
  it('removes and disables every audio track', () => {
    const audio = track('audio')
    const stream = streamOf(audio, track('video'))

    dropAudio(stream)

    expect(stream.getAudioTracks()).toHaveLength(0)
    expect(audio.enabled).toBe(false)
  })

  it('leaves video tracks untouched', () => {
    const video = track('video')
    const stream = streamOf(track('audio'), video)

    dropAudio(stream)

    expect(stream.getVideoTracks()).toEqual([video])
    expect(video.enabled).toBe(true)
  })

  it('is a no-op on a stream that already has no audio', () => {
    const stream = streamOf(track('video'))

    expect(dropAudio(stream).getTracks()).toHaveLength(1)
  })
})
