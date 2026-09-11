# Changelog

All notable changes to the Genesys agent video widget are recorded here.

The widget is a Genesys Cloud Interaction Widget that connects the agent to
the customer's video call. Audio stays in-band on the Genesys SIP trunk, so
routing, recording and analytics work exactly as for a voice call; video
travels over a direct Pexip Infinity WebRTC leg rendered inside the agent's
workspace. The widget's only job is to keep that video leg in step with the
Genesys call state: hold, consult, transfer, disconnect.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/).

## [1.0.0-rc.1] - 2026-09-11

### Release summary

This release candidate answers the two field complaints reported against
the original widget: agents were visible to the customer while they believed
they were on hold, and video could not be recovered after a transfer back
or a widget reload. It also removes a defect where an agent appeared several
times in the customer's video after a missed alert, adds outbound video to
branch devices, and gives agents and support a way to collect diagnostics
without any server-side logging. Every behavioural fix was reproduced and
then re-measured on the wire in a lab against a real Genesys organisation
and a real Pexip Infinity deployment. It is intended for UAT; on sign-off it
becomes 1.0.0 without further code change.

### Fixed

- **Agent video stayed live for about two seconds after every hold.**
  The original delayed every hold transition by a fixed one-second timer,
  in both directions, on top of the Genesys event latency. Hold now mutes
  video immediately; only the un-mute waits for a short settle window
  (750 ms), so a transient `held=false` during consult set-up can never
  briefly expose video. Measured on the wire: the agent's outbound video
  freezes in under one second of the hold command and stays dark for the
  whole hold.
- **Video lost after a transfer back, or after reloading the widget mid
  call ("No active call" on a live call).** Genesys accumulates a
  participant entry per leg, and the original used three different
  first-match lookups to find "my" leg, so after any transfer round-trip a
  dead leg was read instead of the live one. One shared selection rule now
  prefers the connected leg, then the newest non-terminated leg, in every
  code path. A widget reload after transfer-back rejoins with video in
  about 15 seconds.
- **A dead notifications connection left video streaming through a hold,
  with the UI still showing "Connected".** The WebSocket that carries call
  events had no close, error or reconnect handling. On loss the widget now
  mutes video within milliseconds and shows a banner; it then creates a
  fresh channel, re-subscribes, and re-reads the real call state from the
  REST API so that anything missed while down is applied. Measured: mute
  82 ms after the socket closed, reconnected and resynchronised in 1.7 s,
  a hold issued during the outage honoured on the new channel.
- **Video privacy is a single derived rule that fails toward muted.** All
  privacy inputs (hold, connection loss) are recomputed together on every
  change, with confirmed retries. If a mute cannot be confirmed the media
  tracks are stopped outright and the agent is told; an unconfirmed
  un-mute never forces video back on, and the agent's own camera-off is
  never overridden.
- **Joining into a call that was already on hold showed video for a
  moment.** The widget now joins with video muted and settles against the
  real call state immediately after a successful join.
- **Completing a consult left a ghost "Connected" view with the camera
  light on.** Event handlers ran regardless of whether a call was active.
  An explicit call phase now gates every Genesys-driven handler; after a
  consult completes the widget tears down, releases the camera and shows
  "No active call".
- **A mute attempt after disconnect threw an error.** Same cause and fix
  as above.
- **Some disconnect reasons were not recognised, so no teardown ran.**
  Genesys `disconnectType` values change between snapshots and include
  dotted variants such as `transfer.noanswer`. Values are now matched by
  category prefix.
- **The video room could be destroyed on a transient snapshot, or the
  widget could silently join an empty room.** The end-of-call check treated
  "no connected customer in this snapshot" as "customer left" and tore the
  ephemeral room down; and when the room alias could not be resolved the
  widget joined a random new room (black screen, working audio). The call
  now ends only when every customer leg is disconnected or terminated, and
  an alias failure shows "Video is unavailable for this call" with Retry
  instead of joining anywhere.
- **Start-up failures spun forever.** A rejected token, wrong environment,
  failed notifications channel, missing Pexip parameters or an OAuth
  redirect-URI mismatch were all swallowed. Each is now classified and
  shown with a specific message, and any start-up step that exceeds 20
  seconds is replaced by a "Still connecting" pane with a Reload button.
- **The agent appeared two or more times in the customer's video after a
  missed alert.** Two causes. The join routine could run twice for the
  burst of connect events Genesys emits when a call is answered, orphaning
  the first video leg; and every widget instance Genesys loads (it preloads
  one for the alert and renders another for the tool, and reloads and extra
  tabs add more) joined independently. The join is now non-re-entrant, all
  instances for a call elect one video owner before opening the camera, the
  others stay passive, and leftover legs of the same agent are removed
  after the join. The visible window takes the video over automatically;
  a hidden one offers "Use this window for video".
