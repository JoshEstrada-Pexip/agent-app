# Genesys Cloud and Pexip Infinity configuration

Everything an administrator has to configure outside this repository for
the agent video widget to work. The SIP trunk, call queue and call flow that
carry the audio are assumed to exist already (see the Pexip Genesys
integration guide, <https://docs.pexip.com/admin/integrate_genesys.htm>);
this page covers what the widget itself depends on.

Placeholders used below:

| placeholder | meaning |
|---|---|
| `<widget-host>` | the HTTPS origin and path where `dist/` is hosted, e.g. `https://apps.example.com/telecom/agent-app/` |
| `<pexip-domain>` | the SIP domain of the customer's Pexip Infinity deployment |
| `<pexip-node>` | the FQDN of the Infinity conferencing (edge) node the widget connects to |
| `<trunk name>` | the Genesys BYOC Cloud external trunk that points at Pexip Infinity |

## 1. OAuth client (Genesys Cloud)

The widget signs the agent in with the **implicit grant** flow, using the
agent's own Genesys identity. Create (or reuse) an OAuth client of type
*Token Implicit Grant (Browser)*:

| setting | value |
|---|---|
| Grant type | Token Implicit Grant (Browser) |
| Authorized redirect URI | `<widget-host>` with a **trailing slash**, exactly the page address the widget loads from (the widget passes its own URL without the query string as the redirect URI) |
| Scopes | `users:readonly`, `conversations:readonly`, `notifications` |

Notes:

- The client id is compiled into the build as `VITE_GENESYS_OAUTH_CLIENT_ID`
  (see `README.md`). A client id for the implicit grant is public by design;
  it is not a secret.
- The widget uses the Platform API for `GET /users/me` (with
  `authorization` expanded), `GET /conversations/{id}`, notification channel
  creation and subscription to `v2.users.{id}.conversations.calls`. The
  scopes above cover exactly those calls.
- A redirect URI mismatch is the most common installation error. The widget
  reports it as "Genesys sign-in failed. Check that the OAuth client redirect
  URI matches this page address" instead of spinning.
- Every widget instance opens one notification channel. Genesys allows 20
  channels per user per OAuth client, expiring after 24 hours; an agent who
  reloads the workspace very many times in a day can exhaust that pool.

## 2. Interaction Widget

The widget is a Genesys *Interaction Widget* integration, assigned to the
group of agents who take video calls. Its URL carries the Genesys context
and the Pexip settings as query parameters. All five are required; the
widget shows "The widget is missing Pexip configuration" if any is absent.

| parameter | value | purpose |
|---|---|---|
| `pcEnvironment` | `{{pcEnvironment}}` | Genesys region, substituted by Genesys |
| `pcConversationId` | `{{gcConversationId}}` | the interaction the widget belongs to, substituted by Genesys |
| `pexipNode` | `<pexip-node>` | Infinity node used for the WebRTC video leg |
| `pexipAgentPin` | the host PIN configured in the Infinity local policy for agent legs | authenticates the widget as a host |
| `pexipAppPrefix` | the prefix the local policy expects on widget joins, e.g. `app_` | see section 4 |
| `debug` | `1` (optional) | forces verbose diagnostics on for every agent using that URL; use for a pilot group only (`docs/support-diagnostics.md`) |

Example (one line):

```
<widget-host>?pcEnvironment={{pcEnvironment}}&pcConversationId={{gcConversationId}}&pexipNode=<pexip-node>&pexipAgentPin=<pin>&pexipAppPrefix=app_
```

Interaction Widget settings: communication type **Call**, queues as
required. The widget must load inside the interaction; opened directly it
shows "This app must be opened from a Genesys interaction".

The widget runs in an iframe that Genesys sandboxes. One integration
setting controls what the iframe may do:

| setting | value | needed for |
|---|---|---|
| Iframe Feature/Permissions Policy | `camera, microphone, display-capture, clipboard-write` | camera and screen share; the Copy button in the support panel |

Without `clipboard-write` the Copy button falls back to a pre-selected
text box (Ctrl/Cmd+C still works).

Browser: Chrome (or Chromium-based Edge). The agent's WebRTC softphone must
be hosted in the same browser session.

## 3. Hosting the build

`dist/` is a static single-page build. Serve it as-is from `<widget-host>`.

- The base path compiled into the build (`VITE_BASE_PATH`, default
  `/telecom/agent-app/`) must match the path the files are served from.
  Asset URLs in `dist/index.html` are absolute under that path.
- IIS: `dist/web.config` adds the MIME mapping for `.tflite` (the background
  segmentation model). Other servers need `application/octet-stream` for
  `.tflite` and `application/wasm` for `.wasm`.
- `index.html` should be served with a short cache lifetime. The hashed
  files under `assets/` can be cached indefinitely. If a CDN or proxy caches
  `index.html`, change the widget URL's query string (for example add
  `&v=2`) after a deployment so agents pick up the new build; the build stamp
  at the bottom-left of the widget shows which build is running.
