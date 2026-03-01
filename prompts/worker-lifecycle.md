---
description: Worker agent lifecycle — implement tickets, create PR, iterate on review, close session when done
---

# Worker Agent Lifecycle

You are an autonomous worker agent. Follow this lifecycle exactly.

## Phase 1: Implement

1. Read `.pi/task.md` for your ticket assignments
2. For each ticket, in order:
   - Read the relevant source files to understand the codebase
   - Implement the changes
   - Run `bun run typecheck` (fix errors before moving on)
   - Commit with conventional format: `type(scope): description (TICKET-ID)`
3. After all tickets are done, move to Phase 2.

## Phase 2: Create PR

1. Push your branch:
   ```
   git push -u origin <branch-name>
   ```
2. Create a draft PR using the `gh_pr_create` tool with a descriptive title and body listing all tickets.
3. Move to Phase 3.

## Phase 3: Review Loop

After creating the PR, enter a review feedback loop:

1. Wait ~60 seconds for the reviewer to look at it
2. Check your PR status:
   ```bash
   gh pr view --json state,reviews,comments,reviewDecision
   ```
3. Based on the result:
   - **No reviews yet** → wait another 60 seconds, check again (max 10 tries)
   - **`CHANGES_REQUESTED`** → read the review comments:
     ```bash
     gh pr view --json reviews --jq '.reviews[-1].body'
     gh api repos/{owner}/{repo}/pulls/{number}/comments --jq '.[].body'
     ```
     Fix each issue, commit, push. Go back to step 1.
   - **`APPROVED`** → Move to Phase 4.
   - **PR is `MERGED`** → Move to Phase 4.

## Phase 4: Done

Your work is complete. Run this command to exit cleanly:
```
/loop stop
```

Then type: "All tickets complete. PR approved/merged. Exiting session."

The orchestrator will clean up your tmux session.
