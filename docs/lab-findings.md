# Lab Findings Log

Append-only record of validated measurements and findings from harness runs
(`tools/lab/`). Each entry cites its evidence run directory (local,
`tools/lab/runs/`). Baselines here are what PR fixes must beat, re-measured
with the same scenarios after each change.

## 2026-08-28 — Environment validation & S2.1 baseline

### F-01 · Alias rendezvous confirmed working

Genesys reports the customer participant's `aniName` **equal to the Pexip VMR
name** (e.g. `31100_51b5193b`), so the app's join alias `app_` + aniName lands
in the correct conference. Verified live across multiple calls; the app joined
and exchanged video every run.
Evidence: sanity calls + every `S2_1-*` run (`pexip-after-video-join.json`).

### F-02 · Hold privacy window ≈ 2 seconds (nominal path WORKS, slowly)

Single clean hold: agent video (~290 kbps live) keeps transmitting for
~2 s after the hold command, then goes fully dark (0 kbps, frames frozen)
and stays dark; restores within ~3 s of unhold. Breakdown: **447 ms**
Genesys→app event delivery + **1 s** deliberate `setTimeout` in
`genesysService.callsCallback` + mute API round trip.
Implication: the field complaints do NOT come from the clean path — suspects
are flaps, event loss, silent mute failure, transfer/consult (next scenarios).
PR 1 target: window ≤ 0.7 s (remove the timer; mute-immediately).
Evidence: `S2_1-2026-08-28T19-16-39-409Z/webrtc-*.json` (bytesSent deltas),
`app-state-during-hold` (UI switched to on-hold pane at +2.4 s).

### F-03 · Original app attempts a conference join on EVERY hold/unhold event

Console records `"Conference connection already in progress, already
connected, or invalid parameters"` twice per hold and per unhold event — the
legacy connect-handler calls `initConference` on every steady-state `calls`
event and is saved only by its (fresh-closure) guard. Live confirmation of the
review's R1 analysis: the rebuild's stale-closure version of this guard lets
the re-join actually happen.
Evidence: `S2_1-*/app-console.json`.

### F-04 · Agent legs accumulate rapidly in one conversation

A single test conversation accumulated **8 agent participant legs** (bounced
alerts + answers). Any `.find()` by user without state filtering reads a stale
leg. Confirms the stale-leg hazard class (anatomy §5) with production-like
data.
Evidence: sanity conversation 0b1e9da0 (analytics), 2026-08-28.

### F-05 · WebRTC-station answering requires the phone, not the API

`PATCH state=connected` is accepted (202) but never completes for a WebRTC
station with no hosted phone; ACD auto-answer works only when a browser hosts
the phone BEFORE the call arrives. Harness hosts the phone via Playwright
(`openPhoneHost`) pre-dial. Also: direct transfers/consults to a user are
non-ACD and will not auto-answer — S3/S4 must answer via UI/hosted phone or
route via queue.

### F-06 · Wrap-up requires an org code; UI-only completion is a trap

Org policy: "Wrapup code is required for non-provisional wrapup" — with no
codes defined, the API cannot complete wrap-up (only the UI could), blocking
automation and leaving agents stuck. Fixed by creating
`RBFCU_Automated_Testing01` and assigning to the queue; harness completes
wrap-up via `POST .../communications/{id}/wrapup` every teardown.

### F-07 · Pexip management API (v40) cannot report live video-mute state

Participant status has no video-mute field and `tx_bandwidth` is the
negotiated (static) rate; no media_stream status resource exists. Wire truth
therefore comes from the app's own WebRTC `getStats()` (outbound-rtp
bytesSent deltas), hooked via Playwright init script. (Cisco `xStatus
MediaChannels` remains the customer-side check.)

### F-08 · Ghost participants persist after unclean app exits

A killed app browser left a `media: False` WebRTC ghost leg in the VMR until
timeout — the same artifact class the rebuild's rejoin bug would create on
every unhold. Preflight now checks the roster before dialing.

