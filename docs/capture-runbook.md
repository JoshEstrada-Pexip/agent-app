# Genesys Event Capture Runbook (PR 0)

Purpose: record the **real** notification snapshots Genesys emits for every
call scenario this app must handle, and turn each recording into a permanent
test fixture. No behavior fix ships until its scenario has a recorded fixture
proving what Genesys actually sends.

## 1. Setup

**People/equipment:** two agents (A1 = primary capture, A2 = consult/transfer
target), one customer endpoint (poly room or any SIP video endpoint dialing the
normal inbound path), lab/sandbox Genesys org preferred.

**Enable capture** (dev build, zero effect when flag absent):

```bash
# agent-app/.env.local
VITE_CAPTURE_EVENTS=true
```

Run `npm start` (or deploy a flag-enabled build to the lab). On app load the
console prints `[capture] Genesys event capture ENABLED`.

**Both agents** should run capture-enabled sessions when a scenario involves
two agents — capture A1's and A2's streams separately (each user's topic shows
a different view of the same conversation).

## 2. Hands-off operation (recommended)

Nobody has to click through scenarios. The pieces:

| Role | Automated by |
| ---- | ------------ |
| A1/A2 call actions (hold, mute, consult, transfer, wrap-up) | `tools/scenario-runner/index.cjs` — Platform API calls with an agent token, timed per scenario, every action logged with ISO timestamps |
| Answering inbound | The runner itself — `answerWhenAlerting()` PATCHes the alerting leg to `connected` (same call the Agent UI answer button makes; media lands on the registered WebRTC station). No auto-answer config needed; S3.1 works because the runner simply never answers |
| Customer dial / hangup | Cisco RoomOS xAPI (`CISCO_HOST/USER/PASS/DIAL` env → runner dials and hangs up itself), or a Pexip webapp tab driven by the browser operator |
| Console marks + `__captureDump()` harvest, fixture files | Browser automation (Claude session) — reads the console, triggers dumps, writes `src/genesys/__fixtures__/*.json` |

**One-time human setup (~15 min):** log in A1 (main Chrome profile, WebRTC
station, auto-answer on) and A2 (second profile/window, station, auto-answer
on); grab a bearer token per agent (log in to Genesys developer tools /
API explorer as that agent and copy the token — tokens expire, refresh per
session); export `GENESYS_ENV`, `GENESYS_TOKEN_A1`, `GENESYS_TOKEN_A2`, and
the `CISCO_*` vars if using the endpoint.

**Per scenario:** get a call up (runner/Cisco dials, A1 auto-answers, widget
escalates video), then `node tools/scenario-runner/index.cjs S4.2`. The runner
verifies the active conversation, executes the timed steps, and writes
`runner-log-S4_2-*.json` next to the fixtures; the browser operator dumps the
capture and saves it alongside. First run is a shakedown: `S2.1` validates the
harness, `S3.1` validates the consult request shapes (the runner prints full
API error bodies for quick fixes).

**Optional second driver:** [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)
adds CDP-level control — isolated Chrome instances for the A2/customer
sessions and, importantly, **network emulation (offline)** which is the clean
way to run S5.1 without pulling cables.

## 2b. Manual operating procedure (fallback, and for S2.4/S2.7/S5.x)

1. Start the scenario fresh: new inbound call, video escalated, both sides
   confirmed live (check the **wire**: the customer endpoint must actually show
   agent video).
2. Before **each** scripted action, in the browser console:
   `__captureMark('S2.1 a2: hold pressed')` — use the scenario/step IDs below.
3. Perform the action. Wait ~5s between actions unless the step says
   "immediately" (rapid steps are the point of some scenarios).
4. At scenario end: `__captureDump()` — copy the JSON line from the console.
5. Save as `src/genesys/__fixtures__/<scenario-id>-<slug>.<agent>.json`
   (e.g. `S4.2-transfer-back-before-wrapup.a1.json`).
6. Note anything observed on the wire (customer endpoint) that contradicts the
   app UI — put it in a `notes` field you add to the JSON root.

**Privacy:** dumps contain ANI names, user IDs, and conversation IDs. Capture
in the lab org where possible. Before committing fixtures from any real-user
org, replace `aniName`/`name`/address values with stable placeholders (keep
IDs internally consistent — the tests rely on ID equality, not real values).

## 2c. What API-driving does and does not prove — and how we close the gap

The runner replaces only the **finger**. Everything else in the chain is real:
the real widget in the real Genesys Agent UI, the real notification WebSocket,
real Pexip VMR, real SIP trunk, real customer endpoint. The Genesys Agent UI's
own hold/mute/transfer buttons call the same public Platform API the runner
calls — but we do not take that equivalence on faith:

