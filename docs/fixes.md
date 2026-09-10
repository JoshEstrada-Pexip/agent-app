# Video privacy fixes — what changed and why

Branch `pr1-privacy-fix` vs `main`. Every fix below was driven by a defect
reproduced in the lab against the original app (findings `F-xx` in
`docs/lab-findings.md`) and re-validated on the wire against the fixed build
on 2026-08-31 (run artifacts in `tools/lab/runs/*2026-08-31T18*`). "On the
wire" means WebRTC `outbound-rtp` byte/frame counters sampled from the app's
peer connection — never the app's own UI state.

The two field complaints this work answers:

1. **"The customer can see the agent while the agent believes they are
   held/muted"** — fixed by the single privacy rule (§1), immediate hold
   mute (§2), and the socket fail-safe (§6).
2. **"After a transfer back, video is lost and can't reconnect"** — fixed by
   stale-leg-safe participant selection (§3).

| # | Fix | Files | Findings | Validated by |
|---|-----|-------|----------|--------------|
| 1 | Single video-privacy rule, fails toward muted | `src/App.tsx` | F-11, policy 2026-08-28 | S2.5 |
| 2 | Immediate hold-mute, settle-then-unmute | `src/genesys/genesysService.ts` | F-02 | S2.1 |
| 3 | Stale-leg-safe participant selection | `src/call/legSelection.ts`, `src/genesys/genesysService.ts` | F-19 | S4.6 |
| 4 | Foreign-conversation event filter | `src/genesys/genesysService.ts` | — (hardening) | dropped-count 0 in all runs |
| 5 | Tolerant disconnectType matching | `src/genesys/genesysService.ts` | F-16 | S3.2, S4.6 |
| 6 | WebSocket loss fail-safe + reconnect | `src/genesys/notificationsController.ts`, `src/App.tsx` | F-20 | S5.1 |
| 7 | Join-time privacy pre-mute + settle | `src/App.tsx` | — (window at join) | S2.1 join phase |
| 8 | Active-call gate | `src/App.tsx` | F-15, F-17 | S3.2 |
| 9 | Structured logging + banner UX | `src/observability/`, `src/App.tsx` | — (production readiness) | S5.1 log sequence |
| 10 | VMR-destruction guards (customer-gone + alias failure) | `src/call/legSelection.ts`, `src/genesys/genesysService.ts`, `src/App.tsx` | probe E, alias hazard | unit tests (live blocked by F-22) |
| 11 | Agent-facing state panes + bootstrap failure surfacing | `src/App.tsx`, `src/App.scss`, `src/constants/ErrorId.ts`, `src/genesys/genesysService.ts` | field: indefinite spinner on OAuth redirect mismatch (2026-09-02) | replay test (`src/App.replay.test.tsx`), browser bootstrap checks (`tools/lab/bootstrap-check.cjs`, 7/7 on 2026-09-03) |

---

## 1. One video-privacy rule instead of scattered handlers

**Problem.** Video privacy decisions were spread across independent
handlers, and the two biggest holes were:

- Genesys **audio-mute did not touch video at all**. The original handler
  called the Pexip *audio* mute — a no-op, since the agent's WebRTC leg
  carries no audio (audio flows over the SIP trunk):

  ```ts
  // BEFORE — App.tsx
  const onMuteCall = async (muted: boolean): Promise<void> => {
    await infinityClient.mute({ mute: muted })
  }
  ```

  Lab F-11 measured the consequence: mic muted in Genesys, agent video still
  streaming to the customer at ~390 kbps.

- Mute events were additionally **suppressed while on hold** in the event
  layer (`if (!onHoldState) handleMuteCall(...)`), so hold+mute combinations
  could leave the two states permanently out of sync.

> **Policy change 2026-09-03 — mic-mute is mic-only again.** The 2026-08-28
> decision to make Genesys mic-mute also mute video was reversed: agents use
> **Hold** as the privacy control, and the mic-mute button must only mute the
> mic. `audioMuted` was removed from `privacyRef`; `onMuteCall` now only logs
> the event (`genesys/mic-muted`, `genesys/mic-unmuted`). Every other input
> to the rule — hold, connection-loss fail-safe, settle-then-unmute, the
> agent's own camera button — is unchanged. F-11 is therefore accepted
> behaviour, not a defect. The code excerpts below predate this change where
> they mention `audioMuted`.

**Fix.** All video-privacy inputs now live in one ref and one function.
`privacyRef` tracks `{ held, connectionLost }`; every event
handler only updates the ref and calls `applyVideoPrivacy()`
(`src/App.tsx:260`):

