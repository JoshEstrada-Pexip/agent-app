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
7. NEW: does outbound target member *phones* (browser guest join via
   link), branch *video devices* (SIP dial-out from the VMR, like today's
   Leg 3), or both? The brief assumes phones; agent-branch-app serves
   devices. Both fit the new model (device = Infinity dial-out API instead
   of SMS link) but the UI differs.