- **A customer video endpoint was disconnected when its display name
  matched the agent's.** Leg identity used display names. Each join now
  carries a call tag (user, conversation, instance) that Infinity echoes on
  the roster, so only the agent's own legs can ever be treated as
  duplicates. Room systems and SIP endpoints are never touched.
- **Customer hang-up was not detected while a duplicate leg was present.**
  The old "exactly one participant left" rule never fired with a duplicate
  in the room. The call now ends when no counterparty remains.
- **The agent heard the customer twice: once on the softphone and once
  from the widget.** The widget asks for a video-only call, but
  `@pexip/infinity` 23.0 does not pass that call type to the peer
  connection, so the audio channel negotiated send/receive and the
  conference mix was played. The widget now removes and disables every
  incoming audio track and the remote video element is muted, so no sound
  can come from the widget. The defect is fixed upstream in
  `@pexip/infinity` 24.0.1; see Known issues for what remains until that
  upgrade.
- **Inbound branch calls were treated as outbound after the caller-ID
  format changed.** Outbound was detected from the shape of the address.
  It is now decided by the participant's `direction`, and anything else
  takes the inbound path.

### Added

- **Outbound video to branch devices.** The agent dials the branch device
  from the Genesys workspace as a normal call. The Infinity policy creates
  a room named after the dialled alias and dials the device into it; the
  widget derives the same room name from the outbound conversation and
  joins it video-only, with audio staying on the Genesys call so recording
  continues. After joining, the widget waits for the device to appear on
  the roster and dials it once itself if absent (a callback into a room
  that still exists). If the device has not joined within 15 seconds the
  widget leaves the video room, keeps the audio call, and shows "The branch
  video device did not answer" with Retry. Requires an Infinity policy
  branch and, for the workspace Callback button, a Genesys number plan and
  outbound route: see `docs/genesys-configuration.md`.
- **Agent-facing state panes.** Full-window panes for: on hold
  ("Your video is muted. The customer cannot see you."); consulting with
  the customer on hold; incoming call (answer in Genesys to start video);
  no active call; call ended; video running in another window; and each
  connecting step (checking camera, signing in, checking call state,
  locating the call, starting camera, joining video).
- **Feedback when video changes state.** A toast when video is confirmed
  restored after a hold, and a red banner whenever the fail-safe engages
  or a restore could not be confirmed.
- **Support diagnostics in the browser.** Every widget instance keeps a
  rolling log in browser storage (newest 500 entries per instance, newest
  6 instances) that survives Genesys recreating the widget. Clicking the
  build stamp in the bottom-left corner opens a panel with Copy, Download
  and Clear, plus a Verbose toggle that adds debug entries and the raw
  Genesys event stream; `&debug=1` on the widget URL forces verbose on.
  Nothing is sent anywhere, and access tokens, conference PINs and the
  query string are never stored. Procedure in
  `docs/support-diagnostics.md`.
- **Structured logging.** Every privacy decision, connection loss and
  restore, leg election and teardown is logged with a category, event and
  reason, in the console and in the diagnostics log.
- **Build stamp** in the widget so a tester can confirm which build an
  iframe is actually running.
- **Automated test suite**: 174 unit and integration tests, including
  replay tests that push real recorded Genesys notification snapshots
  through the production event pipeline and the application.

### Changed

- **Genesys mic-mute now mutes the microphone only.** Hold is the agent's
  privacy control. An earlier iteration coupled mic-mute to video-mute;
  that policy was reversed on 2026-09-03.
- **Self-view is docked.** Pinned top-centre of the video, sized to the
  widget, mirrored, captioned "Customer can see you". The toolbar camera
  button is the only control: there is no hide, fold or drag. Camera off
  keeps the same footprint with a dark tile and "Camera off / Customer
  can't see you"; on hold it reads "Video muted / On hold". The self-view
  stays mounted through hold.
- **Screen share picker** pre-selects the Chrome tab pane and excludes
  "Entire screen".
- **Events from other conversations are ignored.** Call events arrive on
  a per-user topic; the widget now drops any event whose conversation id
  is not its own.
- **Package** renamed and versioned as `1.0.0-rc.1`; `dist/` in the
  repository is the customer build.
- **Documentation** restructured for the customer: README, this changelog,
  `docs/genesys-configuration.md`, `docs/uat-test-plan.md`,
  `docs/support-diagnostics.md`, `docs/technical-notes.md`.

### Known issues and limitations

- **Consult and conference: the second agent also joins the video room.**
  A rule where one agent owns the video and the consulted or conferenced
  agent stays audio-only was built, then withdrawn from this release for
  further validation. Behaviour in these flows is the same as the original
  widget.
