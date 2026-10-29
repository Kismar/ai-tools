# Project subagent extension

This project-local Pi extension provides isolated subagents plus an explicit
`/dev-deliver` workflow entrypoint.

## Install

Trust the project in Pi, then reload extensions:

```text
/trust
/reload
```

The extension discovers project agents from `.pi/agents/`. It includes
`dev-implement` and `task-reviewer` definitions for the repository's
`dev-deliver` skill.

## Commands

```text
/dev-deliver #123
```

The command injects `skills/dev-deliver/SKILL.md` into the main agent and
requires it to use the subagent tool for implementers, fixers, and reviewers.
The skill remains the conductor and retains its setup confirmation, worktree,
durable-progress, and GitLab safeguards.

The `subagent` tool also supports direct single, parallel, and chain execution.
Use `agentScope: "both"` when invoking the project-local agents.

## Metrics

Each subagent displays elapsed duration, turns, input/output tokens, cache
usage, cost, context usage, and model. Parallel tasks update independently.
