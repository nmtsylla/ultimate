# Deliberate divergences from `upstream`

`upstream` is the original repository (`HazAT/ultimate`); `origin` is this fork (`nmtsylla/ultimate`). This file lists
what the fork does differently, so an integration does not have to rediscover it from `git log` and old reports.

It is maintained, not historical: every integration adds what it found, deletes what `upstream` has taken over, and
records the reason in the same commit as the merge. `inventory.ts` in this folder reads the `**Files:**` and
`**Tests:**` lines to say which of these an incoming upstream range touches; keep that shape when you edit an entry.

- **A** entries are features this fork has and upstream does not: they must survive every merge.
- **B** entries are repairs to upstream code. Upstream may adopt one; when it has, take upstream's version, delete the
  fork's copy and its test, and drop the entry here.
- **C** entries are this project's own configuration. Upstream ships its own; never resolve a conflict by taking it.

## A. Fork features upstream does not have

### MCP OAuth sign-in

**Files:** `extensions/mcp/oauth.ts`, `extensions/mcp/server.ts`, `extensions/mcp/web.tsx`, `extensions/mcp/refs.ts`
**Tests:** `extensions/mcp/test/mcp.test.ts`
**Docs:** `extensions/mcp/README.md`
**Why:** an HTTP MCP server behind OAuth needs only its `url` — no header, no token entry. One browser sign-in stores
client registration and tokens per server URL under `~/.ultimate/mcp-oauth/<sha256(url)>.json` (0600, atomic) and
refreshes silently; the redirect can also be pasted into the chip's popover, because a loopback callback never reaches
this machine when the browser runs on another one. Actions `login`, `completeLogin`, `logout`; a `needs-login` row in
the status-line chip and the Extensions panel. Upstream's MCP has no sign-in at all.
**If it is lost:** every OAuth MCP server (this project's `atlassian`) stops connecting, and the chip's sign-in rows and
their actions disappear.

### Prewalk

**Files:** `extensions/prewalk/server.ts`, `extensions/prewalk/web.tsx`, `extensions/prewalk/refs.ts`
**Tests:** `extensions/prewalk/test/prewalk.test.ts`
**Docs:** `extensions/prewalk/README.md`, `docs/settings.md` (the prewalk key), `agents/coordinator.md` (the paragraph
about making the first representative edit)
**Why:** a one-shot model handoff: once a plan has a task, the first successful in-cwd `edit`/`write` switches the
conversation to a cheaper family with its context intact and disarms, so planning runs on the strong model and the
routine work on the fast one. New lineage branches are armed automatically unless settings say
`{ "prewalk": { "enabled": false } }`; the composer has a chip and ⌘K has a chooser. Upstream knows nothing of it.
**If it is lost:** every branch runs its whole turn on the lead model, and the settings key, chip, tool and actions go.

### Fork CLI lifecycle: background start, list, stop, foreground

**Files:** `bin/ultimate.ts`, `lib/lock.ts`, `package.json`
**Tests:** `test/lock.test.ts`, `test/e2e/project.test.ts`
**Docs:** `README.md`, `docs/running.md`
**Why:** plain `ultimate [dir]` starts a project's supervisor in the background and returns; `ultimate list` shows the
running folders with their local and current Tailscale URLs; `ultimate stop [dir]` stops one; `--foreground` keeps the
dashboard in the terminal, which is what `pnpm start` and the systemd/launchd service use. `lockHeld` in `lib/lock.ts`
tells a live supervisor from a stale pid file by opening its SQLite lock, which is what makes `list`/`stop` safe.
**If it is lost:** `ultimate` blocks the terminal for the whole session and there is no way to see or stop a project's
instance from the CLI.

### Notice split: diagnostics versus transient toasts

**Files:** `server/extensions.ts`, `extensions/fast/server.ts`, `extensions/automations/supervisor.ts`, `extensions/conversations/summary.ts`, `extensions/conversations/summary-model.ts`, `extensions/tailscale/server.ts`
**Tests:** `test/server.test.ts`, `test/events.test.ts`
**Docs:** `docs/extensions/server.md` (notice), `docs/extensions/introspection.md` where notices are described
**Why:** `notice(message, { diagnostic?, untilSecretSet? })` keeps a notice in the Extensions panel only when it names a
persistent setup problem (`diagnostic`) or clears when a secret is stored (`untilSecretSet`); everything else is a
toast, emitted once per distinct message. Upstream kept every facet notice, so a single failed operation sat in
Diagnostics for days.
**If it is lost:** the panel fills with stale one-off failures. When merging, upstream's own notice call sites come with
upstream's rule: mark the ones that report a standing setup problem (an invalid `summaryModel`, an invalid automation
manifest) `diagnostic`, and leave failed operations transient.

