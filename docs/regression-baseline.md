# Regression baseline (2026-10-01)

The state of the app before work starts on the consult video-resume defect.
Use it as the "must not lose" list: every behaviour below works today, and a
change is not done until it still does.

## 1. Snapshot

| Item | Value |
|---|---|
| Commit | `90dc38d` on `main` (= `origin/main`), version `2.0.0-rc.1` |
| Runtime | Node v26.0.0, `@pexip/infinity` 23.0.0, `purecloud-platform-client-v2` ^227 |
| Unit/integration tests | **175 passed / 175**, 17 suites (`npm test`) |
| TypeScript | clean (`npx tsc --noEmit`) |
| Lint | clean (`npm run lint`, max-warnings 0) |

Re-run the baseline:

```sh
npm test && npx tsc --noEmit && npm run lint
```

The `console.error` lines `video-restored … "no privacy cause"` and the React
`act(...)` warnings in the test output are pre-existing noise, not failures.

## 2. Behaviour matrix

"Auto" = covered by automated tests (file › test). "Live" = validated against
a real Genesys org + Infinity + SIP endpoint (see `docs/technical-notes.md`).

### 2.1 Call lifecycle

| # | Behaviour | Auto | Live |
|---|---|---|---|
| L1 | Inbound connect joins the VMR exactly once, even under event bursts | App.test › Video leg ownership › joins the VMR exactly once | yes |
| L2 | Connect fires only on the false→true transition, and only when the agent has no `consultParticipantId` | genesysService.test › addConnectCallListener | yes |
| L3 | Customer hang-up ends the call and destroys the VMR (`disconnectAll`) | genesysService.test › addEndCallListener (customer disconnected); App.replay › `customerGone` | yes |
| L4 | Customer in a transient non-connected state does NOT end the call | legSelection.test › customerLegGone; genesysService.test › transient state | unit only |
| L5 | Agent `client` disconnect ends the call; disconnect-all only if no other agent is connected | genesysService.test › agent disconnects; App.test › Agent disconnect behavior | yes |
| L6 | `transfer.*` / `peer` disconnect: only this agent leaves, VMR survives | genesysService.test › transfer (blind and consult) | yes (S3.2, S4.6) |
| L7 | Reload after transfer-back picks the live leg, not a stale one (F-19) | legSelection.test › selectMyLeg | yes (S4.6) |
| L8 | Events for other conversations are dropped | — (counter only) | yes |
| L9 | "Incoming call" pane while my leg is alerting | App.test › shows "Incoming call" | — |
| L10 | Active-call gate: no ghost "Connected" UI / camera after consult complete | — (only `isCallActive` unit, genesysService.test) | yes (S3.2) |

### 2.2 Hold and video privacy

| # | Behaviour | Auto | Live |
|---|---|---|---|
| P1 | Hold mutes video **immediately** | genesysService.test › addHoldListener; App.replay › `held` | yes (S2.1, <1 s) |
| P2 | Unhold restores video only after a 750 ms settle window, then shows the "Video restored" toast | genesysService.test › resume; App.replay › `unheld` | yes (S2.1) |
| P3 | Mic-mute is mic-only: no pane, no banner, `muteVideo` never called | App.replay › `muted`/`unmuted` | pending (S2.5/S2.6) |
| P4 | Privacy fails toward muted: retries, then forces `muteVideo(true)` + banner | — | — |
| P5 | Never un-mutes over the agent's own camera mute | — | — |
| P6 | Join-time pre-mute, then settle against REST hold state | — (exercised by every App.test join, not asserted) | yes (S2.1 join) |
| P7 | Notification socket loss mutes video (fail-safe) and resyncs from REST on reconnect | — (App wiring) | yes (S5.1, 82 ms / 1.7 s) |

### 2.3 Consult (the area under change)

| # | Behaviour | Auto | Live |
|---|---|---|---|
| C1 | Consult started by me → "Consulting — customer on hold", video muted | genesysService.test › consulting (x2); App.replay › `consulting` | pending (S3.1 wording) |
| C2 | Being consulted → hold(true, 'consulting') | genesysService.test › being consulted | — |
| C3 | Held agent starts a consult → reason re-emitted as 'consulting' | genesysService.test › re-emit hold(true) | — |
| C4 | Consult **cancelled before answer** → video restored + toast | App.replay › `consultCancelled` | — |
| C5 | Consult **completed** (transfer) → this agent leaves, VMR survives | genesysService.test › transfer | yes (S3.2) |
| C6 | Consulted/conferenced second agent is audio-only (by design this phase) | — | — |
| C7 | Consult answered (audio), agent returns to member → video resumes (external, voicemail or agent target) | genesysService.test › consult to an external target (x4); App.replay › `consultExternalActive` … `consultTargetGone` | yes (S3.6, S3.7, 2026-10-02) — fixed, technical-notes §18 |

### 2.4 Video leg ownership, outbound, UI, diagnostics

