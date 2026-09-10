# Collecting widget logs from an agent

Everything stays in the agent's browser. The widget never sends logs
anywhere: the agent copies a file and hands it over.

## What is always recorded

Every widget instance keeps a rolling log in browser storage: state
transitions, warnings and failures, with the build id and the conversation
id on every entry. A few dozen entries per call. It survives Genesys
destroying and recreating the widget between interactions, so the log of
the call being complained about is still there afterwards.

Storage is capped (the newest 500 entries per widget session, the newest 6
sessions) and is per browser, per agent. Nothing is retained server-side by
the widget.

## Asking an agent for logs

1. In the video widget, click the small grey build stamp in the
   bottom-left corner. The support panel opens.
2. Click **Copy** and paste into the ticket, or **Download** for a file.
   Copy is the reliable one: Genesys may block downloads from the widget's
   iframe. If the clipboard is blocked too, the text box at the bottom is
   already selected — Ctrl/Cmd+C works.

That is enough for most questions: which build ran, which room it joined,
why it chose that room, what failed and when.

## When normal logs are not enough

Ask the agent to turn on verbose logging, reproduce, then export:

1. Click the build stamp, tick **Verbose logging**.
2. Reload the interaction (or reopen it) so the setting takes effect.
3. Reproduce the problem.
4. Click the build stamp again, then **Copy**.
5. Untick **Verbose logging** afterwards.

Verbose adds debug-level entries and the raw Genesys notification stream,
which is enough to replay the sequence in tests
(`src/App.replay.test.tsx`).

The widget URL also accepts `&debug=1` to force verbose on for everyone —
use it for a pilot group, not for a whole contact centre.

## What the file contains

Build id, widget instance ids, conversation id, agent user id, the widget's
current state, browser and version, and the log entries.

It never contains access tokens, conference PINs or the widget's query
string: secrets are stripped by key name before an entry is stored, and the
page URL is recorded as origin plus path only.

## The other two sides

The agent's file covers what the widget decided. The rest is already
retained without the agent doing anything:

- **Pexip Infinity** keeps conference and participant history: the room,
  the legs, bandwidth and disconnect reasons.
- **Genesys** keeps the conversation: participant states, disconnect types
  and the dialed address.

Ask for the conversation id (the file has it) and pull both yourself.