### Chromium resolution and the browser environment in the units

**Files:** `lib/chromium.ts`, `scripts/setup-machine.ts`, `extensions/browser/server.ts`, `test/setup.ts`
**Tests:** `test/chromium.test.ts`, `test/setup-machine.test.ts`
**Why:** the screenshot and browser tools need a Chromium, the library folder it loads from and, where the kernel
blocks unprivileged user namespaces, `--no-sandbox`. `lib/chromium.ts` resolves the binary once for the browser
extension, `pnpm setup:machine` and the tests; the rendered unit carries `ULTIMATE_CHROMIUM`, `LD_LIBRARY_PATH`
(`~/.local/lib/chrome-deps`) and `ULTIMATE_CHROMIUM_SANDBOX=0`, each only where it applies. Upstream renders the unit
without them.
**If it is lost:** a reinstall drops that environment and every screenshot times out with "No usable sandbox!" or a
missing `libatk-1.0.so.0`.

### One lander row in the sidebar

**Files:** `extensions/sidebar/listed.ts`, `extensions/sidebar/sidebar.tsx`
**Tests:** `extensions/sidebar/test/web/lander-rows.test.ts`
**Why:** the sidebar pins the lander conversation the project knows and sets older lander-labelled conversations aside,
so a project that replaced its lander does not show two pinned rows. `landerRows` and `neverConcludedStandingAgent`
live in `listed.ts` with a test; upstream pins every lander-labelled conversation.
**If it is lost:** the sidebar grows a stray pinned row per replaced lander.

### Tailscale re-serve after a machine rename

**Files:** `extensions/tailscale/server.ts`
**Tests:** `extensions/tailscale/test/tailscale.test.ts`, `test/e2e/tailscale-shutdown.test.ts`
**Docs:** `extensions/tailscale/README.md`
**Why:** `tailscale serve` state can still name a previous MagicDNS name; those entries are unreachable and their ports
would look taken, so they are dropped from the read view before the current name is served. `serve --https=<port> off`
cannot remove them — they stay until `tailscale serve reset`.
**If it is lost:** after a rename this host's own port is reported as foreign and the project never gets its HTTPS URL
back.

### A worktree whose source directory is gone

**Files:** `extensions/workspaces/workspaces.ts`
**Tests:** `extensions/workspaces/test/e2e/workspaces-integration.test.ts`
**Why:** releasing a workspace whose recorded source directory no longer exists is skipped instead of throwing, and a
workspace whose target branch is gone counts nothing as unlanded, so one deleted folder or branch cannot keep the
workspaces surface from releasing the rest.
**If it is lost:** a stale workspace makes release fail on every later attempt.

### The trace's older bound (`until`)

**Files:** `server/trace.ts`
**Tests:** `test/trace.test.ts`
**Docs:** `docs/extensions/introspection.md`
**Why:** `trace.query({ since, until })` both take exclusive ISO bounds on the millisecond a call's `at` shows, so
passing the oldest `at` you have as `until` walks the log backwards without repeating a row. Upstream's query has
`since` only.
**If it is lost:** `ultimate.trace` can only page forwards, and walking back through a long trace is impossible.

## B. Local repairs to upstream code

### Tool papercuts from real failures

**Files:** `extensions/todos/text.ts`, `extensions/todos/server.ts`, `extensions/coding-tools/server.ts`, `extensions/codemode/server.ts`, `extensions/subagents/server.ts`
**Tests:** `extensions/todos/test/todos.test.ts`, `extensions/coding-tools/test/coding-tools.test.ts`, `extensions/codemode/test/codemode.test.ts`
**Why:** each came from a measured failure on another project: the to-do limit and its message live once and the tool
names the limit on its parameter; a failed multi-hunk `edit` names the offending hunk and says nothing was written;
codemode's `project` arguments say they take a name, never a path or an id; `subagent.task` says what a brief contains.
**If it is lost:** the same four mistakes come back and the tool descriptions stop naming their limits.

### Summaries name a session

**Files:** `extensions/conversations/summary.ts`, `extensions/conversations/summary-model.ts`
**Tests:** `extensions/conversations/test/conversations-summary.test.ts`
**Why:** every summary request names the session, otherwise `opencode.ai` rejected all of them ("session not found") and
titles, abstracts and reply summaries silently fell back.
**If it is lost:** summaries fail on that provider again, quietly.

### Dream asks at most five decisions on a card