```ts
/**
 * Single privacy rule: video is muted whenever the call is held, the mic is
 * muted in Genesys (policy: mute must always mean fully private), or the
 * call-state connection is lost (fail-safe). Applies the state with retries
 * and FAILS TOWARD MUTED — if mute cannot be confirmed, the wire is muted
 * directly and the agent sees a banner. Audio is never touched.
 */
const applyVideoPrivacy = async (): Promise<void> => {
  if (!activeCallRef.current || infinityClient == null) return
  const p = privacyRef.current
  const reason = p.connectionLost
    ? 'connection to call state lost'
    : p.held ? 'call on hold'
    : p.audioMuted ? 'microphone muted'
    : null
  const shouldMute = reason != null
  // Never un-mute over the agent's own camera mute.
  if (!shouldMute && cameraMuted) return
  let ok = false
  for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
    ok = await handleCameraMuteChanged(shouldMute, false).catch(() => false)
  }
  logger.log({ ... })                     // every decision is logged
  if (!ok) {
    if (shouldMute) {
      // Last resort: force the wire dark even if the tidy path failed.
      await infinityClient.muteVideo({ muteVideo: true }).catch(console.error)
      localStream?.getTracks().forEach((track) => { track.stop() })
      setBanner('Video muted for safety — call state could not be confirmed')
    } else {
      setBanner('Video could not be restored — use the camera button to retry')
    }
    return
  }
  setBanner(shouldMute && !p.held ? `Video muted — ${reason}` : null)
}
```

Design properties worth knowing when reviewing:

- **Derived, not event-driven.** Video state is recomputed from the full
  privacy tuple on every change, so no ordering of hold/loss events can
  bypass it.
- **Fails toward muted.** The unchecked `muteVideo` of the original (its
  response was ignored) is replaced by 3 confirmed attempts; if muting still
  can't be confirmed, the stream tracks are stopped outright and the agent
  sees a banner. An unconfirmed *un*mute never force-unmutes.
- **Audio is never touched**; the agent's own camera-mute button is never
  overridden by an unmute.
- `handleCameraMuteChanged` now returns `boolean` (`src/App.tsx:415`) so
  callers can verify success — previously `Promise<void>`, unverifiable.

**Wire evidence (S2.5, 2026-08-31).** Mic mute commanded → 8 frames
(<0.5 s) then the byte counter froze at 113,349 for the whole mute; unmute →
~360 kbps within 4 s. Baseline F-11 streamed ~390 kbps throughout.

## 2. Hold: mute immediately, unmute only after the state settles

**Problem.** The original delayed **every** hold transition by a fixed
timer, in both directions:

```ts
// BEFORE — genesysService.ts
setTimeout(() => {
  handleHold(onHoldState)
}, 1000) // Delay because we receive held=false when we try a consult transfer
```

The timer existed to paper over a real quirk (Genesys emits a transient
`held=false` during consult setup), but it delayed the *privacy-critical*
direction too: lab F-02 measured ~2 s of live video to the customer on every
hold (~450 ms Genesys event latency + the 1 s timer + mute round-trip).

**Fix** (`src/genesys/genesysService.ts:381`): asymmetric handling. Mute
fires immediately; unmute waits out a 750 ms settle window so a `held=false`
flap can never briefly expose video (lab-measured event bursts arrive within
~150 ms):

```ts
if (effectiveHoldState) {
  // Privacy first: mute IMMEDIATELY (was a blind 1s delay — lab F-02
  // measured a ~2s live-video window on every hold).
  handleHold(true)
} else {
  // Un-mute only once the state has settled, so a held=false flap can
  // never briefly expose video.
  unholdSettleTimer = setTimeout(() => {
    unholdSettleTimer = null
    if (!onHoldState) handleHold(false)
  }, UNHOLD_SETTLE_MS)
}
```

The consult-transfer quirk the old timer handled is covered by the existing
`effectiveHoldState` logic (customer-held during consult counts as held)
plus the settle window.

**Wire evidence (S2.1, 2026-08-31).** Hold commanded → ~12 frames (well
under 1 s, at the ~450 ms Genesys latency floor) then the byte counter froze
at 95,728; identical at +2 s/+6 s/+10 s into the hold; restored to ~385 kbps
after unhold. Baseline: ~2 s live window.

## 3. Stale-leg-safe participant selection (the transfer-back bug)

**Problem.** Genesys *accumulates* participant entries: after a
transfer-back the same agent has multiple legs — old
terminated/disconnected ones first, the live one last (8 legs piled up in
one lab conversation). The app had **three different, disagreeing "which
participant is me" predicates**, all `find()`-first:

```ts
// BEFORE — isCallActive() took the FIRST matching agent leg, no state filter
const agentParticipant = conversation.participants?.find((participant) => {
  return (
    participant.purpose === GenesysRole.AGENT &&
    participant.userId === userMe.id
  )
})
```

