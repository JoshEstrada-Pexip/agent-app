# Agent-Originated Outbound Calls with Pexip Video Escalation
## Implementation Brief for Claude Code

**Project:** RBFCU — Genesys Cloud + Pexip video integration
**Author:** Josh (Pexip SE) with research assistance
**Date:** 2026-08-31
**Status:** Ready to implement — READ `outbound-review.md` FIRST (four required corrections)

---

## 0. How to use this document (read first, Claude Code)

This brief describes a change to the existing Genesys/Pexip integration app. Before writing any code:

1. **Explore the repo first.** Find the current "outbound" code path (the one that calls Pexip Infinity to dial into a Genesys queue), the existing inbound video-escalation flow, the Genesys auth layer, and the participant-lookup helper. Everything below builds on what already exists — do not create a parallel implementation.
2. **Reuse the inbound escalation code.** The Pexip video leg is unchanged. Only the *trigger* and the *participant lookup* change.
3. **Verify exact API field names against the Genesys API Explorer** (https://developer.genesys.cloud/devapps/api-explorer) for the org's region before shipping. The Genesys Developer Center is a JavaScript SPA and could not be fully fetched during research; field names below are from Genesys tutorials, forum posts, and SDK usage and are believed correct, but treat any field marked **[VERIFY]** as needing confirmation.
4. Ask Josh before making decisions in the "Open decisions" section (§10). Do not guess.

---

## 1. Problem statement

### Current outbound design (to be replaced)
The app's "outbound" flow does not actually place an outbound call. It calls the Pexip Infinity API, which causes Pexip to dial **into** Genesys Cloud over the SIP trunk. That call lands in an ACD queue configured with priority/preferred-agent routing intended to target one specific agent.

### Why it fails
- **Rollover.** ACD routing is designed to fall through: if the preferred agent does not answer within the alerting timeout, Genesys offers the call to the next eligible agent. There is no way to make an ACD-routed call "belong" to one agent.
- **Wrong direction.** The interaction is genuinely inbound from Genesys's perspective (`direction: "inbound"`). It shows up as inbound in the agent roster, reporting, and analytics. Agents find this confusing.
- **Wrong far-end identity.** The "customer" participant is a Pexip SIP address, not the member's phone number, so ANI/DNIS in reporting are meaningless.
- **Extra moving part.** Pexip is in the audio path from the start, which couples video state to telephony state (hold/consult/transfer) — the source of several bugs in the existing failure inventory.

### Target design
Use the Genesys Platform API to place a real outbound call **from the agent's own WebRTC station**, exactly as the native Agent Workspace "Start a new call" button does. Then escalate to Pexip video using the *same* overlay mechanism already used for inbound calls.

Result: no ACD, no rollover, correct direction, real member number as the far end, and Pexip is never in the audio path. The Pexip→Genesys SIP dial-in path is retired.

---

## 2. Architecture

### 2.1 Two-leg model (unchanged, now symmetric)

```
INBOUND (today, unchanged)
  Member ──PSTN/SIP trunk──> Genesys Cloud ──ACD──> Agent WebRTC phone   [AUDIO]
  Member ──browser──> Pexip Infinity VMR <──browser── Agent (via app)     [VIDEO]

OUTBOUND (new)
  Agent WebRTC phone ──POST /conversations/calls──> Genesys ──SIP trunk──> Member   [AUDIO]
  Member ──browser──> Pexip Infinity VMR <──browser── Agent (via app)              [VIDEO]
```

The audio leg is always a Genesys call conversation. The video leg is always a Pexip VMR joined via WebRTC by both parties. Video is an **overlay** — it never carries audio, and it never changes Genesys conversation state.

### 2.2 Component responsibilities

| Component | Responsibility |
|---|---|
| Agent-side app (embedded client app / interaction widget in Agent Workspace) | Holds the agent's user-context OAuth token. Places the outbound call. Subscribes to conversation notifications. Triggers escalation. Hosts the Pexip WebRTC client for the agent. |
| Backend (existing) | Allocates/resolves the Pexip VMR. Sends the SMS with the guest link (client-credentials token is fine here). Optionally writes participant attributes. **[REVIEW §2.4: no backend exists today — v1 uses on-screen link/QR]** |
| Genesys Cloud | Audio leg, recording, QM, analytics, wrap-up. Source of truth for conversation state. |
| Pexip Infinity | Video leg only. |

### 2.3 Why the split in token types matters
- `POST /api/v2/conversations/calls` places the call **as the authenticated user**. It requires a **user-context token** (Implicit Grant or Authorization Code + PKCE from the agent's browser session). A client-credentials token has no user/station and cannot place a call this way. This constraint is likely why the original design routed through Pexip dial-in.
- The agentless SMS endpoint works with **client credentials**, so the backend can send the guest link without needing the agent's token.

---

## 3. Genesys Cloud prerequisites (config, not code)

Confirm these with the RBFCU Genesys admin before testing. Missing any one produces confusing failures.

**OAuth client for the agent-side app**
- Grant type: Implicit Grant (browser) or Authorization Code with PKCE.
- Scopes: `conversations`, `notifications`, `users`, `presence` (minimum). Add `routing` if using `callFromQueueId`.

**OAuth client for the backend (SMS)**
- Grant type: Client Credentials.
- Role with permission `Conversation > Message > Create` (agentless messaging).

**Agent permissions (role assigned to agents)**
- `Conversation > Call > Add` — required to create a call.
- `Conversation > Call > View`, `Conversation > Communication > View`.
- If using on-behalf-of-queue: `Routing > Queue > Search` (and agent must be a member of the queue, but does NOT need to be On Queue).

**Telephony**
- Each agent has a **WebRTC phone** provisioned and **selected as their station**. The API rings the selected station; if none is selected the call fails.
- Outbound trunk/route exists for E.164 external numbers (it does — inbound already uses the trunk; confirm outbound routing is enabled on it).
- A **provisioned SMS number** exists in the org for the guest-link text (RBFCU needs a Genesys Cloud CX Digital license for agentless SMS).

**Optional**
- A dedicated queue (e.g., `Video Outbound`) to use as `callFromQueueId` so outbound video calls are attributed to a queue for reporting and inherit that queue's ACW settings.

---

## 4. API reference for this feature

All endpoints are relative to the org's regional API host (e.g., `https://api.usw2.pure.cloud`, `https://api.mypurecloud.com`). Use the org's actual region.

### 4.1 Pre-flight: confirm the agent can dial

**Get the agent's selected station**
```
GET /api/v2/users/{userId}/station
```
Response includes `associatedStation` (or `effectiveStation`). If empty/null → show "Select your WebRTC phone" and disable the dial button. Also check `webRtcCallAppearances`/type is `inin_webrtc_softphone` **[VERIFY exact field names]**.

**Get the agent's presence/routing status**
```
GET /api/v2/users/{userId}/presences/PURECLOUD
GET /api/v2/users/{userId}/routingstatus
```
Use these only for UX (warn if agent is already on a call). Outbound calls are allowed while On Queue; utilization settings determine whether a second call is permitted.

**Get the agent's own user ID**
```
GET /api/v2/users/me
```

### 4.2 Place the outbound call

```
POST /api/v2/conversations/calls
Authorization: Bearer <AGENT USER-CONTEXT TOKEN>
Content-Type: application/json

{
  "phoneNumber": "+12105551234",
  "callFromQueueId": "<queueId>",          // optional — see §10
  "callerId": "+12105550100",              // optional — RBFCU outbound ANI
  "callerIdName": "RBFCU"                  // optional
}
```

Response (201/200): a `Conversation` object. Save `id` as `conversationId`.

**Behavior:** Genesys rings the agent's selected station first. When the station answers (auto-answer or manual), Genesys dials `phoneNumber`. The agent participant connects immediately; the far-end participant transitions `dialing → alerting → connected` (or `disconnected` on no-answer/busy).

**Notes**
- Phone number: send E.164. Non-E.164 may work depending on the org's number plan, but E.164 is the safe path.
- `callFromQueueId` makes this an "on behalf of queue" call. Statistics attribute to that queue and the queue's After Call Work settings apply. Omit it for a plain personal call (no queue reporting, no ACW).
- Known edge case (forum reports): the endpoint can intermittently return 400 or create a conversation with only one participant. Handle both: on 400, surface the error text and allow retry; after success, poll or wait for notification and confirm **two** participants exist before enabling the escalate button.

### 4.3 Track conversation state (do not poll)

**[REVIEW §2.3: amended — channel REUSE + permanent resync watchdog required, see lab finding F-22]**

Use the Notifications API over WebSocket. The app likely already does this for inbound — reuse the channel.

**Create a notification channel**
```
POST /api/v2/notifications/channels
```
Returns `connectUri` (WebSocket URL) and `id`.

**Subscribe to the agent's call conversations**
```
POST /api/v2/notifications/channels/{channelId}/subscriptions
[
  { "id": "v2.users.{userId}.conversations.calls" }
]
```

Each event contains the full conversation with participants. Filter on `eventBody.id === conversationId`.

Key transitions to react to:
- Far-end participant `state: "connected"` → **call is live; enable "Escalate to Video".**
- Far-end participant `state: "disconnected"` with `disconnectType` → call ended/failed; show reason (`client`, `endpoint`, `peer`, `error`, `timeout`, etc.).
- Agent participant `state: "disconnected"` → agent hung up; tear down any video session.
- `held: true` on either side → **[REVIEW §2.1: amended — apply the shared privacy rule; video session stays up but MUTES]**

Fallback if the WebSocket is unavailable: `GET /api/v2/conversations/calls/{conversationId}` every 2–3 s, max ~60 s. **[REVIEW: this loop runs ALWAYS as the watchdog, not as fallback]**

### 4.4 Participant lookup (the one place the inbound code must change)

**[REVIEW §2.2: amended — build on src/call/legSelection.ts, never find()-first; participants accumulate legs (lab finding F-19)]**

Outbound conversations order participants differently from inbound:

| Direction | First participant | Later participant |
|---|---|---|
| Inbound | member (`purpose: "customer"` or `"external"`) | agent (`purpose: "agent"` or `"user"`) |
| Outbound | agent (`purpose: "user"`, or `"agent"` if `callFromQueueId` was set) | member (`purpose: "external"`, or `"customer"` if `callFromQueueId` was set) **[VERIFY purpose values in your org]** |

**Do not** locate the member by array index or by `direction`.

The member's dialed number is at `member.calls[0].other.addressNormalized` (outbound) — for inbound it is `member.calls[0].self.addressNormalized`. Prefer `addressNormalized` (E.164) over `address`.

### 4.5 Escalate to video

Reuse the existing inbound escalation path. The steps are:

**(a) Allocate / resolve the Pexip VMR** — inputs: `conversationId`, `agentUserId`, member number. Output: `vmrAlias`, `guestPin` (if used), `guestJoinUrl`, `hostJoinUrl`/host PIN. **[REVIEW: policy-minted ephemeral VMR keyed off dialed number, symmetric with inbound ANI alias]**

**(b) Tag the Genesys conversation with the VMR** (recommended; lets scripts, reporting, and a reconnecting widget rediscover the session)
```
PATCH /api/v2/conversations/calls/{conversationId}/participants/{agentParticipantId}/attributes
{
  "attributes": {
    "pexip.vmrAlias": "<alias>",
    "pexip.conversationId": "<conversationId>",
    "pexip.escalatedAt": "<ISO timestamp>",
    "pexip.direction": "outbound"
  }
}
```
Do not store PINs or join URLs with embedded credentials in attributes — they are visible in analytics/exports.

**(c) Send the guest link to the member via SMS** (client-credentials token — REQUIRES A BACKEND, see review §2.4; v1 ships on-screen link/QR instead)
```
POST /api/v2/conversations/messages/agentless
{
  "fromAddress": "+12105550199",            // provisioned SMS number in the org
  "toAddress": "+12105551234",              // member number, E.164
  "toAddressMessengerType": "sms",
  "textBody": "RBFCU video session: https://<pexip-host>/webapp/?conference=<alias>&pin=<guestPin>",
  "useExistingActiveConversation": true     // [VERIFY exact attribute name — semantics confirmed via Genesys blog 2024-09-27]
}
```
Alternatives if SMS is not licensed or the member prefers email: agentless email (`POST /api/v2/conversations/emails/agentless`) or have the app display the link/QR for the agent to read out.

**(d) Agent joins the VMR** — existing Pexip WebRTC client in the app, joined as host, **video-only / audio muted or audio-less**. Audio remains on the Genesys call. Exactly the same as the current inbound overlay.

**(e) Member joins** via the SMS link in their browser (Pexip web app or the app's guest page). Same as inbound today.

### 4.6 Teardown

Drive teardown from Genesys events, never the other way round:
- Agent or member disconnects the Genesys call → end the Pexip video session (disconnect agent's WebRTC leg; optionally kick all participants from the VMR via Infinity management API so the member's browser tab ends cleanly).
- Video session ends first (member closes tab) → do nothing to the Genesys call. Update UI only.
- Agent completes wrap-up → nothing extra; the VMR was already torn down at disconnect.

---

## 5. Full sequence (happy path)

```
1.  Agent opens app inside Agent Workspace (has user-context token from implicit/PKCE grant)
2.  App: GET /users/me → userId
3.  App: GET /users/{userId}/station → confirm WebRTC phone selected, else block
4.  App: notifications channel + subscribe v2.users.{userId}.conversations.calls (reuse existing)
5.  Agent enters member number (E.164) and clicks Call
6.  App: POST /conversations/calls { phoneNumber, callFromQueueId?, callerId? } → conversationId
7.  Genesys rings agent's WebRTC phone → agent answers (or auto-answer)
8.  Genesys dials member; notification events flow
9.  App: on member participant state === "connected" → enable "Escalate to Video"
10. Agent clicks Escalate
11. App: allocate/resolve VMR for conversationId
12. PATCH participant attributes with vmrAlias
13. Deliver guest link (v1: on-screen link/QR; v2: agentless SMS via backend)
14. App: join VMR as host, video-only
15. Member taps link, joins VMR as guest
16. Call proceeds — audio on Genesys, video on Pexip
17. Either side hangs up Genesys call → app receives disconnected event → tears down VMR
18. Agent completes wrap-up in Genesys as normal
```

---

## 6. Invariants (enforce these in code review)

**[REVIEW §2.1: invariant 1 amended — session lifecycle decoupled from telephony, but video MUTE follows the shared privacy rule (held ∨ audioMuted ∨ connectionLost → dark)]**

1. **Genesys is the state machine.** The video layer never initiates Genesys state changes. The video *session* is never torn down by hold/consult/transfer — but its *mute state* follows `applyVideoPrivacy`, same as inbound. On transfer → tear down video only when *this agent's* participant disconnects.
2. **Audio never traverses Pexip.** Agent joins the VMR with audio disabled; the guest link should also default to audio-muted if the Pexip web app supports the parameter, to prevent echo.
3. **No ACD in the outbound path.** `POST /conversations/calls` only. Do not reintroduce queue routing for outbound video calls.
4. **The agent-side app uses the agent's token; client credentials never ship in the browser.**
5. **Retire the Pexip→Genesys dial-in for outbound.** Remove or feature-flag the old code path; leave the SIP trunk config in place only if inbound still depends on it (it should not — inbound audio comes from the carrier, not Pexip — confirm).

---

## 7. Failure handling

| Situation | Detection | Handling |
|---|---|---|
| No station selected | `GET /users/{id}/station` empty | Disable Call button; message "Select your WebRTC phone in Genesys." |
| Agent already on a call / utilization blocks | 4xx on POST, or existing connected conversation in roster | Show error; do not retry automatically. |
| POST returns 400 (intermittent, known) | HTTP 400 | Show Genesys error message; allow manual retry. Log conversation body if any. |
| Conversation created with one participant (intermittent, known) | Notification/poll shows `participants.length < 2` after ~5 s | Treat as failed dial; disconnect the conversation (`PATCH .../participants/{id}` with `state: "disconnected"`); allow retry. |
| Member no-answer / busy | Member participant `disconnected` with `disconnectType` `endpoint`/`timeout`/`peer` before `connected` | Show reason; agent completes wrap-up; no video was started. |
| Guest-link delivery fails | Non-2xx from agentless endpoint (v2) | Fall back to displaying link + QR in the agent UI. Do not block the escalation. |
| Member never joins VMR | Backend/Infinity participant events, or timeout | UI hint only; agent can resend link. Audio call continues regardless. |
| Agent's WebRTC video leg drops | Pexip client disconnect event | Auto-rejoin VMR (VMR still exists, alias in participant attributes). Genesys call unaffected. |
| Agent browser refresh mid-call | App reload | On load, `GET /conversations/calls` for active conversations; read `pexip.vmrAlias` from participant attributes; offer "Rejoin video". |
| Token expiry | 401 | Re-run implicit/PKCE flow; conversations persist. |
| Notification channel deaf (F-22) | Watchdog detects state drift vs REST | Reconcile from REST truth; log; banner if drift persists. |

---

## 8. Reporting / QM impact (for RBFCU stakeholders)

- Outbound video calls now appear as **outbound** interactions with the member's real number.
- Recording, transcription, sentiment, and QM evaluations operate on the Genesys audio leg — unchanged from any other outbound call.
- With `callFromQueueId`, calls roll into that queue's stats and ACW; without it, they are personal (non-ACD) calls and appear under the user, not a queue.
- Participant attributes (`pexip.*`) surface in conversation detail and analytics exports, enabling "how many outbound calls escalated to video" reporting.
- Video itself is not recorded by Genesys. If Pexip-side recording is required, that is a separate decision (§10).

---

## 9. Testing checklist

Manual, in a Genesys test org or RBFCU sandbox with a real WebRTC phone:

- [ ] Agent with no station selected → Call button disabled with clear message
- [ ] Agent with WebRTC phone selected → POST succeeds, phone rings, member phone rings after answer
- [ ] Member answers → "Escalate" becomes enabled only after member `connected`
- [ ] Member does not answer → conversation ends cleanly, wrap-up prompt appears, no VMR allocated
- [ ] Escalate → guest link delivered, link opens Pexip guest page
- [ ] Both in VMR → video both directions, **no audio in the VMR**, no echo
- [ ] Agent places Genesys call on hold → video session stays up, video MUTES (privacy rule)
- [ ] Agent resumes → video restores (unless mic-muted)
- [ ] Agent mutes mic in Genesys → video mutes (privacy rule)
- [ ] Member hangs up phone → video torn down within a few seconds
- [ ] Agent hangs up phone → video torn down; wrap-up works
- [ ] Agent refreshes browser mid-call → app recovers active conversation and offers Rejoin video
- [ ] With `callFromQueueId` → call appears under the queue in Performance > Queues; ACW applies
- [ ] Without `callFromQueueId` → call appears under the user only
- [ ] Interaction shows `direction: outbound` and correct DNIS in Interactions view
- [ ] Old Pexip dial-in path disabled → no inbound "video outbound" interactions appear in any queue
- [ ] Second agent logged in during all tests → never receives any of these calls

Automated: unit tests for the direction-agnostic participant lookup against fixture conversations for inbound, outbound-with-queue, outbound-without-queue, and single-participant (failed) shapes — fixtures from the capture recorder.

---

## 10. Open decisions — ask Josh before implementing

1. **`callFromQueueId`: yes or no?** Recommendation: yes, with a dedicated "Video Outbound" queue, so RBFCU gets queue-level reporting and ACW without exposing the call to ACD routing. Requires agents to be queue members (not On Queue).
2. **Caller ID.** Which RBFCU number should present as ANI on outbound video calls? Must be a number RBFCU is entitled to present on the trunk.
3. **Guest-link delivery.** v1 on-screen link/QR (no backend); SMS in v2 (needs Digital license + provisioned number + small backend).
4. **VMR strategy.** Recommendation: policy-minted ephemeral VMR keyed off the dialed number (symmetric with inbound's ANI alias; we control the policy).
5. **Pexip-side recording.** In the new model Pexip only has video. If RBFCU needs video recording, decide where — Genesys will not record the video leg.
6. ~~Where the agent-side app lives~~ — RESOLVED: both existing apps already hold user-context implicit-grant tokens.
7. **Feature flag vs. hard cutover** for retiring the Pexip dial-in path.
8. **Member endpoint types** (review §6.7): phones via guest link, branch video devices via VMR dial-out, or both?

---

## 11. Source notes

Research conducted 2026-08-31 against Genesys Cloud Resource Center, Developer Center forum, Genesys tutorial repositories, and community posts. Items marked **[VERIFY]** must be checked in the API Explorer for the org's region:

- Exact station response field names on `GET /api/v2/users/{userId}/station`
- Participant `purpose` values for outbound with/without `callFromQueueId`
- Exact name of the "send on connected conversation" flag on the agentless message endpoint (semantics CONFIRMED: developer.genesys.cloud/blog/2024-09-27-agentless-sms-api, help.genesys.cloud "Agentless SMS notifications")

Confirmed from sources:
- `POST /api/v2/conversations/calls` with `phoneNumber`, optional `callFromQueueId`, `callerId`, `callerIdName` is the documented way to place an agent outbound call and is what Agent Workspace uses.
- On-behalf-of-queue attributes stats to the queue and applies queue ACW; agent does not need to be On Queue.
- Agentless SMS via `POST /api/v2/conversations/messages/agentless`; sending during a connected conversation is supported via an optional attribute (since Dec 2021); requires Digital license and `Conversation > Message > Create`.
- Intermittent 400 / single-participant conversations from `POST /conversations/calls` are reported on the forum; handle defensively.
