# UAT test plan — agent video widget 1.0.0-rc.1

A two-person session: **Agent** (a Genesys user with the video widget
assigned, on a WebRTC softphone) and **Partner** (the customer side: a
branch video endpoint or any SIP video endpoint that dials the normal inbound
path; a second agent for consult and transfer tests).

The ground truth for every privacy test is the **partner's screen**, what
the customer actually sees, never the agent's widget. Note the build stamp
(bottom-left of the widget) at the start of the session and on every failed
step.

Legend: ☐ pass ☐ fail. Note anything odd in the margin; timestamps help.

## Setup (once)

- [ ] Agent signed in to Agent Workspace, on queue, WebRTC phone hosted
- [ ] Widget opens inside the interaction (the Interaction Widget tab). Do
      NOT open the widget URL in a separate browser tab during a call; that
      would create a second video leg
- [ ] Build stamp visible bottom-left of the widget; record it: ________
- [ ] Partner ready to dial the video queue and watch the video feed
- [ ] Agent's auto-answer setting known (some steps need it OFF)

## 1 · Basic call

- [ ] Partner calls in, agent answers → both directions of video within a
      few seconds
- [ ] Self-view is pinned top-centre, mirrored, captioned "Customer can see
      you"
- [ ] Agent presses the toolbar camera button → self-view becomes a dark
      tile "Camera off / Customer can't see you"; partner loses agent video
- [ ] Camera button again → video back on both sides
- [ ] **Audio check**: the agent hears the partner ONLY through the Genesys
      softphone. Nothing is audible from the widget (mute the softphone for
      a moment to confirm silence)
- [ ] Screen share: the picker opens on the "Chrome Tab" pane and offers no
      "Entire screen" option; sharing a tab shows on the partner side

## 2 · Hold (the headline fix)

- [ ] Agent holds → partner loses agent video in **under ~1 second**
      (the original build streamed ~2 s of live video on every hold)
- [ ] Widget shows the "Call on hold" pane: "Your video is muted. The
      customer cannot see you."; self-view tile reads "Video muted / On
      hold"
- [ ] Unhold → partner sees agent video again within ~1–2 s; widget shows
      the toast "Video restored — the customer can see you"
- [ ] Rapid hold / unhold three times → ends in the correct final state;
      video never flashes on while held
- [ ] Hold while the agent's camera button is off, then unhold → camera
      stays off (the widget never overrides the agent's own camera mute)

## 3 · Microphone mute (mic-only by design)

Genesys mic-mute mutes only the microphone. **Hold** is the privacy control.

- [ ] Agent mutes the mic in Genesys → partner **still sees** the agent's
      video; no pane, no banner
- [ ] Unmute → nothing changes on the video side
- [ ] Hold, then mute, then unhold → video returns on unhold (mute state
      does not hold video dark)

## 4 · Consult

- [ ] Start a consult to the second agent → partner loses agent video
      (customer is held during the consult); widget shows "Consulting —
      customer on hold"
- [ ] Cancel the consult → agent and partner video restored, restore toast
      shown
- [ ] Repeat and **complete** the consult (it becomes a transfer) → first
      agent's widget shows "Call ended", camera light OFF (the original build
      kept a ghost "Connected" UI with the camera live)
- [ ] Known limitation to observe, not a failure: if the consult is joined
      as a conference, the second agent's widget also joins the video room.
      Note what each side sees

## 5 · Transfer and transfer back

- [ ] Blind transfer to the second agent → first widget tears down cleanly
      ("Call ended", camera off)
- [ ] Receiving agent answers → note whether video starts automatically or
      the widget has to be opened. Record the observation
- [ ] Transfer back to the first agent → answer → video works again
- [ ] **Note the path**: did the transfer-back arrive as a direct transfer
      or via the queue? Record it in the results table
- [ ] **Reload test**: right after a transfer-back, press F5 on the
      workspace mid-call → widget rejoins with video (~15 s) and never shows
      "No active call" (this was the original field bug)

## 6 · Double transfer

- [ ] A → B → back to A → B again, answering each leg
- [ ] Video correct for whoever holds the call at each step
- [ ] Widgets of agents who left the call are torn down (no ghost UI, no
      camera lights)
- [ ] This path has no prior automated coverage; write down anything odd

## 7 · Customer hang-up

- [ ] Mid-call, partner hangs up → agent widget shows "Call ended — video
      has been disconnected" within a few seconds, camera light OFF
- [ ] Repeat once while the call is ON HOLD → same clean teardown
- [ ] Agent completes wrap-up; the widget stays on "Call ended" until the
      next interaction

## 8 · State panes

- [ ] Auto-answer OFF. Partner calls in: while the call is ringing the
      widget says "Incoming call — answer the call in Genesys to start
      video", not "No active call"
