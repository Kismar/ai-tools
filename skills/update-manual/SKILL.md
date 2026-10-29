---
name: update-manual
description: Bring the Czech operator manual in docs/manual/ up to date with
  the code before a release, and open a PR. Pass --full to rewrite every
  chapter.
disable-model-invocation: true
---

The manual is the only documentation client IT gets. It ships as a PDF inside
the release zip, and the operator reads it at a server with no internet access
(ADR 0014). Task tickets leave it alone, so this run is what brings it level
with the code.

The argument is empty or `--full`.

## 1. Base

```bash
git fetch origin --tags
git describe --tags --abbrev=0 --match "v*" origin/release
```

That tag is the base. Tags sit on `release`, not on `main` (ADR 0015), so
`git describe` on `main` finds none. With `--full`, or when there is no tag
yet, every chapter is in scope, and step 3 reads the whole code as it is on
`origin/main` instead of a diff.

```bash
git switch -c manual/<YYYY-MM-DD> origin/main
```

## 2. Gather

Read `CONTEXT.md` and ADR 0014, then list every operator-visible change between
the base and `origin/main`:

```bash
git log --oneline <base>..origin/main
git diff <base>..origin/main -- src/ scripts/build_bundle.py docs/adr/
gh pr list --state merged --search "merged:>=<base tag date>" --limit 100
```

An operator-visible change is one that alters what the operator types, edits,
sees or has to decide:

- an install config key added, removed or renamed, or its meaning, default or
  allowed values changed
- a `Reporter` event added, removed or renamed, or what triggers it changed
- a log line or exit code the operator would search for
- the scheduled task definition, the launcher, or the zip's layout
- what the host needs: port, accounts, rights, network access to the downstream system
- how a new version replaces the old one, and how to go back
- an ADR that changes any of the above

Refactors, tests and dev tooling are out of scope unless they change one of
these.

Done when every commit in the range is either matched to a change on your list
or confirmed as invisible to the operator.

## 3. Write

Edit only the chapters your list touches. With `--full`, write all of them.

- **`01-overview.md`**:
  - Chapter: Co aplikace dělá
  - What it holds: the data flow from its sources through the application to
    the downstream system on one page, and what the application does not do
- **`02-requirements.md`**:
  - Chapter: Požadavky
  - What it holds: Host, port 80, reaching the downstream system, the service account, the
    rights needed to create the task
- **`03-install.md`**:
  - Chapter: Instalace
  - What it holds: Unpack, fill in the install config, create the scheduled
    task, check it works
- **`04-configuration.md`**:
  - Chapter: Konfigurace
  - What it holds: Every install config key: meaning, default, allowed values,
    example
- **`05-running.md`**:
  - Chapter: Provoz
  - What it holds: Start, stop, restart, how to tell it is healthy
- **`06-logs-and-reports.md`**:
  - Chapter: Logy a hlášení
  - What it holds: Where they go, and every `Reporter` event: what it means and
    what to do
- **`07-upgrade-and-rollback.md`**:
  - Chapter: Aktualizace a návrat
  - What it holds: Deploying a new version folder and going back to the previous
    one
- **`08-troubleshooting.md`**:
  - Chapter: Řešení potíží
  - What it holds: A table of symptom, cause, action
- **`09-uninstall.md`**:
  - Chapter: Odinstalace
  - What it holds: Removing the task and the folders

How the text reads:

- Czech throughout. Each domain term is its `_Czech_` form from `CONTEXT.md`.
- Install config keys, event names, log lines, file names and commands appear
  exactly as the application and the zip have them, in English, in backticks.
- Procedures are numbered steps the operator can follow at the server: the exact
  command, the path relative to the unpacked folder, and what they should see
  when it worked.
- Describe what the code on `origin/main` does. A behaviour still waiting on a
  decision appears only once the code has it.
- The repo is client-visible, so the text carries no price, effort or internal
  risk talk.
- Run the `unslop` skill over each chapter you changed. Its patterns apply to
  Czech too.

Done when every change on your list is reflected in its chapter, and every
install config key and every `Reporter` event name in the code appears verbatim
in `docs/manual/`.

## 4. Check

```bash
uv run python scripts/build_manual.py
```

It writes `dist/provozni-prirucka.pdf`. Fix whatever it reports. Open the PDF
and check the table of contents and that the Czech characters render.

Commit once per chapter, with a one-line subject.

## 5. Hand off

```bash
git push -u origin manual/<YYYY-MM-DD>
gh pr create --title "Update the operator manual since <base>" --body-file <body>
```

The body is your list from step 2, grouped by chapter: each change with the PR
that caused it. Under it, note anything you found in the code that the operator
would need but you couldn't describe with confidence.

The owner reviews and merges, then follows the release steps in ADR 0015.
