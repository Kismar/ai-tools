---
name: break-down
description: End a define session whose decision needs code. Draft the design
  and the task tickets in chat, then publish them as sub-issues once the owner
  approves.
disable-model-invocation: true
---

Run this after the decision is settled and written down (ADR, `CONTEXT.md`). It
covers code only. Instruction and doc changes go in the define ticket's own PR,
which then closes the define ticket.

## 1. Design

Draft two sections for the define ticket's body:

- *Decision*: what was decided, in a few lines, linking the ADR.
- *Design*: Mermaid diagrams, which GitHub renders. A before/after module
  diagram is always required: the modules added or changed, the layer each sits
  in (`domain`, `application`, `adapters`, `runtime`, `main`) and the imports
  between them, pointing inward. Add a flowchart only when the change alters how
  data moves through the application.

## 2. Slice

Cut the work into task tickets. Each one is a tracer bullet: it merges on its
own and leaves `main` green, because the hook runs the whole suite on every
commit.

- Graspable in one head: one behaviour or a tight set of them, about three *Done
  when* items, and changes in at most two layers. Split anything bigger.
- The *Interface* is decided here, as Python signatures with types. The task
  session implements behind them.
- Every *Done when* item is decidable from the ticket and the ADRs. A slice that
  still needs a choice goes back to grilling.
- Two slices that would edit the same module get a blocked-by link, even with no
  logical dependency, so unblocked siblings can run in parallel sessions without
  conflicts.

## 3. Draft in chat

Show the owner the *Decision* and *Design* text, and every ticket in full:
title, body in the shape of `.github/ISSUE_TEMPLATE/task.md`, and its blockers.
Revise until the owner approves that exact text. The approval covers that text
only. Show any later change again before publishing it.

Done when the owner has approved every ticket and both sections.

## 4. Publish

Create the tickets in dependency order, so each *Blocked by* can name real
numbers. Then link them:

```bash
gh issue create --label task --title "<title>" --body-file <body>
id=$(gh api repos/{owner}/{repo}/issues/<task> -q .id)
gh api repos/{owner}/{repo}/issues/<define>/sub_issues -F sub_issue_id=$id
gh api repos/{owner}/{repo}/issues/<task>/dependencies/blocked_by \
  -F issue_id=<blocker id>
```

Add the approved *Decision* and *Design* to the define ticket's body with `gh
issue edit <define> --body-file`.

## 5. Record

The decision PR says `Refs #<define>`, not `Closes`. The define ticket stays
open until its last sub-issue closes, and the owner closes it then. Draft the
epic's *Decisions so far* line in chat for the owner to approve. It is recorded
when the decision PR merges.