| # | Behaviour | Auto |
|---|---|---|
| V1 | Call tag carries user + conversation + instance identity | App.test › sends its identity; legIdentity.test |
| V2 | Kicks only my OLDER ghost legs, never other agents / SIP rooms | App.test › kicks my OLDER ghost legs; kicks a ghost that appears later |
| V3 | One leg per agent per call (Web Locks), visible-window takeover once per call | App.test › stays out / VISIBLE window / only ONCE; videoLegLock.test |
| V4 | Steps aside when Infinity says another participant removed it; rejoins once after unexpected drop | App.test |
| V5 | Repeated end-of-call snapshot talks to Infinity once | App.test |
| O1 | Outbound joins rendezvous alias, dials the branch device once, refuses video if device never joins | App.test › Outbound dynamic VMR; outboundAlias.test; deviceRoster.test |
| A1 | Widget never plays audio (tracks dropped + muted element) | dropAudio.test |
| U1 | Bootstrap failure classification + connecting watchdog | App.test › Bootstrap |
| U2 | Error panels (camera, permission, Infinity, conference, PIN, ANI) | App.test › Error panel; ErrorPanel.test |
| U3 | Settings, effects, self-view, toolbar | SettingsPanel / EffectButton / SelfView / Toolbar tests |
| D1 | Diagnostics store, logger redaction, capture tool | diagnostics / logger / capture tests |

## 3. Current consult/hold rules (as coded)

All in `callsCallback`, `src/genesys/genesysService.ts`:

- **My leg**: `selectMyLeg` = newest connected leg of mine, else newest non-terminated.
- **isConsulting** = `myLeg.attributes.consultInitiator === 'true'`
  OR (`myLeg.consultParticipantId` set AND more than one connected agent-purpose leg).
- **effectiveHoldState** = `true` if isConsulting AND no connected agent-purpose leg is `confined`;
  otherwise `myLeg.held`.
- Hold → `handleHold(true, reason)` immediately. Unhold → `handleHold(false)` after 750 ms if still unheld.
- **connected** (join trigger) additionally requires `myLeg.consultParticipantId === undefined`.
- **REST path** `getMyCallState()` (reconnect/bootstrap): `active` excludes consulting, but its
  isConsulting is defined differently (`consultParticipantId` set AND NOT initiator), and `held`
  reads `calls[].held` only, with no consult override.

App side (`src/App.tsx`): `onHoldVideo` sets `privacyRef.held`, then `applyVideoPrivacy` un-mutes
only if `isActive()`, not connection-lost, and the agent has not muted their own camera.

## 4. Fixture coverage

Recorded snapshots (`src/genesys/__fixtures__/replay-snapshots.json`, 2026-08-28): `baseline`,
`held`, `unheld`, `muted`, `unmuted`, `consulting` (consult target still **alerting**),
`consultCancelled`, `customerGone`.

**Not captured.** Every step of the field defect is missing:

1. Consult target **answers** (agent extension, and Genesys external contact).
2. Agent toggles back to the member ("speak to customer"), consult still up.
3. Consulted party hangs up → agent back with member alone.
4. Agent ends the consult leg themselves.
5. Conference (join all), lab S3.5.

## 5. Open observations for the fix (unconfirmed)

These are leads, not conclusions. Confirm them with captured snapshots before changing code.

- `consultInitiator: 'true'` alone forces held. If Genesys leaves that attribute on my leg after
  the consult ends, or while I am back with the member, video can never resume (C7).
- The "confined" escape hatch only looks at **agent-purpose** legs. A consult to an external
  contact or a video extension is likely `external`/far-end purpose, so its `confined` flag is
  never seen.
- The REST and event paths disagree on what "consulting" means (see §3), so a reload or
  socket reconnect mid-consult may settle to a different state than live events do.

## 6. Change protocol for this fix

1. Capture the real event sequence for §4 items 1–4 with `VITE_CAPTURE_EVENTS=true`
   (`__captureMark("C7 …")`, `__captureDumpAll()`). Sanitize, then add to the fixtures.
2. Add a failing replay test for C7 first, then fix.
3. Done means: all 175 baseline tests still pass, new tests pass, `tsc` and lint are clean, and
   the "Live" rows touched by the change (P1, P2, C1, C4, C5) are re-run on the lab network.

**Untested rules worth guarding while in this code:** P4 (fail toward muted), P5 (camera-mute
guard), P6 (join pre-mute), P7 (socket fail-safe), L10 (active-call gate). None has a direct
assertion today. A fix to the hold path can break them silently.

## 7. Outcome (2026-10-02)

C7 reproduced in the lab (S3.6), fixed in one rule in `callsCallback`, and
re-validated on the wire; see `docs/technical-notes.md` §18 and
`docs/lab-findings.md` F-30. The first two leads in §5 were confirmed (the
consult flags stay set while back with the member, and an external target is
not an agent leg). The third (REST vs event disagreement) is real and still
open. Baseline is now 179 tests. Live rows re-run on the fixed build: P1, P2
(S2.1), C1, C4 (S3.1), C7 (S3.6, S3.7). C5 (S3.2) was not re-run.
