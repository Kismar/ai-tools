---
name: release
description: Check main, build and sandbox-test a locally bumped commit, and
  only then merge it into main and release, tag it and publish the zip.
disable-model-invocation: true
---

There is no argument. Only the owner invokes this skill, and running it is the
owner's act of merging, tagging and publishing (ADR 0015). It runs in the main
checkout, not a worktree, on a clean tree.

Nothing reaches `origin` before step 7. Until then a failure or a "no" leaves
`origin` as it was.

- The **first release** is the one that makes the first GitHub release:
  `gh release list` shows none. It ships the version `pyproject.toml` already
  has, and has no bump branch.
- The **built commit** is the one step 4 builds: the tip of the local
  `bump/vX.Y.Z`, or local `main` for the first release. Neither moves until the
  last block of step 7, so a later run can still find it.
- To **drop the bump**, run `git switch main` and
  `git branch -D bump/vX.Y.Z`. The first release has nothing to drop.

Before step 1, look for a run that stopped in step 7:

```bash
git fetch origin --tags
git branch --list "bump/v*"
gh release list --limit 1
git ls-remote --heads --tags origin release "v*"
```

A local `bump/v*` branch, or no GitHub release with a `release` branch or `v*`
tag on `origin`, sends you to [Resume](#resume).

## 1. Checks

```bash
git status --porcelain
git rev-parse --path-format=absolute --git-dir --git-common-dir
git switch main
git merge --ff-only origin/main
pre-commit run --all-files
git rev-parse origin/main
```

Stop when the tree isn't clean, the two git paths differ (this is a worktree),
the fast-forward fails or the hook fails. Keep the last hash: step 7 compares
`origin/main` against it.

Then two warnings. Each one is a question to the owner. On "go on", continue.
Otherwise stop, with nothing changed.

- **Manual.** The base is the last tag on `release`, which the first release
  doesn't have:

  ```bash
  git describe --tags --abbrev=0 --match "v*" origin/release
  git diff --quiet <base> origin/main -- src/
  TZ=UTC git log -1 --date=format-local:%Y-%m-%dT%H:%M:%SZ --format=%cd <base>
  gh pr list --state merged --base main --limit 100 \
    --json headRefName,mergedAt \
    --jq '.[] | select(.headRefName | startswith("manual/")) | .mergedAt'
  ```

  Both dates are UTC in the same form, so they compare as strings. Warn when
  `git diff --quiet` fails and no `manual/*` PR was merged after the base's
  date. Without a base, `src/` counts as changed and any merged `manual/*` PR
  counts as newer. Ask:

  ```text
  src/ changed since <base> and the manual didn't. Go on without update-manual?
  ```

- **Runtime.** The newest 3.14 patch in the latest python-build-standalone
  release, then the one the build uses:

  ```bash
  gh release view --repo astral-sh/python-build-standalone --json assets \
    --jq '.assets[].name' | grep -o 'cpython-3\.14\.[0-9]*' |
    sort -uV | tail -1
  cat .python-version
  ```

  Warn when the first is newer. ADR 0015 puts a runtime bump PR (ADR 0010) into
  `main` before the release. Ask:

  ```text
  python-build-standalone has <patch>. Go on with <.python-version>?
  ```

Done when every check passed and the owner answered each warning.

## 2. Version

The first release skips this step. Its version is `uv version --short`.

Otherwise read what changed since the base:

```bash
git log --oneline <base>..origin/main
git diff <base> origin/main -- \
  src/<package>/adapters/config.py \
  src/<package>/adapters/task.xml \
  src/<package>/adapters/<downstream>.py \
  src/<package>/domain/event.py
```

Then take the highest level any change reaches, by ADR 0015 *Versions*:

- **Major.** A key removed from or renamed in `INSTALL_KEYS`, any change to
  `task.xml`, or a change to the payload the downstream system must accept.
- **Minor.** A key added to `INSTALL_KEYS`, a class added to the `Event` union
  that `Reporter` takes, or anything else new the operator can see or use.
- **Patch.** Everything else, the runtime bump included.

Before `1.0.0`, a major change is a minor bump. Propose `X.Y.Z` with the change
that set its level, and ask `Release vX.Y.Z?`.

Done when the owner confirmed a version.

## 3. Local bump

The first release skips this step.

```bash
git switch -c bump/vX.Y.Z origin/main
uv version X.Y.Z
git commit -am "bump the version to X.Y.Z"
```

`uv version` writes `pyproject.toml` and `uv.lock`. The commit goes through the
hook. If the hook fixed files, stage them and commit again. If it fails, report,
drop the bump and stop. Leave the branch unpushed.

Done when `git status --porcelain` is empty and `git diff --stat origin/main`
lists only `pyproject.toml` and `uv.lock`.

## 4. Build

```bash
uv run scripts/build_bundle.py
git rev-parse HEAD "HEAD^{tree}"
```

On a failure, report what the build printed, drop the bump and stop.

Done when `dist/<bundle>-X.Y.Z.zip` exists and you have both hashes: the
built commit and its tree.

## 5. Sandbox test

The test upgrades from the last release's zip (`scripts/README.md`, *Bundle
test*). That release is the newest on GitHub, and `<prev>` is its
version, which the first command prints with a `v` in front. Resume runs this
step before the new release exists, so the newest is still the previous one.
`gh release download` refuses a file that is already there, so clear the folder
first:

