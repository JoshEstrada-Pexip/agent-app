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

### F-26 · Field bug: every widget instance joins the VMR — missed alerts multiply the agent (2026-09-08)

Reported by the user from a real environment: alert missed once → agent in
the video call twice on answer; missed twice → three times. Code analysis
(see fixes.md §12): each widget instance Genesys loads is a fully armed
listener from boot, including instances opened while the call was only
alerting ("No active call" pane); the connect event is delivered to every
instance's channel and each joins. No cross-instance dedupe existed.
Corollary found in the same pass: with a duplicate agent leg present the
customer hang-up rule ("one video/api participant left") never fires, so
the VMR outlives the call. Related: F-08 (unload ghost leg), F-22 (double
load → double join, channel cap), F-23 (workspace-hosted widget = second
leg), F-24 (hang-up only visible on the Infinity roster).
Unverified: exact Genesys iframe lifecycle on miss/re-alert; the
`disconnectType` of an ACD alert timeout; whether raw participant events
carry `call_tag`. Harness scenarios S7.1–S7.3 cover these (UNVALIDATED).

**Live results 2026-09-08 (Pages build 19:00Z+, alias 31101):**
- S7.2 reload mid-call: 2 legs at +2 s, 1 leg at +4 s; the new instance's
  kick returned 200 (`S7_2-2026-09-08T19-12-30-069Z`, s72-summary.json).
- S7.3 two instances: the older instance was evicted ~0.3 s after the
  second joined and showed "Video is running in another window"; customer
  hang-up → survivor "Call ended", run VMR gone
  (`S7_3-2026-09-08T19-14-51-877Z`).
- S7.1 miss-then-answer through the REAL embedded workspace widget: during
  alert 1 the widget showed "Incoming call"; Genesys REMOVED the widget
  iframe when the first leg ended (`widgets-after-miss: []`) and created a
  new one for the re-alert; after answer: 1 agent leg, 1 widget instance,
  clean teardown (`S7_1-2026-09-08T19-18-29-913Z`). Note: in this org the
  alert did not time out within 120 s; the first leg ended (disconnectType
  `client`, straight to terminated) only when A1 was put back on queue.
  The N+1 duplication the user sees in the field therefore needs the
  missed leg to stay `disconnected` (wrap-up pending) so the first widget
  instance survives — an org-config difference the lab cannot reproduce
  (see F-18). The eviction rule does not depend on it.
- First attempt at the fix (build 18:53Z) LOOPED in the field: a kicked
  instance read "video leg lost" (SDK roster already cleared), showed
  "Call ended", and rejoined on the next Genesys event → 3 legs churning.
  Fixed in 19:00Z by keying on Infinity's "Disconnected by another
  participant" reason and keeping the last roster view.