### F-09 · Rapid hold/unhold flaps do NOT wedge the original app (API-paced)

S2.2: hold→unhold→hold→unhold back-to-back (8 raw events in ~750 ms), then
hold-again, then unhold. Every final state landed correct on the wire: live
after the flap (≈400 kbps), dark by +7 s of hold-again (0 kbps, same ~2–3 s
window as F-02), live again after final unhold. The original survives because
its 1 s timer reads the mutable hold flag at fire time — last write wins.
(The rebuild's unserialized async reconciles do NOT have this property — its
race remains a must-fix, R5.)
Evidence: `S2_2-2026-08-28T19-36-52-000Z/webrtc-*.json`.

### F-10 · Event bursts:each hold action emits TWO identical-flag snapshots; no loss at flap rate

The app received all 12 raw WS events of the flap sequence — each hold/unhold
produced a duplicate pair (`H,H` then `-,-`). No event loss at this rate
(completeness verified: app capture ⊇ 1 s-poll API timeline). Any future
dedup/serialization logic must expect duplicate-flag bursts within ~150 ms.
Evidence: same run, `app-capture.json` vs `genesys-timeline.json`.

### F-11 · Audio mute leaves agent video fully live (policy decision data)

S2.5: during a Genesys audio mute the agent's video keeps streaming at full
rate (~390 kbps) for the entire mute — muted agents are fully visible today.
This is the "nose-pick" scenario; the rebuild's audioMuted→videoMuted
coupling (review §4 policy decision) would change this behavior. Stakeholders
now have the measured baseline for that decision.
Evidence: `S2_5-2026-08-28T19-57-37-213Z/webrtc-*.json`.

### F-12 · Hold works correctly while audio-muted; video returns still-muted

S2.6: mute → hold → unhold → unmute. Video went dark on hold (same ~2 s
window) and RETURNED on unhold while the agent was still audio-muted
(279 kbps) — the original's mute-event suppression while held
(`if (!onHoldState)`) causes no video misbehavior. Also confirms: an
audio-muted agent becomes visible again after hold resume (same policy
consideration as F-11).
Evidence: `S2_6-2026-08-28T19-59-59-200Z/webrtc-*.json`.

### F-13 · Consult-initiate/cancel handled correctly by the original

S3.1: consult started toward A2 (never answered), canceled 6 s later. Video
went dark by +6 s of consult-start (same ~2–3 s window) despite the
`held=false` flap — the consult-topology override works; video restored fully
after cancel. The captured raw event sequence (consultParticipantId,
consultInitiator, flap ordering) fills the anatomy doc's "capture needed" row
for consult-cancel and is fixture material for replay tests.
API note: consult/POST must target the CUSTOMER participant (the consultation
subject), not the agent's own leg ("not.a.participant" otherwise).
Evidence: `S3_1-2026-08-28T20-18-20-942Z/`.

### F-14 · RETRACTED (2026-08-28): "empty participants events" were heartbeats

Initial analysis reported `participants: []` snapshots reaching the app during
transfers. Re-examination shows those frames were `channel.metadata`
HEARTBEATS — a different topic that never reaches `callsCallback`. No live
evidence exists of an empty conversation snapshot. The code-level hazard
(anatomy probe E: an empty/customer-less snapshot triggers `disconnectAll`)
remains a real code path but is downgraded back to unobserved. Lesson encoded
in tooling: capture analysis must filter `topicName` to `conversations.calls`.

### F-15 · After transferring away, A1's app re-enters Connected UI with camera ON

Post-transfer (leg disconnected, zero outbound video), trailing hold-state
evaluation flips the UI back to the Connected view and re-acquires the camera:
selfview live, camera light on, no call. Agent-facing state lie + camera
privacy issue; the app has no "is a call active" gate on its event handlers
(original-app equivalent of review finding R4).
Evidence: `S3_2-2026-08-28T22-56-*` (`app-state-after-complete` selfview:true
vs `webrtc-after-complete-5s` no sender).

