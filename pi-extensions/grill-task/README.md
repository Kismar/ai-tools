# Grill Task

A global Pi extension that turns one feature request into small task folders.
It inspects the active repository without changing it.
It then asks one material question per turn.

The extension contains its own interview and writing rules.
It does not load planning or writing skills at runtime.

## Start

```text
/grill-task <feature request>
/grill-task Restructure @docs/plans/existing-plan.md
```

Answer each question with an ordinary reply.
Each question includes its impact, alternatives, and a recommended answer.
Exact `confirm` is reserved for the complete draft.

Stop without creating a plan:

```text
/grill-task-stop
```

## Output

The extension writes approved plans outside the repository:

```text
~/.pi/agent/task-plans/<project>/<feature>/
  README.md
  architecture.md
  tasks/
    01-<task>/
      task.md
      implementation-guide.md
```

Existing feature folders remain unchanged.
Later plans use `-v2`, `-v3`, and subsequent suffixes.

`task.md` is the authoritative implementation contract.
`implementation-guide.md` is advisory.
A material guide deviation requires a `/pair-implement` scope-change checkpoint.

After creation, the extension prints a manual handoff for a new Pi session.
It does not start implementation or record implementation progress.

## Safety

While active, the extension permits built-in inspection tools and conservative read-only shell commands.
It blocks repository mutation and unknown custom tools.
Only its approved writer can write under `~/.pi/agent/task-plans/`.

The writer validates the complete draft.
It writes to a temporary sibling folder and verifies every file.
It then renames the folder to its final name.

## Verification

```sh
node --test ~/.pi/agent/extensions/grill-task/*.test.ts
pi --no-extensions -e ~/.pi/agent/extensions/grill-task/index.ts --list-models
```

Run `/reload` after changing the extension.
