# Prewalk

Prewalk is a one-shot model handoff for a conversation: once a plan has at least one task, the first successful `edit` or `write` inside the conversation's own cwd switches the conversation to the armed target model, with its full context intact, and disarms — so expensive planning runs on the strong model and everything after the first real edit runs on a cheaper one.

## Arming

Arm from the browser or from the agent; both write the same `prewalk` document on the conversation.

- **Composer toolbar:** a small footprints button; while armed it reads `prewalk → fast · <modelId>` and its ✕ cancels the handoff. Clicking it opens the family chooser.
- **⌘K → Prewalk…** opens the same chooser for the shown conversation; picking a family arms it. Chooser errors (a missing login, a target that is already the conversation's model) show in the popover.
- **`prewalk` tool** (agent): `arm {action:"arm", target?}` with a family name (default `fast`) or `provider/modelId`, `disarm` cancels, `status` reads the state.
- **Actions** (browser, typed in `refs.ts`): `arm {conversation, target?}`, `disarm {conversation}`, `status {conversation}`, each returning the saved `PrewalkState`.

Arming resolves the target immediately (family → model and thinking level, clamped to what the model supports) and fails when there is no login for it or the conversation already runs exactly that model and level, which disarms instead. A preview's `instance.model` pin wins over every target, so prewalk never escapes a preview.

## The switch

The handoff fires in the tool-result round of the first call that is all of these: an `edit` or `write`, successful, on a path inside the conversation's cwd, after the plan has at least one task. Failed calls, read-only calls and calls outside the cwd do not switch. When the plan extension is disabled or absent, the first in-cwd edit alone is enough — there is no plan gate to wait for. The switch reconfigures the conversation (model and thinking level), records `{from, to, at, entry}` in the document's `switched` field and disarms, all in one commit; the models extension's switch divider above that response is the only transcript UI for it. Later runs never switch again unless the conversation is armed again.

## Automatic arming

Prewalk arms every **new lineage branch** as it is created, with the `fast` family unless settings say otherwise — existing branches never become armed retroactively. Turn it off in settings:

```json
{ "prewalk": { "enabled": false } }
```

`enabled` defaults to `true`; `target` defaults to `"fast"` and takes a family name or `provider/modelId`. Project settings apply over user settings, field by field. A target that cannot be armed (no login, unknown family) leaves the branch usable and writes a notice.
