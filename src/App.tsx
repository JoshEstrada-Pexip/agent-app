import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'
import {
  createInfinityClient,
  createInfinityClientSignals,
  createCallSignals,
  type InfinityClient,
  type InfinitySignals,
  type CallSignals,
  ClientCallType,
  type PresoConnectionChangeEvent
} from '@pexip/infinity'
import {
  Button,
  CenterLayout,
  Icon,
  IconTypes,
  NotificationToast,
  notificationToastSignal,
  Spinner,
  Video
} from '@pexip/components'
import { StreamQuality } from '@pexip/media-components'
import { convertToBandwidth } from './media/quality'
import * as GenesysService from './genesys/genesysService'
import { type HoldReason } from './genesys/genesysService'
import { ErrorPanel } from './error-panel/ErrorPanel'
import { ErrorId } from './constants/ErrorId'
import { ConnectionState } from './types/ConnectionState'
import { Toolbar } from './toolbar/Toolbar'
import { SelfView } from './selfview/SelfView'
import { type Settings } from './types/Settings'
import { type MediaDeviceInfoLike } from '@pexip/media-control'
import { Effect } from './types/Effect'
import { type VideoProcessor } from '@pexip/media-processor'
import { getVideoProcessor } from './media/video-processor'
import { LocalStorageKey } from './types/LocalStorageKey'
import { Logger, createConsoleSink } from './observability/logger'
import { DiagnosticsPanel } from './diagnostics/DiagnosticsPanel'
import { createStorageSink, isVerbose } from './diagnostics/diagnostics'
import {
  agentCallTag,
  ghostLegsOfMine,
  isMyLeg,
  remainingCounterparties,
  type AgentIdentity,
  type RosterLegLike
} from './call/legIdentity'
import { acquireLegLock, legLockName, type LegLock } from './call/videoLegLock'
import { deviceAliasFromConferenceAlias } from './call/outboundAlias'
import { isDeviceInRoster } from './call/deviceRoster'
import { DEVICE_JOIN_TIMEOUT_MS } from './constants/Outbound'
import { useWidgetVisibility } from './hooks/useWidgetVisibility'
import { StatePane } from './components/StatePane'
import { stopStream } from './media/stopStream'

import './App.scss'

let infinitySignals: InfinitySignals
let callSignals: CallSignals
let infinityClient: InfinityClient

let pexipNode: string
let pexipAgentPin: string
let pexipAppPrefix: string = 'agent'

let videoProcessor: VideoProcessor

// Injected by vite `define`; absent under jest.
// eslint-disable-next-line @typescript-eslint/naming-convention
declare const __BUILD_ID__: string | undefined
const BUILD_ID: string = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev'
// A widget that lost the video leg to another instance but is the one the
// agent can SEE takes it back after this long (once per call).
const AUTO_TAKEOVER_MS = 2000
// One automatic rejoin after an unexpected Infinity drop, after this long.
const REJOIN_DELAY_MS = 1500

/** Where this instance stands with the Pexip leg. Guards event handlers. */
type Phase = 'idle' | 'joining' | 'active' | 'passive'
/** Why the Disconnected pane is shown. */
type IdleReason =
  'none' | 'alerting' | 'ended' | 'another-window' | 'audio-only'

// A Connecting step that has not progressed within this window shows the
// agent a "still connecting" pane instead of an indefinite spinner.
const CONNECTING_WATCHDOG_MS = 20_000

/**
 * Screen-share picker hints (Chrome 107+/119+; other browsers ignore them).
 * The picker is the BROWSER's, not Pexip's: a page can only bias it —
 * pre-select the "Chrome Tab" pane and remove "Entire screen". "Window"
 * cannot be removed by a web page; only the Chrome enterprise policy
 * TabCaptureAllowedByOrigins restricts an origin to tab capture outright.
 */
const displayCaptureOptions: DisplayMediaStreamOptions & {
  monitorTypeSurfaces?: 'include' | 'exclude'
  surfaceSwitching?: 'include' | 'exclude'
} = {
  video: { displaySurface: 'browser' },
  audio: false,
  monitorTypeSurfaces: 'exclude',
  surfaceSwitching: 'include'
}

interface GenesysState {
  pcEnvironment: string
  pcConversationId: string
  pexipNode: string
  pexipAgentPin: string
  pexipAppPrefix: string
}

