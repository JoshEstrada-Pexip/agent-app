import {
  type ProcessVideoTrack,
  type VideoProcessor,
  createCanvasTransform,
  createSegmenter,
  createVideoProcessor,
  createVideoTrackProcessor,
  createVideoTrackProcessorWithFallback
} from '@pexip/media-processor'
import { type Effect } from '../types/Effect'
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

export const getVideoProcessor = async (
  effect: Effect
): Promise<VideoProcessor> => {
  const assets = effectAssetPaths(BASE_URL)

  // Setting the path to that `@mediapipe/tasks-vision` assets
  // It will be passed direct to
  // [FilesetResolver.forVisionTasks()](https://ai.google.dev/edge/api/mediapipe/js/tasks-vision.filesetresolver#filesetresolverforvisiontasks)
  const segmenter = createSegmenter(assets.wasm, {
    modelAsset: {
      path: assets.model,
      modelName: 'selfie'
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

  return processor
}