### F-16 · disconnectType is unstable across snapshots and has unmodeled values

The same agent leg reported `disconnected/transfer` → `disconnected/peer` →
`terminated/peer` across ~200 ms; a no-answer consult produced
`transfer.noanswer` (matches no constant in either codebase — `=== 'transfer'`
misses it). Consults rolling to voicemail add a `voicemail` purpose
participant. Disconnect classification must be tolerant (prefix/category
match, last-write-wins), never single-exact-value.
Evidence: both S3_2 runs, app-capture.json.

### F-17 · Post-disconnect mute call throws (captured twice)

After the app's leg disconnects, a trailing Genesys mute evaluation calls
`infinityClient.mute()` on the dead client → "Request 'mute' threw an Error".
Harmless-looking console noise today, but it is the same no-active-call-gate
defect as F-15.

### F-18 · Transfer-back round-trip WORKS via API; stale-leg window did not materialize

S4.2 (blind transfer A1→A2, transfer back with A1 wrap-up deliberately open):
teardown on transfer-away was clean (video sender gone, app showed
no-active-call — the F-15 ghost UI is CONSULT-specific), and on return A1's
app re-joined and restored live video (~400 kbps) within seconds. Decisive
sub-finding: in this org the old agent leg goes **straight to `terminated`
even with wrapupRequired still true** — the hypothesized wrap-up window
holding legs in `disconnected` (the stale-leg trigger, anatomy §5) does NOT
occur for API-driven transfers. Probes A/B/D remain code-level hazards
contingent on a lingering `disconnected` leg, which we could not reproduce.
Field-bug suspect list narrows to: consult-complete ghost UI (F-15), no
automatic video for the receiving agent post-transfer (S3.2), UI-clicked
transfer sequencing (S0), reload-into-call after transfer (weak isCallActive
predicate), and WS event loss (S5.1).
Harness notes: `replace` targets the agent's own leg while `consult` targets
the customer participant; answer clicks must be verified by call state, not
click success; agent legs must be answered in Agent Workspace view.
Evidence: `S4_2-2026-08-28T23-47-58-683Z/` (webrtc samples, leg inventory,
Pexip roster).

### Design levers available for fixes (standing note)

We control the Pexip local policy and its dynamic VMR creation (policy script
by Simon Smith & Josh Estrada, on pex-simon-mgr). Fix options are therefore
NOT app-only. Candidate policy-side remedies mapped to findings: VMR lifetime
grace across transfers (ephemeral-VMR-gone class); role/PIN/host-wait tuning;
alias contract changes for a more deterministic rendezvous key than aniName;
layout/theme behavior when the agent slot is empty (customer-facing
experience during transfers, cf. receiving-agent-no-video). App/widget-side
remains the fix for auto-opening video on transferred interactions.

### F-19 · REPRODUCED: widget reload after transfer-back shows "No active call" on a live call

S4.6: transfer round-trip, agent live and connected, widget reloaded. The
bootstrap's `isCallActive` picks the FIRST agent leg with **no state filter**
(genesysService.ts:184-190) — post-transfer that leg is terminated — so the
app declared "No active call" while the agent was mid-call. It stayed dark
**18 s** until an unrelated conversation event arrived; the WS event path
(which filters `terminated`) then found the live leg and re-joined with
video. Rescue is entirely event-dependent: on a quiet call the widget stays
"No active call" indefinitely. This is the field complaint "after
transfer-back, video is lost and can't be reconnected," reproduced on tape
with the exact defective predicate identified. PR 1 fix: one shared
leg-selection (prefer connected, else newest non-terminated) across
isCallActive / getActiveAgent / event path.
Evidence: `S4_6-2026-08-29T00-04-31-721Z/` (app-state-after-reload
no-active-call at +15 s vs a1-genesys-state connected; capture session
00:05:35 shows the rescuing event at 05:53.755).