**Files:** `extensions/dream/DREAM.md`, `extensions/dream/README.md`
**Tests:** `extensions/dream/test/dream-instructions.test.ts`
**Why:** more than five questions on one card is unanswerable; the dream puts the first five on the card and the rest in
its text.
**If it is lost:** dream cards come back with a dozen questions.

### Test suite worker bounds, and tests that may launch Chromium

**Files:** `vite.config.ts`, `test/e2e/vitest.config.ts`, `test/setup.ts`
**Tests:** `test/setup-machine.test.ts` (the sandbox switch)
**Why:** this host runs short of memory: the lander runs the checks in sequence, so the fast suite keeps four workers
and the e2e suite three. `test/setup.ts` gives the tests the same Chromium sandbox switch the installed service gets,
without inheriting the live supervisor's other `ULTIMATE_*` variables.
**If it is lost:** suites OOM, and browser tests fail on a machine whose kernel blocks user namespaces.

### A trusted source copy carries no real project automations

**Files:** `test/helpers.ts`
**Tests:** `test/source-copy.test.ts`
**Why:** `sourceCopy` copies the checkout for a test server with the project's own `.ultimate/automations` left out:
with them, the sync-upstream watcher ran inside every trusted source copy and raced lineage and model assertions. Tests
that need an automation create their own fixture.
**If it is lost:** the fork's real automation runs inside every source copy, and one test's automation races another's
assertions.

## C. This project's own configuration

### `.ultimate/settings.json`

**Files:** `.ultimate/settings.json`
**Tests:** none
**Docs:** `docs/worktrees.md` (the lander runs its checks in sequence here), `.ultimate/README.md`
**Why:** the model families (`lead` on this account's strong model, `review`, `fast`), `voice-live` disabled,
`isolates.worktree.setup` installing dependencies, and the lander's checks in sequence with budgets that fit this host
(`pnpm check` 120 s, `pnpm test` 300 s, `pnpm test:e2e` 300 s) pushing to `origin`. Upstream's file configures its own
machine.
**If it is lost:** the lander runs `pnpm test` and `pnpm test:e2e` in parallel again, which is how this host ran out of
memory, and the families point at models this account has no login for.

### The review team and agent contracts

**Files:** `.ultimate/agents/reviewer.md`, `.ultimate/agents/reviewer-correctness.md`, `.ultimate/agents/reviewer-simplicity.md`, `.ultimate/agents/reviewer-architecture.md`, `agents/coordinator.md`, `agents/worker.md`
**Tests:** none
**Why:** a `reviewer` lead (`addTools: []`, `thinking: high`, `resident: false`) starts the three reviewers: correctness
on the `review` family, simplicity and architecture on `fast` (architecture at `thinking: low` and advisory), each with
`skills: []` so none loads a skill over its contract. The coordinator hands subagents sources rather than retellings, and
the worker's report names the command behind every claim. The `skills: []` allow-lists in `agents/dream-pass.md`,
`agents/reviewer.md`, `agents/scout.md` and `agents/watcher.md` are upstream's now — check they survive a merge.
**If it is lost:** review runs as one generic reviewer again, and agents start loading skills that overwrite their
contracts.

### `.nvmrc` pinning Node 26

**Files:** `.nvmrc`
**Tests:** none
**Why:** this setup's convenience beside `package.json`'s `engines.node`: the server runs `.ts` files directly and needs
Node 26 (`node:sqlite`, `import.meta.main`), so a checkout opened in a shell that picks an older Node fails on the first
import.
**If it is lost:** another checkout starts on Node 22 and the server will not boot.

### The upstream sync automation

**Files:** `.ultimate/automations/sync-upstream/run`, `.ultimate/automations/sync-upstream/automation.json`
**Tests:** none
**Why:** a supervised script merges `upstream/main` into this clone's `main` once a day at 06:00 UTC, installs packages
when the lockfile moves, pushes `origin`, wakes @ultimate only when the range needs a host restart, and probes with
`git merge-tree` first so a conflicting merge is reported once per upstream change instead of retried for eight hours.
**If it is lost:** nothing syncs, or a permanently conflicting merge retries all day.

## D. History that must not come back

**Mission Control** was its own extension, `extensions/mission-control/` (a surface, a fleet action, a test), built in
conversation 2400 (commits `d06736a6`..`22974dc3`) and removed in `d22b236b` together with the `status` fields it had
added (`url`, `setup`, `goal`), its `setup` and `goal` API additions and its `mission-control` settings key. Upstream
never had it. A merge must not resurrect the folder, the key or those fields; the `extensions/status` differences that
remain against upstream are leftovers of the removal (one README sentence and a mock parameter in its test).
