export const createCanvasTransform = (): unknown => ({
  close: jest.fn(),
  destroy: jest.fn()
})

export const createMediapipeSegmenter = (): unknown => ({
  close: jest.fn(),
  destroy: jest.fn()
})

// Status mirrors the library: 'opened' after open, 'Error' when assets fail.
export const createSegmenter = jest.fn(() => ({
  status: 'opened',
  close: jest.fn(),
  destroy: jest.fn()
}))
export const createVideoTrackProcessor = jest.fn()
export const createVideoTrackProcessorWithFallback = jest.fn()
export const createVideoProcessor = (): unknown => ({
  close: jest.fn(),
  destroy: jest.fn(),
  open: jest.fn(),
  process: jest.fn()
})
export const ProcessVideoTrack = jest.fn()
export const RenderEffect = jest.fn()
