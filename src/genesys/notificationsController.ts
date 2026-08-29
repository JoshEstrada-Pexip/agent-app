/**
 * This file manages the channel that listens to chat events.
 *
 * Reliability (lab finding F-20): the WebSocket previously had no failure
 * handling at all — a dead socket meant call-state events silently stopped
 * and video no longer followed hold/mute. The socket now reports loss
 * upward (so the app can fail toward video-muted) and reconnects with a
 * fresh channel + re-subscription.
 */
import platformClient from 'purecloud-platform-client-v2'
import { captureRecord } from './capture'

const notificationsApi = new platformClient.NotificationsApi()

let channel: any = {}
// Kept for debugging/visibility of the active socket.
let ws: WebSocket | null = null
export const getActiveSocket = (): WebSocket | null => ws
let intentionallyClosed = false
let reconnectAttempt = 0
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 20000]

interface ConnectionCallbacks {
  onDown?: (reason: string) => void
  onRestored?: () => void
}
let connectionCallbacks: ConnectionCallbacks = {}

// Object that will contain the subscription topic as key and the
// callback function as the value
const subscriptionMap: any = {
  'channel.metadata': () => {
    console.log('Notification heartbeat.')
  }
}

const openSocket = (): void => {
  const socket = new WebSocket(channel.connectUri as string)
  socket.onopen = (): void => {
    captureRecord('ws-open', { channelId: channel.id })
    reconnectAttempt = 0
  }
  socket.onmessage = onSocketMessage
  socket.onerror = (): void => {
    captureRecord('ws-error', {})
  }
  socket.onclose = (e: CloseEvent): void => {
    captureRecord('ws-close', {
      code: e.code,
      reason: e.reason,
      wasClean: e.wasClean
    })
    if (intentionallyClosed) {
      return
    }
    connectionCallbacks.onDown?.(`notifications socket closed (code ${e.code})`)
    scheduleReconnect()
  }
  ws = socket
}

const scheduleReconnect = (): void => {
  const delay =
    RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]
  reconnectAttempt++
  console.warn(`Notifications reconnect attempt ${reconnectAttempt} in ${delay}ms`)
  setTimeout(() => {
    reconnect().catch((err) => {
      console.error('Notifications reconnect failed', err)
      connectionCallbacks.onDown?.('reconnect attempt failed')
      scheduleReconnect()
    })
  }, delay)
}

/** Channels are single-use once dead: create a fresh one and re-subscribe. */
const reconnect = async (): Promise<void> => {
  const data = await notificationsApi.postNotificationsChannels()
  channel = data
  captureRecord('channel-created', { channelId: channel.id, reconnect: true })
  const topics = Object.keys(subscriptionMap).filter(
    (topic) => topic !== 'channel.metadata'
  )
  if (topics.length > 0) {
    await notificationsApi.postNotificationsChannelSubscriptions(
      channel.id as string,
      topics.map((id) => ({ id }))
    )
  }
  openSocket()
  connectionCallbacks.onRestored?.()
}

/**
 * Creation of the channel. If called multiple times,
 * the last one will be the active one.
 */
export const createChannel = async (
  callbacks: ConnectionCallbacks = {}
): Promise<void> => {
  connectionCallbacks = callbacks
  intentionallyClosed = false
  const data = await notificationsApi.postNotificationsChannels()

  console.log('---- Created Notifications Channel ----')
  console.log(data)

  channel = data
  captureRecord('channel-created', { channelId: channel.id })
  openSocket()
}

/**
 * Add a subscription to the channel
 * @param {String} topic PureCloud notification topic string
 * @param {Function} callback callback function to fire when the event occurs
 */
export const addSubscription = async (
  topic: string,
  callback: (event: any) => void
): Promise<void> => {
  const body = [{ id: topic }]

  await notificationsApi.postNotificationsChannelSubscriptions(
    channel.id as string,
    body
  )

  subscriptionMap[topic] = callback
  captureRecord('subscription-added', { topic })
  console.log(`Added subscription to ${topic}`)
}

/**
 * Callback function for notications event-handling.
 * It will reference the subscriptionMap to determine what function to run
 * @param {Object} event
 */
const onSocketMessage = (event: any): void => {
  let data: any
  try {
    data = JSON.parse(event.data as string)
  } catch (err) {
    // Record the unparseable frame before surfacing the same error as before.
    captureRecord('ws-parse-error', { raw: String(event.data).slice(0, 2000) })
    throw err
  }
  // Recorded before dispatch so events that crash a handler are still captured.
  captureRecord('ws-event', data)
  const handler = subscriptionMap[data.topicName]
  if (handler == null) {
    console.warn(`No handler for notification topic ${String(data.topicName)}`)
    return
  }
  handler(data)
}