- HTTPS is required (camera access and the OAuth redirect).

## 4. Pexip Infinity local policy contract

The Infinity **local policy** creates the video room per call and is
customer configuration (service PINs, trunk numbers, node names); it is
maintained on the Management Node and delivered separately by Pexip. The
widget relies on the following contract.

### Inbound calls

The customer's video call arrives at Infinity, the policy creates a room and
sends the audio leg on to Genesys over the SIP trunk. The widget must land in
that same room:

- The widget reads the customer participant's `aniName` field in Genesys,
  which is the SIP **display name** the policy put on the trunk leg, and
  joins `<pexipAppPrefix><aniName>` on `<pexip-node>` with `pexipAgentPin`.
- The policy's widget branch (`protocol == "api"`) must therefore resolve
  `<pexipAppPrefix><name>` to the room created for the customer's call.
- The display name is independent of the caller-ID address (ANI). Changing
  how the policy formats the ANI (section 5) does not affect the inbound
  rendezvous, and must not.
- If `aniName` is empty the widget does not join a room. It shows "Video is
  unavailable for this call — audio continues on the phone line" with a
  Retry button.

### Outbound branch video

An agent dials a branch video device from the workspace. Genesys routes the
call over `<trunk name>` to Infinity; the policy's outbound branch creates a
room named after the **dialed alias** and dials the registered device into
it as an automatic participant. The widget derives the same room name from
the outbound conversation's dialed address and joins it video-only.

Policy shape (two branches above the policy's final reject, plus a
declaration beside the existing local-alias extraction):

| branch | condition | returns |
|---|---|---|
| declaration | dialed alias in the branch-device range (30000–30999) | remembers the device alias and the room name (the dialed alias) |
| trunk / endpoint | `protocol != "api"` | a conference named after the dialed alias, host PIN = `pexipAgentPin`, one automatic participant dialing `<device>@<pexip-domain>` as a guest over SIP, routed by the call routing rules |
| widget | `protocol == "api"` | the same conference name with **no** automatic participants, so the widget lands in the room the trunk call created |

Requirements:

- The branch devices are registered to Infinity with numeric aliases in the
  range 30000–30999 (`BRANCH_DEVICE_MIN`/`MAX` in `src/constants/Outbound.ts`)
  and set to **auto-answer**.
- Infinity needs a call routing rule that reaches those registered devices.
- The automatic participant fires only when the room is **created**. If the
  device is not in the room 15 s after the widget joins, the widget dials it
  once itself; if the device still does not appear the widget leaves its own
  video leg, keeps the audio call, and shows "The branch video device did
  not answer" with Retry.

Full design notes: `docs/technical-notes.md` §14.

## 5. Branch callback (Genesys number plan and outbound route)

For the workspace **Callback** button to redial a branch after an inbound
branch call, the branch's caller ID must be something Genesys can classify
and route.

### 5.1 Policy: bare device number as the ANI