### F-19b · S3.3/S4.5 pass: consult-cancel and hold-after-return work

Answered consult canceled → video restored fully (393 kbps). Hold immediately
after transfer-back → dark on schedule, restored after unhold, correct with
3 accumulated agent legs. The event-path leg filtering holds up; the REST
predicates are the broken ones.

### F-20 · REPRODUCED: silent socket death = video streams through hold, forever

S5.1: notifications WebSocket closed (app has no onclose handling), then the
call was held. Genesys held correctly (API truth) — the app never heard it:
agent video streamed at ~390 kbps through the ENTIRE hold (sampled at +4/+10/
+20 s), UI stayed "Connected". With no reconnection logic the desync is
permanent until page reload. This is field complaint #1 ("customer staring at
an agent who believes they are muted/held") reproduced with wire evidence.
PR 1 minimal mitigation (user's fail-safe concept): ws.onclose/onerror →
IMMEDIATELY mute video + agent banner ("connection lost — video muted for
safety") + reconnect attempt; full reconnect/resubscribe hardening remains
PR 2. Control: S2.4 (reload on normal call) rejoins fine — F-19 is
transfer-specific.
Evidence: `S5_1-*/webrtc-*.json` vs `genesys-timeline.json`.

### Batch-A status notes

S4.3 PASS (wrap-up-completed control: return + video OK). S4.4 parked —
harness cannot yet answer A2's SECOND alert in one call (repeat-alert UI
quirk); double-transfer coverage moves to the human-clicked S0 session.
S2.7 pending a camera-button selector (toolbar screenshot captured).

### F-21 · Human-clicked UI actions produce IDENTICAL events to API calls (S0)

A 6-minute human-driven session (hold, mute, self-mute, transfer, answer,
second hold/mute cycle) produced the same event shapes, participant fields,
flags, and disconnectType values as every API-driven run. All API-based
findings (F-01..F-20) transfer to real agent behavior. Fidelity question
closed.
Evidence: `S0-2026-08-29T01-16-51-677Z/` + capture.jsonl 01:17–01:24.

### Decisions & open items from the human session (2026-08-29)

- **POLICY DECIDED (user):** Genesys audio-mute must ALWAYS also mute video.
  PR 1 includes the audioMuted→videoMuted coupling (F-11 is the before
  baseline).
- **Open item:** receiving agent (A2) appeared to have NO transfer-back
  control on a direct-transferred interaction — if confirmed, production
  transfer-backs travel other paths (re-queue/dial) with different event
  shapes. Investigate next session.
- **Fidelity upgrade queued:** manual sessions should instrument the REAL
  widget iframe in Agent Workspace (Playwright pierces it) instead of running
  the app as an extra tab, which risks double-joining the VMR next to the
  real widget.
- **Deliverable queued:** action→effect matrix (each button press × Genesys
  participants / VMR legs / mute states / widget UI) for the team docs.

### Environment notes

- OAuth client 2ee93707: implicit grant; redirect URI must match EXACTLY
  including trailing slash; scopes needed beyond defaults: `notifications`,
  `users:readonly`. MFA challenged once per session; silent afterwards.
- Policy admits the Cisco without DTMF PIN (PIN retained as harness fallback).
- Ring-through time dial→agent alert: ~20–25 s via Architect flow + queue.

### F-22 · REPRODUCED: silent notification-channel starvation — field complaint #2 mechanism

2026-08-31 evening (S1.1 runs 20:05 and 20:10): the app's notification
channel stops receiving call events entirely while looking perfectly
healthy. Channel created (200), topic subscription accepted (200), WebSocket
open, heartbeats arriving every 30 s — and yet ZERO conversation events
delivered. The customer hung up (REST truth: customer leg `terminated`);
the app never heard it and kept selfview+remote video mounted indefinitely.
Morning runs (18:01–18:13) on the identical build had events flowing
normally — 4 hold/unhold events delivered in S2.1 alone.

Two contributing factors observed:
- **Channel-cap saturation (prime suspect):** 47 distinct notification
  channels were created today against Genesys' 20-per-user-per-app cap
  (every page load creates one; reconnects and double-loads multiply it).
  Starvation began only after the cumulative count crossed the cap.
- **Double app load:** each evening run booted TWO full app instances
  (post-relogin auth redirect), each creating its own channel — and BOTH
  Pexip WebRTC legs joined the VMR (double-join confirmed in
  `pexip-after-video-join.json`: two "JE- AI Agent 01" legs).

Why this matters beyond the lab: this is the strongest mechanism yet for
field complaint #2 ("sometimes video doesn't follow state") — and it
**evades every PR-1 fail-safe**. The socket never closes (no `onclose`), and
heartbeats keep arriving, so neither the connection-loss mute nor heartbeat
monitoring would fire. Real agents reload their workspace all day; a fleet
of agents plausibly crosses the 20-channel cap in normal operation.

PR-2 requirement upgraded from nice-to-have to MUST: a call-state resync
watchdog — periodically compare local held/muted/active against REST truth
(`fetchCurrentCallState`) and reconcile, catching silent starvation
regardless of cause. Subscription verification after subscribe (GET the
channel's subscriptions) is a cheaper partial check.

Consequence for today: live validation of the customerLegGone guard (S1.1
customer-hangup teardown) is BLOCKED by this starvation — no event reaches
the app, so the guard's code path never runs at all (equally true of the
pre-guard code; the failure is orthogonal to the change). Guard behavior is
locked by unit tests against real event shapes. Retest live once channels
expire (24 h) or after confirming the cap theory with a harness-created
channel.
Evidence: `S1_1-2026-08-31T20-05-27-288Z/` and `S1_1-2026-08-31T20-10-08-378Z/`
(app-capture pages with heartbeat-only entries vs `genesys-timeline.json`
customer `terminated`), morning control `S2_1-2026-08-31T18-01-36-816Z/`.

### F-22 addendum · Probe verdict: lab-scoped exhaustion, NOT a Genesys platform issue

Decisive experiment (2026-08-31 20:27, `runs/channel-probe-2026-08-31/`):
a fresh channel created for the SAME user on the harness OAuth app (channel
pool count: 0) and subscribed to the SAME calls topic received every event
of a probe call instantly (alerting → disconnected → terminated, sub-second
latency) — at the same time the widget app's channels (47 created today,
over the 20-per-user-per-app cap) received zero. Genesys event publishing
for the user is healthy; the deafness is scoped to the widget app's
exhausted channel pool. Conclusion: lab-inflicted churn (per-user+app
channel cap, amplified by the double page load), no platform incident, no
org-wide effect. Production exposure reduces to a bounded question — can a
real agent's widget create >20 channels in 24 h? (one per video interaction
plus reloads; PR0's recorder will measure the real rate) — and the PR-2
resync watchdog covers the silent-deafness mode regardless of cause.
Genesys docs: developer.genesys.cloud/notificationsalerts/notifications/
("new channel replaces the oldest channel that does not have an active
connection"; channels expire after 24 hours).

### F-22 design note · PR-2 should REUSE channels, not create per load

Channels are unrelated to call lifecycle: created per widget load, no
delete API exists, they linger 24 h server-side. A per-interaction widget
therefore burns one channel per video call per agent toward the 20 cap.
PR-2 fix: on startup, GET /api/v2/notifications/channels and reuse the
newest existing channel (re-subscribe the calls topic) instead of always
POSTing a new one — Genesys allows a new WebSocket to take over an
existing channel (the old socket, already dead after a reload, is
disconnected). Burn drops to ~1 channel/agent/day; the cap becomes
unreachable. Caution: two LIVE widget instances must never share a
channel id (second socket kicks the first) — another reason the
double-load matters. Combined with the resync watchdog this closes F-22
end to end.

## 2026-09-03 — Agent-facing state panes, mic-only mute, live validation

### F-23 · Harness: the workspace tab hosts the PRODUCTION widget, which joins the VMR as a second agent leg

Every `--video` run opens the Genesys workspace (to host the agent's WebRTC
phone) and separately opens the app under test. The workspace auto-renders
the interaction widget for the selected call — the production build at
`https://joshestrada-pexip.github.io/agent-app/` — which joins the same VMR
as a second "JE- AI Agent 01" WebRTC leg (2 legs in
`pexip-after-video-join.json` on 2026-09-02 and in the first S6.1 run; 1 leg
in runs where the workspace had not selected the interaction yet). Fix:
`openPhoneHost` now blocks any `agent-app` URL that is not `APP_BASE` and
logs it (`[app] blocked embedded widget …`). Not an app defect, but see F-24
for the product consequence of two agent instances.
Evidence: `S6_1-2026-09-03T18-38-36-313Z/pexip-after-customer-hangup.json`
(2 WebRTC legs), `S6_1-2026-09-03T18-44-03-734Z` (1 leg after the block).

### F-24 · Customer hang-up ends the session ONLY via the Infinity roster; the Genesys "customer" leg is the Pexip trunk

When the customer (Cisco, SIP into Pexip) hangs up, the Genesys customer
participant does NOT change state — that leg is the Pexip→Genesys SIP trunk,
which lives as long as the VMR does. The app learns of the hang-up from
Infinity (`participant_delete`), then `checkIfDisconnect` → `onEndCall(true)`
→ `disconnectAll`, which tears down the VMR, which ends the trunk, which
finally terminates the Genesys customer leg (~2.5 s later). With ONE app
instance this works: "Call ended" pane at +1.4 s, `/disconnect` POST at
+1.0 s, VMR gone by teardown. With TWO agent instances (F-23, or an agent
with the widget open twice) the last-participant check sees 2 video legs
and never ends the call — video stays up until the agent hangs up. Product
risk to track; candidate fix: end on "no non-agent video participant left"
instead of "exactly one participant left".
Evidence: `S6_1-2026-09-03T18-38-36-313Z` (2 legs: no pane, customer
`connected` in Genesys until the harness disconnected the agent 17 s later)
vs `S6_1-2026-09-03T18-44-03-734Z` (1 leg: pane + teardown).

### F-25 · Headless Playwright is bounced to Genesys login/MFA; headed reuses the profile session

`scenario … --headless` sent the OAuth authorize to the login page
(`/#/authenticate-mfa`) even though the persistent profile is logged in;
the same profile headed went straight through. Use headed for `--video`.
Evidence: `S2_1-2026-09-03T18-28-25-122Z/app-network.json`.

### Live results for fixes #1 (mic-only mute) and #11 (state panes)

| Run | What | Result |
|-----|------|--------|
| S2.1 `S2_1-2026-09-03T18-31-09-302Z` | hold/unhold | pane "Call on hold" + "Your video is muted. The customer cannot see you." at +2 s; wire 407 kbps → 0 within 2 s of hold; 384 kbps at +6 s after unhold |
| S2.5 `S2_5-2026-09-03T18-33-41-462Z` | mic mute/unmute | no pane, no banner; wire 391/400 kbps through the mute; app logs `genesys/mic-muted` only, no `video-muted` |
| S3.1 `S3_1-2026-09-03T18-36-09-575Z` | consult start/cancel | pane "Consulting — customer on hold"; wire 0 kbps at +6 s; 377 kbps at +6 s after cancel |
| S6.1 `S6_1-2026-09-03T18-44-03-734Z` | panes + toast + customer hang-up | hold pane at +0.7 s; toast "Video restored — the customer can see you" at +1.4 s after unhold; mic mute live view untouched (388 kbps); "Call ended / Video has been disconnected." at +1.4 s after hang-up; VMR torn down |