export const App = (): React.JSX.Element => {
  const [device, setDevice] = useState<MediaDeviceInfoLike>()
  const [effect, setEffect] = useState<Effect>(
    (localStorage.getItem(LocalStorageKey.Effect) as Effect) ?? Effect.None
  )
  const [streamQuality, setStreamQuality] = useState<StreamQuality>(
    (localStorage.getItem(LocalStorageKey.StreamQuality) as StreamQuality) ??
      StreamQuality.High
  )
  const [localStream, setLocalStream] = useState<MediaStream>()
  const [processedStream, setProcessedStream] = useState<MediaStream>()
  const [cameraMuted, setCameraMuted] = useState<boolean>(false)
  const [remoteStream, setRemoteStream] = useState<MediaStream>()
  const [presenting, setPresenting] = useState<boolean>(false)
  const [presentationStream, setPresentationStream] = useState<MediaStream>()

  const [connectionState, setConnectionState] = useState<ConnectionState>(
    ConnectionState.Connecting
  )
  const [secondaryVideo, setSecondaryVideo] = useState<
    'remote' | 'presentation'
  >('presentation')

  const [errorId, setErrorId] = useState<string>('')

  const [banner, setBanner] = useState<string | null>(null)
  // Agent-facing state detail (UI only; never drives the video policy).
  const [holdReason, setHoldReason] = useState<HoldReason>('held')
  const [connectingStep, setConnectingStep] = useState<string | null>(null)
  const [connectingStalled, setConnectingStalled] = useState<boolean>(false)
  const [idleReason, setIdleReason] = useState<IdleReason>('none')
  // One automatic takeover per call (reset only when the call ends), so two
  // visible instances converge instead of trading the leg forever.
  const [takeoverAttempted, setTakeoverAttempted] = useState<boolean>(false)

  const appRef = useRef<HTMLDivElement | null>(null)
  const visible = useWidgetVisibility(appRef)

  // Privacy causes currently in force; video must be dark while ANY is true.
  // Genesys mic-mute is deliberately NOT a cause (decided 2026-09-03): the
  // agent uses Hold for privacy, and mic-mute must only mute the mic.
  const privacyRef = useRef({
    held: false,
    connectionLost: false
  })
  // Event handlers read the phase from a ref: they run from SDK/WebSocket
  // callbacks whose closures may be stale, and Genesys sends bursts of
  // connect-shaped events, so this is the ONE re-entrancy guard.
  const phaseRef = useRef<Phase>('idle')
  const setPhase = (phase: Phase): void => {
    phaseRef.current = phase
  }
  const isActive = (): boolean => phaseRef.current === 'active'
  // Identity this instance joined with (call tag); set once per join.
  const identityRef = useRef<AgentIdentity | undefined>(undefined)
  // Held for the life of the call; other instances stay out of the VMR.
  const legLockRef = useRef<LegLock | null>(null)
  const rejoinAttemptedRef = useRef(false)
  const kicksInFlightRef = useRef(new Set<string>())
  // Mirror of localStream for teardown paths called from stale closures.
  const localStreamRef = useRef<MediaStream | undefined>(undefined)

  // One id per widget instance: console log lines and the Infinity call tag
  // carry the same value so the two logs can be joined.
  const instanceIdRef = useRef<string>(uuidv4())
  const instanceId = instanceIdRef.current
  const loggerRef = useRef<Logger | null>(null)
  if (loggerRef.current == null) {
    // Support diagnostics: the storage sink keeps a rolling log in this
    // browser so an agent can hand it over on request. Nothing is sent
    // anywhere. Verbose adds debug entries and the raw Genesys stream.
    loggerRef.current = new Logger({
      sessionId: instanceId,
      sinks: [createConsoleSink(), createStorageSink(instanceId)],
      minLevel: isVerbose() ? 'debug' : 'info'
    })
  }
  const logger = loggerRef.current
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)

  /** Common reset when this instance stops owning the leg (any reason). */
  const resetCallState = (): void => {
    privacyRef.current = { held: false, connectionLost: false }
    setBanner(null)
    stopStream(localStreamRef.current)
    setLocalStream(undefined)
    setProcessedStream(undefined)
  }

  const checkCameraAccess = async (): Promise<void> => {
    const devices = await navigator.mediaDevices.enumerateDevices()
    if (devices.filter((device) => device.kind === 'videoinput').length === 0) {
      setErrorId(ErrorId.CAMERA_NOT_CONNECTED)
      setConnectionState(ConnectionState.Error)
      throw new Error('Camera not connected')
    }
  }

  const joinConference = async (
    node: string,
    conferenceAlias: string,
    mediaStream: MediaStream,
    displayName: string,
    pin: string,
    identity: AgentIdentity
  ): Promise<void> => {
    infinityClient = createInfinityClient(infinitySignals, callSignals)
    const bandwidth = convertToBandwidth(streamQuality)
    const response = await infinityClient.call({
      node,
      conferenceAlias,
      mediaStream,
      displayName,
      bandwidth,
      pin,
      // Infinity echoes the tag on every roster participant: that is how
      // this instance recognises its own ghost legs (call/legIdentity.ts).
      callTag: agentCallTag(identity, instanceId),
      callType: ClientCallType.VideoSendRecvPresentationSendRecv
    })

    if (response != null) {
      switch (response.status) {
        case 403: {
          setErrorId(ErrorId.CONFERENCE_AUTHENTICATION_FAILED)
          setConnectionState(ConnectionState.Error)
          break
        }
        case 404: {
          setErrorId(ErrorId.CONFERENCE_NOT_FOUND)
          setConnectionState(ConnectionState.Error)
          break
        }
        default: {
          // Privacy pre-mute: never show live video in the window before the
          // call's real state is known (e.g. joining into an already-held
          // call). initConference settles it against real state right after.
          await infinityClient
            .muteVideo({ muteVideo: true })
            .catch(console.error)
          // Phase only: the Connected/OnHold UI is set by the settle step
          // after the join (outbound waits for the branch device first).
          setPhase('active')
          break
        }
      }
    } else {
      setErrorId(ErrorId.INFINITY_SERVER_UNAVAILABLE)
      setConnectionState(ConnectionState.Error)
    }
  }

  const exchangeVideos = (): void => {
    if (secondaryVideo === 'presentation') {
      setSecondaryVideo('remote')
    } else {
      setSecondaryVideo('presentation')
    }
  }

  /**
   * Initiates a conference based on the global fields pexipNode and pexipAgentPin.
   * The local media stream will be initiated in this method.
   * The method relies on GenesysService to get the conference alias and the agents display name
   */
  const initConference = async (
    options: { takeover?: boolean } = {}
  ): Promise<void> => {
    const takeover = options.takeover === true
    if (
      phaseRef.current !== 'idle' &&
      !(takeover && phaseRef.current === 'passive')
    ) {
      logger.log({
        category: 'lifecycle',
        event: 'join-suppressed',
        level: 'debug',
        reason: phaseRef.current
      })
      return
    }
    if (pexipNode === '') {
      failBootstrap(ErrorId.MISSING_CONFIG, 'pexipNode is empty')
      return
    }
    logger.log({
      category: 'lifecycle',
      event: 'join-start',
      level: 'info',
      reason: takeover ? 'takeover' : 'connect'
    })
    setPhase('joining')
    try {
      await join(takeover)
    } finally {
      // Anything but a completed join leaves this instance out of the call.
      if ((phaseRef.current as Phase) === 'joining') {
        setPhase('idle')
      }
    }
  }

  const join = async (takeover: boolean): Promise<void> => {
    setConnectionState(ConnectionState.Connecting)
    setConnectingStep('Locating the call')
    setIdleReason('none')

    // The rendezvous key is whatever both sides already share. Outbound: the
    // agent dialed `out_<device>@…`, Pexip minted a room of that name, and
    // the widget joins it AS IS (no app prefix). Inbound: the customer's ANI
    // name, prefixed. Never a generated alias — that joined an empty room
    // (black screen with working audio).
    const outboundAlias = await GenesysService.fetchOutboundAlias().catch(
      () => undefined
    )
    const isOutbound = outboundAlias != null
    let joinAlias: string
    if (isOutbound) {
      joinAlias = outboundAlias
    } else {
      const aniName = await GenesysService.fetchAniName().catch(() => undefined)
      if (aniName == null || aniName === '') {
        logger.log({
          category: 'failsafe',
          event: 'alias-unavailable',
          level: 'error',
          reason: 'no ANI name on customer leg — cannot locate the call VMR'
        })
        setErrorId(ErrorId.VIDEO_UNAVAILABLE)
        setConnectionState(ConnectionState.Error)
        return
      }
      joinAlias = pexipAppPrefix + aniName
    }

    // Election before joining: one leg per agent per call in this browser.
    // Losing means another instance already has the video; this one waits
    // (and, if it is the visible one, takes over shortly).
    const identity: AgentIdentity = {
      userId: GenesysService.getUserId() ?? 'unknown',
      conversationId: GenesysService.getConversationId()
    }
    identityRef.current = identity
    if (legLockRef.current == null) {
      const lock = await acquireLegLock(
        legLockName(identity.conversationId, identity.userId),
        { steal: takeover }
      )
      if (lock == null) {
        logger.log({
          category: 'lifecycle',
          event: 'leg-owned-elsewhere',
          level: 'info',
          reason: 'another widget instance holds the video leg'
        })
        goPassive('lost election')
        return
      }
      legLockRef.current = lock
      lock.lost.then(() => {
        if (legLockRef.current !== lock) {
          return
        }
        legLockRef.current = null
        goPassive('leg taken over by another window')
        Promise.resolve(infinityClient?.disconnect({})).catch(() => undefined)
      }, console.error)
    }

    logger.log({
      category: 'lifecycle',
      event: 'alias-resolved',
      level: 'info',
      reason: isOutbound ? 'outbound' : 'inbound',
      data: { joinAlias }
    })
    setConnectingStep('Starting camera')
    let localStream: MediaStream
    let processedStream: MediaStream
    try {
      const device = await getInitialDevice()
      localStream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: device?.deviceId } }
      })
      processedStream = await getProcessedStream(localStream, effect)
      setDevice(device)
      setLocalStream(localStream)
      setProcessedStream(processedStream)
    } catch (err) {
      setErrorId(ErrorId.CAMERA_ACCESS_DENIED)
      setConnectionState(ConnectionState.Error)
      return
    }

    const displayName = GenesysService.getAgentName()

    setConnectingStep('Joining video')
    await joinConference(
      pexipNode,
      joinAlias,
      processedStream,
      displayName,
      pexipAgentPin,
      identity
    )

    // Deterministically settle video against the REAL call state right after
    // join. The conference was joined video-MUTED (privacy pre-mute in
    // joinConference); this either keeps it dark (held) or brings it live for
    // a normal call. Skipped when the join failed (error state).
    if (!isActive()) {
      return
    }
    if (isOutbound) {
      // Audio first: video stays dark until the branch device is actually in
      // the room (the trunk leg "connects" as soon as Pexip mints the room,
      // so Genesys' connected state proves nothing about the device).
      const deviceAlias = deviceAliasFromConferenceAlias(outboundAlias)
      setConnectingStep('Waiting for the branch device')
      const present = await waitForDevice(deviceAlias)
      if (!present) {
        logger.log({
          category: 'failsafe',
          event: 'device-no-answer',
          level: 'error',
          reason: 'branch device never joined the VMR',
          data: { deviceAlias, timeoutMs: DEVICE_JOIN_TIMEOUT_MS }
        })
        await leaveWithoutVideo()
        setErrorId(ErrorId.DEVICE_NO_ANSWER)
        setConnectionState(ConnectionState.Error)
        return
      }
    }
    await settleVideoAgainstCallState()
    await evictGhostLegs(takeover)
  }

  /** Settle video against the REAL Genesys hold state right after a join. */
  const settleVideoAgainstCallState = async (): Promise<void> => {
    const holdState = await GenesysService.isHeld().catch(() => false)
    privacyRef.current.held = holdState
    setConnectionState(
      holdState ? ConnectionState.OnHold : ConnectionState.Connected
    )
    await applyVideoPrivacy()
  }

  /**
   * Outbound stage 2. Resolves true as soon as the branch device is in the
   * roster. If it is absent, dial it once — the policy's automatic
   * participant only fires when the room is CREATED, so a callback into a
   * branch-keyed room that still exists (or whose device dropped) needs the
   * widget to place the call. Resolves false if the device has not joined
   * within DEVICE_JOIN_TIMEOUT_MS.
   */
  const waitForDevice = async (deviceAlias: string): Promise<boolean> => {
    const inRoster = (): boolean =>
      isDeviceInRoster(infinityClient.getParticipants('main'), deviceAlias)
    if (inRoster()) {
      return true
    }
    logger.log({
      category: 'pexip',
      event: 'device-dial',
      level: 'info',
      reason: 'branch device not in the room; dialing it',
      data: { deviceAlias }
    })
    await infinityClient
      .dial({ destination: deviceAlias, role: 'GUEST', protocol: 'sip' })
      .catch((err: unknown) => {
        logger.log({
          category: 'pexip',
          event: 'device-dial-failed',
          level: 'error',
          reason: String(err),
          data: { deviceAlias }
        })
      })
    return await new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (present: boolean): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timer)
        infinitySignals.onParticipantJoined.remove(onJoin)
        infinitySignals.onParticipants.remove(onJoin)
        resolve(present)
      }
      const onJoin = (): void => {
        if (inRoster()) {
          finish(true)
        }
      }
      const timer = setTimeout(() => {
        finish(false)
      }, DEVICE_JOIN_TIMEOUT_MS)
      infinitySignals.onParticipantJoined.add(onJoin)
      infinitySignals.onParticipants.add(onJoin)
      // The roster may have filled between the first check and the add.
      onJoin()
    })
  }

  /** Leave our own video leg only; the audio call and the room are untouched. */
  const leaveWithoutVideo = async (): Promise<void> => {
    setPhase('idle')
    resetCallState()
    legLockRef.current?.release()
    legLockRef.current = null
    await Promise.resolve(infinityClient?.disconnect({})).catch(() => undefined)
  }

  /**
   * Remove this agent's ghost legs from the VMR: a reloaded or crashed
   * widget leaves its leg behind until the media timeout (F-08), and the
   * management API is not available to the client. Takeover evicts every
   * other leg of mine. Re-run on roster events while the roster fills.
   */
  const evictGhostLegs = async (takeover = false): Promise<void> => {
    const identity = identityRef.current
    if (!isActive() || infinityClient == null || identity == null) {
      return
    }
    const roster = infinityClient.getParticipants('main')
    const me = infinityClient.getMe('main')
    const targets = ghostLegsOfMine(roster, me, identity, { takeover }).filter(
      (leg) => !kicksInFlightRef.current.has(leg.uuid)
    )
    await Promise.all(
      targets.map(async (leg) => {
        kicksInFlightRef.current.add(leg.uuid)
        let status: number | null = null
        try {
          const result = await infinityClient.kick({
            participantUuid: leg.uuid as Parameters<
              typeof infinityClient.kick
            >[0]['participantUuid']
          })
          status = (result as { status?: number } | undefined)?.status ?? null
        } catch (err) {
          status = -1
        } finally {
          kicksInFlightRef.current.delete(leg.uuid)
        }
        // 404: the leg already left (e.g. the previous holder disconnected
        // itself when the lock was stolen) — nothing to clean up.
        const gone = status === 200 || status === 404
        logger.log({
          category: 'pexip',
          event: 'ghost-leg-kicked',
          level: gone ? 'info' : 'error',
          reason: takeover ? 'takeover' : 'older leg of this agent',
          data: { uuid: leg.uuid, startTime: leg.startTime ?? null, status }
        })
        if (!gone) {
          setBanner('Could not remove a duplicate video leg — see console')
        }
      })
    )
  }

  const handleRosterChange = (): void => {
    evictGhostLegs().catch(console.error)
  }

  /**
   * Infinity dropped this leg while the Genesys call is still active.
   * Kicked (another instance or an admin removed it): step aside, never
   * touch the VMR. Anything else (network): one automatic rejoin, then
   * step aside.
   */
  const handleInfinityDisconnected = (event: { error: string }): void => {
    if (!isActive()) {
      return
    }
    const kicked = /another participant|an administrator/i.test(
      event.error ?? ''
    )
    logger.log({
      category: 'failsafe',
      event: kicked ? 'leg-kicked' : 'leg-dropped',
      level: kicked ? 'info' : 'warn',
      reason: event.error
    })
    if (kicked || rejoinAttemptedRef.current) {
      goPassive(event.error)
      return
    }
    rejoinAttemptedRef.current = true
    setPhase('idle')
    resetCallState()
    setConnectingStep('Reconnecting video')
    setConnectionState(ConnectionState.Connecting)
    setTimeout(() => {
      Promise.resolve(GenesysService.isCallActive())
        .then(async (active) => {
          if (active) {
            await initConference()
          } else {
            await onEndCall(false)
          }
        })
        .catch(console.error)
    }, REJOIN_DELAY_MS)
  }

  /** Another instance owns the leg: wait, never end the customer's call. */
  const goPassive = (reason: string): void => {
    logger.log({
      category: 'lifecycle',
      event: 'passive',
      level: 'info',
      reason
    })
    setPhase('passive')
    resetCallState()
    setIdleReason('another-window')
    setConnectionState(ConnectionState.Disconnected)
  }

  /** Agent chose THIS window: steal the lock, join, evict my other legs. */
  const takeOver = (): void => {
    initConference({ takeover: true }).catch(console.error)
  }

  /**
   * Single privacy rule: video is muted whenever the call is held or the
   * call-state connection is lost (fail-safe). Genesys mic-mute is NOT an
   * input (2026-09-03): it mutes only the mic; Hold is the agent's privacy
   * control. Applies the state with retries and FAILS TOWARD MUTED — if mute
   * cannot be confirmed, the wire is muted directly and the agent sees a
   * banner. Audio is never touched.
   */
  const applyVideoPrivacy = async (): Promise<boolean> => {
    if (!isActive() || infinityClient == null) {
      return false
    }
    const p = privacyRef.current
    const reason = p.connectionLost
      ? 'connection to call state lost'
      : p.held
        ? 'call on hold'
        : null
    const shouldMute = reason != null
    // Never un-mute over the agent's own camera mute.
    if (!shouldMute && cameraMuted) {
      return false
    }
    let ok = false
    let lastError: string | null = null
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      ok = await handleCameraMuteChanged(shouldMute, false).catch(
        (err: unknown) => {
          lastError = String(err)
          return false
        }
      )
    }
    logger.log({
      category: shouldMute ? 'failsafe' : 'media',
      event: shouldMute ? 'video-muted' : 'video-restored',
      level: ok ? 'info' : 'error',
      reason: reason ?? 'no privacy cause',
      data: { confirmed: ok, lastError }
    })
    if (!ok) {
      if (shouldMute) {
        // Last resort: force the wire dark even if the tidy path failed.
        await infinityClient.muteVideo({ muteVideo: true }).catch(console.error)
        stopStream(localStreamRef.current)
        setBanner('Video muted for safety — call state could not be confirmed')
      } else {
        setBanner(
          'Video could not be restored — use the camera button to retry'
        )
      }
      return false
    }
    setBanner(shouldMute && !p.held ? `Video muted — ${reason}` : null)
    return true
  }

  // Set the video to mute for all participants
  const onHoldVideo = async (
    onHold: boolean,
    reason: HoldReason = 'held'
  ): Promise<void> => {
    if (!isActive()) {
      return
    }
    privacyRef.current.held = onHold
    setHoldReason(reason)
    setConnectionState(
      onHold ? ConnectionState.OnHold : ConnectionState.Connected
    )
    if (onHold && presenting) {
      handlePresentationChanged().catch(console.error)
    }
    const applied = await applyVideoPrivacy()
    if (!onHold && applied) {
      // Explicit confirmation at the one moment the agent most wants it.
      // Bottom-centre, above the toolbar: the top-centre default sits exactly
      // on the VMR's burned-in name overlay in the remote video and was hard
      // to read (lab S6.1, 2026-09-03). Contrast is forced in App.scss.
      notificationToastSignal.emit([
        {
          message: 'Video restored — the customer can see you',
          position: 'bottomCenter',
          colorScheme: 'dark',
          timeout: 5000
        }
      ])
    }
  }

  const onEndCall = async (shouldDisconnectAll: boolean): Promise<void> => {
    const hadCall = isActive()
    setPhase('idle')
    resetCallState()
    setIdleReason(hadCall ? 'ended' : 'none')
    setTakeoverAttempted(false)
    rejoinAttemptedRef.current = false
    legLockRef.current?.release()
    legLockRef.current = null
    // Only the instance that owned a live leg talks to Infinity here. Genesys
    // sends several end-of-call snapshots; a second pass, or a passive
    // instance, must not call an already torn-down client (405/403 noise).
    if (hadCall) {
      if (shouldDisconnectAll) {
        await infinityClient?.disconnectAll({})
      }
      await infinityClient?.disconnect({})
    }
    setConnectionState(ConnectionState.Disconnected)
  }

  /**
   * Genesys mic-mute mutes ONLY the mic (decided 2026-09-03, reversing the
   * 2026-08-28 "mute also mutes video" policy: Hold is the agent's privacy
   * control, and mic-mute must not be linked to video). The mic itself is
   * muted by Genesys on the SIP leg — the agent's WebRTC leg carries no audio
   * track, so there is nothing for this app to do beyond recording the event.
   */
  const onMuteCall = async (muted: boolean): Promise<void> => {
    if (!isActive()) {
      return
    }
    logger.log({
      category: 'genesys',
      event: muted ? 'mic-muted' : 'mic-unmuted',
      level: 'info',
      reason: 'mic-only; video unaffected by design'
    })
  }

  const initializeGenesys = async (
    state: GenesysState,
    accessToken: string
  ): Promise<void> => {
    // Initiate Genesys environment
    await GenesysService.initialize(
      state.pcEnvironment,
      state.pcConversationId,
      accessToken
    )

    pexipNode = state.pexipNode
    pexipAgentPin = state.pexipAgentPin
    pexipAppPrefix = state.pexipAppPrefix

    setGenesysCallbacks()
    // The active-call decision (and the Disconnected transition) lives in
    // initialize(), after the "Checking call state" step is shown.
  }

  const handleRemoteStream = (remoteStream: MediaStream): void => {
    setRemoteStream(remoteStream)
  }

  const handleRemotePresentationStream = (
    presentationStream: MediaStream
  ): void => {
    setPresentationStream(presentationStream)
    setSecondaryVideo('remote')
  }

  /**
   * Disconnect the playback service when connected.
   */
  const checkPlaybackDisconnection = async (event: any): Promise<void> => {
    if (
      event.id === 'main' &&
      event.participant.uri.match(/^sip:.*\.playback@/) != null
    ) {
      await infinityClient.kick({ participantUuid: event.participant.uuid })
      infinitySignals.onParticipantJoined.remove(checkPlaybackDisconnection)
    }
  }

  /**
   * Participants left (batched signal). The call is over when no video/api
   * counterparty remains; legs of this agent leaving (a ghost eviction) say
   * nothing about the customer.
   */
  const checkIfDisconnect = async (
    events: Array<{ participant?: RosterLegLike }> = []
  ): Promise<void> => {
    const identity = identityRef.current
    if (!isActive() || infinityClient == null || identity == null) {
      return
    }
    const left = events
      .map((e) => e.participant)
      .filter((p): p is RosterLegLike => p != null)
    if (left.length > 0 && left.every((p) => isMyLeg(p, identity))) {
      return
    }
    const remaining = remainingCounterparties(
      infinityClient.getParticipants('main'),
      identity
    )
    if (remaining.length === 0) {
      await onEndCall(true)
    }
  }

  const handleCameraMuteChanged = async (
    mute: boolean,
    changeButtonState: boolean = true
  ): Promise<boolean> => {
    const response = await infinityClient.muteVideo({ muteVideo: mute })
    if (response?.status === 200) {
      stopStream(localStream)
      if (mute) {
        setLocalStream(undefined)
        setProcessedStream(undefined)
        if (changeButtonState) {
          setCameraMuted(true)
        }
      } else {
        const localStream = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: device?.deviceId } }
        })
        const processedStream = await getProcessedStream(localStream, effect)
        setLocalStream(localStream)
        setProcessedStream(processedStream)
        if (changeButtonState) {
          setCameraMuted(false)
        }
        infinityClient.setStream(processedStream)
      }
      return true
    }
    return false
  }

  const handlePresentationChanged = async (): Promise<void> => {
    setPresenting(!presenting)

    if (presenting) {
      infinityClient.stopPresenting()
      presentationStream?.getTracks().forEach((track) => {
        track.stop()
      })
      setPresentationStream(undefined)
      setSecondaryVideo('presentation')
    } else {
      try {
        const presentationStream = await navigator.mediaDevices.getDisplayMedia(
          displayCaptureOptions
        )
        setPresentationStream(presentationStream)

        presentationStream.getVideoTracks()[0].onended = () => {
          infinityClient.stopPresenting()
          presentationStream?.getTracks().forEach((track) => {
            track.stop()
          })
          setPresentationStream(undefined)
          setPresenting(false)
          setSecondaryVideo('presentation')
        }

        infinityClient.present(presentationStream)
        setSecondaryVideo('presentation')
      } catch (error) {
        console.error(error)
        setPresenting(false)
      }
    }
  }

  /**
   * Callback function that is used to detect when the presentation connection changes.
   * @param event The event that is emitted when the presentation connection changes.
   */
  const handlePresentationConnectionChange = (
    event: PresoConnectionChangeEvent
  ): void => {
    // We only care about the remote presentation stream being disconnected
    if (
      !(event.send === 'connecting' || event.send === 'connected') &&
      event.recv === 'disconnected'
    ) {
      setPresenting(false)
      setPresentationStream(undefined)
      setSecondaryVideo('presentation')
    }
  }

  // const handleCopyInvitationLink = (): void => {
  //   const invitationLink = `https://${pexipNode}/webapp/m/<alias>/step-by-step?role=guest`
  //   const textarea = document.createElement('textarea')
  //   textarea.value = invitationLink
  //   textarea.setAttribute('readonly', '')
  //   textarea.style.position = 'absolute'
  //   textarea.style.left = '-9999px'
  //   document.body.appendChild(textarea)
  //   textarea.select()
  //   document.execCommand('copy')
  //   textarea.remove()
  //   notificationToastSignal.emit([
  //     {
  //       message: 'Invitation link copied to clipboard!'
  //     }
  //   ])
  // }

  const handleSettingsChanged = async (settings: Settings): Promise<void> => {
    let newLocalStream = localStream
    if (settings.device?.deviceId !== device?.deviceId) {
      setDevice(settings.device)
      localStorage.setItem(
        LocalStorageKey.VideoDeviceInfo,
        JSON.stringify(settings.device)
      )
      localStream?.getTracks().forEach((track) => {
        track.stop()
      })
      newLocalStream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: settings.device?.deviceId } }
      })
      setLocalStream(newLocalStream)
    }

    if (
      settings.effect !== effect ||
      settings.device?.deviceId !== device?.deviceId
    ) {
      setEffect(settings.effect)
      localStorage.setItem(LocalStorageKey.Effect, settings.effect)
      if (newLocalStream != null) {
        const processedStream = await getProcessedStream(
          newLocalStream,
          settings.effect
        )
        setProcessedStream(processedStream)
        if (processedStream != null) {
          infinityClient.setStream(processedStream)
        }
      }
    }

    if (settings.streamQuality !== streamQuality) {
      setStreamQuality(settings.streamQuality)
      localStorage.setItem(
        LocalStorageKey.StreamQuality,
        settings.streamQuality
      )
      infinityClient.setBandwidth(convertToBandwidth(settings.streamQuality))
    }
  }

  const getInitialDevice = async (): Promise<MediaDeviceInfoLike> => {
    const localStream = await navigator.mediaDevices.getUserMedia({
      video: true
    })
    const devices = await navigator.mediaDevices.enumerateDevices()
    localStream.getTracks().forEach((track) => {
      track.stop()
    })

    const videoDevices = devices.filter(
      (device) => device.kind === 'videoinput'
    )

    const videoDeviceInfoString =
      localStorage.getItem(LocalStorageKey.VideoDeviceInfo) ?? '{}'
    const videoDeviceInfo: MediaDeviceInfoLike = JSON.parse(
      videoDeviceInfoString
    )

    const device =
      videoDevices.find(
        (device) => device.deviceId === videoDeviceInfo.deviceId
      ) ?? videoDevices[0]

    return device
  }

  const getProcessedStream = async (
    stream: MediaStream,
    effect: Effect
  ): Promise<MediaStream> => {
    if (videoProcessor != null) {
      videoProcessor.close()
      await videoProcessor.destroy()
    }
    videoProcessor = await getVideoProcessor(effect)
    await videoProcessor.open()
    const processedStream = await videoProcessor.process(stream)
    return processedStream
  }

  /**
   * Surface a bootstrap failure to the agent. Every path here used to end in
   * a swallowed console.error with the spinner left up indefinitely (seen in
   * the field with a mismatched OAuth redirect URI).
   */
  const failBootstrap = (id: ErrorId, reason: string): void => {
    logger.log({
      category: 'failsafe',
      event: 'bootstrap-failed',
      level: 'error',
      reason,
      data: { errorId: id }
    })
    setConnectingStep(null)
    setErrorId(id)
    setConnectionState(ConnectionState.Error)
  }

  const initialize = async (): Promise<void> => {
    setConnectingStep('Checking camera')
    try {
      await checkCameraAccess()
    } catch (error) {
      return
    }
    const queryParams = new URLSearchParams(window.location.search)

    const pcEnvironment = queryParams.get('pcEnvironment') ?? ''
    const pcConversationId = queryParams.get('pcConversationId') ?? ''

    pexipNode = queryParams.get('pexipNode') ?? ''
    pexipAgentPin = queryParams.get('pexipAgentPin') ?? ''
    pexipAppPrefix = queryParams.get('pexipAppPrefix') ?? ''

    if (
      pcEnvironment !== '' &&
      pcConversationId !== '' &&
      pexipNode !== '' &&
      pexipAgentPin !== '' &&
      pexipAppPrefix !== ''
    ) {
      // Launched from Genesys: hand off to the OAuth implicit-grant redirect.
      setConnectingStep('Redirecting to Genesys sign-in')
      await GenesysService.loginPureCloud(
        pcEnvironment,
        pcConversationId,
        pexipNode,
        pexipAgentPin,
        pexipAppPrefix
      )
      return
    }

    // Return leg of the OAuth redirect — or a direct open of the page.
    setConnectionState(ConnectionState.Connecting)

    const parsedUrl = new URL(window.location.href.replace(/#/g, '?'))
    const hashParams = new URLSearchParams(parsedUrl.search)

    // Genesys reports a rejected sign-in (e.g. redirect URI mismatch) as
    // error / error_description in the fragment instead of a token.
    const oauthError = hashParams.get('error')
    if (oauthError != null) {
      const description = hashParams.get('error_description') ?? ''
      failBootstrap(
        ErrorId.GENESYS_SIGN_IN_FAILED,
        `oauth ${oauthError}: ${description}`
      )
      return
    }

    const accessToken: string = hashParams.get('access_token') ?? ''
    const rawState = hashParams.get('state')
    if (accessToken === '' || rawState == null) {
      failBootstrap(
        ErrorId.NOT_LAUNCHED_FROM_GENESYS,
        'no access token or launch state in the URL'
      )
      return
    }
    let state: GenesysState
    try {
      state = JSON.parse(decodeURIComponent(rawState))
    } catch (err) {
      failBootstrap(
        ErrorId.NOT_LAUNCHED_FROM_GENESYS,
        'launch state unparseable'
      )
      return
    }
    const missing = (
      [
        'pcEnvironment',
        'pcConversationId',
        'pexipNode',
        'pexipAgentPin',
        'pexipAppPrefix'
      ] as const
    ).filter((key) => state[key] == null || state[key] === '')
    if (missing.length > 0) {
      failBootstrap(
        ErrorId.MISSING_CONFIG,
        `launch state missing: ${missing.join(', ')}`
      )
      return
    }

    setConnectingStep('Signing in to Genesys')
    let callState: { active: boolean; alerting: boolean; soleAgent: boolean }
    try {
      await initializeGenesys(state, accessToken)
      setConnectingStep('Checking call state')
      callState = await GenesysService.getMyCallState()
    } catch (err) {
      const status: unknown =
        (err as { status?: unknown })?.status ??
        (err as { response?: { status?: unknown } })?.response?.status
      const rejected = status === 401 || status === 403
      failBootstrap(
        rejected
          ? ErrorId.GENESYS_SIGN_IN_FAILED
          : ErrorId.GENESYS_CONNECTION_FAILED,
        `${rejected ? 'token rejected' : 'genesys init failed'}: ${String(err)}`
      )
      return
    }
    logger.log({
      category: 'lifecycle',
      event: 'bootstrap-call-state',
      level: 'info',
      reason: callState.active ? 'joining' : 'waiting for connect',
      data: callState
    })
    if (callState.active && !callState.soleAgent) {
      // Consult target, or conferenced in: the other agent owns the video.
      // This widget stays out of the VMR entirely — nothing transmitted,
      // nothing received — and the audio call is unaffected.
      setIdleReason('audio-only')
      setConnectingStep(null)
      setConnectionState(ConnectionState.Disconnected)
      return
    }
    if (callState.active) {
      await initConference().catch(console.error)
    } else {
      setIdleReason(callState.alerting ? 'alerting' : 'none')
      setConnectingStep(null)
      setConnectionState(ConnectionState.Disconnected)
    }
  }

  useEffect(() => {
    localStreamRef.current = localStream
  }, [localStream])

  // Auto-takeover: the instance the agent can SEE should own the video.
  useEffect(() => {
    if (idleReason !== 'another-window' || !visible || takeoverAttempted) {
      return
    }
    const timer = setTimeout(() => {
      setTakeoverAttempted(true)
      Promise.resolve(GenesysService.isCallActive())
        .then((active) => {
          if (active) {
            logger.log({
              category: 'lifecycle',
              event: 'auto-takeover',
              level: 'info',
              reason: 'passive instance is the visible one'
            })
            takeOver()
          }
        })
        .catch(console.error)
    }, AUTO_TAKEOVER_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [idleReason, visible, takeoverAttempted])

  // Connecting watchdog: each step gets CONNECTING_WATCHDOG_MS before the
  // agent is told something is stuck (previously: spinner forever, with the
  // cause visible only in the console).
  useEffect(() => {
    if (connectionState !== ConnectionState.Connecting) {
      setConnectingStalled(false)
      return
    }
    const timer = setTimeout(() => {
      setConnectingStalled(true)
      logger.log({
        category: 'failsafe',
        event: 'connecting-stalled',
        level: 'warn',
        reason: connectingStep ?? 'unknown step',
        data: { watchdogMs: CONNECTING_WATCHDOG_MS }
      })
    }, CONNECTING_WATCHDOG_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [connectionState, connectingStep])

  useEffect(() => {
    infinitySignals = createInfinityClientSignals([], {
      batchScheduleTimeoutMS: 500,
      batchBufferSize: 10
    })
    callSignals = createCallSignals([])

    initialize().catch(console.error)

    const handleDisconnect = (): void => {
      infinityClient?.disconnect({}).catch(console.error)
    }

    window.addEventListener('beforeunload', handleDisconnect)
    return () => {
      window.removeEventListener('beforeunload', handleDisconnect)
      onEndCall(false).catch(console.error)
    }
  }, [])

  useEffect(() => {
    GenesysService.addHoldListener(onHoldVideo)
    GenesysService.addEndCallListener(onEndCall)

    callSignals.onRemoteStream.add(handleRemoteStream)
    callSignals.onRemotePresentationStream.add(handleRemotePresentationStream)
    callSignals.onPresentationConnectionChange.add(
      handlePresentationConnectionChange
    )
    infinitySignals.onParticipantJoined.add(checkPlaybackDisconnection)
    infinitySignals.onParticipantLeft.add(checkIfDisconnect)
    infinitySignals.onDisconnected.add(handleInfinityDisconnected)
    // Roster fills after the join: ghost legs of mine may appear late.
    const rosterSignals = [
      infinitySignals.onParticipantJoined,
      infinitySignals.onParticipants,
      infinitySignals.onMe
    ]
    rosterSignals.forEach((signal) => {
      signal.add(handleRosterChange)
    })
    return () => {
      callSignals.onRemoteStream.remove(handleRemoteStream)
      callSignals.onRemotePresentationStream.remove(
        handleRemotePresentationStream
      )
      infinitySignals.onParticipantJoined.remove(checkPlaybackDisconnection)
      infinitySignals.onParticipantLeft.remove(checkIfDisconnect)
      infinitySignals.onDisconnected.remove(handleInfinityDisconnected)
      rosterSignals.forEach((signal) => {
        signal.remove(handleRosterChange)
      })
    }
  }, [presenting, presentationStream, localStream])

  const setGenesysCallbacks = (): void => {
    GenesysService.addHoldListener(onHoldVideo)
    GenesysService.addEndCallListener(onEndCall)
    GenesysService.addMuteListener(onMuteCall)
    GenesysService.addConnectCallListener(async () => {
      await initConference()
    })
    GenesysService.addAlertingListener((alerting) => {
      if (phaseRef.current !== 'idle') {
        return
      }
      setIdleReason((current) =>
        alerting ? 'alerting' : current === 'alerting' ? 'none' : current
      )
    })
    // Fail-safe (lab F-20): a dead notifications socket used to mean video
    // streamed through holds indefinitely. Now: mute immediately, tell the
    // agent, and re-sync real state once the connection is back.
    GenesysService.addConnectionLossListener((reason) => {
      if (!isActive()) {
        return
      }
      privacyRef.current.connectionLost = true
      setBanner('Connection to call state lost — video muted for safety')
      logger.log({
        category: 'failsafe',
        event: 'connection-lost',
        level: 'error',
        reason
      })
      applyVideoPrivacy().catch(console.error)
    })
    GenesysService.addConnectionRestoredListener(() => {
      if (!isActive()) {
        return
      }
      GenesysService.fetchCurrentCallState()
        .then(async (state) => {
          privacyRef.current.connectionLost = false
          logger.log({
            category: 'failsafe',
            event: 'connection-restored',
            level: 'info',
            data: state
          })
          if (!state.active) {
            await onEndCall(false)
            return
          }
          privacyRef.current.held = state.held
          setHoldReason('held')
          setBanner(null)
          setConnectionState(
            state.held ? ConnectionState.OnHold : ConnectionState.Connected
          )
          await applyVideoPrivacy()
        })
        .catch(console.error)
    })
  }

  useEffect(setGenesysCallbacks)

  const inCall =
    connectionState === ConnectionState.Connected ||
    connectionState === ConnectionState.OnHold

  const renderIdlePane = (): React.JSX.Element => {
    switch (idleReason) {
      case 'another-window':
        // The visible instance is about to take the leg back: show that as
        // a plain connection step (agents see it for a split second).
        return visible && !takeoverAttempted ? (
          <CenterLayout className="loading-spinner">
            <div className="connecting" data-testid="superseded-connecting">
              <Spinner colorScheme="light" />
              <p className="connecting-step">Connecting video in this window</p>
            </div>
          </CenterLayout>
        ) : (
          <StatePane
            id="superseded"
            icon={IconTypes.IconVideoOn}
            title="Video is running in another window"
          >
            <p>
              Another copy of this widget has the video. Use the button to bring
              it back to this window.
            </p>
            <Button onClick={takeOver} data-testid="take-over">
              Use this window for video
            </Button>
          </StatePane>
        )
      case 'audio-only':
        return (
          <StatePane
            id="audio-only"
            icon={IconTypes.IconMicrophoneOn}
            title="Audio only"
            data-testid="audio-only"
          >
            <p>
              Another agent has the video for this call. Your audio is connected
              as normal.
            </p>
          </StatePane>
        )
      case 'alerting':
        return (
          <StatePane
            id="incoming-call"
            icon={IconTypes.IconPhone}
            title="Incoming call"
          >
            <p>Answer the call in Genesys to start video.</p>
          </StatePane>
        )
      case 'ended':
        return (
          <StatePane
            id="no-active-call"
            icon={IconTypes.IconLeave}
            title="Call ended"
          >
            <p>Video has been disconnected.</p>
          </StatePane>
        )
      default:
        return (
          <StatePane
            id="no-active-call"
            icon={IconTypes.IconWaiting}
            title="No active call"
          >
            <p>Waiting for a video interaction.</p>
          </StatePane>
        )
    }
  }

  return (
    <div className="App" data-testid="App" ref={appRef}>
      {errorId !== '' && connectionState === ConnectionState.Error && (
        <ErrorPanel
          error={errorId}
          onClick={() => {
            setErrorId('')
            setConnectionState(ConnectionState.Connecting)
            initialize().catch(console.error)
          }}
        ></ErrorPanel>
      )}

      {((connectionState === ConnectionState.Connecting &&
        !connectingStalled) ||
        connectionState === ConnectionState.Connected) && (
        <CenterLayout className="loading-spinner">
          <div className="connecting">
            <Spinner colorScheme="light" />
            {connectionState === ConnectionState.Connecting &&
              connectingStep != null && (
                <p className="connecting-step" data-testid="connecting-step">
                  {connectingStep}
                </p>
              )}
          </div>
        </CenterLayout>
      )}

      {connectionState === ConnectionState.Connecting && connectingStalled && (
        <StatePane
          id="connecting-stalled"
          icon={IconTypes.IconWarningRound}
          title="Still connecting"
        >
          <p>
            Stuck at: {connectingStep ?? 'starting'}. This is taking longer than
            expected.
          </p>
          <Button
            onClick={() => {
              window.location.reload()
            }}
          >
            Reload
          </Button>
          <p className="hint">
            If reloading does not help, close and reopen the interaction in
            Genesys.
          </p>
        </StatePane>
      )}

      {connectionState === ConnectionState.Disconnected && renderIdlePane()}

      {connectionState === ConnectionState.OnHold && (
        <StatePane
          id="call-on-hold"
          icon={
            holdReason === 'consulting'
              ? IconTypes.IconGroup
              : IconTypes.IconPause
          }
          title={
            holdReason === 'consulting'
              ? 'Consulting — customer on hold'
              : 'Call on hold'
          }
        >
          <p>
            <Icon
              className="state-pane-inline-icon"
              source={IconTypes.IconVideoOff}
            />
            Your video is muted. The customer cannot see you.
          </p>
        </StatePane>
      )}

      {connectionState === ConnectionState.Connected && (
        <>
          <Video
            id="remoteVideo"
            srcObject={remoteStream}
            className={secondaryVideo === 'remote' ? 'secondary' : 'primary'}
            onClick={secondaryVideo === 'remote' ? exchangeVideos : undefined}
          />

          {presentationStream != null && (
            <Video
              srcObject={presentationStream}
              style={{ objectFit: 'contain' }}
              className={
                secondaryVideo === 'presentation' ? 'secondary' : 'primary'
              }
              onClick={
                secondaryVideo === 'presentation' ? exchangeVideos : undefined
              }
            />
          )}
        </>
      )}

      {inCall && (
        // Pinned top centre for the whole call (hold included): the
        // self-view never moves or hides.
        <SelfView
          localStream={processedStream}
          offTitle={
            connectionState === ConnectionState.OnHold
              ? 'Video muted'
              : 'Camera off'
          }
          offDetail={
            connectionState === ConnectionState.OnHold
              ? 'On hold'
              : "Customer can't see you"
          }
        />
      )}

      {connectionState === ConnectionState.Connected && (
        <Toolbar
          infinityClient={infinityClient}
          callSignals={callSignals}
          infinitySignals={infinitySignals}
          cameraMuted={cameraMuted}
          presenting={presenting}
          onCameraMuteChanged={async (mute: boolean) => {
            await handleCameraMuteChanged(mute)
          }}
          onPresentationChanged={handlePresentationChanged}
          // onCopyInvitationLink={handleCopyInvitationLink}
          onSettingsChanged={handleSettingsChanged}
        />
      )}

      {banner != null && (
        <div className="state-banner" data-testid="state-banner" role="status">
          {banner}
        </div>
      )}

      <NotificationToast />

      {diagnosticsOpen && (
        <DiagnosticsPanel
          context={{
            buildId: BUILD_ID,
            instanceId,
            conversationId: GenesysService.getConversationId(),
            userId: GenesysService.getUserId(),
            state: {
              phase: phaseRef.current,
              connectionState: ConnectionState[connectionState],
              idleReason,
              errorId,
              held: privacyRef.current.held,
              cameraMuted
            }
          }}
          onClose={() => {
            setDiagnosticsOpen(false)
          }}
        />
      )}

      {/* Support entry point: invisible to agents until they are told. */}
      <button
        className="build-stamp"
        data-testid="build-stamp"
        title="Support diagnostics"
        onClick={() => {
          setDiagnosticsOpen((open) => !open)
        }}
      >
        build {BUILD_ID}
      </button>
    </div>
  )
}
