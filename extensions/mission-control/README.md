Mission control: one screen showing which Ultimate on this machine needs the user, and linking to the conversation that waits on them.

## What it shows

One row per project on this machine, ordered by need: the ones waiting on the user first, then running ones, then
instances that did not answer, then projects with no live server. Each row says what it waits on, and links to it:

- **question:** messages waiting on the user's answer; the oldest one's line and its conversation.
- **failure:** failed runs since the user cleared this project; how many, and the newest one's title, error and
  conversation. Clearing writes the time into the user's `cleared` marks, which the screen sends with each call.
- **provider:** a model provider whose login fails on that instance.
- **extension:** an enabled extension whose server facet failed to load.
- **setup:** setup warnings; how many, and the first one's area and summary.
- **goal:** the hands-off goal is paused, waiting on the user, with the reason @ultimate gave.

## Action

`fleet { cleared? }` → `Fleet` (contract in `refs.ts`). `cleared` maps a project root to when the user cleared its
failures (epoch milliseconds); older failures no longer count. It is validated: anything but a finite number per root
is refused.

```json
{
  "at": 1793112000000,
  "peers": [
    {
      "name": "my-app",
      "root": "/home/you/code/my-app",
      "here": false,
      "state": "running",
      "status": {
        "at": 1793111999000,
        "questions": {
          "count": 1,
          "first": { "text": "Ship it?", "conversation": 57, "message": 812 }
        },
        "busy": 1,
        "extensions": []
      },
      "seenAt": 1793112000000,
      "needs": [{ "kind": "question", "count": 1, "text": "Ship it?", "conversation": 57 }]
    }
  ]
}
```

Each need comes from a field of that instance's `status` action (`extensions/status`): `questions`, `failures`,
`providers`, `extensions`, `setup` and `goal`. Mission control reads `status` over the API of the extension that owns
each field, never its documents, so a field absent because that extension is off there simply yields no need.

## How it polls

One round asks every project at once: this instance in process through its own `status` action, every other running
project over its loopback URL (`POST http://127.0.0.1:4749/api/extensions/status/actions/status`, `Origin` set to
that URL), each with a 5 second timeout. A round is shared: a call within 15 seconds of the last round's start gets
that round's answers instead of a new poll, and a call during a round awaits the same one. A round's answers live in
process memory only, so restarting Ultimate forgets them; there is no document to keep in step.

A project that runs but did not answer is `unreachable`: it keeps its last status and needs, with `error` saying why
this round failed, such as a timeout. A project that stopped keeps nothing; it has no `status`, no needs and no
`seenAt` until it runs again, since nothing waits there.

## What it does not reach

This machine's projects only. Other machines are not polled: each instance admits its own origin, and a tagged
Tailscale host cannot authenticate to its peers. Reaching another machine's instances would need a login every
instance trusts.

## Enabling it

Off by default: a screen for the whole machine is the user's choice. Turn it on in **user** settings
(`~/.ultimate/settings.json`):

```json
{ "extensions": { "enable": ["mission-control"] } }
```

The UI is built separately; until then the action is what exists.