- **S0 calibration (run first):** capture S2.1 twice — once with a human
  clicking the Genesys UI buttons, once runner-driven. Diff the two captured
  event sequences (shape and order, ignoring IDs/timestamps). If they match,
  API-driving is *proven* equivalent for hold; repeat once for consult (S3.3)
  and transfer (S4.1). Any mismatch is itself a finding — it means the UI
  takes a path our fixtures must reflect.
- **Wire truth is asserted, not eyeballed.** "What the customer sees" can be
  read programmatically from both ends: the **Cisco xAPI**
  (`xStatus MediaChannels` — incoming video bitrate/state on the customer
  endpoint: literally what the customer receives) and the **Pexip Management
  API** (agent participant's media-stream tx state; read access available in
  the Claude session — confirm the management node is reachable during
  setup). Poll either after each runner step and record the result in the
  fixture notes: "agent video tx stopped within Ns of hold" is a stronger
  assertion than a human watching a monitor.
- **What stays human:** one acceptance pass per shipped PR with real eyes on
  real screens (agent UI + customer endpoint), and any scenario involving the
  widget's own buttons (S2.7 self-mute) or browser conditions (S5.x). Also
  note: a **headset/hardware mute** never reaches Genesys at all — S2.8 below
  measures which real-world mute paths even emit events; whatever emits
  nothing, the app can never react to, and that limit must be documented for
  agents.

## 3. Scenario matrix

Legend for the **why** column: refs are findings in the review/anatomy docs
(stale-leg = multi-leg shadowing; flap = consult `held=false` flap).

### S0 — Fidelity calibration (do these first)

| ID | Steps (marks) | Why we need it |
|----|---------------|----------------|
| S0.1 | S2.1 clicked by a human in the Genesys UI | baseline for the diff |
| S0.2 | S2.1 via the runner; diff against S0.1 | proves (or disproves) UI ≡ API for hold/unhold |
| S0.3 | one consult + one transfer, clicked; diff vs runner versions | same proof for the consult/transfer paths |

### S1 — Baseline

| ID | Steps (marks) | Why we need it |
|----|---------------|----------------|
| S1.1 | inbound → escalate video → talk 30s → customer hangs up | baseline snapshot shapes; customer-disconnect sequence |
| S1.2 | inbound → escalate → agent ends call from Genesys | `disconnectType: client` sequence; does another snapshot follow? |
| S1.3 | inbound → escalate → reload the widget mid-call | what REST `getConversation` returns mid-call (paste from Network tab into the fixture notes) |

### S2 — Hold and mute

| ID | Steps | Why |
|----|-------|-----|
| S2.1 | hold → wait 10s → unhold | canonical held:true/false snapshots; how many events per action |
| S2.2 | hold → unhold → hold → unhold, each **immediately** after the last | burst ordering; whether intermediate snapshots interleave |
| S2.3 | hold → customer hangs up while held | teardown-from-held sequence |
| S2.4 | put call on hold, then reload the widget | join-into-held REST + first WS snapshot |
| S2.5 | audio-mute → wait → unmute (no hold) | `muted` field behavior, snapshot count |
| S2.6 | audio-mute → hold → unhold → unmute | interaction of `muted` and `held` in the same snapshots |
| S2.7 | self video-mute in app → Genesys hold → unhold → self unmute | confirms Genesys never sees app-side video mute (expected: no events for it) |
| S2.8 | mute three ways: Genesys UI button, runner API, headset hardware mute | which real-world mute paths emit `muted` events at all — hardware mute likely emits nothing, a hard limit on the audio-mute→video-mute invariant that must be documented |

### S3 — Consult

| ID | Steps | Why |
|----|-------|-----|
| S3.1 | consult to A2 → cancel before A2 answers | flap timing; field-clearing order on cancel (**capture needed** row in anatomy §6) |
| S3.2 | consult to A2 → A2 answers → A1 completes transfer | `consultParticipantId`/`consultInitiator` lifecycle; A1's disconnect sequence |
| S3.3 | consult to A2 → A2 answers → A1 cancels (takes call back) | retrieve path; how held settles |
| S3.4 | same as S3.2 but capture **A2's** stream too | receiving-agent view: is A2 "consulting" per `isCallActive`? (bootstrap gate) |
| S3.5 | consult → A2 answers → all-three conference (if org supports) | `confined` semantics — the field the hold-override logic keys on |

### S6 — Agent-facing state panes

| ID | Steps | Why |
|----|-------|-----|
| S6.1 | hold → unhold → mic mute/unmute → CUSTOMER hangs up (`--video` required) | pane text on hold, the transient restore toast (sampled immediately after unhold), mic-mute leaving the live view alone, and the "Call ended" pane + VMR teardown when the customer leaves first — the one path `tearDown` never exercises (F-24) |

