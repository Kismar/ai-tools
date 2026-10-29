---
name: merge-pr
description: Settle a task PR's open questions with the owner, merge it into
  main, and clean up its branches, screenshots and issues.
disable-model-invocation: true
---

The argument is a PR number. Only the owner invokes this skill, and running it
is the owner's act of merging (ADR 0015). It merges task PRs into `main` only.
PRs into `release` belong to the `release` skill.

## 1. Read

```bash
git fetch origin
fields=state,isDraft,baseRefName,headRefName,title,labels,body
gh pr view <pr> --json $fields,closingIssuesReferences
```

Then the unresolved review threads, with the GraphQL query in step 1 of
`.claude/skills/implement-ticket/review.md`.

Stop and say why when the PR isn't open, is a draft, isn't from a `task/`
branch into `main`, or a local copy of the branch has commits
`git rev-list origin/<head>..<head>` lists.

## 2. Gate

Take each *Your call* item and each unresolved thread to the owner, one at a
time. The owner chooses:

- **Answer now.** Post the answer as a PR comment that quotes the item, so the
  decision stays with the PR.
- **Fix first.** Stop the skill and point to `implement-ticket review <pr>`.
- **Follow-up ticket.** Draft a `define` ticket: a title, the question, and
  `Refs #<pr>`. On the owner's approval of its exact text, create it and attach
  it as a sub-issue of the epic above the merged ticket:

  ```bash
  gh issue create --label define --title "..." --body-file <draft>
  gh api -X POST repos/{owner}/{repo}/issues/<epic>/sub_issues \
    -F sub_issue_id=<new issue's id>
  ```

Then ask `Merge #<pr>, <label>: <title>?`, even when there was nothing to
settle.

Done when every item has an answer or a follow-up ticket, and the owner said
yes.

## 3. Land

When `git merge-base --is-ancestor origin/main origin/<head>` fails, the branch
is behind `main`. In the task's worktree, or in a new one on `<head>`:

```bash
git rebase origin/main
pre-commit run --all-files
git push --force-with-lease
```

On a conflict or a failing hook, `git rebase --abort`, then stop and report.
Then merge:

```bash
gh pr merge <pr> --rebase
```

Done when `gh pr view <pr> --json state` says `MERGED`.

## 4. Clean up

- **Remote branch.** GitHub deletes it on merge. If
  `git ls-remote --heads origin <head>` still lists it, delete it with
  `git push origin --delete <head>`.
- **Worktree and local branch.** Find the worktree on `<head>` in
  `git worktree list --porcelain`. If `git status --porcelain` there shows
  anything, stop and report. Otherwise `git worktree remove <path>` and
  `git branch -D <head>`. The rebase-merge gave the commits new SHAs, so
  `-d` would refuse.
- **Screenshots.** If `origin/pr-assets` has a folder for the merged issue,
  remove it from the tip. The PR's SHA links keep rendering from history.

  ```bash
  git worktree add --detach ../pr-assets-<n> origin/pr-assets
  git -C ../pr-assets-<n> rm -r <n>
  git -C ../pr-assets-<n> commit -m "drop screenshots for #<n>"
  git -C ../pr-assets-<n> push origin HEAD:pr-assets
  git worktree remove ../pr-assets-<n>
  ```

- **`main`.** Fast-forward local `main` to `origin/main`.

## 5. Issues

- **Ticket.** `Closes #<n>` closed each issue in `closingIssuesReferences`.
  Close any still open, and remove their `in progress` label.
- **Parents.** When the closed ticket's parent has every sub-issue complete and
  isn't labelled `epic`, close it. Repeat one level up. An epic closes when its
  destination ships, by the owner.
- **Stale "Blocked" marks.** GitHub sometimes keeps counting a closed blocker.
  For each open issue, compare `issueDependenciesSummary.blockedBy` with its
  open blockers:

  ```bash
  gh api graphql -F owner='{owner}' -F name='{repo}' -f query='
    query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        issues(states: OPEN, first: 100) {
          nodes { number issueDependenciesSummary { blockedBy }
            blockedBy(first: 20) { nodes { number state } } }
        }
      }
    }'
  ```

  Where the count is higher, remove and re-add each closed blocker's link. The
  link stays, and the count is recomputed. The id is the blocker's REST `id`:

  ```bash
  repo='repos/{owner}/{repo}'
  gh api -X DELETE $repo/issues/<n>/dependencies/blocked_by/<id>
  gh api -X POST $repo/issues/<n>/dependencies/blocked_by -F issue_id=<id>
  ```

- **Next.** List the open `task` issues whose blockers are all closed, that
  aren't labelled `in progress`, and that no open PR closes. These are ready to
  start.

Done when the owner has a report: the merge, what was cleaned up, the issues
closed, the marks fixed, and the tickets ready to start.
