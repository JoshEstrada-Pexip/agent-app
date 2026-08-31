# Manual validation checklist — pr1-privacy-fix

Two-person session: **Agent** (fresh Genesys account, NOT JE- AI Agent 01 —
its notification pool is exhausted until ~18:00 Sep 1) and **Partner**
(customer caller; second agent for consult/transfer tests).

The ground truth for every privacy test is the **partner's screen** — what
the customer actually sees — never the agent's UI.

## Setup (once)

- [ ] Dev server running on the agent machine: `npm start`
      (serves the pr1 branch at `https://localhost:3000`)
- [ ] Capture flag ON in `.env.local` (widget records every Genesys event —
      free evidence, writes to `src/genesys/__fixtures__/live/capture.jsonl`)
- [ ] Agent logged into **Agent Workspace** on the test account, on-queue
- [ ] Use the REAL widget inside the workspace iframe only — do NOT open
      the app in a separate tab (it would join the video room twice)
- [ ] Partner ready to dial the video queue and watch the video feed

Legend: ☐ pass ☐ fail — note anything odd in the margin, timestamps help.

## 1 · Basic call

- [ ] Call in, agent answers → both directions of video within a few seconds
- [ ] Agent's own camera button still mutes/unmutes selfview normally

## 2 · Hold (the headline fix)

- [ ] Agent holds → partner loses agent video in **under ~1 second**
      (was ~2 s live video on every hold)
- [ ] Widget shows "call on hold" state while held
- [ ] Unhold → partner sees agent video again within ~1–2 s
- [ ] Rapid hold/unhold ×3 quickly → ends in the correct final state,
      video never flashes on while held

## 3 · Mic mute (new policy: mute = fully private)

- [ ] Agent mutes mic in Genesys → partner loses agent video too
- [ ] Widget shows a "Video muted — microphone muted" banner
- [ ] Unmute → video returns
- [ ] Hold, then mute, then unhold → video **stays dark** until unmute
- [ ] Mute mic while agent's camera button is also muted, then unmute mic
      → camera stays off (app never overrides the agent's own camera mute)

## 4 · Consult

- [ ] Start consult to second agent → partner loses agent video (customer
      is held during consult)
- [ ] Cancel consult → agent + partner video restored
- [ ] Repeat, **complete** the consult (becomes transfer) → agent widget
      shows "no active call" and the **camera light turns OFF**
      (the old build kept a ghost "Connected" UI with camera live)

## 5 · Transfer / transfer back

- [ ] Blind transfer to second agent → first widget tears down cleanly
- [ ] Receiving agent: no automatic video — must open/join manually
      (known limitation, next iteration)
- [ ] Transfer back to first agent → answer → video works again
- [ ] **NOTE THE PATH**: did the transfer-back arrive as a direct transfer
      or via re-queue? If re-queue: → tell Josh, this is an open question
      about production event shapes
- [ ] **Reload test**: right after a transfer-back, F5 the workspace
      mid-call → widget rejoins with video (~15 s), does NOT show
      "No active call" (this was THE field bug)

## 6 · Double transfer — NEW GROUND, never tested

- [ ] A → B → back to A → B again, answering each leg
- [ ] Video correct for whoever holds the call at each step
- [ ] Widgets of agents who left the call are torn down (no ghost UI,
      no camera lights)
- [ ] Write down ANYTHING odd — this path has zero prior coverage

## 7 · Customer hang-up (validates the new VMR guard)

- [ ] Mid-call, partner simply hangs up → agent widget tears down to
      "no active call" within a few seconds, camera light OFF
- [ ] Repeat once while the call is ON HOLD → same clean teardown

## 8 · Wrap-up / next call

- [ ] Complete wrap-up, take a second call → fresh join works, video up
- [ ] Reload the widget mid-call on a NORMAL call (no transfer) → rejoins

## Skipped here (already covered elsewhere)

- Socket-death fail-safe: wire-validated in automation (S5.1 — mute in
  82 ms + banner + auto-reconnect)
- Alias-failure banner: unit-tested (hard to force by hand)
- Exact privacy-window timing: measured on the wire in automation (S2.1)

## After the session

- [ ] Save `src/genesys/__fixtures__/live/capture.jsonl` (event evidence)
- [ ] Report: any FAILs, the transfer-back path (direct vs re-queue), and
      double-transfer observations