### S4 — Transfer (the stale-leg scenarios)

| ID | Steps | Why |
|----|-------|-----|
| S4.1 | blind transfer A1→A2 → A2 escalates video | does A2's widget receive the same conversationId/aniName (alias rendezvous)? |
| S4.2 | transfer A1→A2 → A2 transfers back **while A1's wrap-up is still open** | **the stale-leg window** (probes A/B): capture A1's old-leg `state` over time — when does `disconnected` become `terminated`? |
| S4.3 | transfer A1→A2 → A1 completes wrap-up → A2 transfers back | control for S4.2 (probe C: should work) |
| S4.4 | A1→A2→A1 double transfer, quickly | probe D; leg accumulation with 3+ agent entries |
| S4.5 | transfer back to A1 → A1 **immediately holds** | probe B in the field: hold event with the stale leg present |
| S4.6 | transfer to a **queue**, A2 picks up from queue | `acd` participant entries — shapes the code has never been tested against |

### S5 — Infrastructure

| ID | Steps | Why |
|----|-------|-----|
| S5.1 | mid-call: DevTools → Network → Offline for 60s → online → hold | proves silent event loss: hold performed while offline must appear in the capture only if Genesys replays (expected: it does not) |
| S5.2 | customer endpoint drops (unplug/hang up) and redials the same conversation flow | does the customer participant reuse its entry or add one; transient non-connected snapshots (probe E risk) |

## 4. Turning dumps into fixtures

Each fixture replays through the pure pipeline (lands with PR 1's port of
`interpretGenesysEvent`): filter `entries` to `kind === 'ws-event'` where
`data.topicName` matches `conversations.calls`, feed each `data` in order, and
assert the **final** derived intent per scenario (e.g. S4.5 must end
`hold: 'active'`, not a disconnect). The `mark` entries document which
operator action produced which snapshots. Until the pipeline lands, fixtures
are still immediately useful: read them to confirm/refute every **capture
needed** row in the anatomy doc's scenario matrix.

## 5. Done criteria for PR 0

- [ ] Every S-row above has at least one fixture file (two for dual-agent rows)
- [ ] Fixtures sanitized (if from a real-user org) and committed
- [ ] The "capture needed" rows in the anatomy scenario matrix are re-labeled
      confirmed/refuted, with fixture filenames as evidence
- [ ] S4.2 answers the load-bearing question: how long does a `disconnected`
      agent leg survive, and does wrap-up completion terminate it

## Off-network validation (no customer endpoint needed)

| Tool | What it does |
|------|--------------|
| `node tools/lab/get-token.cjs a1` (or `a2`) | Refreshes `GENESYS_TOKEN_A1`/`A2` in `.env.lab` with no human step: runs the implicit-grant sign-in through the logged-in persistent lab profile (headed, a window flashes), captures `access_token` from the redirect, verifies it with `/users/me`, writes it back. Uses the app's own OAuth client (redirect URI = `APP_BASE`); its scopes cover everything the harness does (verified 2026-09-03: presence, routing, conversation PATCH, wrap-up). If the profile session itself has expired, run `lab app login a1` once. |
| `node tools/lab/bootstrap-check.cjs` (after `set -a; source tools/lab/.env.lab; set +a`) | Real browser (Playwright, fake camera) against `APP_BASE` (dev server by default): every bootstrap failure path, the SDK-timeout path, the connecting watchdog, and a real-token control that lands on "No active call". Writes `tools/lab/runs/bootstrap-*/` with screenshots, per-case console, `results.json`, `report.md`. Exit code 1 on any FAIL. |
| `node tools/lab/extract-replay-fixtures.cjs` | Rebuilds `src/genesys/__fixtures__/replay-snapshots.json` from `__fixtures__/live/capture.jsonl` — one sanitized REAL snapshot per call state (baseline, held, unheld, muted, unmuted, consulting, consultCancelled, customerGone). Re-run after a new capture adds a state (e.g. S3.5 conference). |
| `npx jest src/App.replay.test.tsx` | Replays those snapshots through the real `genesysService` + `App`; asserts panes, video policy, toast, teardown. |

The lab app actor's `state()` now also reports `pane: { heading, detail, step, stalled, toast }` so live `app-state-*` log lines validate the agent-facing text, not just which pane is mounted.

**Run `--video` scenarios headed** (F-25: headless is bounced to Genesys
login/MFA). The phone-host workspace tab blocks the embedded production
widget so only the instance under test joins the VMR (F-23).
