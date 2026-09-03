import type {
  ConversationsApi,
  Models,
  UsersApi
} from 'purecloud-platform-client-v2'
import platformClient from 'purecloud-platform-client-v2'
import { GenesysRole } from '../constants/GenesysRole'
import { GenesysConnectionsState } from '../constants/GenesysConnectionState'
import { createChannel, addSubscription } from './notificationsController.ts'
import { captureRecord } from './capture'
import { selectMyLeg, customerLegGone } from '../call/legSelection'
import { GenesysDisconnectType } from '../constants/GenesysDisconnectType'
import { VITE_GENESYS_OAUTH_CLIENT_ID } from '../env'

export interface CallEvent {
  version: string
  topicName: string
  metadata: {
    CorrelationId: string
  }
  eventBody: {
    id: string
    participants: Models.ConversationCallEventTopicCallMediaParticipant[]
    recordingState: string // e.g. "active"
  }
}

const redirectUri = window.location.href.split('?')[0]

const clientId: string = VITE_GENESYS_OAUTH_CLIENT_ID
if (clientId === undefined) {
  throw new Error('VITE_GENESYS_OAUTH_CLIENT_ID is not defined')
}

const client = platformClient.ApiClient.instance

const billablePermission = 'integration:pexipVideo:agent'

let conversationId: string

let userMe: Models.UserMe

let usersApi: UsersApi
let conversationsApi: ConversationsApi

/** Why the call is held, for agent-facing UI text (video policy is the same). */
export type HoldReason = 'held' | 'consulting'

let handleHold: (flag: boolean, reason?: HoldReason) => any
let handleEndCall: (shouldDisconnectAll: boolean) => any
let handleMuteCall: (flag: boolean) => any
let handleConnectCall: () => any
let handleConnectionLoss: ((reason: string) => any) | undefined
let handleConnectionRestored: (() => any) | undefined

let onHoldState: boolean = false
let holdReasonState: HoldReason = 'held'
let muteState: boolean = false
let droppedForeignEvents: number = 0

/**
 * Triggers the login process for Genesys
 * @param pcEnvironment ToDo
 * @param pcConversationId ToDo
 * @param pexipNode ToDo
 * @param pexipAgentPin ToDo
 * @param pexipAppPrefix ToDo
 */
export const loginPureCloud = async (
  pcEnvironment: string,
  pcConversationId: string,
  pexipNode: string,
  pexipAgentPin: string,
  pexipAppPrefix: string
): Promise<void> => {
  client.setEnvironment(pcEnvironment)
  await client.loginImplicitGrant(clientId, redirectUri, {
    state: JSON.stringify({
      pcEnvironment,
      pcConversationId,
      pexipNode,
      pexipAgentPin,
      pexipAppPrefix
    })
  })
}

/**
 * Initiates the Genesys util object
 * @param genesysState The necessary context information for the Genesys util
 * @param accessToken The access token provided by Genesys after successful login
 */
export const initialize = async (
  pcEnvironment: string,
  pcConversationId: string,
  accessToken: string
): Promise<void> => {
  conversationId = pcConversationId
  const client = platformClient.ApiClient.instance
  client.setEnvironment(pcEnvironment)
  client.setAccessToken(accessToken)
  usersApi = new platformClient.UsersApi()
  conversationsApi = new platformClient.ConversationsApi()
  userMe = await usersApi.getUsersMe({ expand: ['authorization'] })
  captureRecord('context', {
    userId: userMe.id,
    conversationId: pcConversationId
  })
  await createChannel({
    onDown: (reason) => handleConnectionLoss?.(reason),
    onRestored: () => handleConnectionRestored?.()
  })
  if (userMe.id != null) {
    await addSubscription(
      `v2.users.${userMe.id}.conversations.calls`,
      callsCallback
    )
  } else {
    throw Error('Cannot get the user ID')
  }
}
/**
 * Fetches the ani name provided by inbound SIP call. It uses the conversationid provided during initialization
 * @returns The ani name which will be used as alias for the meeting
 */
export const fetchAniName = async (): Promise<string | undefined> => {
  const conversation = await conversationsApi.getConversation(conversationId)
  const participant = conversation.participants?.find(
    (participant) => participant.purpose === GenesysRole.CUSTOMER
  )
  return participant?.aniName
}

/**
 * Reads agents displayname via Genesys API
 * @returns The agents displayname (returns "Agent" if name is undefined)
 */
export const getAgentName = (): string => {
  return userMe?.name ?? 'Agent'
}

/**
 * Reads agents displayname via Genesys API
 * @returns The agents displayname (returns "Agent" if name is undefined)
 */
export const hasBillingPermission = (): boolean => {
  const foundPermission = userMe.authorization?.permissions?.find(
    (permission: string) => permission === billablePermission
  )
  return foundPermission !== undefined
}

/**
 * Reads agents hold state
 * @returns Returns the hold state of the active call
 */