**F-26 ROOT CAUSE (20:46, `S7_4-2026-09-08T20-45-39-076Z`):** one widget
instance, two `request_token` POSTs 0.6 s apart (participants fb8d620f and
110ac64a), second client replaced the first → orphaned leg, then the SDK
raised "Could not execute critical network action" on the orphan and the
app's eviction/passive logic fought its own ghost; agent hang-up left the
VMR up (the user's "stuck call"). Cause: re-entrant `initConference`
(flag released after the token call; stale `connectionState` closure in
the connect listener). Fixed in build 20:49Z; re-run
`S7_4-2026-09-08T20-50-xx`: 1 token request, `join-suppressed` at the
second connect event, VMR gone after agent hang-up. Harness: S7.4 flow
(embedded widget, tool-click probe, AGENT-side hang-up) added; Pexip
mgmt `command` API returns 401 for this OAuth client (clearAll needs a
role with command permission), so ghosts still wait for the media
timeout.

**Restructure + final validation (21:20–21:30 build):** after a four-angle
structure review the fix was rebuilt around a Web Lock election before
joining and call-tag identity (fixes.md §12, final form). Live on the
21:20Z build: S7.4 — 1 `request_token`, `join-suppressed` on the burst,
1 leg / 1 frame at every probe, VMR gone after agent hang-up; S7.2 —
1 leg at every sample after the reload. Batch 1 on 21:02Z: S2.1, S7.2,
S6.1 PASS. **Channel cap reached:** the suite counted 32 notification
channels for A1 today (cap 20/user/app/24 h, F-22); live results after
~21:20 may miss Genesys events. Next live sweep after the 24 h expiry.
Harness: S7.4 second end-of-call snapshot produced a 405 `disconnectAll`
on the torn-down client — guarded in the app (only the owning instance
talks to Infinity in onEndCall).

### F-27 · Outbound lab facts (2026-09-09)

- **Branch device registered.** `30005@genesys.pexsupport.com` is registered
  on pexsupport (Cisco Room Kit, SIP username `arizonaroomkit`, display
  name "Arizona Rooms Kit", registered 17:15 UTC). Auto-answer was OFF and
  was turned **ON** for the outbound tests (production branches run
  auto-answer, so this matches the field).
- **An API-placed outbound call cannot be answered in the lab.**
  `POST /api/v2/conversations/calls` with
  `sip:out_30005@pex-simon-conf1.genesys.pexsupport.com` is ACCEPTED and
  creates a conversation, but the agent's own leg never becomes an
  answerable interaction: the workspace shows "No active conversations"
  and after 60 s the leg ends `terminated / error` with
  `error.ininedgecontrol.connection.timeout` ("Call Connection Timeout").
  The far-end participant is never created, so nothing reaches the trunk
  and nothing reaches Pexip. Re-confirms the 2026-08-31 probe note.
- **Cause is the station, not the app.** `GET /api/v2/stations/<id>` for
  "RBFCU - JE AI Agent 01" (`inin_webrtc_softphone`) shows
  `webRtcPersistentEnabled: false`. Without a persistent connection every
  call needs a manual answer that only the real workspace UI offers.
  Enabling persistent connection on that phone would make outbound
  scenarios automatable like the inbound ones.
- **Tool.** `node tools/lab/outbound-vmr-test.cjs [--dest …]` places and
  observes the call; `--watch [--minutes N]` opens the lab-profile
  workspace, waits for a human-dialed call, then snapshots Genesys legs,
  the Infinity room + participants + media streams, and the codec, and
  writes `verdict.json` (routedToPexip / deviceDialed / farEndState).
  `cisco.accept()` was added for codecs without auto-answer.

### F-28 · OUTBOUND VALIDATED END TO END (2026-09-10 02:11)

Agent dialed `30005@genesys.pexsupport.com` from the Genesys workspace
"Make Call" dialog (queue RBFCU-Auto-Loans selected). All three legs met
in one room, `30005` (tag Genesys-Agent-VMR, Josh's policy variant names
the room after the dialed alias):

| leg | protocol | role | tx/rx |
|---|---|---|---|
| JE- AI Agent 01 (widget) | WebRTC | chair | 4128 / 3381 |
| 30005 Branch device (Cisco) | SIP | chair | 4128 / 3381 |
| RBFCU Genesys (trunk) | SIP | guest | 64 / 64 |

Genesys side: `agent:connected` and `customer:connected -> sip:30005@
genesys.pexsupport.com;language=en-US`. Audio stays in-band on the trunk
(64k) exactly as inbound; video is peer-to-peer inside the VMR.

Evidence: `tools/lab/runs/outbound-vmr-2026-09-10T02-10-19-638Z/`.

**What it took (each was a real defect or lab fact):**
1. Trunk routing for SIP URIs works — Aug 31's open question. ANI on the
   far leg is `sip:genesys@rbfcu.byoc.usw2.pure.cloud`.
2. Policy branch for the branch-device range mints the room and dials the
   device (policy is customer config, not in the repo; shape in fixes.md
   §14.1). Naming the room after
   the device does NOT break the room's own dial to that device.
3. Widget bug 1: the dialed address is the far end's OWN address
   (`calls[].self`), not `other`. Reading `other` made the widget fall back
   to the inbound ANI path and request `app_RBFCU Genesys` → 404.
4. Widget bug 2 (earlier): the room name is the dialed alias, not
   `out_<device>`; deriving a prefix joined a second, empty room.
5. The widget loads while the agent leg is still `contacting`, so the join
   is driven by the connect event, not by bootstrap.
6. GitHub Pages caches index.html: the widget kept running an older bundle
   until the widget URL's query string was changed. Always bust it.

**Lab facts that block automation (not app bugs):**
- An API-placed outbound call (`POST /conversations/calls`, with or without
  `callFromQueueId`, agent On Queue, acdAutoAnswer on) never becomes an
  answerable interaction on the Playwright-hosted station: it ends
  `terminated / error`, `error.ininedgecontrol.connection.timeout`.
  `webRtcPersistentEnabled` is false on that station; enabling persistent
  connection is the fix if outbound scenarios should run unattended.
- The org's UI token rate limit (`ui.token.rate.per.minute` = 300) was hit
  during rapid repeat testing; Genesys returned 429 to the workspace and
  its gadgets. The widget shares that budget — space out test calls.

### F-29 · Callback identity: the branch ANI needs a Genesys number plan (2026-09-10)

The agent workspace "Callback" button was unusable on branch calls. This
took three org-config steps and produced one finding worth keeping: the
inbound VMR rendezvous and the callback identity read DIFFERENT fields,
which is why they broke and were fixed independently.

**Two fields, two purposes.**

| field | used by | value on a branch call |
|---|---|---|
| `participant.aniName` | widget, to build the join alias | `31101_<hex>` (SIP display name) |
| `participant` ANI address | Genesys, for the callback button | `tel:30005` |

`fetchAniName()` reads `aniName`, the SIP *display name*, never the ANI
address. That is why changing the policy's `local_alias` (the address)
could break the callback path without touching inbound video, and why
`ani=unknown` degraded callback while calls still connected normally.
Do not "simplify" these two into one lookup.

**Step 1 — the policy stops appending the queue.** `local_alias` was
emitting `30005_31101@<domain>`, which Genesys cannot normalize, so the
callback dialed a nonexistent address. Changing it to the bare
`30005@<domain>` made Genesys normalize the ANI to `tel:30005`. See
fixes.md §14.2 for the app-side guard this required.

**Step 2 — a number plan to classify the branch range.** `tel:30005`
was still undialable: it fell through to the org's pre-existing
"Extension" plan, which has NO outbound route, so callback failed with
"No outbound route was found matching the classification Extension".

Plan `Branch Video`, placed at the TOP of the list (plans evaluate
top-to-bottom, so it must sit above `Extension`):

| field | value |
|---|---|
| Match type | Regular expression |
| Match expression | `^(30\d{3})$` |
| Normalized number expression | `$1` |
| Classification | `Branch Video` (new value, not International) |

Outbound route `Branch Video`, classification `Branch Video`, external
trunk `RBFCU Pexip Infinity - Simon's Lab`.

**The trap that cost a round trip.** The regex was first written
`^30\d{3}$` with NO capture group while the normalized expression was
`$1`. `$1` resolved to empty, so the plan matched the inbound ANI,
produced an empty normalized number, and Genesys recorded
`ani=unknown` on EVERY branch call. Number plans normalize inbound ANI,
not just outbound dialing — a broken plan corrupts caller ID org-wide.
Symptom in the analytics record, with the fix saved between 23:23 and
23:39 UTC:

```
23:13 / 23:21 / 23:23  inbound   ani=tel:30005     (policy fixed, no plan yet)
23:25                  outbound  dnis=tel:30005    (first working callback)
23:39 / 23:41 / 23:42  inbound   ani=unknown       (plan live, $1 empty)
23:40                  outbound  dnis=sip:unknown@localhost
```

That 23:40 leg is the callback button dialing the literal string
`unknown`. Treat `sip:unknown@localhost` as the signature of a number
plan whose normalized expression yields nothing.

**Verifying.** Site → Simulate call is authoritative and needs no live
call. Success names the plan, the classification and the route:

```
Match found. Number plan name "Branch Video", classification "Branch Video", new URI "30005".
Match found. Outbound route name "Branch Video".
External trunk information successfully received.
```

Two lines in that output look like failures and are not. "The number
30005 is not an assigned DID or Extension" is expected, since it is not
an internal Genesys extension. "This Site is not associated with an Edge
Group" with empty Sites and Edges is normal for a BYOC Cloud trunk,
which has no Edges in the media path.

**`tel:` in the caller ID is correct, not a defect.** Genesys stores
every resolved address as a URI and stamps `tel:` on anything it has
normalized to a phone number. The simulate log shows the platform adding
it before plan matching and stripping it again to match, so no plan field
controls it. `tel:` is precisely what makes the address eligible for
number-plan and outbound-route evaluation, i.e. what makes callback work.
The scheme leaking into the agent's Interaction Details pane is that
pane's raw rendering; it is not our widget, which never displays caller
ID.

**Lab tooling note.** The number plan config is NOT readable with the
lab's agent token: `GET /telephony/providers/edges/numberplans` returns
403 `missing.any.permissions [telephony:plugin:all]`. Diagnose from
`POST /analytics/conversations/details/query` (the ANI/DNIS per session)
plus the Simulate call tab instead.

### F-29 addendum · Dial the bare number, not the URI (2026-09-10)

Two follow-ups once the plan and route were live.

**The External Contact carried the wrong number.** The workspace callback
dials whatever the matched External Contact holds, not the raw ANI. That
record still had the old suffixed form, so callback kept failing after the
routing was correct. Changing the contact's number to `30005` fixed it.
When the ANI format changes, the External Contact has to change with it.

**A full SIP URI is NOT dialable, and this is expected.** From the Calls
panel, "New Phone Call" with `30005@genesys.pexsupport.com` fails:

```
seg dialing error error.ininedgecontrol.connection.dialplan.notReachable
```

The workspace sends it as `sip:30005@genesys.pexsupport.com;language=en-US`.
The Branch Video plan's expression is anchored to exactly five digits, so
an address still carrying `@domain` matches no plan, gets no
classification, and therefore no route. The bare `30005` matches, becomes
`tel:30005`, and routes. Note this INVERTS the pre-plan behaviour recorded
in F-28, where the URI form was the one that worked.

Dial the bare number. If the URI form is ever needed, it takes a second
plan above Inbound SIP URI, classification `Branch Video` so it reuses the
existing route, matching `^(30\d{3})@genesys\.pexsupport\.com(;.*)?$` with
normalized `$1`.

**Reading the failures.** `dialplan.notReachable` fires within a
millisecond of the dialing segment and means no outbound route was
selected. It is a Genesys routing decision, never a trunk or Pexip
problem, and the analytics detail query shows it directly:
`POST /analytics/conversations/details/query`, then read each session's
`segments[].errorCode` alongside its `dnis`.
