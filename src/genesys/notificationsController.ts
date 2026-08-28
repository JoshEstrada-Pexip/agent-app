/**
 * This file manages the channel that listens to chat events.
 */
import platformClient from 'purecloud-platform-client-v2'
import { captureRecord } from './capture'

const notificationsApi = new platformClient.NotificationsApi()

let channel: any = {}
let ws = null

// Object that will contain the subscription topic as key and the
// callback function as the value
const subscriptionMap: any = {
  'channel.metadata': () => {
    console.log('Notification heartbeat.')
  }
}

/**
 * Creation of the channel. If called multiple times,
 * the last one will be the active one.
 */
export const createChannel = async (): Promise<void> => {
  const data = await notificationsApi.postNotificationsChannels()

  console.log('---- Created Notifications Channel ----')
  console.log(data)

  channel = data
  captureRecord('channel-created', { channelId: channel.id })
  ws = new WebSocket(channel.connectUri as string)
  ws.onopen = (): void => {
    captureRecord('ws-open', { channelId: channel.id })
  }
  ws.onclose = (e: CloseEvent): void => {
    captureRecord('ws-close', {
      code: e.code,
      reason: e.reason,
      wasClean: e.wasClean
    })
  }
  ws.onerror = (): void => {
    captureRecord('ws-error', {})
  }
  ws.onmessage = onSocketMessage
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
  subscriptionMap[data.topicName](data)
}
