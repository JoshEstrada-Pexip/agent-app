import { effectAssetPaths } from './video-processor'

// The processor library is ESM-only and not resolvable under jest; the path
// helper under test never touches it.
jest.mock(
  '@pexip/media-processor',
  () => ({
    createCanvasTransform: jest.fn(),
    createSegmenter: jest.fn(),
    createVideoProcessor: jest.fn(),
    createVideoTrackProcessor: jest.fn(),
    createVideoTrackProcessorWithFallback: jest.fn()
  }),
  { virtual: true }
)

// Bucket hosting (Azure Blob, GCS) treats `//` literally: the segmenter's
// assets 404'd and blur / background image silently did nothing whenever the
// base path carried a trailing slash (field report 2026-10-22).
describe('effectAssetPaths', () => {
  const expected = {
    wasm: '/telecom/agent-app/wasm',
    model: '/telecom/agent-app/models/selfie_segmenter.tflite',
    backgroundImage: '/telecom/agent-app/media-processor/background.jpg'
  }

  it('base with a trailing slash (our default) → no double slash', () => {
    expect(effectAssetPaths('/telecom/agent-app/')).toEqual(expected)
  })

  it('base without a trailing slash (upstream default) → same paths', () => {
    expect(effectAssetPaths('/telecom/agent-app')).toEqual(expected)
  })

  it('root base → absolute paths from /', () => {
    expect(effectAssetPaths('/')).toEqual({
      wasm: '/wasm',
      model: '/models/selfie_segmenter.tflite',
      backgroundImage: '/media-processor/background.jpg'
    })
  })

  it('absolute origin base (dev server) → origin + path', () => {
    expect(effectAssetPaths('http://localhost/').wasm).toBe(
      'http://localhost/wasm'
    )
  })

  it('never emits a double slash for any spelling', () => {
    for (const base of ['/a/', '/a', '/a//', 'https://h/a/b/']) {
      Object.values(effectAssetPaths(base)).forEach((p) => {
        expect(p.replace(/^https?:\/\//, '')).not.toMatch(/\/\//)
      })
    }
  })
})