The local policy must emit the inbound ANI as the bare device number,
`30005@<pexip-domain>`, not a compound such as `30005_<queue>@…`. Genesys
normalizes it to `tel:30005`. (This is the ANI address only; the display
name used for the inbound room is a separate field, section 4.)

### 5.2 Number plan

Admin → Telephony → Sites → *your site* → Number Plans. Add a plan and move
it **above** the built-in "Extension" plan (plans are evaluated top to
bottom, and Extension has no outbound route, so a branch number falling
through to it fails with "No outbound route was found matching the
classification Extension").

| field | value |
|---|---|
| Name | Branch Video |
| Match type | Regular expression |
| Match expression | `^(30\d{3})$` |
| Normalized number expression | `$1` |
| Classification | `Branch Video` (a new classification value) |

**The capture group is mandatory.** With `^30\d{3}$` (no parentheses)
`$1` resolves to an empty string. Number plans normalize **inbound** caller
ID as well as outbound dialing, so the broken plan still matches every
branch call and records its ANI as the literal `unknown`, org-wide. The
signature in analytics is inbound `ani=unknown` and callbacks dialing
`sip:unknown@localhost`. Fix the plan and the next call is correct.

### 5.3 Outbound route

Admin → Telephony → Sites → *your site* → Outbound Routes:

| field | value |
|---|---|
| Name | Branch Video |
| Classifications | Branch Video |
| External trunks | `<trunk name>` (the Pexip BYOC Cloud trunk) |

### 5.4 External Contact

The workspace callback dials the number stored on the matched **External
Contact**, not the raw ANI. Each branch's contact record must hold the bare
device number (`30005`). Whenever the ANI format changes, update the contact
records with it.

### 5.5 Dial the bare number

Agents and the callback dial `30005`, never `30005@<pexip-domain>`. The
workspace turns a SIP-style address into
`sip:30005@<pexip-domain>;language=en-US`, which the five-digit plan does
not match; the call then fails within a millisecond with
`error.ininedgecontrol.connection.dialplan.notReachable` (a Genesys routing
decision, not a trunk or Pexip failure). If the URI form is ever needed, add
a second plan above "Inbound SIP URI" with classification `Branch Video`,
match `^(30\d{3})@<pexip-domain>(;.*)?$`, normalized `$1`.

### 5.6 Verify without a live call

Admin → Telephony → Sites → *your site* → **Simulate Call**, number
`30005`. Success names the plan, the classification and the route:

```
Match found. Number plan name "Branch Video", classification "Branch Video", new URI "30005".
Match found. Outbound route name "Branch Video".
External trunk information successfully received.
```

Two lines in that output look like failures and are not:

- "The number 30005 is not an assigned DID or Extension" is expected; it is
  not a Genesys extension.
- "This Site is not associated with an Edge Group" with empty Sites and
  Edges is normal for a BYOC Cloud trunk, which has no Edges in the media
  path.

A `tel:` prefix on the caller ID in the agent's Interaction Details pane is
correct: Genesys stamps it on every address it has normalized to a number,
and it is what makes the address eligible for number-plan and route
evaluation. The widget never displays caller ID.

## 6. Screen sharing (optional Chrome policy)

The share picker is Chrome's own. The widget pre-selects the "Chrome Tab"
pane and removes "Entire screen", but a web page cannot remove "Window". To
restrict agents to sharing tabs only, push the Chrome enterprise policy
`TabCaptureAllowedByOrigins` for the widget origin.

## 7. Verifying the deployment

- [ ] Open `<widget-host>` directly in a browser: the page loads over HTTPS
      and shows "This app must be opened from a Genesys interaction". No
      404s in the browser's network tab for `assets/`, `wasm/`, `models/`.
- [ ] The build stamp (version and build time) is visible bottom-left.
- [ ] Take a test video call from the widget inside an interaction: sign-in
      completes without the redirect-URI error, video is up both ways.
- [ ] Click the build stamp and **Copy**: the export contains the build id
      and conversation id and no token.
- [ ] If outbound is configured: Simulate Call passes (section 5.6), and a
      dial to a branch number from the workspace brings the device into the
      room.
