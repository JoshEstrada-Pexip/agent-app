# Outbound redesign — review of the implementation brief

Reviewed 2026-08-31 against (a) the brief ("Agent-Originated Outbound Calls
with Pexip Video Escalation"), (b) the current outbound app
(`agent-branch-app`), and (c) everything this project has proven
empirically in `docs/lab-findings.md` (F-01..F-22). Verdict up front:

- **The brief's core architecture is right and validated.** Real outbound
  via `POST /api/v2/conversations/calls` from the agent's station, video as
  a Pexip overlay, Genesys as the only state machine. Adopt it.
- **Four corrections are required** before implementation — three come
  straight from this project's lab findings, one is a missing dependency.
- **`agent-branch-app`'s core flow should be retired**, with two of its
  components ported. Build the new outbound as a **mode of this app**
  (agent-app), sharing the hardened pr1 plumbing.

## 1. What the brief gets right (validated)

- `POST /api/v2/conversations/calls` with `phoneNumber` /
  `callFromQueueId` / `callerId` is the documented agent-outbound path —
  the same thing Agent Workspace's "Start a new call" does. Correct.
- The token-type split (user-context token to place calls,
  client-credentials for agentless SMS) is correct. Better: **both existing
  apps already hold user-context implicit-grant tokens**, so §10.6's "the
  auth layer must change first — the largest piece of this work" is
  already done. The largest risk item in the brief evaporates on contact
  with the codebase.
- Agentless SMS while a voice call is connected: confirmed in substance.
  Genesys documents that agentless SMS to a number with a connected
  conversation fails by default and an optional request attribute
  overrides it (developer.genesys.cloud blog 2024-09-27, Resource Center
  "Agentless SMS notifications"). Exact attribute name still to be checked
  in the API Explorer, as the brief itself says.
- The diagnosis of the current outbound design (§1) is accurate — see §3
  below; the code confirms every claimed defect.
- Failure-handling table (§7) and testing checklist (§9) are solid and
  match the failure classes we've seen live.

## 2. Required corrections

### 2.1 Invariant 1 ("on hold → leave video up") CONTRADICTS the decided privacy policy — must be amended

The brief: *"On hold → leave video up (optionally show 'on hold'
overlay)"* and *"`held: true` → do NOT touch the video session."*

This recreates, on outbound, the exact field complaint this project spent
the week fixing on inbound: a member on hold watching an agent who
believes they are private. The user-decided policy (2026-08-28, F-11) is
**hold or mic-mute must always mute video**, and it was wire-validated on
2026-08-31 (S2.1, S2.5).