```bash
gh release view --json tagName --jq .tagName
rm -rf dist/previous/
gh release download v<prev> --pattern '*.zip' --dir dist/previous/
uv run scripts/sandbox/bundle_test.py --zip dist/<bundle>-X.Y.Z.zip \
  --previous dist/previous/<bundle>-<prev>.zip
```

The first release has no release to upgrade from. It skips the first three
commands and runs the test without `--previous`.

It takes minutes, so run it in the background. It exits 0 only when every step
in `.sandbox/out/result.toml` passed, and leaves a failed sandbox up for
inspection (`scripts/README.md`, *Bundle test*).

On a failure, report the output with `result.toml`, or `check.log` when there
is no `result.toml`, drop the bump and stop.

Done when it exited 0.

## 6. Gate

Show the owner:

- `vX.Y.Z`, and the change that set its level
- the built commit and its tree
- the sandbox result, step by step from `result.toml`, whose `upgrade` step is
  the upgrade from `v<prev>`. The first release's has none.
- one English line on what the upgrade needs, by ADR 0015 *Versions*, such as
  "Upgrade: run the new `install.bat`. `config.toml` and the task stay as they
  are."

Ask `Publish vX.Y.Z?`. The owner may rewrite the line, and their wording goes
into the release. On "no", drop the bump and stop.

Done when the owner said yes.

## 7. Publish

```bash
git fetch origin --tags
git rev-parse origin/main
```

When it differs from the hash kept in step 1, something was merged since the
checks: drop the bump and stop. A new run starts again at step 1.

Push the bump and rebase-merge it into `main`. `gh pr create` prints the PR's
URL, which `gh pr merge` takes:

```bash
git push -u origin bump/vX.Y.Z
pr=$(gh pr create --base main --head bump/vX.Y.Z \
  --title "Bump the version to X.Y.Z" --body "")
gh pr merge "$pr" --rebase
git fetch origin
```

`git rev-parse "origin/main^{tree}"` must now equal the built tree. Otherwise
stop: `main` holds something the zip doesn't, and the owner decides.

Merge `main` into `release` with a merge commit. GitHub never deletes the
default branch on merge, so `main` stays:

```bash
pr=$(gh pr create --base release --head main --title vX.Y.Z --body "")
gh pr merge "$pr" --merge --subject "vX.Y.Z" --body ""
git fetch origin
```

The first release skips the bump and both PRs, and creates `release` instead:

```bash
git push origin origin/main:refs/heads/release
```

`git rev-parse "origin/release^{tree}"` must equal the built tree. Otherwise
stop before tagging, show both trees, and leave the decision to the owner:
`release` holds something the sandbox didn't test.

Tag the merge commit and publish:

```bash
git tag -a vX.Y.Z -m vX.Y.Z origin/release
git push origin vX.Y.Z
gh release create vX.Y.Z dist/<bundle>-X.Y.Z.zip --verify-tag \
  --generate-notes --notes "<the upgrade line>"
```

`--notes` goes above the generated list. Then bring the checkout level:

```bash
git switch main
git merge --ff-only origin/main
git branch -D bump/vX.Y.Z
git ls-remote --heads origin bump/vX.Y.Z
```

The rebase-merge gave the bump a new hash, so `-d` would refuse. If `origin`
still lists the bump branch, `git push origin --delete bump/vX.Y.Z`. The first
release has no bump branch, so it only fast-forwards `main`.

Done when `gh release view vX.Y.Z` lists the zip and local `main` equals
`origin/main`. Report the version, the tag's commit, the release URL and the
PRs.

## Resume

A run that stopped in step 7 left `origin` part-way. A new run reads `origin`
and finishes from there, without steps 1 to 6.

- **A local `bump/vX.Y.Z`.** When `origin` has the branch or a PR from it
  (`gh pr list --head bump/vX.Y.Z --state all`), the version is `X.Y.Z` and the
  built commit is the branch's tip. When `origin` has neither, the run stopped
  before step 7: drop the bump and start at step 1.
- **No GitHub release, and `release` or a `v*` tag on `origin`.** The first
  release stopped. The version is `uv version --short`, and the built commit is
  local `main`.

Show the owner what is done and what is left, with a newly drafted upgrade line,
and ask `Finish publishing vX.Y.Z?`. Then do the parts of step 7 in order,
skipping each one whose check passes:

1. **Bump in `main`.** `gh pr list --head bump/vX.Y.Z --state merged` lists a
   PR. Merge an open one, and open one for a pushed branch without one. The
   first release skips this part.
2. **`release` holds the build.** `git rev-parse "origin/release^{tree}"`
   equals the built commit's tree. Before the PR into `release`, `origin/main`'s
   tree must equal it too.
3. **Tag.** `git ls-remote --tags origin vX.Y.Z` lists it.
4. **GitHub release.** `gh release view vX.Y.Z` succeeds.
5. **Checkout.** Local `main` equals `origin/main`, and any bump branch is gone
   here and on `origin`.

Step 7's check that `origin/main` hasn't moved doesn't apply, since the bump
moved it. Each tree check still stops the run, and the owner decides.

When the GitHub release is still to do and the zip is gone from `dist/`, run
Build and Sandbox test (steps 4 and 5) again first, on the tag, or on the built
commit while there is no tag. On a failure
there, report and stop, and keep the bump branch: it is how the next run finds
the version.