export const isHeld = async (): Promise<boolean> => {
  const agentParticipant = await getActiveAgent()
  const connectedCall = agentParticipant?.calls?.find(
    (call) => call.state === GenesysConnectionsState.Connected
  )
  return connectedCall?.held ?? false
}

/**
 * Reads agents mute state
 * @returns Returns the mute state of the active call
 */
export const isMuted = async (): Promise<boolean> => {
  const agentParticipant = await getActiveAgent()
  const connectedCall = agentParticipant?.calls?.find(
    (call) => call.state === GenesysConnectionsState.Connected
  )
  return connectedCall?.muted ?? false
}

/**
 * Checks if ANI reflects a PSTN call. Whitespaces will be trimmed out.
 * @param sipSource The source domain or ip of the sip call
 * @returns true if ANI is a phone number / false if ANI is not a phone number
 */
export const isDialOut = async (sipSource: string): Promise<boolean> => {
  const conversation = await conversationsApi.getConversation(conversationId)
  const participant = conversation.participants?.find(
    (participant) => participant.purpose === GenesysRole.CUSTOMER
  )

  const regExp = new RegExp(`@(${sipSource}$)`)
  const result = participant?.calls?.some((call) =>
    regExp.test(call?.self?.addressRaw ?? '')
  )
  return result ?? false
}

/**
 * Get if the is a active call or not.
 * @returns Boolean that indicates that a call is active.
 */
export const isCallActive = async (): Promise<boolean> => {
  const conversation = await conversationsApi.getConversation(conversationId)
  // Stale-leg-safe (lab F-19): after a transfer-back the FIRST matching
  // participant is a terminated old leg; select the live one instead.
  const agentParticipant = selectMyLeg(conversation.participants, userMe.id)
  const connected = (agentParticipant?.calls ?? []).some(
    (call) => call?.state === GenesysConnectionsState.Connected
  )
  const isConsulting =
    agentParticipant?.consultParticipantId !== undefined &&
    agentParticipant?.attributes?.consultInitiator !== 'true'
  return connected && !isConsulting
}

export const addHoldListener = (
  holdListener: (flag: boolean, reason?: HoldReason) => any
): void => {
  handleHold = holdListener
}

export const addEndCallListener = (
  endCallListener: (shouldDisconnectAll: boolean) => any
): void => {
  handleEndCall = endCallListener
}

export const addMuteListener = (
  muteCallListener: (flag: boolean) => any
): void => {
  handleMuteCall = muteCallListener
}

export const addConnectCallListener = (
  handleConnectCallListener: () => any
): void => {
  handleConnectCall = handleConnectCallListener
}

/**
 * Fires when the notifications WebSocket dies (lab finding F-20: a dead
 * socket previously meant video streamed through holds indefinitely with no
 * indication). The app's fail-safe mutes video until the connection is back.
 */
export const addConnectionLossListener = (
  listener: (reason: string) => any
): void => {
  handleConnectionLoss = listener
}

/** Fires after the notifications channel has been re-created and re-subscribed. */
export const addConnectionRestoredListener = (listener: () => any): void => {
  handleConnectionRestored = listener
}

/**
 * Re-reads hold+mute truth from the REST API (used after a reconnect, when
 * events may have been missed while the socket was down).
 */
export const fetchCurrentCallState = async (): Promise<{
  held: boolean
  muted: boolean
  active: boolean
}> => {
  const [held, muted, active] = await Promise.all([
    isHeld(),
    isMuted(),
    isCallActive()
  ])
  return { held, muted, active }
}

/** Diagnostics: how many foreign-conversation events were dropped (must be 0 for own-call flows). */
export const getDroppedForeignEventCount = (): number => droppedForeignEvents

/**
 * Returns the active agent (endtime === undefined && purpose === 'agent')
 * @returns The active agent.
 */
const getActiveAgent = async (): Promise<Models.Participant | undefined> => {
  const conversation = await conversationsApi.getConversation(conversationId)
  // Unified stale-leg-safe selection (same rule as isCallActive and the
  // event path — previously three different predicates disagreed, F-19).
  return selectMyLeg(conversation?.participants, userMe.id)
}

// Pending un-hold settle timer: video MUTES immediately (privacy first) but
// un-mutes only after the hold state has been stable for a short window, so
// transient held=false flaps can never leave video live. Lab-measured event
// bursts arrive within ~150ms; 750ms is comfortably past them.
let unholdSettleTimer: ReturnType<typeof setTimeout> | null = null
const UNHOLD_SETTLE_MS = 750

/** Category of a disconnectType: values morph across snapshots and include
 *  variants like "transfer.noanswer" (lab finding F-16) — match by prefix. */
const disconnectCategory = (dt: string | undefined): string =>
  (dt ?? '').split('.')[0].toLowerCase()