(The event path filtered `state !== terminated` only; `getActiveAgent`
filtered on `endTime`.) After any transfer round-trip the first match is a
dead leg, so `isCallActive()` answered `false` on a live call. Lab F-19
reproduced the field symptom exactly: reload the widget after a
transfer-back → "No active call" on a live call, dark indefinitely (an
unrelated event rescued it after 18 s in the lab; on a quiet call, never).

**Fix.** One shared predicate, `src/call/legSelection.ts`, used by the event
path, `isCallActive`, and `getActiveAgent`:

```ts
// Rule: prefer a CONNECTED leg (the newest if several), else the newest
// non-terminated leg, else undefined. Works for both API shapes:
// REST conversations (userId + calls[0].state) and notification events
// (user.id + state).
export const selectMyLeg = <T extends LegLike>(
  participants: T[] | undefined,
  myUserId: string | undefined
): T | undefined => {
  if (participants == null || myUserId == null) return undefined
  const mine = participants.filter(
    (p) => p.purpose === 'agent' && legUserId(p) === myUserId
  )
  const connected = mine.filter((p) => legState(p) === 'connected')
  if (connected.length > 0) return connected[connected.length - 1]
  const alive = mine.filter((p) => legState(p) !== 'terminated')
  return alive.length > 0 ? alive[alive.length - 1] : undefined
}
```

**Wire evidence (S4.6, 2026-08-31).** Transfer A1→A2→back, reload widget
mid-call: app rejoined with full video in ~15 s (page load + auth + join),
no "No active call". Baseline: dark indefinitely.

## 4. Foreign-conversation event filter

**Problem.** Call events arrive on a **user-level** topic
(`v2.users.{id}.conversations.calls`), so late events from a previous
conversation — or a concurrent one — could drive this widget's call state.

**Fix** (`src/genesys/genesysService.ts:295`): drop any event whose
`eventBody.id` doesn't match this widget's conversation; count and log the
drops. `getDroppedForeignEventCount()` exposes the counter — it must stay 0
during a widget's own call flows (confirmed in all 2026-08-31 runs).

## 5. Tolerant disconnectType matching

**Problem.** `disconnectType` values morph across event snapshots and
include dotted variants (`transfer.noanswer`) the original's exact-match
`if` chains didn't model (lab F-16) — an unmodeled value meant no teardown
path ran at all.

**Fix** (`src/genesys/genesysService.ts:287`): compare by category prefix:

```ts
/** Category of a disconnectType: values morph across snapshots and include
 *  variants like "transfer.noanswer" (lab finding F-16) — match by prefix. */
const disconnectCategory = (dt: string | undefined): string =>
  (dt ?? '').split('.')[0].toLowerCase()
```

`transfer` and `peer` categories share the only-this-agent-leaves path;
`client` keeps the disconnect-all-if-last-agent check.

## 6. WebSocket loss: fail-safe now, reconnect next (field complaint #1)

**Problem.** The notifications socket had **no failure handling at all**:

```ts
// BEFORE — notificationsController.ts (the entire connection lifecycle)
ws = new WebSocket(channel.connectUri as string)
ws.onmessage = onSocketMessage
```

No `onclose`, no `onerror`, no reconnect. A dead socket meant call-state
events silently stopped. Lab F-20 reproduced the field complaint: socket
killed, call held → agent video streamed ~390 kbps through the **entire**
hold, UI stuck on "Connected", desync permanent until page reload.

**Fix**, in two layers:

*Transport* (`src/genesys/notificationsController.ts`): `onclose` reports
loss upward and schedules reconnection with backoff (1 s → 2 s → 5 s → 10 s
→ 20 s cap). Genesys channels are single-use once dead, so reconnection
creates a **fresh channel and re-subscribes** every topic before reopening
the socket:

```ts
socket.onclose = (e: CloseEvent): void => {
  if (intentionallyClosed) return
  connectionCallbacks.onDown?.(`notifications socket closed (code ${e.code})`)
  scheduleReconnect()
}

/** Channels are single-use once dead: create a fresh one and re-subscribe. */
const reconnect = async (): Promise<void> => {
  const data = await notificationsApi.postNotificationsChannels()
  channel = data
  const topics = Object.keys(subscriptionMap).filter((t) => t !== 'channel.metadata')
  if (topics.length > 0) {
    await notificationsApi.postNotificationsChannelSubscriptions(
      channel.id as string, topics.map((id) => ({ id })))
  }
  openSocket()
  connectionCallbacks.onRestored?.()
}
```