- [ ] Open the widget on an interaction with no call → "No active call —
      waiting for a video interaction"
- [ ] During a normal join, the spinner shows its current step (checking
      camera → signing in → checking call state → locating the call →
      starting camera → joining video)
- [ ] Only if it happens: a step stuck longer than 20 s shows "Still
      connecting — stuck at: <step>" with a Reload button. Record the step
      and export the diagnostics (section 11)

## 9 · One video leg per agent (duplicate-leg fixes)

- [ ] **Miss then answer**: auto-answer OFF, let an inbound alert time out,
      go available again, answer the re-alert. Expect ONE copy of the agent
      on the partner's screen. Any earlier widget instance shows "Video is
      running in another window"
- [ ] **Reload mid-call**: F5 the workspace on a live video call → the
      duplicate disappears within a few seconds of the rejoin (partner sees
      one agent tile)
- [ ] **Two workspace tabs**: open the same interaction in two tabs → the
      newer tab holds the video, the older one shows "Video is running in
      another window". Press "Use this window for video" on the older tab →
      video moves back to it; the other tab goes passive
- [ ] **Customer endpoint named like the agent**: if a branch endpoint's SIP
      display name equals an agent's Genesys name, that endpoint is NOT
      kicked from the call
- [ ] **Hang-up with a duplicate present**: partner hangs up → widget shows
      "Call ended" and the room is gone (check in Pexip Infinity if
      available)

## 10 · Outbound branch video

Prerequisites: the Infinity policy outbound branch, the Genesys number plan,
outbound route and External Contact (see `docs/genesys-configuration.md`).
The branch device (for example extension `30005`) is registered to Pexip
Infinity and set to auto-answer.

- [ ] Agent selects a queue and dials the **bare branch number** (e.g.
      `30005`) from the workspace → the audio call connects on the softphone;
      the widget joins video-only; the branch device rings and auto-answers;
      both sides see video
- [ ] Agent hears the branch ONLY through the softphone; the widget is
      silent
- [ ] Hold / unhold on the outbound call behaves as in section 2
- [ ] Agent hangs up → widget shows "Call ended"; branch device call ends;
      room is gone
- [ ] **Device does not answer**: branch device switched off or auto-answer
      disabled; dial it → within ~15 s the widget shows "The branch video
      device did not answer. Your audio call continues on the phone line."
      with a Retry button; the audio call is still up. Power the device on,
      press Retry → video comes up
- [ ] **Callback**: on a completed inbound branch call, press the workspace
      Callback button → the bare branch number is dialed, the branch answers,
      video joins as above
- [ ] **Inbound branch call after the callback config**: the branch calls
      in normally → the widget treats it as INBOUND (video joins the inbound
      room; the policy does not dial the branch a second time)

## 11 · Diagnostics export

- [ ] Click the build stamp (bottom-left) → support panel opens with build,
      conversation id and entry count
- [ ] **Copy** works and the pasted text contains the log entries; no access
      token, PIN or query string appears in it
- [ ] Tick **Verbose logging**, reopen the interaction, reproduce any step,
      export again → debug entries and raw Genesys events are present.
      Untick afterwards
- [ ] Optional: append `&debug=1` to the widget URL for one test user and
      confirm verbose is forced on

## 12 · Wrap-up and next call

- [ ] Complete wrap-up, take a second call → fresh join works, video up
- [ ] Reload the widget mid-call on a NORMAL call (no transfer) → rejoins

## Already covered by Pexip's automated lab runs

- Socket-loss fail-safe: video muted 82 ms after the socket closed, banner
  shown, reconnect and resync in 1.7 s (lab S5.1)
- Alias-failure panel ("Video is unavailable for this call"): unit-tested;
  hard to force by hand
- Exact privacy-window timing measured on the wire (lab S2.1, S2.5)

## Results

| # | Scenario | Build stamp | Pass / Fail | Notes (path taken, timings, what each side saw) |
|---|----------|-------------|-------------|--------------------------------------------------|
| 1 | Basic call, audio check, screen share | | | |
| 2 | Hold | | | |
| 3 | Mic mute (mic-only) | | | |
| 4 | Consult | | | |
| 5 | Transfer / transfer back / reload | | | transfer-back path: direct / queue |
| 6 | Double transfer | | | |
| 7 | Customer hang-up | | | |
| 8 | State panes | | | |
| 9 | One video leg per agent | | | |
| 10 | Outbound branch video | | | |
| 11 | Diagnostics export | | | |
| 12 | Wrap-up / next call | | | |

For every FAIL: attach the diagnostics export (section 11), the Genesys
conversation id, the time, and what the partner saw.
