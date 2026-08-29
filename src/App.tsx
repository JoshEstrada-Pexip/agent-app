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
  CallType,
  type PresoConnectionChangeEvent
} from '@pexip/infinity'
import {
  CenterLayout,
  NotificationToast,
  // notificationToastSignal,
  Spinner,
  Video
} from '@pexip/components'
import { StreamQuality } from '@pexip/media-components'
import { convertToBandwidth } from './media/quality'
import * as GenesysService from './genesys/genesysService'
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

import './App.scss'

let infinitySignals: InfinitySignals
let callSignals: CallSignals
let infinityClient: InfinityClient

let pexipNode: string
let pexipAgentPin: string
let pexipAppPrefix: string = 'agent'
let conferenceAlias: string
let connectingCallInProgress: boolean = false

let videoProcessor: VideoProcessor

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

  const [displayName, setDisplayName] = useState<string>('Agent')

  const [errorId, setErrorId] = useState<string>('')

  const [banner, setBanner] = useState<string | null>(null)

  const appRef = useRef<HTMLDivElement | null>(null)

  // Privacy causes currently in force; video must be dark while ANY is true.
  const privacyRef = useRef({
    held: false,
    audioMuted: false,
    connectionLost: false
  })
  // Event handlers must never drive the call after it ended (post-call
  // Genesys events previously resurrected the Connected UI, lab F-15).
  const activeCallRef = useRef(false)

  const loggerRef = useRef<Logger | null>(null)
  if (loggerRef.current == null) {
    loggerRef.current = new Logger({
      sessionId: uuidv4(),
      sinks: [createConsoleSink()]
    })
  }
  const logger = loggerRef.current

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
    pin: string
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
      callType: ClientCallType.VideoSendRecvPresentationSendRecv
    })

    connectingCallInProgress = false

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
          await infinityClient.muteVideo({ muteVideo: true }).catch(console.error)
          activeCallRef.current = true
          setConnectionState(ConnectionState.Connected)
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
  const initConference = async (): Promise<void> => {
    // Avoid to join a conference if no pexipNode is set or if it's already connected or connecting
    // This can happen if the user is not logged in to Genesys or the GenesysService is not initialized correctly
    if (
      connectingCallInProgress ||
      connectionState === ConnectionState.OnHold ||
      connectionState === ConnectionState.Connected ||
      pexipNode === ''
    ) {
      console.error(
        'Conference connection already in progress, already connected, or invalid parameters'
      )
      return
    }

    setConnectionState(ConnectionState.Connecting)
    connectingCallInProgress = true

    conferenceAlias = (await GenesysService.fetchAniName()) ?? uuidv4()

    // Test to determine if the call is dial-out or dial-in and generate a random
    // conferenceAlias in case we are dialing out. Not used currently.
    //
    // conferenceAlias = (await GenesysService.isDialOut(pexipNode))
    //   ? conferenceAlias
    //   : uuidv4()

    const prefixedConfAlias = pexipAppPrefix + conferenceAlias
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
    setDisplayName(displayName)

    await joinConference(
      pexipNode,
      prefixedConfAlias,
      processedStream,
      displayName,
      pexipAgentPin
    )

    // Deterministically settle video against the REAL call state right after
    // join. The conference was joined video-MUTED (privacy pre-mute in
    // joinConference); this either keeps it dark (held / mic-muted) or brings
    // it live for a normal call. Skipped when the join failed (error state).
    if (activeCallRef.current) {
      const holdState = await GenesysService.isHeld().catch(() => false)
      const muteState = await GenesysService.isMuted().catch(() => false)
      privacyRef.current.held = holdState
      privacyRef.current.audioMuted = muteState
      setConnectionState(
        holdState ? ConnectionState.OnHold : ConnectionState.Connected
      )
      await applyVideoPrivacy()
    }
  }

  /**
   * Single privacy rule: video is muted whenever the call is held, the mic is
   * muted in Genesys (policy: mute must always mean fully private), or the
   * call-state connection is lost (fail-safe). Applies the state with retries
   * and FAILS TOWARD MUTED — if mute cannot be confirmed, the wire is muted
   * directly and the agent sees a banner. Audio is never touched.
   */
  const applyVideoPrivacy = async (): Promise<void> => {
    if (!activeCallRef.current || infinityClient == null) {
      return
    }
    const p = privacyRef.current
    const reason = p.connectionLost
      ? 'connection to call state lost'
      : p.held
        ? 'call on hold'
        : p.audioMuted
          ? 'microphone muted'
          : null
    const shouldMute = reason != null
    // Never un-mute over the agent's own camera mute.
    if (!shouldMute && cameraMuted) {
      return
    }
    let ok = false
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      ok = await handleCameraMuteChanged(shouldMute, false).catch(() => false)
    }
    logger.log({
      category: shouldMute ? 'failsafe' : 'media',
      event: shouldMute ? 'video-muted' : 'video-restored',
      level: ok ? 'info' : 'error',
      reason: reason ?? 'no privacy cause',
      data: { confirmed: ok }
    })
    if (!ok) {
      if (shouldMute) {
        // Last resort: force the wire dark even if the tidy path failed.
        await infinityClient.muteVideo({ muteVideo: true }).catch(console.error)
        localStream?.getTracks().forEach((track) => {
          track.stop()
        })
        setBanner('Video muted for safety — call state could not be confirmed')
      } else {
        setBanner('Video could not be restored — use the camera button to retry')
      }
      return
    }
    setBanner(
      shouldMute && !p.held ? `Video muted — ${reason}` : null
    )
  }

  // Set the video to mute for all participants
  const onHoldVideo = async (onHold: boolean): Promise<void> => {
    if (!activeCallRef.current) {
      return
    }
    privacyRef.current.held = onHold
    setConnectionState(
      onHold ? ConnectionState.OnHold : ConnectionState.Connected
    )
    if (onHold && presenting) {
      handlePresentationChanged().catch(console.error)
    }
    await applyVideoPrivacy()
  }

  const onEndCall = async (shouldDisconnectAll: boolean): Promise<void> => {
    activeCallRef.current = false
    privacyRef.current = { held: false, audioMuted: false, connectionLost: false }
    setBanner(null)
    localStream?.getTracks().forEach((track) => {
      track.stop()
    })
    if (shouldDisconnectAll) {
      await infinityClient?.disconnectAll({})
    }
    await infinityClient?.disconnect({})
    setConnectionState(ConnectionState.Disconnected)
    connectingCallInProgress = false
  }

  /**
   * Genesys mic-mute now ALSO mutes video (decided 2026-08-28: mute must mean
   * fully private). The old audio-only infinityClient.mute() call was a no-op
   * — the agent's WebRTC leg carries no audio track.
   */
  const onMuteCall = async (muted: boolean): Promise<void> => {
    if (!activeCallRef.current) {
      return
    }
    privacyRef.current.audioMuted = muted
    await applyVideoPrivacy()
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

    // Stop the initialization if no call is active
    const callActive = (await GenesysService.isCallActive()) || false
    if (!callActive) {
      setConnectionState(ConnectionState.Disconnected)
    }
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
   * Check if the agent should be disconnected. This should happen after the last
   * customer participant leaves. We check if the callType is api, because the
   * agent is connected first as api and later it changes to video.
   */
  const checkIfDisconnect = async (): Promise<void> => {
    const participants = infinityClient.getParticipants('main')
    const videoParticipants = participants.filter((participant) => {
      return (
        participant.callType === CallType.video ||
        participant.callType === CallType.api
      )
    })
    if (videoParticipants.length === 1) {
      await onEndCall(true)
    }
  }

  const handleCameraMuteChanged = async (
    mute: boolean,
    changeButtonState: boolean = true
  ): Promise<boolean> => {
    const response = await infinityClient.muteVideo({ muteVideo: mute })
    if (response?.status === 200) {
      localStream?.getTracks().forEach((track) => {
        track.stop()
      })
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
        const presentationStream =
          await navigator.mediaDevices.getDisplayMedia()
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
  //   const invitationLink = `https://${pexipNode}/webapp/m/${pexipAppPrefix}${conferenceAlias}/step-by-step?role=guest`
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

  const initialize = async (): Promise<void> => {
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
      await GenesysService.loginPureCloud(
        pcEnvironment,
        pcConversationId,
        pexipNode,
        pexipAgentPin,
        pexipAppPrefix
      )
    } else {
      // Logged into Genesys
      setConnectionState(ConnectionState.Connecting)

      const parsedUrl = new URL(window.location.href.replace(/#/g, '?'))
      const queryParams = new URLSearchParams(parsedUrl.search)

      const accessToken: string = queryParams.get('access_token') ?? ''
      const state: GenesysState = JSON.parse(
        decodeURIComponent(queryParams.get('state') ?? '{}')
      )

      await initializeGenesys(state, accessToken)
      const isCallActive = await GenesysService.isCallActive()
      if (isCallActive) {
        await initConference().catch(console.error)
      } else {
        setConnectionState(ConnectionState.Disconnected)
      }
    }
  }

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
    return () => {
      callSignals.onRemoteStream.remove(handleRemoteStream)
      callSignals.onRemotePresentationStream.remove(
        handleRemotePresentationStream
      )
      infinitySignals.onParticipantJoined.remove(checkPlaybackDisconnection)
      infinitySignals.onParticipantLeft.remove(checkIfDisconnect)
    }
  }, [presenting, presentationStream, localStream])

  const setGenesysCallbacks = (): void => {
    GenesysService.addHoldListener(onHoldVideo)
    GenesysService.addEndCallListener(onEndCall)
    GenesysService.addMuteListener(onMuteCall)
    GenesysService.addConnectCallListener(initConference)
    // Fail-safe (lab F-20): a dead notifications socket used to mean video
    // streamed through holds indefinitely. Now: mute immediately, tell the
    // agent, and re-sync real state once the connection is back.
    GenesysService.addConnectionLossListener((reason) => {
      if (!activeCallRef.current) {
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
      if (!activeCallRef.current) {
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
          privacyRef.current.audioMuted = state.muted
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

      {(connectionState === ConnectionState.Connecting ||
        connectionState === ConnectionState.Connected) && (
        <CenterLayout className="loading-spinner">
          <Spinner colorScheme="light" />
        </CenterLayout>
      )}

      {connectionState === ConnectionState.Disconnected && (
        <div className="no-active-call" data-testid="no-active-call">
          <h1>No active call</h1>
        </div>
      )}

      {connectionState === ConnectionState.OnHold && (
        <div className="call-on-hold" data-testid="call-on-hold">
          <h1>Call on hold</h1>
        </div>
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

          <SelfView
            floatRoot={appRef}
            callSignals={callSignals}
            username={displayName}
            localStream={processedStream}
            onCameraMuteChanged={async (mute: boolean) => {
              await handleCameraMuteChanged(mute)
            }}
          />

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
        </>
      )}

      {banner != null && (
        <div className="state-banner" data-testid="state-banner" role="status">
          {banner}
        </div>
      )}

      <NotificationToast />
    </div>
  )
}
