# agent-stuff

My [pi](https://github.com/badlogic/pi-mono) extensions, agents, prompts, and tmux workflow.

## Setup

```bash
# Symlink extensions
for f in pi-extensions/*.ts; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/extensions/$(basename "$f")
done

# Symlink directory extensions
for d in pi-extensions/plan-mode pi-extensions/subagent; do
  ln -sf "$(pwd)/$d" ~/.pi/agent/extensions/$(basename "$d")
done

# Symlink agents
mkdir -p ~/.pi/agent/agents
for f in agents/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/agents/$(basename "$f")
done

# Symlink prompts
mkdir -p ~/.pi/agent/prompts
for f in prompts/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/prompts/$(basename "$f")
done

# Install pi-tmux (the `pit` command)
ln -sf "$(pwd)/pi-tmux" ~/bin/pi-tmux
```

## Extensions

### Workflow

| Extension | Description |
|-----------|-------------|
| `tmux-worktrees.ts` | Tmux + git worktree integration. `/worktrees` overlay (Ctrl+Alt+W), `/split` pane with same session, ready indicator, pane lifecycle |
| `tmux.ts` | Tmux session manager. `/tmux` overlay (Ctrl+Alt+T), `tmux` tool for agent to list/kill/rename/create sessions |
| `linear.ts` | Linear ticket integration. System prompt injection, `read_linear_ticket` tool, `/ticket` overlay, footer status |
| `github.ts` | GitHub integration. `gh_pr_checks` + `gh_pr_create` (always draft) tools, CI poller with failure notifications, PR status footer |
| `git-checkpoint.ts` | Git stash checkpoints at each turn. Offers code restore on `/fork` |
| `git-impact.ts` | `git_impact` tool — dependents, test coverage, churn, authors, risk score. `file=hotspots` for most-changed files |

### Agent Capabilities

| Extension | Description |
|-----------|-------------|
| `loop.ts` | `/loop` — keep running until a condition is met (tests pass, custom condition, self-driven) |
| `review.ts` | `/review` — code review with P0-P3 severity. Supports PR, branch, commit, folder, custom. Loop fixing mode |
| `quickfix.ts` | `quickfix` tool — run a command, parse errors into structured list. `/quickfix` overlay |
| `subagent/` | Delegate to specialized subagents (scout, planner, reviewer, worker) with streaming |
| `handoff.ts` | `/handoff <goal>` — transfer context to a fresh session |
| `plan-mode/` | `/plan` — read-only exploration mode (Ctrl+Alt+P) |

### UI & Quality of Life

| Extension | Description |
|-----------|-------------|
| `command-palette.ts` | `/commands` (Ctrl+Alt+K) — searchable overlay of all commands, tools, shortcuts |
| `activity-log.ts` | `/log` — session activity: tool calls, args, success/fail, timestamps |
| `notify.ts` | Desktop notification when agent finishes (OSC 777/99) |
| `session-name.ts` | Auto-names sessions for readable `/resume` picker |

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Alt+W` | Worktrees overlay |
| `Ctrl+Alt+S` | Split pane with same session |
| `Ctrl+Alt+T` | Tmux session manager |
| `Ctrl+Alt+K` | Command palette |
| `Ctrl+Alt+P` | Toggle plan mode |

## Agents

| Agent | Purpose | Model | Tools |
|-------|---------|-------|-------|
| `scout` | Fast codebase recon | Haiku | read, grep, find, ls, bash |
| `planner` | Implementation plans | Sonnet | read, grep, find, ls |
| `reviewer` | Code review | Sonnet | read, grep, find, ls, bash |
| `worker` | General-purpose | Sonnet | all default |

## Workflow Prompts

| Prompt | Flow |
|--------|------|
| `/implement <task>` | scout → planner → worker |
| `/scout-and-plan <task>` | scout → planner |
| `/implement-and-review <task>` | worker → reviewer → worker |

## pi-tmux (`pit`)

Tmux wrapper for pi with git worktree support.

```bash
pit                          # attach to session for current branch
pit eng-155-build-kanban     # create worktree + session
pit -r                       # browse sessions (flags pass through to pi)
pit -c                       # continue last session
```

## Requirements

- [pi](https://github.com/badlogic/pi-mono) (`npm i -g @mariozechner/pi-coding-agent`)
- `tmux` 3.5+
- `gh` CLI (for GitHub extensions)
- `LINEAR_API_KEY` env var (for Linear extension)
- `allow-passthrough on` in tmux.conf (for notifications)