*Policy* (`src/App.tsx:704`): on loss, set `connectionLost` in the privacy
ref → video mutes via the single rule and the agent sees "Connection to call
state lost — video muted for safety". On restore, **re-read truth from the
REST API** (`fetchCurrentCallState()` — hold/mute/active in parallel)
because events may have been missed while down, then re-apply privacy; if
the call ended while down, tear down.

**Wire evidence (S5.1, 2026-08-31).** Socket killed → video muted **82 ms**
after `onclose` → reconnected + resynced in **1.7 s** → a hold commanded
during the outage was heard on the *new* channel and muted video 721 ms
after the command → byte counter frozen through the entire hold → unhold
restored. Baseline: video streamed throughout, permanently desynced.

## 7. Join-time privacy: pre-mute, then settle against real state

**Problem.** The app joined the conference with live video, then asked
Genesys for hold/mute state — a window where video could stream into a call
that was already held (e.g. widget reload during hold), and the join-time
reconcile ignored audio-mute entirely.

**Fix** (`src/App.tsx:150` and `:234`): join video-muted, then immediately
settle against reality:

```ts
// Privacy pre-mute: never show live video in the window before the
// call's real state is known (e.g. joining into an already-held
// call). initConference settles it against real state right after.
await infinityClient.muteVideo({ muteVideo: true }).catch(console.error)
activeCallRef.current = true
```

```ts
// Deterministically settle video against the REAL call state right after
// join ... Skipped when the join failed (error state).
if (activeCallRef.current) {
  const holdState = await GenesysService.isHeld().catch(() => false)
  const muteState = await GenesysService.isMuted().catch(() => false)
  privacyRef.current.held = holdState
  privacyRef.current.audioMuted = muteState
  ...
  await applyVideoPrivacy()
}
```

The settle only runs after a *successful* join (`activeCallRef` is set in
the success branch), so a failed join can't trigger media calls.

## 8. Active-call gate

**Problem.** Handlers ran regardless of whether a call was actually active:
consult-complete left a ghost "Connected" UI with the camera re-acquired
(lab F-15), and post-disconnect mute attempts threw (F-17).

**Fix.** `activeCallRef` (a ref, not state — event listeners registered
once at mount would close over stale state) is set on successful join,
cleared in `onEndCall`, and gates every Genesys-driven handler
(`onHoldVideo`, `onMuteCall`, `applyVideoPrivacy`, connection loss/restore).
`onEndCall` also resets the privacy ref and banner.

**Evidence (S3.2, 2026-08-31).** After consult-complete: "no active call"
UI, camera released, peer connection torn down. Baseline: ghost "Connected"
UI with camera live.

## 9. Structured logging and agent-facing banners

New `src/observability/` (Logger + console sink, remote sink is a later
PR). Every privacy decision logs `{category, event, level, reason,
data.confirmed}` — categories `failsafe` / `media` — plus connection
loss/restore and the dropped-foreign-event counter. The S5.1 log sequence
(connection-lost → video-muted 82 ms → connection-restored → hold →
video-muted) is exactly the audit trail support will need in production.

Banner UI (`state-banner` in `src/App.tsx:829`) tells the agent *why* video
is dark and when the fail-safe has engaged — previously the app gave no
feedback at all.

## 10. VMR-destruction guards: don't kill the room on a hunch

**Problem.** Two paths could destroy or lose the ephemeral VMR — and since
the room is created per-call by the Infinity policy, destruction is
unrecoverable (rejoin lands nowhere). Both failures are *availability*
failures, not privacy leaks: video disappears while SIP audio keeps working,
silently.

- The call-end check treated "no customer in state `connected` in this
  snapshot" as "customer left" and fired `disconnectAll` — a transient
  snapshot (customer `dialing`, or a snapshot missing the customer entry)
  destroyed the room (probe E, 2026-08-27 review).
- The conference alias comes from the customer leg's ANI name — it IS the
  rendezvous key. On lookup failure the app fell back to
  `?? uuidv4()`: it silently joined a brand-new **empty** room. Black
  screen, working audio, no clue why.

**Fix.**

`src/call/legSelection.ts` — the call ends only when the customer is
*genuinely* gone:

```ts
export const customerLegGone = (participants): boolean => {
  const customers = (participants ?? []).filter((p) => p.purpose === 'customer')
  if (customers.length === 0) return false   // ambiguous snapshot: never destroy
  return customers.every((p) => {
    const state = legState(p)
    return state === 'disconnected' || state === 'terminated'
  })
}
```

`src/App.tsx` — alias failure is now visible instead of silent: no join
happens, the agent sees the error panel "Video is unavailable for this call
— audio continues on the phone line" with a Retry button, and a `failsafe`
log entry records the cause.

