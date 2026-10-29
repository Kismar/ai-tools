# ai-tools

My [Pi](https://github.com/badlogic/pi-mono) extensions and agent skills.

## Layout

| Folder | Contents | Installed to |
| --- | --- | --- |
| `pi-extensions/` | Pi coding agent extensions, one folder each | `~/.pi/agent/extensions/` |
| `skills/` | Agent skills (`SKILL.md` format) | `~/.claude/skills/` or a project's `.claude/skills/` |

### Pi extensions

- `code-review`
- `grill-task`
- `implement-task-plan`
- `pair-implement`
- `subagent`

### Skills

A ticket-driven GitHub workflow: break a decision into task tickets, implement one, merge it, update the manual, release.

- `break-down`
- `implement-ticket`
- `merge-pr`
- `release`
- `update-manual`

## Install

The files here are copies. Copy a folder to where the agent loads it from:

```powershell
Copy-Item -Recurse pi-extensions\grill-task $HOME\.pi\agent\extensions\
Copy-Item -Recurse skills\release <project>\.claude\skills\
```