const callsCallback = (callEvent: CallEvent): void => {
  // Events arrive on a USER-level topic: late events from a previous
  // conversation (or a concurrent one) must never drive this widget's call.
  // Dropped events are counted and logged for validation (must stay at zero
  // for the widget's own call flows).
  const eventConversationId = callEvent?.eventBody?.id
  if (eventConversationId !== conversationId) {
    droppedForeignEvents++
    console.warn(
      `Ignoring event for other conversation ${eventConversationId ?? '?'} (mine: ${conversationId}); total dropped: ${droppedForeignEvents}`
    )
    return
  }

  const participants = callEvent?.eventBody?.participants
  // Stale-leg-safe selection (lab finding F-19): prefer the connected leg,
  // else the newest non-terminated one — never the first match.
  const agentParticipant = selectMyLeg(participants, userMe.id)

  const connectedAgentParticipants = participants?.filter(
    (participant) =>
      participant.purpose === GenesysRole.AGENT &&
      participant.state === GenesysConnectionsState.Connected
  )

  const customerParticipant = participants?.find(
    (participant) =>
      participant.purpose === GenesysRole.CUSTOMER &&
      participant.state === GenesysConnectionsState.Connected
  )

  // Disconnect event. End the call ONLY when the customer has genuinely
  // left — every customer leg disconnected/terminated. The old check ("no
  // customer in state connected") fired on transient snapshots too, and
  // handleEndCall(true) destroys the ephemeral VMR, after which no rejoin
  // is possible.
  if (customerLegGone(participants)) {
    const shouldDisconnectAll = true
    handleEndCall(shouldDisconnectAll)
    return
  }

  if (agentParticipant?.state === GenesysConnectionsState.Disconnected) {
    const category = disconnectCategory(agentParticipant?.disconnectType)
    if (category === GenesysDisconnectType.CLIENT) {
      // Disconnect all the users when agent disconnects. We need to check if
      // another agent is connected to the same call (Audio conference).
      const shouldDisconnectAll =
        connectedAgentParticipants == null ||
        connectedAgentParticipants.length === 0
      handleEndCall(shouldDisconnectAll)
    } else if (
      category === GenesysDisconnectType.TRANSFER ||
      category === GenesysDisconnectType.PEER
    ) {
      // Transfer (incl. transfer.noanswer variants): only this agent leaves.
      // Peer: the SIP leg was terminated by Infinity.
      handleEndCall(false)
    }
  }

  // Connect event
  // This will happen if we transfer the call to another participant and he
  // transfer the call back to us
  if (
    agentParticipant?.state === GenesysConnectionsState.Connected &&
    customerParticipant?.state === GenesysConnectionsState.Connected &&
    agentParticipant.consultParticipantId === undefined
  ) {
    handleConnectCall()
  }

  // Mute event. Always forwarded (the old "only when not held" suppression
  // is removed) so the app can log it. Since 2026-09-03 mic-mute is mic-only
  // and does not drive video; Hold is the agent's privacy control.
  if (muteState !== agentParticipant?.muted) {
    muteState = agentParticipant?.muted ?? false
    handleMuteCall(muteState)
  }

  // During a consult transfer, Genesys sends held=false even though the agent
  // should be on hold. We detect this scenario and override the hold state.
  const isConsulting =
    agentParticipant?.attributes?.consultInitiator === 'true' ||
    (agentParticipant?.consultParticipantId !== undefined &&
      connectedAgentParticipants != null &&
      connectedAgentParticipants.length > 1)

  // The agent is confined when he is put on hold by the other agent in consult.
  const connectedAgentParticipantConfined = connectedAgentParticipants?.find(
    (participant) => participant.confined === true
  )

  const effectiveHoldState =
    isConsulting && connectedAgentParticipantConfined == null
      ? true
      : (agentParticipant?.held ?? false)
  // UI-only: tells the agent WHY they are held (plain hold vs consult). The
  // video policy is identical for both; a reason change while still held
  // re-emits hold(true), which is idempotent on the mute path.
  const holdReason: HoldReason = isConsulting ? 'consulting' : 'held'
  const holdReasonChanged = effectiveHoldState && holdReason !== holdReasonState
  if (onHoldState !== effectiveHoldState || holdReasonChanged) {
    onHoldState = effectiveHoldState
    holdReasonState = effectiveHoldState ? holdReason : 'held'
    if (unholdSettleTimer != null) {
      clearTimeout(unholdSettleTimer)
      unholdSettleTimer = null
    }
    if (effectiveHoldState) {
      // Privacy first: mute IMMEDIATELY (was a blind 1s delay — lab F-02
      // measured a ~2s live-video window on every hold).
      handleHold(true, holdReason)
    } else {
      // Un-mute only once the state has settled, so a held=false flap can
      // never briefly expose video.
      unholdSettleTimer = setTimeout(() => {
        unholdSettleTimer = null
        if (!onHoldState) {
          handleHold(false)
        }
      }, UNHOLD_SETTLE_MS)
    }
  }
}
