/** Stop every track of a stream (camera/presentation release). */
export const stopStream = (stream: MediaStream | undefined | null): void => {
  stream?.getTracks().forEach((track) => {
    track.stop()
  })
}
