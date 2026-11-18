---
name: integrate-upstream
description: Merge new commits from the original repository into this fork without losing the fork's own features. Use when someone asks to update the fork, sync with upstream, merge the original repository, or when the sync-upstream automation reports that `upstream/main` conflicts with main and needs a branch.
---

# Integrate `upstream` into the fork

`upstream` is the original repository (`HazAT/ultimate`); `origin` is this fork. Main follows upstream and carries the
fork's own features on top. The `sync-upstream` automation merges a conflict-free range into main itself; every other
integration is a branch that runs this procedure, and an integration that conflicts arrives as this page.

Read `divergences.md`, next to this file, before you touch a conflict: it is the maintained list of what the fork does
differently, with the files and tests that prove it. Do not re-derive it from `git log`; correct the file instead when
the merge shows it is out of date. Read memory `host-runs-short-of-resources` for the checks.

This is integration work, not design: keep upstream's architecture and make the fork's behaviour fit it. Never drop a
fork feature, and never choose one side wholesale in a file that holds both.

## 1. Fetch and inventory

```bash
git -C <clone> fetch origin && git -C <clone> fetch upstream main
node .ultimate/skills/integrate-upstream/inventory.ts
```

It prints commits behind and ahead, the `git merge-tree` conflict list, which divergences the incoming range touches
with their tests and docs, whether the lockfile moved, and whether the landing needs a restart or a unit change. It is
read-only. `--ref <remote/branch>` reads another range.

Behind 0: there is nothing to integrate; say so and stop.

## 2. Branch

@ultimate starts the branch; never merge on main, and never rebase, reset, stash or force-push the fork's history. The
coordinator works in its own worktree, so main stays clean while the merge is resolved.

## 3. Merge

```bash
git merge --no-edit upstream/main
git diff --name-only --diff-filter=U
```

The conflict list should be what the inventory printed. If a file it called clean conflicts, stop and look: an
unrelated local edit, or a range fetched under a different base.

## 4. Resolve by class

| The conflict                                                                          | What to do                                                                                                                          |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Upstream refactored the code around a fork change (renamed, split, moved a helper)    | Take upstream's shape and re-apply the fork's behaviour on top of it — never the old file back.                                     |
| Both sides added the same thing (same fix, same setting, same option)                 | Keep one: upstream's. Delete the fork's copy and its test in the same commit, and drop its entry from `divergences.md`.             |
| A contract changed (`shared/extension-api.ts`, `ExtensionHost`, `shared/protocol.ts`) | Merge both designs: upstream's new shape, the fork's option expressed inside it. A fork option that loses its home is a bug to fix. |
| A deliberate divergence (section A of `divergences.md`)                               | The fork's behaviour wins; take upstream's surroundings and keep the entry's tests green.                                           |
| A local repair upstream has now made (section B)                                      | Take upstream's version, delete the fork's copy and its test, remove the entry.                                                     |
| This project's configuration (section C, `.ultimate/`, `agents/`)                     | Keep this project's intent; take upstream's structure if the shape changed (for example `settings.json` gained a section).          |
| Docs and `pnpm-lock.yaml`                                                             | Keep both sides' facts; a doc's conflict is a wording merge, not a "take theirs".                                                   |

Upstream's own call sites come with upstream's rules: with the notice split, a notice about a standing setup problem
(an invalid `summaryModel`, an invalid automation manifest) is `diagnostic`, and one failed operation stays transient.

## 5. Update `divergences.md` in the merge commit

- **Add** what the merge revealed: a fork-only file the inventory did not list, a test that proves a divergence, a doc
  to keep in step.
- **Delete** an entry upstream has taken over, together with the fork's code and test.
- **Amend** paths that moved, and the reason if you learned a better one.

Keep the `**Files:**`, `**Tests:**` and `**Docs:**` lines in the shape the inventory reads. This step is why the file
exists: the next integration starts from it instead of from an old report.

## 6. Packages

`pnpm install --frozen-lockfile` when `pnpm-lock.yaml` came along, before any check runs.

## 7. Checks: one heavy suite at a time

In this order, alone, never two suites at once and never beside a lander run:

1. `pnpm check`
2. the covering tests the inventory lists (`pnpm test extensions/mcp/`, `pnpm test test/trace.test.ts`, …)
3. `pnpm test`
4. `pnpm test:e2e`

A failure in a test the range did not touch, that passes alone, is host load, not a regression: prove it on the base
commit in a separate worktree (`git worktree add /tmp/base <base-sha>`, run that one test there), fix wall-clock waits
at their cause, and report it. Never retry until green, raise a test's timeout or skip it.

## 8. Preview and feature proof

On a preview (`instance start`) or the host, look at it, do not assume: the server boots, and every touched divergence
still works where it is visible — the MCP chip shows its servers and its sign-in row, the prewalk chip arms, the sidebar
has exactly one lander row, Tailscale serves the current name, the trace walk-back returns rows. Take screenshots and
check them against how the same thing looks today. State anything you could not verify.

## 9. One reviewer, then submit

One `reviewer` over the immutable `base..head` with the acceptance criteria of the merge (upstream commits in, every
divergence still proven, checks run). Verify each finding yourself before acting on it, fix or rebut it, then
`workspace submit`. Divergence in the report: what the merge needed beyond conflict resolution, and what upstream now
does differently from the fork.

## 10. After the landing

A card that says `needs restart` gets the `restart` tool for `server/`, `shared/` or packages, per
[docs/running.md](../../../docs/running.md).

When the range changed the **unit** — `scripts/setup-machine.ts`, `bin/` arguments or environment, the service files —
a restart swaps the process but cannot apply the change: run `pnpm setup:machine` on the host clone. It writes the
units, runs `systemctl --user daemon-reload`, enables and restarts the ones it replaced, and answers
`restart ultimate yourself` for the unit the command is running inside. That real service restart
(`systemctl --user restart ultimate`; on macOS `launchctl kickstart -k gui/$(id -u)/com.ultimate.app`) ends every
conversation on the host, so it is the last step of the work, or @ultimate's or the user's to do — never a surprise in
the middle of a turn. A landing concludes the branch, so when the range changed the unit, the report says plainly that
the host still needs `pnpm setup:machine` and a real service restart. Then verify it took: the supervisor is healthy, no
extension reports a load error, and one read shows the new unit (`systemctl --user show ultimate -p ExecStart`, or
`ultimate list` printing a folder).