Amended invariant: *the video **session** survives Genesys state changes
(never torn down by hold/consult/transfer), but the video **mute state**
follows the same single privacy rule as inbound* — `applyVideoPrivacy`
(held ∨ audioMuted ∨ connectionLost → dark). The brief's instinct
(don't couple session lifecycle to telephony) is right; muting is not
lifecycle.

### 2.2 `findParticipants()` (§4.4) repeats the stale-leg bug (F-19)

The proposed helper uses `find()` — first match — for both agent and
member. This project proved participants **accumulate** (8 agent legs in
one lab conversation; terminated legs sort first) and that first-match
predicates read dead legs after any transfer or reconnect. That was THE
field bug (F-19).

Fix: build the outbound lookup on `src/call/legSelection.ts`
(`selectMyLeg` + `customerLegGone`), extended for the outbound `purpose`
values (`user`/`external` without queue, `agent`/`customer` with). Same
rule: prefer connected leg, else newest non-terminated, never first-match.
The brief's own §9 asks for fixture tests of exactly these shapes — the
fixtures can come from the capture recorder.

### 2.3 Notifications guidance (§4.3) predates F-22 — the fallback must be a watchdog

The brief says "reuse the channel" (meaning the app's existing socket) and
offers REST polling only as a *fallback if the WebSocket is unavailable*.
F-22 proved the dangerous mode is a socket that looks healthy —
open, heartbeating, subscription 200 — delivering nothing. For outbound
this is worse than inbound: a deaf channel means the app never learns the
member answered (escalate button never enables) or hung up (video never
tears down).

Requirements carried over from the PR-2 design notes:
- **Channel reuse** (`GET /notifications/channels`, take over the newest)
  instead of channel-per-load — respects the 20-per-user-per-app cap.
- **Resync watchdog** as a permanent companion, not a fallback: poll
  `GET /conversations/calls/{id}` every few seconds and reconcile.
  (The brief's §4.3 fallback loop is the right code; it just must always
  run.)

### 2.4 The "existing backend" does not exist

§2.2 assigns VMR allocation and the agentless SMS to "Backend (existing)".
Neither repo has a backend: agent-app is client-only (VMRs come from the
Infinity local policy, alias = ANI), and agent-branch-app is client-only
(conference created by first join, alias generated in the browser). The
agentless SMS **requires client credentials, which cannot ship in a
browser**, so SMS needs a real (if tiny) backend component — or v1 ships
without SMS using the brief's own fallback: display link + QR in the agent
UI (and the member's phone is already in hand — the agent just dialed it).

Recommendation: v1 = on-screen link/QR (zero new infrastructure, policy
mints the VMR exactly as inbound does — alias derivable from the dialed
number); v2 = small backend or Genesys Function for SMS. Do not block the
redesign on standing up a backend.

## 3. agent-branch-app review (the code confirms the brief's diagnosis)

~2,300 lines, cleanly typed, but the architecture fights Genesys instead
of using it. Flow: create a Pexip conference; **Pexip dials SIP into the
contact center** (`contactCenterAlias` \@byoc.pure.cloud) with
`X-agent-id`/`X-queue-id` custom headers to steer preferred-agent ACD
routing; agent joins by WebRTC; then a "Leg 3" video dial-out to the
external device. Confirmed defects, all structural:

- The interaction is genuinely **inbound** to Genesys; preferred-agent
  routing can and does roll to other agents (the "missed agents on queue"
  complaint), and the far end is a Pexip SIP identity, not the member.
- The orchestrator compensates with heuristic machinery — `minTwoArmed`,
  `belowTwoSince`, a "4-legs/20s" rule, `leg0Retired` + 8 s stabilization
  timers, SSE grace windows, display-name-substring participant matching,
  Leg-3 candidate-URI retry loops. Every one of these timers exists
  because the app doesn't own the call; the new design deletes them all.
- Pexip carries the audio from second one — the exact
  video-state-coupled-to-telephony class this project just spent a week
  fixing on inbound.

**Worth porting** into the combined app: the External Contacts member
lookup + queue picker UI (`genesys.ts` routing/contacts calls, App.tsx
form), and its habit of a support-facing debug handle
(`window.__agentDial.getState()`). **Retire**: orchestrator, sse.ts,
pexipClient.ts (agent-app's `@pexip/infinity` SDK replaces them), the SIP
dial-in dial plan.

## 4. Combine? Yes — one app, two modes

Both apps are React+Vite+TS on the purecloud SDK with implicit-grant user
tokens. The combined design:

- **One codebase (this repo).** Entry mode keyed off the URL: a
  `pcConversationId` present → inbound interaction-widget mode (today's
  behavior); absent → outbound dialer mode (member lookup → dial →
  escalate).
- **Shared, already-hardened plumbing** from pr1: `legSelection`
  (extended per §2.2), `notificationsController` (+PR-2 reuse/watchdog),
  `applyVideoPrivacy` (per §2.1 the same rule governs both directions),
  the logger, the capture recorder, the banner UX. The privacy evidence
  pack then covers outbound almost for free.
- **UX win**: one widget, one token, one Pexip session model; hold/mute
  behave identically in both directions; agents learn one tool.

## 5. Sequencing (protects the validated PR-1)

1. PR-1 ships as scoped (manual session + S1.1 guard rerun pending).
2. PR-2: WS reliability (channel reuse + watchdog) — now doubly required,
   it is a prerequisite for trustworthy outbound state.
3. Then the outbound mode on this branch (`outbound-dialer`), reusing the
   hardened modules; agent-branch-app retired when it reaches parity.

## 6. Open decisions for Josh (unchanged from the brief §10, plus one)

1. `callFromQueueId` — recommend yes with a dedicated "Video Outbound"
   queue (reporting + ACW, no ACD exposure).
2. Outbound caller ID (must be presentable on the trunk).
3. Guest-link delivery — recommend on-screen link/QR for v1 (no backend),
   SMS in v2 (§2.4).
4. VMR strategy — recommend the policy-minted ephemeral VMR keyed off the
   dialed number, symmetric with inbound's ANI alias; we control the
   policy (existing design lever).
5. Pexip-side recording — unchanged question.
6. Feature flag vs hard cutover for retiring agent-branch-app.
7. ~~Member endpoint types~~ — **DECIDED (Josh, 2026-08-31): outbound
   targets BRANCHES ONLY (video devices), all present in the agents'
   softphone phonebook (Genesys External Contacts).**

## 7. Decision update: branches-only v1 (2026-08-31)

Consequences of decision 7 — this simplifies v1 substantially:

- **No SMS, no guest links, no backend.** The entire §2.4 backend
  question is moot for v1. The escalation delivers no link; the VMR
  **dials the branch device** (as today's Leg 3 does), just triggered at
  the right moment and with the audio already on Genesys.
- **Branch picker is already written**: agent-branch-app's External
  Contacts fetch (org-name filtered, workPhone as dial value) ports
  straight over, including its SIP-candidate logic
  (`value@customerSipDomain` variants).
- **Revised happy path**:
  1. Agent picks branch from the phonebook-backed list
  2. `POST /conversations/calls { phoneNumber: <branch number> }` — real
     outbound audio; agent station rings, then the branch rings
  3. Branch answers the phone call → audio live on Genesys
     (recording/reporting correct, direction outbound, real DNIS)
  4. Escalate → policy mints the VMR; agent joins WebRTC video-only;
     VMR dials the branch device as a **second, video call**; the
     device's VMR leg is kept audio-less so the only audio path stays
     the Genesys call
  5. Teardown driven by Genesys events, as in the brief

- **THE critical open question — second-call behavior on the device.**
  When the branch endpoint (e.g. Cisco RoomOS) receives the VMR's video
  call while already on the Genesys audio call, what happens on answer?
  Many endpoints put the first call on hold when answering a second —
  which would kill the Genesys audio. Options to evaluate: concurrent
  calls / "add" behavior on RoomOS, auto-answer config for the second
  call, or letting the device's video call carry no audio at all
  (verify the cleanest mechanism: an audio-less dial vs server-muting
  the leg both directions after connect). **This is lab-testable TODAY
  with the harness Cisco (cisco.cjs xAPI drives exactly this device
  class) before any code is written.**
- **Alias/routing detail to confirm**: the same workPhone value must
  resolve (a) via the Genesys number plan for the audio call and (b) via
  Pexip routing for the video dial-out — agent-branch-app's candidate
  logic suggests (b) already works; (a) is Josh's "in their softphone
  phonebook too" observation.

### 7.1 Stale-leg handling for the callback case (decided design, 2026-08-31)

Context: the branch Poly runs auto-answer specifically so agents can call
back after a dropped call. If a drop leaves the Poly connected to an old
VMR leg, the callback must not fight it. Three-layer design:

1. **Branch-keyed VMR alias** (stable per branch, not per conversation).
   A stale Poly leg is then already in the room the callback uses —
   reunion, not conflict. Escalate is idempotent: *join → list roster
   (client API, host token — agent-branch-app's `listParticipants`
   pattern) → dial the branch only if not already present.*
2. **Host/Guest roles + guests-disconnect-when-last-host-leaves** (N s)
   in the VMR policy. Normal drops self-clean: agent's video leg goes,
   Poly is kicked seconds later, returns to idle with auto-answer armed.
   No management API, no backend.
3. **Media timeout backstop** (~30 s) covers agent browser crashes: dead
   WebRTC host leg times out → layer 2 fires anyway.

At callback time the Poly is therefore either idle (clean redial) or in
the target room (skip dial). Both handled.

### 7.2 Mechanics-probe results (2026-08-31 night, `tools/lab/outbound-probe.cjs`, runs `outbound-probe-*`)

Proven empirically (lab org, A1, target `josh.estrada@pexip.com` = the lab
Cisco, registered to pexip.com corp):

- `POST /api/v2/conversations/calls` **accepts a raw SIP URI** as
  `phoneNumber` (also with `callFromQueueId`); conversation created.
- Participant purposes CONFIRMED (brief §4.4 [VERIFY] closed): personal
  call → agent leg `purpose:"user"`; with `callFromQueueId` →
  `purpose:"agent"`. Fixtures: `e1-conversation-fixture.json`.
- Station [VERIFY] closed: `GET /users/{id}/station` returns
  `associatedStation`/`effectiveStation` with `type:
  "inin_webrtc_softphone"`, `webRtcCallAppearances`.
- External Contact model: a SIP URI stored in Other Phone survives
  verbatim at `otherPhone.userInput` (UI shows a "non-standardized"
  warning; harmless). Branch picker must read `otherPhone`, NOT
  `workPhone` (change vs agent-branch-app).
- **API-placed calls: the hosted WebRTC phone never surfaces a pickup UI**
  in the workspace shell (agent leg dies after 60 s with
  `error.ininedgecontrol.connection.timeout`; workspace toast "Call
  Connection Timeout"). A HUMAN-placed call from the workspace dialpad
  auto-connects the agent leg — no pickup needed. For the real widget this
  is fine (agent is present); for lab automation the answer path still
  needs solving (or place calls via the workspace UI in Playwright).
- Human-placed dial to the SIP URI: agent leg connected, customer leg
  created and routed with ANI `sip:genesys@rbfcu.byoc.usw2.pure.cloud`,
  DNIS `sip:josh.estrada@pexip.com;language=en-US` (note the appended
  parameter), then `disconnectType: endpoint` — and **no trace in
  pexsupport Infinity history**: the INVITE never reached the Pexip the
  trunk serves. Lab org lacks an outbound route carrying sip: URIs to a
  reachable destination; the codec is NOT registered on pexsupport
  (registration_alias list is empty).

**Lab config needed to finish E1/E2** (either):
1. Register the codec TO pexsupport Infinity (alias e.g.
   `joshcisco@genesys.pexsupport.com`) + ensure a call-routing rule for
   registered devices + confirm the Genesys number plan/outbound route
   sends that URI down the BYOC trunk — this faithfully emulates prod
   (branch Poly registered to the customer's Pexip); or
2. Add a pexsupport call-routing rule forwarding
   `josh.estrada@pexip.com` outbound to pexip.com, and fix the Genesys
   route for sip: URIs.

**Poly lab items before implementation** (on the actual branch model —
auto-answer semantics differ from Cisco):
- Second incoming (video) call while on the Genesys audio call: does
  auto-answer fire? does answering hold the audio call?
- Auto-answer while sitting in a stale VMR leg (the callback-audio call
  itself arrives as a second call in that state).
- Confirm audio-less handling of the VMR leg (dial variant vs
  server-side mute both directions after connect).
