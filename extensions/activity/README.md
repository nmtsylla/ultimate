The right panel's Activity tab: what happened in the project, newest first, from the durable event log.

Each event is one quiet line with an icon for its kind, what happened and its age:

- **Landing** (`workspaces.landed`): the feature tag and title it shipped, and its commit count, which opens the
  range in Review (with DiffsHub as a small ↗ beside it; without review the count links DiffsHub), as the root row's
  Landed lines do. Click opens the submitting conversation at the entry it submitted
  from.
- **Branch** (`lineage.branched`): the new branch as a conversation chip and the conversation it forked from.
- **Root** (`lineage.rooted`): the new root by its title.
- **Notice** (`ultimate.notice`): the extension and its message, amber for warnings, wrapping to two lines. It opens the
  conversation it happened in when the event's trace context names one.
- **Check** (`workspaces.check`): a lander check that failed, timed out, was flaky or ran over its budget, with its
  command. Passed checks stay out.
- **Backup** (`cloud.backup`): a finished or failed backup, with the Worker's sentence for a refused one. Started
  backups stay out.
- **Escalation** (`automations.escalated`): the automation and its reason.

Errors (failed checks and backups, escalations, error notices) get a red edge and tint, warnings (flaky or over-budget
checks, warning notices) an amber one, and the header counts them with a link to the Problems filter.

Chips filter by kind (all, landed, branches, problems) and a range keeps the last 24h, 7d (default) or all; both are
kept in UI state. Rows come from `useEvents({ events })`, which streams the root's `ultimate.event-feed` document
(the latest 100 events of every kind, so a busy hour leaves few of these). **Load older** pages back from the oldest
live one with this extension's `page { kinds, before?, since?, limit? }` action, 50 at a time, over the durable event
log; `cloud` and `automations` events are named by string, so Activity loads without those extensions. The
right panel is the place for it because the feed is project-wide, like Tasks and Agents, while the sidebar's root rows
already show each tree's own landings. `Show recent activity` in the command palette opens it.
