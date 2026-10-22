# Changelog

Release notes for the Pexip Genesys Video App, the Interaction Widget that
gives Genesys Cloud agents video on a call while audio stays in-band on the
Genesys SIP trunk. Detail for every item, with code excerpts and lab
measurements, is in `docs/technical-notes.md` (section numbers in brackets).

## [2.0.0-rc.5] - 2026-10-22

Fifth release candidate. Diagnostics for background effects; no change to
call handling or to the effects themselves.

### Added

- **Background-effect entries in the support export.** The effect
  pipeline reported nothing: the processor library does not throw when
  the segmentation model fails to load, it records an error status and
  calls an optional log hook, and the widget passed none. A broken effect
  (rc.4's double-slash 404) therefore left the plain camera up with
  nothing in the diagnostics file for anyone to act on. The widget now
  logs, under `media`: `effect-open` with the effect and the exact asset
  URLs it will request, `effect-opened`, or `effect-failed` with those
  URLs when the library ends in error, and `effect-library` lines with the
  library's own messages (its failures at error level). With no effect
  selected these are debug entries. `docs/support-diagnostics.md` describes
  them [§22].

### Validation

- 225 automated tests passing (220 in rc.4); TypeScript and lint clean.
- Not re-run live: no call-path change since rc.3.

### Deployment notes

- Unchanged from rc.4. Rebuild `dist/`; the build stamp reads
  `v2.0.0-rc.5 · build <date>`.

## [2.0.0-rc.4] - 2026-10-22

Fourth release candidate. One fix from rc.3 UAT: background effects.

### Fixed

- **Background blur and background image did nothing.** The widget built
  the effect asset URLs by appending `/wasm`, `/models/…` and
  `/media-processor/…` to the base path, and the base path carries a
  trailing slash (`/telecom/agent-app/`), giving `/telecom/agent-app//wasm`.
  GitHub Pages collapses the double slash, so the lab never saw it; Azure
  Blob and Google Cloud Storage serve object names literally and returned
  404, the segmentation model never loaded, and selecting Blur or
  Background image left the plain camera up with no error shown. The base
  path is now normalised before the paths are built, so either spelling
  of `VITE_BASE_PATH` works. Present since 1.0.0 on bucket hosting [§21].

### Deployment notes

- Rebuild `dist/` from this source; the build stamp reads
  `v2.0.0-rc.4 · build <date>`. No configuration change.
- `web.config` (IIS only) now also maps `.wasm` to `application/wasm`.
  Bucket hosting needs no change; confirm the objects under `wasm/`,
  `models/` and `media-processor/` were uploaded with the build.

### Validation

- 220 automated tests passing (215 in rc.3); TypeScript and lint clean.
- Single-slash asset URLs return 200 on the lab GCS bucket where the
  double-slash form returns 404 (curl, 2026-10-22).
- Not re-run live for rc.4 (no call-path code changed): the rc.3 live
  suite; the effects themselves on a bucket-hosted build.

## [2.0.0-rc.3] - 2026-10-08

Third release candidate. One fix from rc.2 UAT, in consult handling.

### Fixed

- **Video stayed dark after the consult target was held and resumed.**
  Pressing Hold then Resume on the consult row leaves nobody parked: the
  member, the agent and the consult target are all talking, the same shape
  Genesys uses for a conference. The hold rule read "consult target not
  parked" as "member parked" and kept the agent's video muted while the
  member was live, with the pane still saying "member on hold"; the target
  holding or resuming its own leg changed nothing. Video now follows the
  member's own parked flag only, so Hold/Resume on the consult row, the
  target's own hold, and a three-way conference all keep video live
  whenever the member can hear the agent. Reproduced on an outbound branch
  call with the Genesys workspace buttons; the full consult, hold,
  reload, socket-loss and hang-up lab suite re-run green on this build.

### Validation

- 215 automated tests passing (208 in rc.2); TypeScript and lint clean.
- Live lab re-run on this build: hold/unhold, mic mute, consult cancel,
  consult complete, consult taken back, back-to-member resume, reload and
  socket loss mid-consult, transfer back with reload, member hang-up.
- Not yet re-run live on this exact build: the consult-row Hold/Resume
  sequence itself (captured on rc.2, encoded in the unit tests); an
  outbound branch call end to end.

### Deployment notes

- Unchanged from rc.2. Rebuild `dist/` from this source; the build stamp
  reads `v2.0.0-rc.3 · build <date>`.

## [2.0.0-rc.2] - 2026-10-02

Second release candidate. Fixes found during UAT of rc.1, all in consult
handling and in the path the widget takes on a reload or reconnect, plus
the hold-video hand-off and the on-screen wording. Each fix was reproduced
in the lab first and re-measured on the wire afterwards.

### Fixed

- **Video did not resume when the agent went back to the member during a
  consult to an extension or external contact.** The consult target is a
  far-end leg, and the hold rule only recognised agent legs as the parked
  party. The rule now follows who Genesys has parked, whatever the target
  is. Measured: 0 kbps before, 373 kbps after, restored 1.6 s after the
  switch; video still mutes within 0.6 s when the agent returns to the
  target. [§18]

- **Reloading the widget during a consult showed "not held".** The REST
  read used at join, reload and reconnect had its own copy of the hold
  rule. Both paths now share one. [§19.1]
- **Reload after a consult to a branch-range number joined the wrong
  room.** The consult leg was mistaken for an outbound branch call. Only
  the call's original far end decides now. [§19.2]
- **Camera kept sending after the widget joined a call that was already
  held.** Infinity was told video was muted but the camera track was never
  stopped. [§19.3]

- **Hold video kept playing after the agent answered.** The playback leg
  the policy dials in for the waiting customer was never removed: the
  handler listened for a signal that is not raised for participants already
  in the room. The widget now removes it as soon as the agent's video has
  joined. The playback alias must end in `.playback`. [§20]

### Changed

- **On-screen wording says "member", not "customer".** The hold and consult
  panes, the "Video restored" toast and the self-view captions.

### Known issues and limitations

- **Conference (agent speaks to the member and the consult target
  together)** is still not defined: video stays muted for the agent who
  started the consult.
- **Member hangs up during an answered consult to an external number**:
  the call ends through the Infinity roster, not through Genesys call
  state.
- The rc.1 items still apply (audio-only for the consulted agent,
  conference audio silenced locally, screen-share "Window" option).

### Validation

- Live, Genesys org + Pexip Infinity + SIP video endpoint, video measured
  from WebRTC `outbound-rtp` counters: consult round trip to an external
  number and to an agent; reload and notification-socket loss in the middle
  of a consult; hold/unhold; consult cancel and consult complete; transfer
  away and back with a reload; all repeated on a queue with hold video.
- Not re-run live for this candidate: an outbound branch call, and socket
  loss during a plain hold.
- 208 automated tests passing (175 in rc.1); TypeScript and lint clean.

### Deployment notes

- Unchanged from rc.1. The build stamp in the widget reads
  `v2.0.0-rc.2 · build <date>`.
- Hold video: the playback alias dialed by the Infinity policy must end in
  `.playback`; no policy change is needed.

## [2.0.0-rc.1] - 2026-09-11

Release candidate for UAT. The original widget trusted its own UI state and hoped the video
followed the call. This release rebuilds it so the video leg is driven by
verified Genesys call state, fails toward privacy, recovers on its own, and
can be diagnosed from the agent's browser. It also extends the widget from
inbound-only to outbound branch video. Every behavioural change was
reproduced and then re-measured on the wire against a real Genesys org and
Pexip Infinity, and the whole thing ships with 175 automated tests.

- **Hold means private.** Video goes dark within a second of hold and
  stays dark until the call is really resumed; a lost connection to call
  state mutes video too. Was about two seconds of live video per hold, and
  indefinite on a dead connection.
- **Video survives transfers and reloads.** Transfer back, reload
  mid-call, and consult complete all recover or tear down correctly. Was
  "No active call" on a live call.
- **One agent, one video leg.** Missed alerts, reloads and second tabs no
  longer multiply the agent in the customer's view; the visible window
  owns the video.
- **Outbound branch video.** An agent dials a branch device from the
  workspace and the widget joins the room the Infinity policy creates, with
  audio still in-band. New capability.
- **Call, video, error and logging layers rebuilt.** One call-phase state
  machine, one privacy rule, classified start-up failures with a watchdog,
  structured logs with an agent-driven export and no server-side storage.
- **Agents see what is happening.** Panes for hold, consult, incoming call,
  call ended and connecting steps; a toast when video is back; a banner
  when the fail-safe engages.

On UAT sign-off this becomes 2.0.0 with no code change.

### Fixed

- **Hold left video live for ~2 s.** A fixed one-second timer delayed every
  hold. Video now mutes immediately; only the un-mute waits 750 ms for the
  state to settle. Measured: dark in under 1 s. [§2]
- **Video lost after transfer back or a mid-call reload.** Stale
  participant legs shadowed the live one. One shared "which leg is me" rule
  now prefers the connected leg everywhere. Reload rejoins in ~15 s. [§3]
- **Dead notifications socket left video streaming through a hold.** No
  reconnect existed. Video now mutes within milliseconds of the loss, a
  banner shows, and the widget reconnects and re-reads call state from the
  REST API. Measured: mute in 82 ms, resync in 1.7 s. [§6]
- **Privacy decisions were scattered and unverified.** One rule derives
  video state from hold and connection loss, retries, and fails toward
  muted. The agent's own camera-off is never overridden. [§1]
- **Joining an already-held call flashed video.** Joins are video-muted,
  then settled against real call state. [§7]
- **Consult complete left a ghost "Connected" view with the camera on.**
  Handlers now run only while a call is active; the widget tears down and
  releases the camera. [§8]
- **Mute after disconnect threw.** Same gate as above. [§8]
- **Some disconnect reasons (e.g. `transfer.noanswer`) ran no teardown.**
  Matched by category prefix now. [§5]
- **Room destroyed on a transient snapshot; empty room joined on alias
  failure.** The call ends only when every customer leg is gone; an alias
  failure shows "Video is unavailable for this call" with Retry. [§10]
- **Start-up failures spun forever.** Bad token, wrong environment, missing
  parameters and OAuth redirect mismatches now show a specific message; any
  step over 20 s shows "Still connecting" with Reload. [§11]
- **Agent appeared two or more times after a missed alert.** A re-entrant
  join and one join per widget instance. The join is now single-entry, all
  instances elect one video owner before opening the camera, and leftover
  legs of the same agent are removed. [§12]
- **Customer endpoint kicked when its name matched the agent's.** Leg
  identity now travels in a call tag, never a display name. [§12]
- **Customer hang-up missed while a duplicate leg was present.** The call
  ends when no counterparty remains. [§12]
- **Agent heard the customer from the widget as well as the softphone.**
  `@pexip/infinity` 23 ignores the video-only call type. Incoming audio
  tracks are dropped and the video element is muted. [§17]
- **Inbound branch calls treated as outbound after the caller-ID change.**
  Direction now decides, not address shape. [§14.2]

### Added

- **Outbound branch video.** Agent dials the branch device from the
  workspace; the Infinity policy creates a room named after the dialled
  number and dials the device in; the widget joins video-only. Device not
  in the room within 15 s: widget leaves video, keeps audio, offers Retry.
  Needs the policy branch, a Genesys number plan and route: see
  `docs/genesys-configuration.md`. [§14]
- **Agent-facing state panes**: on hold, consulting, incoming call, no
  active call, call ended, video in another window, and each connecting
  step. [§11, §12]
- **Restore toast and fail-safe banner** so the agent knows why video is
  dark and when it is back. [§9, §11]
- **Support diagnostics.** Rolling local log per widget instance, exported
  by clicking the build stamp (Copy), with a verbose mode and
  `&debug=1`. Nothing leaves the browser; tokens, PINs and the query string
  are never stored. See `docs/support-diagnostics.md`. [§15]
- **Structured logging** of every privacy decision, connection event, leg
  election and teardown. [§9]
- **Version and build stamp** in the widget and in every export.
- **Automated tests**: 175, including replay tests driven by real recorded
  Genesys events.

### Changed

- **Call-state handling rebuilt.** One conversation fetch yields active,
  alerting, held and muted; the service raises connect, hold, mute and
  alerting only on transitions; one stale-leg-safe "which leg is me" rule
  is used everywhere; a four-phase machine (idle, joining, active,
  passive) is the single guard on every handler. [§3, §8, §12]
- **Video-state handling rebuilt.** One derived privacy rule with
  confirmed retries that fails toward muted; video-muted join then settle;
  one video owner per agent per call, elected before the camera opens,
  with leftover legs removed. [§1, §7, §12]
- **Error handling rebuilt.** Every start-up failure classified and shown;
  a 20 s connecting watchdog; connection-loss fail-safe with reconnect
  and resync; alias and device failures surface with Retry instead of a
  silent join. [§6, §10, §11, §14]
- **Logging rebuilt.** Structured logger (category, event, level, reason)
  with console and local-storage sinks, a level threshold, secret
  stripping, and an agent-driven export. [§9, §15]
- **Mic-mute mutes only the microphone.** Hold is the privacy control. [§1]
- **Self-view is docked** top-centre; the camera button is the only
  control. Camera-off and on-hold tiles say so in words. [§13]
- **Screen share** opens on the Chrome tab pane; "Entire screen" is
  removed. [§11]
- **Events from other conversations are ignored.** [§4]
- **Package** renamed to `pexip-genesys-video-app`; new repository;
  `dist/` is the customer build. `agent-app` and `agent-branch-app` are
  superseded.
- **Documentation**: README, this changelog, `docs/genesys-configuration.md`,
  `docs/support-diagnostics.md`, `docs/technical-notes.md`.

### Known issues and limitations

- **Consult and conference are audio-only for the second agent.** Video
  for a consulted or conferenced agent is not defined in this release and
  that agent should treat the call as audio-only; it will be clarified in
  the next version.
- **Conference audio still arrives at the widget (~60 kbps)**, silenced
  locally. Removed only by the planned `@pexip/infinity` 24 upgrade.
- **Screen share "Window" option** cannot be removed by a web page; use the
  Chrome policy `TabCaptureAllowedByOrigins` to restrict to tabs.

### Validation

- Automated lab harness against a real Genesys org, Pexip Infinity and a
  SIP video endpoint; API-driven agent actions (proven identical to UI
  clicks); video measured from WebRTC `outbound-rtp` counters, not UI
  state.
- Headline results: hold dark in under 1 s (was ~2 s); reload after
  transfer-back rejoins in ~15 s (was never); socket loss muted in 82 ms
  and resynced in 1.7 s (was live through the hold); consult complete
  tears down cleanly; missed-alert, reload and two-window cases each leave
  one agent leg; outbound validated end to end 2026-09-10.
- 175 automated tests passing; TypeScript and lint clean.

### Deployment notes

- Build with `VITE_GENESYS_OAUTH_CLIENT_ID=<client id>` and
  `VITE_BASE_PATH=/telecom/agent-app/`; the committed `dist/` is that
  build. `web.config` covers the IIS MIME type.
- The OAuth client must list the exact hosted URL, trailing slash
  included, as a redirect URI.
- Widget URL parameters unchanged: `pcEnvironment`, `pcConversationId`,
  `pexipNode`, `pexipAgentPin`, `pexipAppPrefix`; `debug=1` optional.
- After a deploy, change the widget URL query string to bypass cached
  `index.html`; confirm with the build stamp.
- Outbound needs org-side config (policy branch, number plan with a
  capture group, outbound route, External Contact number). See
  `docs/genesys-configuration.md`.
- No backend, database or server-side logging is introduced.

## [1.0.0] - 2026-07-14

Baseline, numbered retroactively: the build in production before this
release. Upstream Pexip Genesys example with the customer's configuration
(React 19, Vite 8, base path `/telecom/agent-app/`, IIS `web.config`).

[2.0.0-rc.5]: https://github.com/JoshEstrada-Pexip/pexip-genesys-video-app/releases/tag/v2.0.0-rc.5
[2.0.0-rc.4]: https://github.com/JoshEstrada-Pexip/pexip-genesys-video-app/releases/tag/v2.0.0-rc.4
[2.0.0-rc.3]: https://github.com/JoshEstrada-Pexip/pexip-genesys-video-app/releases/tag/v2.0.0-rc.3
[2.0.0-rc.2]: https://github.com/JoshEstrada-Pexip/pexip-genesys-video-app/commit/1fd4db1
[2.0.0-rc.1]: https://github.com/JoshEstrada-Pexip/pexip-genesys-video-app/releases/tag/v2.0.0-rc.1
[1.0.0]: https://github.com/JoshEstrada-Pexip/agent-app
