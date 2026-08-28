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

### Environment notes

- OAuth client 2ee93707: implicit grant; redirect URI must match EXACTLY
  including trailing slash; scopes needed beyond defaults: `notifications`,
  `users:readonly`. MFA challenged once per session; silent afterwards.
- Policy admits the Cisco without DTMF PIN (PIN retained as harness fallback).
- Ring-through time dial→agent alert: ~20–25 s via Architect flow + queue.
