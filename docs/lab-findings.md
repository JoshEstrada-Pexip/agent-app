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

### Environment notes

- OAuth client 2ee93707: implicit grant; redirect URI must match EXACTLY
  including trailing slash; scopes needed beyond defaults: `notifications`,
  `users:readonly`. MFA challenged once per session; silent afterwards.
- Policy admits the Cisco without DTMF PIN (PIN retained as harness fallback).
- Ring-through time dial→agent alert: ~20–25 s via Architect flow + queue.
