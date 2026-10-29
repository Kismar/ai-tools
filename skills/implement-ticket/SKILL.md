---
name: implement-ticket
description: Implement one task ticket from issue to open PR, or address the
  owner's review on that PR.
disable-model-invocation: true
---

The argument is an issue number, or `review <PR number>`. For `review`, follow
[review.md](review.md) instead of the steps below.

The ticket is the approved plan. Its *Interface* is the interface, and its *Done
when* items are the behaviours to build. What you may change without asking is
in `AGENTS.md` under *What you may do*.

## 1. Read

Read the issue (`gh issue view <n> --comments`), its parent's *Decision* and
*Design*, every doc under *Read first*, and `CONTEXT.md`.

Stop and end the session, with a comment on the issue saying why, when:

- *Blocked by* names an issue that is still open
- the issue is labelled `in progress`, so another session has it
- a *Done when* item can't be tested through the *Interface* as written
- a *Done when* item needs a decision that neither the ticket nor an ADR makes

Done when you can name, for each *Done when* item, the *Interface* function its
test will call.

## 2. Branch

```bash
git fetch origin
git switch -c task/<n>-<slug> origin/main
gh issue edit <n> --add-assignee @me --add-label "in progress"
```

If you stop from here on, remove the label with the comment that says why
(`gh issue edit <n> --remove-label "in progress"`). The owner stays assigned.

## 3. Loop

Use the `tdd` skill. The ticket replaces its planning step: skip the
confirmation and start on the first tracer bullet.

Tests:

- Test each *Done when* behaviour through the public interface of its module: a
  domain module's public functions, an application step called with the fakes in
  `tests/fakes.py`, an adapter against the real library or a fake of the
  downstream system, or the whole application in `tests/e2e/` (ADR 0013).
- Write about one test per *Done when* item. Add a case only where the logic
  branches.
- Leave constants, dataclass fields and defaults, private helpers and wiring
  without tests of their own, along with anything basedpyright or the
  architecture test already checks.

Commit once per behaviour, when it is green and refactored, with a one-line
subject.

A slice with no behaviour (config, tooling, docs) skips `tdd`. Do each *Done
when* item and run the check the item names.

Done when every *Done when* item has a passing test, or a passing named check,
on the branch.

## 4. Self-review

Run the `code-review` skill with fixed point `origin/main` and issue `#<n>` as
the spec. Fix the findings you agree with, in new commits. Note each finding you
leave, with the reason.

Done when every finding is either fixed or noted.

## 5. Screenshots

Only when the change shows a GUI. Run it from the branch and capture each state
the change touches as a PNG of the window, with PowerShell's `System.Drawing`
(`Graphics.CopyFromScreen` over the window's rectangle). A state behind UAC
needs the owner's hands: list it under *Your call*.

Commit them to the orphan `pr-assets` branch, in a folder named for the issue,
from a worktree of their own:

```bash
git fetch origin pr-assets
git worktree add --detach ../pr-assets-<n> origin/pr-assets
# copy the PNGs into ../pr-assets-<n>/<n>/
git -C ../pr-assets-<n> add <n>
git -C ../pr-assets-<n> commit -m "screenshots for #<n>"
git -C ../pr-assets-<n> push origin HEAD:pr-assets
git -C ../pr-assets-<n> rev-parse HEAD
git worktree remove ../pr-assets-<n>
```

Embed each as `![<what it shows>](<repo>/blob/<sha>/<n>/<name>.png?raw=true)`,
where `<repo>` is the URL `gh repo view --json url -q .url` prints and `<sha>`
is that commit, so the image outlives the folder.

Done when every GUI state the change touches is either embedded or listed under
*Your call*.

## 6. Hand off

Push the branch and open the PR, titled with the issue's title and labelled
with its attention level:

```bash
git push -u origin task/<n>-<slug>
gh pr create --title "<issue title>" --label <scrutinize|review|skim> \
  --body-file <filled template>
```

Fill `.github/pull_request_template.md` from the code on the branch, after the
self-review. Its comments define each section and the attention levels. Trace
the diagram through the actual functions, tagged against `origin/main`. For
*Blast radius*, group `git diff --stat origin/main...` by layer (`domain`,
`application`, `adapters`, `runtime`, `main`, `tests`, `scripts`).

The owner reviews and merges, with `merge-pr` or by hand. Your session ends at
the open PR.