**Validation.** 13 new unit tests (transient states, missing-customer
snapshots, REST vs event shapes, normal hang-up still tears down; App-level
test for the error panel). Live S1.1 validation is currently blocked by
F-22 (see below) — no event reaches the app at all, which is orthogonal to
this change. The structural fix remains policy-side VMR grace across
transfers (we control the Infinity local policy).

---

## Known gaps (deliberately not in this PR)

- **Silent notification starvation (lab F-22, 2026-08-31).** A channel can
  pass every health signal — created 200, subscribed 200, socket open,
  heartbeats flowing — and still deliver zero call events (observed after
  crossing Genesys' 20-channels-per-user cap; 47 channels created in one lab
  day). **No PR-1 fail-safe catches this**: the socket never closes and
  heartbeats keep arriving. PR 2 MUST include a call-state resync watchdog
  (periodic `fetchCurrentCallState` compare-and-reconcile); subscription
  verification after subscribe is a cheaper partial check.
- **Receiving agent gets no automatic video after a transfer** — deferred.
- **Double transfer (A1→A2→A1→A2)** — not yet covered by the harness.
- **Transfer-backs via re-queue** (suspected production path) — event shapes
  not yet captured.
- **Full WS hardening** — 24 h channel expiry, heartbeat monitoring,
  20-channel cap: PR 2. This PR ships only the loss fail-safe + reconnect.

---

## 11. Agent-facing state panes and bootstrap failure surfacing (2026-09-03)

**Problem.** Two agent-feedback gaps:

