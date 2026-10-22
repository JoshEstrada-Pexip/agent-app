import {
  type ProcessVideoTrack,
  type VideoProcessor,
  createCanvasTransform,
  createSegmenter,
  createVideoProcessor,
  createVideoTrackProcessor,
  createVideoTrackProcessorWithFallback
} from '@pexip/media-processor'
import { Effect } from '../types/Effect'
import { BASE_URL } from '../env'

/**
 * Where the background-effect assets live, under the Vite base URL.
 * The base is used as a prefix with `/` appended, so a trailing slash on it
 * (`VITE_BASE_PATH=/telecom/agent-app/`) produced `/telecom/agent-app//wasm`.
 * GitHub Pages collapses the double slash; bucket hosting (Azure Blob, GCS)
 * does not, the segmenter never loaded, and blur and background image did
 * nothing (field report 2026-10-22). Both spellings of the base now work.
 */
export const effectAssetPaths = (
  baseUrl: string
): { wasm: string; model: string; backgroundImage: string } => {
  const base = baseUrl.replace(/\/+$/, '')
  return {
    wasm: `${base}/wasm`,
    model: `${base}/models/selfie_segmenter.tflite`,
    backgroundImage: `${base}/media-processor/background.jpg`
  }
}

/**
 * What the effect pipeline reports to the diagnostics log. The processor
 * library never throws on a failed open: it sets its status to `Error` and
 * calls an optional log hook. Without surfacing that, a broken effect left
 * the plain camera up and nothing in the support export (2026-10-22).
 */
export interface EffectReport {
  event: 'open' | 'opened' | 'failed' | 'library'
  level: 'debug' | 'info' | 'warn' | 'error'
  reason?: string
  data?: Record<string, unknown>
}
export type EffectReporter = (report: EffectReport) => void

const STATUS_ERROR = 'Error'
const LIBRARY_FAILURE = /fail|error|unable|cannot/i

/** Library log metadata often carries an Error; keep it JSON-safe. */
const plainMeta = (meta: unknown): unknown => {
  if (meta instanceof Error) {
    return meta.message
  }
  if (typeof meta === 'object' && meta !== null) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(meta as Record<string, unknown>)) {
      out[k] = v instanceof Error ? v.message : v
    }
    try {
      return JSON.parse(JSON.stringify(out))
    } catch {
      return String(meta)
    }
  }
  return meta
}

export const getVideoProcessor = async (
  effect: Effect,
  report?: EffectReporter
): Promise<VideoProcessor> => {
  const assets = effectAssetPaths(BASE_URL)
  const quiet = effect === Effect.None ? 'debug' : 'info'
  report?.({ event: 'open', level: quiet, data: { effect, ...assets } })

  // Setting the path to that `@mediapipe/tasks-vision` assets
  // It will be passed direct to
  // [FilesetResolver.forVisionTasks()](https://ai.google.dev/edge/api/mediapipe/js/tasks-vision.filesetresolver#filesetresolverforvisiontasks)
  const segmenter = createSegmenter(assets.wasm, {
    modelAsset: {
      path: assets.model,
      modelName: 'selfie'
    },
    log: (message, meta) => {
      report?.({
        event: 'library',
        level: LIBRARY_FAILURE.test(message) ? 'error' : 'debug',
        data: { message, meta: plainMeta(meta) }
      })
    }
  })

  const transformer = createCanvasTransform(segmenter, {
    effects: effect,
    backgroundImageUrl: assets.backgroundImage
  })

  const getTrackProcessor = (): ProcessVideoTrack => {
    // Feature detection if the browser has the `MediaStreamProcessor` API
    if ('MediaStreamTrackProcessor' in window) {
      return createVideoTrackProcessor() // Using the latest Streams API
    }
    return createVideoTrackProcessorWithFallback() // Using the fallback implementation
  }

  const processor = createVideoProcessor([transformer], getTrackProcessor())

  // Start the processor
  await processor.open()

  const status = String(segmenter.status)
  if (status === STATUS_ERROR) {
    report?.({
      event: 'failed',
      level: 'error',
      reason:
        'Background effect could not start; the camera continues without it',
      data: { effect, status, ...assets }
    })
  } else {
    report?.({ event: 'opened', level: quiet, data: { effect, status } })
  }

  return processor
}
