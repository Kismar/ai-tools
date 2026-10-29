# Pair Implement

A global Pi extension for implementing one task through explicit decision checkpoints.
It is self-contained and does not load a project or user `dev-implement` skill.

## Usage

```text
/pair-implement <task prompt>
```

The extension starts in the current checkout. The agent inspects the project read-only,
then checks whether any material requirement, behavior, acceptance criterion, or constraint
is unclear. If so, it pauses for a focused Q&A before proposing implementation. It then
proposes:

- the current state and resolved clarifications or assumptions;
- implementation units and local commit structure;
- verification per commit;
- files and resulting structure;
- a local branch name;
- any difference from the request.

Clarification answers use ordinary replies; they never authorize mutation. When all
questions have a safe recommendation, reply `use recommended defaults` to accept them.
The workflow skips Q&A when repository evidence and the task are already clear.

Type exactly `confirm` to authorize the immediately preceding unchanged checkpoint.
`confirm` is reserved for checkpoints. Any other checkpoint reply is treated as feedback
and requires a revised checkpoint.

Stop without discarding local changes:

```text
/pair-implement-stop
```

## Clarification gate

Before the initial checkpoint, the agent must resolve questions from repository evidence
where possible. It asks only questions whose answers could materially change the
implementation or acceptance. After each answer it reassesses, and it cannot present the
initial checkpoint while a clarification is pending.

## Checkpoints

The workflow pauses:

1. before implementation begins;
2. before each implementation unit;
3. before a new domain rule, core control flow, or public interface;
4. whenever scope, design, sequence, or commit structure changes.

A confirmed implementation unit uses red-green-refactor where practical, runs focused
verification, self-reviews the diff, and creates a coherent local commit. Applicable full
verification runs before completion.

## Git boundary

The agent may create a local branch and local commits. It must not push or create or modify
a pull/merge request. Remote delivery remains manual.

The extension blocks direct `git push` and common provider change-request commands. This is
a workflow guard, not a security sandbox; shell indirection or an unknown provider client
cannot be classified perfectly.

## Mutation guard

Before exact confirmation, only built-in inspection tools and a conservative allowlist of
read-only shell commands are available. Unknown custom tools and shell commands are blocked
fail-closed because they may mutate files.

Confirmation authorizes one agent run. Reloading, resuming, or an agent run that ends
without completing the workflow locks mutations again and requires a fresh checkpoint.

## Verification

```sh
node --test ~/.pi/agent/extensions/pair-implement/guards.test.ts
pi --no-extensions -e ~/.pi/agent/extensions/pair-implement/index.ts --list-models
```

Run `/reload` after changing the extension.
