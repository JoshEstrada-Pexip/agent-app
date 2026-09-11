/**
 * Drop every audio track from a stream, in place.
 *
 * The widget is a VIDEO leg: the agent's audio is carried by the Genesys SIP
 * leg and must never also come out of the browser, or the agent hears the
 * customer twice. The app asks Infinity for a call type with no audio bits
 * set, but `@pexip/infinity` 23 never forwards that request to the peer
 * connection (fixed upstream in 24 — see docs/fixes.md §17), so the call
 * negotiates audio send/recv and the node sends the conference mix down.
 *
 * Disabling as well as removing is deliberate: removing detaches the track
 * from this stream, disabling silences the track itself even if some other
 * reference to it survives.
 */
export const dropAudio = (stream: MediaStream): MediaStream => {
  stream.getAudioTracks().forEach((track) => {
    track.enabled = false
    stream.removeTrack(track)
  })
  return stream
}
