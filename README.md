# Pexip Genesys Video App

![Architecture Diagram](docs/images/01-Architecture-Diagram.png)

An Interaction Widget for Genesys Cloud that adds video to an agent's call.
When an agent takes a video interaction, the widget opens inside Agent
Workspace, resolves the Pexip Infinity room for that conversation, and joins
it over WebRTC as a video-only participant. The agent's Genesys softphone
keeps carrying the audio.

Audio for the call stays in Genesys, carried over the SIP trunk to Pexip
Infinity. That keeps audio "in-band" so the customer gets:

- The normal Genesys agent experience: hold, consult, transfer, wrap-up and
  skills-based routing all work exactly as they do for a voice call.
- Genesys recording and analytics on the audio, unchanged.
- Video as an overlay on the call, with privacy tied to the call state: when
  the call is on hold the customer cannot see the agent.

Current release: **2.0.0-rc.1** (release candidate for UAT). See
[CHANGELOG.md](CHANGELOG.md) for what changed, what was validated and the
known issues.

## How it works

| Direction | Trigger | Room | Who dials whom |
|---|---|---|---|
| Inbound | Customer's video endpoint calls the Genesys queue through Pexip | Named after the customer leg's SIP display name, prefixed with `pexipAppPrefix` | Infinity policy creates the room; the widget joins it video-only when the agent answers |
| Outbound (branch) | Agent dials the branch device number from the Genesys workspace | Named after the dialed number | Infinity policy creates the room and dials the branch device into it; the widget joins video-only |

In both cases the agent's Genesys softphone carries the audio and the widget
carries only video. The widget never opens a microphone and never plays
conference audio.

Privacy rule: the agent's video is muted whenever the call is on hold or the
widget loses its connection to Genesys call state. Muting the microphone in
Genesys mutes only the microphone. Hold is the privacy control.

## Repository layout

```
src/                  Application source (React + TypeScript)
  App.tsx             Widget orchestration: bootstrap, join, privacy, panes
  call/               Pure call logic: leg selection, identity, locks, outbound alias
  genesys/            Genesys Platform SDK wrapper and notifications transport
  media/              Local media helpers
  diagnostics/        Rolling local log and the support panel
  observability/      Structured logger
  selfview/ toolbar/ settings-panel/ error-panel/ components/
public/               Static assets copied into the build (models, wasm, IIS web.config)
dist/                 Committed production build for direct hosting
docs/                 Configuration, test plan, technical notes, support procedure
setup-validator/      Genesys Premium App setup validator
```

## Documentation

| Document | Audience | Purpose |
|---|---|---|
| [CHANGELOG.md](CHANGELOG.md) | Everyone | Release notes, validation summary, known issues |
| [docs/genesys-configuration.md](docs/genesys-configuration.md) | Genesys and Pexip administrators | OAuth client, widget URL, hosting, Infinity policy contract, branch callback number plan |
| [docs/uat-test-plan.md](docs/uat-test-plan.md) | UAT testers | Checkbox test plan for every supported scenario |
| [docs/support-diagnostics.md](docs/support-diagnostics.md) | Support | How to collect widget logs from an agent |
| [docs/technical-notes.md](docs/technical-notes.md) | Developers | Each change explained: problem, cause, fix, evidence |

## Configuration

Create a `.env` file in the project root (see `.env.example`):

```
VITE_GENESYS_OAUTH_CLIENT_ID=<Genesys OAuth client id, implicit grant>
VITE_BASE_PATH=/telecom/agent-app/
```

- `VITE_GENESYS_OAUTH_CLIENT_ID`: the OAuth client created in Genesys Cloud.
  Its authorized redirect URI must be the exact URL the widget is served
  from, including the trailing slash.
- `VITE_BASE_PATH`: the path the build will be hosted under. It is compiled
  into the asset URLs, so a build made for one path does not work at another.
  Defaults to `/telecom/agent-app/`.

The Interaction Widget URL supplies the per-call parameters:

| Parameter | Value |
|---|---|
| `pcEnvironment` | `{{pcEnvironment}}` (Genesys substitutes the region) |
| `pcConversationId` | `{{gcConversationId}}` (Genesys substitutes the conversation) |
| `pexipNode` | Pexip Infinity conferencing node the widget connects to |
| `pexipAgentPin` | Host PIN the policy assigns to agent rooms |
| `pexipAppPrefix` | Prefix added to the inbound room name (default `agent`) |
| `debug` | Optional. `1` forces verbose diagnostics on |

Full setup, including the Genesys number plan and Infinity policy the
outbound branch calls depend on, is in
[docs/genesys-configuration.md](docs/genesys-configuration.md).

## Building and running

Requires Node.js 20.19 or newer.

```
npm install
npm start          # dev server on https://localhost:3000 (self-signed cert)
npm test           # unit and replay tests (jest)
npm run lint       # eslint (TypeScript) and stylelint (SCSS)
npm run build      # type-check, then production build into dist/
```

`npm run build` reads `.env`. To build for a different client or path
without editing the file, pass the variables on the command line:

```
VITE_GENESYS_OAUTH_CLIENT_ID=<id> VITE_BASE_PATH=/telecom/agent-app/ npm run build
```

Every build stamps the widget with its version and build time. The stamp is
shown bottom-left in the widget and is included in every diagnostics export,
so support can always tell which build an agent is running.

## Deploying

The `dist/` folder is committed and is the release artifact. Host its
contents as static files at the path given by `VITE_BASE_PATH`. For IIS the
included `web.config` adds the MIME type the segmentation model needs. No
server-side code is required.

After deploying a new build, change something in the Interaction Widget URL
query string (for example bump a `v=` parameter) if agents keep seeing the
old build. Genesys and CDNs cache `index.html`.

`npm run deploy` publishes `dist/` to the `gh-pages` branch of this
repository for Pexip's own testing. It is not part of the customer
deployment.

## Testing

- `npm test` runs 174 unit and replay tests. The replay tests push real
  recorded Genesys notification sequences (sanitized) through the real
  service and application code.
- Behaviour that matters was additionally validated on the wire against a
  live Genesys org, Pexip Infinity and a SIP video endpoint. The results are
  summarized per change in [CHANGELOG.md](CHANGELOG.md) and
  [docs/technical-notes.md](docs/technical-notes.md).
- The UAT scenarios for the customer environment are in
  [docs/uat-test-plan.md](docs/uat-test-plan.md).

## Support

If an agent reports a problem, ask them to click the build stamp in the
widget and press Copy. The procedure and what the export contains (and does
not contain: no tokens, no PINs) are in
[docs/support-diagnostics.md](docs/support-diagnostics.md).

## Genesys Premium App setup validator

`setup-validator/` holds the validator Genesys provides for Premium App
setup packages:

```
cd setup-validator
npm install
npm start
```

## License

See [LICENSE](LICENSE). Based on the Pexip Genesys app example.
