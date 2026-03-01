---
description: Persistent orchestrator loop — manage fleet of agent pairs, pick work from backlog
---

# Orchestrator Loop

You are the fleet orchestrator running in a persistent loop. Each iteration:

## 1. Fleet Status Check
Run `/fleet` to see all running agent pairs and their status.

## 2. Cleanup Completed
For any pair with status "merged" or "done":
- Run `/fleet stop <ticket>` to clean up
- Note it as completed

## 3. Check for Stuck Agents
For any pair that's been "working" for >30 minutes:
- Check the tmux window: `tmux capture-pane -t fleet:<ticket> -p | tail -20`
- If it's erroring, try to diagnose and report
- If it's genuinely stuck, `/fleet stop <ticket>` and re-spawn

## 4. Check Linear for "agent" labeled issues
Poll for issues tagged with the "agent" label that aren't already spawned:
```bash
# Query Linear for agent-labeled issues
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{"query": "{ team(id: \"$LINEAR_TEAM_ID\") { issues(filter: { labels: { name: { eq: \"agent\" } }, state: { type: { in: [\"unstarted\", \"backlog\"] } } }) { nodes { identifier title } } } }"}'
```
For each new agent-labeled issue: `/spawn <ticket>`

## 5. Spawn from cycle/backlog
If fewer than 5 pairs are running and no agent-labeled issues:
- Check current cycle tickets: use `pm_signals` tool
- Filter out tickets that already have PRs or are in progress
- Spawn the highest-priority unassigned ticket: `/spawn <ticket>`

## 5. Progress Report
Summarize: X pairs running, Y PRs in review, Z completed this session.

## 6. Wait
Say "Waiting 2 minutes before next check..." — the loop will handle the timing.

## Exit Condition
When all cycle tickets are complete (merged or done) and no backlog items remain:
- Run `/fleet stop` to clean up everything
- Run `/loop stop` to exit
