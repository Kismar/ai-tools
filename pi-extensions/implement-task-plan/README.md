# Implement Task Plan

A global Pi extension that implements every task in a plan created by `/grill-task`.

The orchestrator reads the complete plan. It delegates each task to a fresh Pi process. Each subagent receives only its assigned task, guide, relevant context, prerequisite outputs, and validation commands.

## Start

Open the repository that the plan describes. Use a named branch and a clean working tree. Then run:

```text
/implement-task-plan @~/.pi/agent/task-plans/<project>/<feature>
```

The command also accepts absolute paths and paths relative to the current repository.

To skip an already completed prefix, add `start from task N`:

```text
/implement-task-plan @~/.pi/agent/task-plans/<project>/<feature> start from task 3
```

The workflow starts with task 3 and processes every later task. Earlier tasks are outside the execution scope and count as satisfied prerequisites. You can also use an exact task ID, such as `start from task 03-add-conversation-blob-metadata`.

Stop orchestration without changing existing repository work:

```text
/implement-task-plan-stop
```

## Execution

The extension:

- validates the Grill Task folder structure
- enforces task dependency order
- starts a fresh isolated subagent for each implementation or correction attempt
- stops a subagent after 60 minutes, 10 minutes without process output, or 80 assistant turns
- permits at most two correction attempts for each task
- inherits the orchestrator model and thinking level for each subagent
- disables extensions, skills, and automatic context files in subagent processes
- supplies applicable repository rules through the task-specific context
- requires each completed subagent to report a commit hash and message
- verifies each reported commit against Git
- locks further tasks after an unverified repository change
- checks the plan digest before every task and final summary
- restricts the orchestrator shell to Git inspection and common validation commands
- leaves independent review and final validation to the orchestrator
- never pushes commits

Each subagent result shows these values in the transcript:

```text
Context: 42,100 / 1,000,000 | Tokens In: 38,200 | Tokens Out: 3,900 | Cost: $0.184200
```

`Context` is the final context size reported by that agent. Token and cost values are cumulative for that agent.

## Final summary

The final transcript summary contains:

- one usage row for every subagent attempt
- one usage row for the orchestrator
- cumulative tokens in, tokens out, and cost
- the final commit hash and message for each task
- final validation results
- deviations and remaining concerns
- branch, working-tree, commit-count, and push status

The provider and model catalogue determine cost. A provider that reports zero cost produces `$0.000000`.

## Verification

```sh
node --test ~/.pi/agent/extensions/implement-task-plan/*.test.ts
pi --no-extensions -e ~/.pi/agent/extensions/implement-task-plan/index.ts --list-models
```

Run `/reload` after you change the extension. Reloading does not apply new limits to a subagent process that is already running. Abort that run first.