- **The widget still receives conference audio at the transport level
  (about 60 kbps).** It is silenced locally and the agent hears nothing,
  but the leg shows as audio-active in Infinity. Only the planned upgrade
  to `@pexip/infinity` 24.x removes it.
- **Silent notification-channel starvation is not detected.** Genesys
  allows 20 notification channels per user per application in 24 hours and
  each widget instance creates one. Past the cap a channel can pass every
  health check and still deliver no events; the widget has no periodic
  call-state resync yet. Agents who reload the widget very many times in a
  day may see video stop following the call until the next day. A resync
  watchdog and channel reuse are the next planned change.
- **Receiving agent after a transfer**: automatic video join has not been
  validated in the lab; the receiving agent may need to open the widget.
- **Double transfer (A to B to A to B) and transfer-back via re-queue**
  have not been exercised.
- **Outbound**: callback re-dial into an existing room, the 15-second
  device-no-answer path and hang-up teardown are implemented and unit
  tested but not yet exercised live.
- **Screen share "Window" option** cannot be removed by a web page. To
  restrict agents to tab sharing, apply the Chrome enterprise policy
  `TabCaptureAllowedByOrigins` for the widget origin.
- **No dedicated conference pane**: a conferenced call shows the hold or
  consulting wording.
- **Browsers without the Web Locks API** treat each widget instance as the
  only one; the one-video-leg election needs a current Chrome or Edge.
- **The same agent on two different machines** is handled only by
  newest-wins removal of the older leg.

### Validation

- **Lab**: an automated harness drove real calls through a Genesys Cloud
  organisation, a Pexip Infinity deployment and a SIP video endpoint,
  issuing hold, mute, consult, transfer, wrap-up and disconnect through
  the Genesys API (confirmed to produce events identical to agent UI
  clicks) and measuring the agent's video on the wire from the WebRTC
  `outbound-rtp` counters, never from the widget's own state.
- **Headline measurements against the original widget**: hold mute in
  under 1 s (was about 2 s of live video); mic-mute leaves video live by
  policy; transfer-back then reload rejoins with video in about 15 s (was
  dark indefinitely); socket loss mutes in 82 ms with reconnect and
  resync in 1.7 s (was live video through the whole hold); consult
  complete tears down with the camera released (was a ghost Connected
  view); missed-alert, reload and two-window scenarios each leave exactly
  one agent leg; outbound branch video validated end to end on
  2026-09-10 with video on both video legs and audio on the trunk.
- **Automated tests**: 174 passing (17 suites), including replay tests
  from sanitised real Genesys snapshots; TypeScript compiles clean.
- **Not covered**: see Known issues.

### Upgrade and deployment notes

- Build with the customer's OAuth client id and base path:
  `VITE_GENESYS_OAUTH_CLIENT_ID=<client id>` and
  `VITE_BASE_PATH=/telecom/agent-app/` in `.env` (or the environment),
  then `npm run build`. The committed `dist/` is that build and can be
  hosted directly; `public/web.config` covers the IIS MIME type for the
  segmentation model.
- The OAuth client (implicit grant) must list the exact hosted URL,
  including the trailing slash, as an authorised redirect URI, or agents
  see "Genesys sign-in failed".
- Interaction Widget URL parameters are unchanged: `pcEnvironment`,
  `pcConversationId`, `pexipNode`, `pexipAgentPin`, `pexipAppPrefix`;
  `debug=1` is optional.
- Hosting caches `index.html`: after a deploy, change the widget URL query
  string (any extra parameter) to force agents onto the new build, and
  confirm with the build stamp.
- **Outbound prerequisites, all organisation-side**: the Infinity local
  policy branch for the branch-device range; a Genesys number plan that
  classifies the range with a capture group in the match expression; an
  outbound route for that classification on the Pexip trunk; and the
  External Contact record for each branch holding the bare device number.
  Details and the verification procedure are in
  `docs/genesys-configuration.md`.
- No database, backend or server-side logging is introduced. Diagnostics
  live in the agent's browser storage only.

## [0.1.0] - 2026-07-14

Baseline: the upstream Pexip Genesys example application with the
customer's configuration.

- React 19, Vite 8 and current Pexip packages.
- Base path `/telecom/agent-app/` and an IIS `web.config`.
- Self-view centred.
- Upstream fixes for conference and consult state handling.

---

### Versioning

Releases follow Semantic Versioning. `1.0.0-rc.1` is the UAT candidate;
on sign-off it is tagged `1.0.0` with no code change. Fixes found in UAT
ship as further release candidates (`rc.2`, ...). The widget shows its
version and build stamp bottom-left.

[1.0.0-rc.1]: https://github.com/JoshEstrada-Pexip/agent-app/compare/v0.1.0...v1.0.0-rc.1
[0.1.0]: https://github.com/JoshEstrada-Pexip/agent-app/releases/tag/v0.1.0