- The full-window panes were bare headings ("Call on hold", "No active
  call") with no privacy confirmation and no distinction between a plain
  hold and a consult, or between "no call yet" and "call ended".
- Every bootstrap failure after the spinner appeared was swallowed by a
  `catch(console.error)`: a rejected token, a wrong environment, a failed
  notifications channel, a missing Pexip node, or — the field case on
  2026-09-02 — an OAuth **redirect URI mismatch**, which Genesys reports as
  `error`/`error_description` in the fragment instead of a token. The old
  code treated "no launch params" as "returned from login", called the API
  with an empty token, and spun forever.

**Fix.**

- **State panes** (`.state-pane`, Pexip design-system icons, neutral tone;
  red stays reserved for the fail-safe banner):
  - Hold: "Call on hold" / "Consulting — customer on hold" with
    "Your video is muted. The customer cannot see you." The hold listener
    now carries a `HoldReason` (`'held' | 'consulting'`) — UI only, the
    video policy is identical for both. A reason change while still held
    re-emits `hold(true)`, which is idempotent on the mute path.
  - Disconnected: "No active call — waiting for a video interaction" vs
    "Call ended — video has been disconnected" (`lastCallEnded`, set only
    when a call was actually active).
  - Connecting: the current step is shown under the spinner (checking
    camera → signing in → checking call state → locating the call →
    starting camera → joining video).
  - Video restored on unhold: a toast "Video restored — the customer can
    see you" fires only when the un-mute was **confirmed**.
- **Bootstrap classification** (`failBootstrap`, logged as
  `failsafe/bootstrap-failed`): `NOT_LAUNCHED_FROM_GENESYS` (no token or
  state), `GENESYS_SIGN_IN_FAILED` (OAuth error in the fragment, or a
  401/403 from the API), `GENESYS_CONNECTION_FAILED` (any other init
  failure), `MISSING_CONFIG` (launch state or `pexipNode` incomplete — the
  latter was a silent return before).
- **Connecting watchdog**: each step gets 20 s; after that a "Still
  connecting — stuck at: <step>" pane with a Reload button replaces the
  spinner and `failsafe/connecting-stalled` is logged.

**Deferred**: a dedicated *conference* (consult → join-all) pane. Its event
shape has not been captured (runbook S3.5); hold text may be wrong in that
state until it is.

**Verification (2026-09-03).** The customer endpoint was unreachable from
the dev machine (different LAN), so the live S-scenarios could not be run.
Two substitutes were added and both pass:

- `src/App.replay.test.tsx` — REAL recorded Genesys snapshots (sanitized by
  `tools/lab/extract-replay-fixtures.cjs` into
  `src/genesys/__fixtures__/replay-snapshots.json`) pushed through the real
  `genesysService` and `App`: hold → pane + `muteVideo(true)`; unhold →
  settle window honoured, pane gone, `muteVideo(false)`, restore toast;
  mic-mute/unmute → no pane, no banner, `muteVideo` never called; consult →
  "Consulting — customer on hold" + mute; consult cancel → restore + toast;
  customer hang-up → "Call ended" + `disconnectAll`.
- `tools/lab/bootstrap-check.cjs` — real browser against the dev server:
  direct open, OAuth error fragment, bogus token (live 401 from Genesys),
  missing Pexip config, hung Genesys API (the SDK's 16 s Axios timeout wins
  and lands in the connection-failed panel — the 20 s watchdog is the
  backstop for steps with no SDK timeout, e.g. camera enumeration, which is
  the case it is tested with), and a real-token control on a finished
  conversation (sign-in → call-state check → "No active call" pane).

Still to run live when on the lab network: `lab scenario S2.1 --video`
(hold pane text + toast, now recorded in `app-state-*` via `pane`),
`S2.5`/`S2.6` (mic-mute is mic-only on the wire), `S3.1` (consult wording).

**Follow-ups (2026-09-03, same session):**

- Self-view PiP now defaults to horizontally centred over the main video
  (`src/selfview/SelfView.scss`) — Genesys' minimal/wide layout covered the
  old top-right anchor. Still draggable.
- Screen share (`src/App.tsx`, `displayCaptureOptions`): the picker is
  Chrome's, not Pexip's. The page now pre-selects the "Chrome Tab" pane
  (`displaySurface: 'browser'`) and removes "Entire screen"
  (`monitorTypeSurfaces: 'exclude'`, Chrome 119+). "Window" cannot be
  removed from a web page; to restrict agents to tabs only, push the Chrome
  enterprise policy `TabCaptureAllowedByOrigins` for the widget origin.
- Restore toast moved bottom-centre in a solid box (was unreadable over the
  VMR's burned-in name overlay); verified live, S6.1 `19-07-49`.

## 12. One video leg per agent per call (2026-09-08)

**Field report.** Inbound call rings; the widget auto-opens and shows "No
active call". The agent misses the alert, goes available again, the call
re-alerts; on answer the agent appears TWICE in the video call. Two misses,
three copies. Later the same day: the customer's Cisco room dropped when
the agent answered, and a hang-up left the room up.

**Root cause (lab S7.4, on the wire).** ONE widget instance issued two
Pexip `request_token` calls 0.6 s apart. `initConference` was re-entrant:
its in-progress flag was released right after the token call, before the
hold settle, and the connect listener's state check read a stale closure,
so the burst of connect-shaped Genesys snapshots at answer time started a
second join, whose client object replaced the first and orphaned its leg.
Every extra event in that window = one more leg.

**Design (after a structure review the same day).**

1. *Service fires connect on the transition only.* `callsCallback` keeps a
   `connectedState` and calls the connect listener on false → true, like
   the hold/mute/alerting listeners already did. `getMyCallState()` reads
   active / alerting / held / muted from ONE conversation fetch;
   `isCallActive`, `isHeld`, `isMuted`, `fetchCurrentCallState` are thin
   wrappers.
2. *One phase, one guard.* `phaseRef` ∈ idle | joining | active | passive
   replaces the in-progress flag, the active-call ref and the superseded
   flags. `initConference` is the single writer: it moves idle → joining
   synchronously and back in a `finally`; event handlers test the phase.
3. *Election before joining* (`src/call/videoLegLock.ts`). All widget
   instances for a call share an origin in one browser (Genesys preloads
   one iframe for the alert and renders another for the tool; reloads and
   second tabs add more). A Web Lock `pexip-video:<conversation>:<user>`
   is taken with `ifAvailable` before the camera is opened: the holder
   joins, the others go passive. The lock releases itself when an iframe
   unloads or crashes. "Use this window for video" (and the automatic
   takeover below) steals the lock; the previous holder learns it through
   `lost`, disconnects its own leg and goes passive. Browsers without the
   API behave as the sole instance.
4. *Identity travels in the call tag* (`src/call/legIdentity.ts`). The join
   sends `genesys-user:<id>;conv:<conversation>;instance:<uuid>`; Infinity
   echoes it on every roster participant (`rawData.call_tag`), so a SIP
   room named like the agent can never be mistaken for one of its legs.
   `ghostLegsOfMine` = my legs older than mine (a reloaded or crashed
   widget's leftover, F-08; the management API is not available to the
   client) — kicked after the join and on roster events, in parallel, with
   an in-flight set. Takeover kicks every other leg of mine. "Older only"
   keeps two different browsers from ping-ponging.
5. *Passive means passive.* A passive instance never calls `disconnectAll`
   (that destroys the ephemeral VMR) and ignores connect events. Infinity
   removing this leg while the Genesys call is active → passive (kicked)
   or one automatic rejoin after 1.5 s (network drop), then passive.
6. *The visible window wins.* `useWidgetVisibility` (page visibility +
   IntersectionObserver on the widget element, which works cross-origin)
   drives one automatic takeover per call, 2 s after losing the leg.
   While that is pending the pane is a plain spinner, "Connecting video in
   this window" (agents see it for a split second at most); a hidden
   window shows "Video is running in another window" with the button.
7. *Teardown counts counterparties.* `remainingCounterparties` = video/api
   participants that are not this agent; the call ends when none remain,
   and my own legs leaving (a ghost kick) never triggers it. The old
   "exactly one participant left" rule never fired with a duplicate in the
   room (customer hang-up is only visible on this roster, F-24).
8. *Alerting pane.* Genesys loads the widget while the leg is still
   ringing: `idleReason` = alerting shows "Incoming call — answer the call
   in Genesys to start video" instead of "No active call". One
   `idleReason` (none | alerting | ended | another-window) selects the
   Disconnected pane through a single switch; panes share `StatePane`.

**Diagnostics.** Structured console lines (category/event): lifecycle
`join-suppressed` (reason = phase), `leg-owned-elsewhere`, `passive`,
`auto-takeover`; pexip `ghost-leg-kicked` (status); failsafe `leg-kicked`,
`leg-dropped`. The widget shows its build stamp bottom-left (vite
`define`), because Pages caches index.html for ten minutes.

**Not in this change.** Channel reuse across instances (each instance still
burns a notification channel, F-22 budget); keepalive transport for the
unload disconnect; the same agent on two different machines (ghost kick
covers it only newest-wins).

**Validation.** Unit: `legIdentity.test.ts`, `videoLegLock.test.ts`
(fake LockManager), App tests "Video leg ownership" (burst join = one
token request, call tag, ghost kick after join and on late roster,
hang-up with ghost present, own ghost leaving, election lost hidden →
button → steal, election lost visible → automatic takeover, kicked →
passive, network drop → one rejoin, incoming-call pane). Live (harness,
Pages build, alias 31101): S2.1, S6.1, S7.1 (miss-then-answer through
the real embedded widget), S7.2 (reload: ghost gone at +4 s), S7.3 (two
instances), S7.4 (connect-event burst: one `request_token`,
`join-suppressed`, VMR gone after agent hang-up). Details and the
day's intermediate builds are in lab-findings F-26.

## 13. Docked self-view: one control, one meaning (2026-09-08)

**Problem.** The library self-view (draggable, foldable) mixed two states:
wire mute (toolbar camera button) and fold (chevron / pill). Muting folded
the self-view as a side effect, the pill's camera icon could only unmute,
expanding the pill while muted did nothing visible, and every fold or
unfold made the library re-anchor the element to a corner. We also passed
`isSidePanelVisible`, so the library kept pushing the element right of an
imaginary side panel, and our stylesheet fought its inline positions. On
hold the whole block unmounted, resetting position and fold state. For a
call-centre agent the risk is real: "hide self-view" reads as "camera off".

**Design.** What the mainstream clients do, minus the parts that confuse:
- One control: the toolbar camera button. There is no hide, fold or drag.
- The self-view is pinned at the top centre of the main window (the
  position chosen on 2026-09-04), sized by the widget width (clamp
  112–200 px), mirrored, with the caption "Customer can see you". The
  toolbar is unchanged.
- Camera off keeps the same footprint: dark tile, the same crossed-camera
  glyph as the toolbar button, "Camera off / Customer can't see you". On
  hold: "Video muted / On hold".
- The self-view stays mounted through hold; the toolbar shows only while
  connected, as before.

`src/selfview/SelfView.tsx` is now ~50 lines with no library dependency
beyond `Video`/`Icon`; the icon-token CSS hack is gone. `tools/preview/`
renders the in-call layout on the dev server for visual checks
(`node tools/preview/shoot.cjs <outdir>` screenshots 3 sizes × on/off/hold).

## 14. Outbound dynamic VMR, audio first (2026-09-09, code complete, lab pending)

**Model.** The inbound rendezvous trick pointed the other way. The agent
dials the branch device itself — `30005@genesys.pexsupport.com`, the same
number the Genesys number plan routes — over the BYOC trunk. An additive
branch in the Infinity local policy (customer configuration, kept on the
management node; shape in §14.1) mints a room named after that dialed
alias and dials the registered device into it as an automatic participant.
The widget derives the same room name from the outbound conversation's
dialed address and joins it video-only. Audio stays in-band over the trunk
exactly as inbound, so Genesys keeps recording. This supersedes the
2026-08-31 "audio-less VMR dial while audio stays on a direct Genesys
call" sketch: same branches-only scope, cleaner topology.

The room name is the dialed alias, with no prefix. `OUT_ALIAS_PREFIX`
survives in the code only so a dial plan that prefixes (`out_30005`) still
resolves to the same device.

**Two-stage gate.** Stage 1 is the existing connect event (the far end
"connects" as soon as Pexip answers the trunk — it proves nothing about
the device). Stage 2: after the video-muted join the widget waits for the
device in the roster (`isDeviceInRoster`, exact local-part match, SIP
legs only). If absent it dials the device once itself — the policy's
automatic participant fires only when the room is CREATED, so a callback
into a branch-keyed room that still exists needs the widget's dial
(decision §7.1's idempotent escalation). No device within 15 s (under the
20 s connecting watchdog) → the widget leaves its own leg, keeps the
audio call and the room, and shows `DEVICE_NO_ANSWER` with Retry.

**Code.** `constants/Outbound.ts`, `call/outboundAlias.ts` (scheme,
domain and `;params` stripped — Genesys appends `;language=en-US` on the
trunk), `call/deviceRoster.ts`, `GenesysRole.USER/EXTERNAL` +
`isAgentPurpose`/`isFarEndPurpose` in `legSelection.ts` (outbound
personal calls use `user`/`external`; with `callFromQueueId` they are
`agent`/`customer` — both handled everywhere), `fetchOutboundAlias` in
the service, and the join path in App (`waitForDevice`,
`leaveWithoutVideo`). The join no longer sets the Connected UI itself;
`settleVideoAgainstCallState` does, after the gate. The dead "generate a
random alias for dial-out" block is gone.

**VALIDATED LIVE 2026-09-10** (lab-findings F-28): agent dials
`30005@genesys.pexsupport.com` from the workspace; room `30005` holds the
widget's WebRTC leg, the branch Cisco and the Genesys trunk, video at
4128/3381 on both video legs and 64k audio on the trunk. Two widget bugs
were found and fixed on the way: the dialed address is the far end's OWN
address (`calls[].self`, not `other`), and the room name is the dialed
alias itself (no prefix). Still to exercise: callback re-dial into an
existing room, device-no-answer timeout, and teardown on hang-up.

### 14.1 The Infinity policy branch this relies on

Not in this repo: the local policy is customer configuration (service PINs,
trunk numbers, node hostnames). Shape of the addition — two `elif` branches
above the policy's final reject, plus a declaration beside the existing
`pex_local_alias` extraction:

- **Declaration.** For a dialed alias in the branch-device range
  (30000-30999), remember the device alias and the room name. The room is
  named after the DIALED alias.
- **Trunk/endpoint branch** (`protocol != "api"`): return a conference with
  that name, tag `Genesys-Outbound-VMR`, the agent PIN, and one automatic
  participant dialing `<device>@<pexip domain>` as a guest over SIP with
  `routing_rule`.
- **Widget branch** (`protocol == "api"`): the same conference name with no
  automatic participants, so the client-API join lands in the room the
  trunk call created.

Naming the room after the device does not trap the room's own dial to that
device: automatic participants are routed by the call routing rules, not by
the service policy (validated 2026-09-10, F-28).

## 15. Support diagnostics in the browser (2026-09-10)

**Problem.** Field reports arrived as "video didn't follow state" with no
evidence, and reproducing them meant asking someone to save a browser
console full of Genesys noise. The widget logged to the console only and
kept nothing.

**Constraint (decided by Josh).** Nothing may be stored on the Pexip side.
No collector, no shipping, no external data flow — a credit union with
~500 agents. Diagnostics must be local and agent-supplied.

**Design.** Two levels, both in the browser.
- *Normal, always on.* A storage sink beside the console sink keeps a
  rolling log in localStorage, newest 500 entries per widget instance and
  newest 6 instances. localStorage is shared across the widget's iframes
  on the origin, so the log survives Genesys recreating the widget between
  interactions and one export carries every instance. The Logger gained a
  level threshold; normal drops `debug`.
- *Verbose, turned on for an investigation.* Sets the threshold to `debug`
  and switches the existing Genesys event capture on at runtime (it was
  build-flag only, and its dev-server POST now fires only for the dev
  flag). Persisted in localStorage so it survives the reload that applies
  it; `&debug=1` on the widget URL forces it on.

**Export.** Clicking the build stamp opens a support panel: build, call,
entry count, the verbose toggle, and Copy / Download / Clear. Copy is
primary because the Genesys iframe sandbox may block downloads; a
read-only, pre-selected text box is the guaranteed fallback.

**What is never in the file:** access tokens, PINs, or the query string.
The logger strips secret-shaped keys before storing, and the page is
recorded as origin plus path.

**Not built (deliberately):** remote log shipping, and writing breadcrumbs
into Genesys participant attributes. Both remain open options; the entry
format is designed so shipping would be a sink swap.

Agent-facing procedure: `docs/support-diagnostics.md`.
