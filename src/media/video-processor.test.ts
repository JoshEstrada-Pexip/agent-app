import { Effect } from '../types/Effect'
import {
  type EffectReport,
  effectAssetPaths,
  getVideoProcessor
} from './video-processor'

// The processor library is ESM-only and not resolvable under jest. The
// segmenter mock lets a test choose the status the library ends in and
// drive its log hook, which is how a failed open surfaces.
const mocks = {
  status: 'opened' as string,
  logHook: undefined as ((message: string, meta?: unknown) => void) | undefined,
  createSegmenter: jest.fn(),
  createCanvasTransform: jest.fn(),
  createVideoProcessor: jest.fn()
}
jest.mock(
  '@pexip/media-processor',
  () => ({
    createSegmenter: (...args: unknown[]) => mocks.createSegmenter(...args),
    createCanvasTransform: (...args: unknown[]) =>
      mocks.createCanvasTransform(...args),
    createVideoProcessor: (...args: unknown[]) =>
      mocks.createVideoProcessor(...args),
    createVideoTrackProcessor: jest.fn(),
    createVideoTrackProcessorWithFallback: jest.fn()
  }),
  { virtual: true }
)

beforeEach(() => {
  mocks.status = 'opened'
  mocks.logHook = undefined
  mocks.createSegmenter.mockImplementation(
    (_base: string, opts: { log?: typeof mocks.logHook }) => {
      mocks.logHook = opts.log
      return {
        get status() {
          return mocks.status
        }
      }
    }
  )
  mocks.createCanvasTransform.mockReturnValue({})
  mocks.createVideoProcessor.mockReturnValue({
    open: jest.fn(async () => {}),
    process: jest.fn(),
    close: jest.fn(),
    destroy: jest.fn()
  })
})

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

// What reaches the diagnostics log. BASE_URL is 'http://localhost' in tests
// (src/setupTests.ts).
describe('getVideoProcessor reporting', () => {
  const run = async (effect: Effect): Promise<EffectReport[]> => {
    const reports: EffectReport[] = []
    await getVideoProcessor(effect, (r) => reports.push(r))
    return reports
  }

  it('blur: logs the resolved asset paths, then opened', async () => {
    const reports = await run(Effect.Blur)
    expect(reports.map((r) => r.event)).toEqual(['open', 'opened'])
    expect(reports[0]).toMatchObject({
      level: 'info',
      data: {
        effect: 'blur',
        wasm: 'http://localhost/wasm',
        model: 'http://localhost/models/selfie_segmenter.tflite',
        backgroundImage: 'http://localhost/media-processor/background.jpg'
      }
    })
    expect(reports[1]).toMatchObject({
      level: 'info',
      data: { effect: 'blur', status: 'opened' }
    })
  })

  it('no effect: same entries at debug level (verbose only)', async () => {
    const reports = await run(Effect.None)
    expect(reports.map((r) => r.level)).toEqual(['debug', 'debug'])
  })

  it('library ends in Error (assets 404) → failed, error level, with paths', async () => {
    mocks.status = 'Error'
    const reports = await run(Effect.Overlay)
    const failed = reports.find((r) => r.event === 'failed')
    expect(failed).toMatchObject({
      level: 'error',
      reason: expect.stringContaining('could not start'),
      data: { effect: 'overlay', status: 'Error', wasm: 'http://localhost/wasm' }
    })
    expect(reports.some((r) => r.event === 'opened')).toBe(false)
  })

  it('library log hook: failures at error level with the Error flattened, chatter at debug', async () => {
    const reports: EffectReport[] = []
    await getVideoProcessor(Effect.Blur, (r) => reports.push(r))
    mocks.logHook?.('Failed to open process', {
      error: new Error('404 /wasm/vision_wasm_internal.js')
    })
    mocks.logHook?.('Init processor with config', { config: { a: 1 } })
    const lib = reports.filter((r) => r.event === 'library')
    expect(lib).toHaveLength(2)
    expect(lib[0]).toMatchObject({
      level: 'error',
      data: {
        message: 'Failed to open process',
        meta: { error: '404 /wasm/vision_wasm_internal.js' }
      }
    })
    expect(lib[1].level).toBe('debug')
  })

  it('still returns the processor without a reporter', async () => {
    const processor = await getVideoProcessor(Effect.Blur)
    expect(typeof processor.open).toBe('function')
  })
})
