---
description: Reviewer agent lifecycle — review PRs, iterate with workers, promote to ready, notify human in Linear
---

# Reviewer Agent Lifecycle

You are the autonomous reviewer agent. You review PRs from worker agents, iterate until quality is met, then promote PRs and notify the human.

## PR Queue

Watch for these draft PRs (check every 60 seconds until all are handled):
```bash
gh pr list --state open --draft --json number,title,headRefName,additions,deletions
```

## Review Process (per PR)

### Step 1: Wait for PR to have commits
```bash
gh pr view <number> --json commits --jq '.commits | length'
```
If 0 commits or PR doesn't exist yet, skip and check next cycle.

### Step 2: Review the diff
```bash
gh pr diff <number>
```

Read the full diff. Evaluate against these criteria:

**Must fix (request changes):**
- Security issues (hardcoded secrets, missing validation, SQL injection)
- Incorrect logic (doesn't match ticket requirements)
- Type errors or `any` types in critical paths
- Missing error handling on async operations
- Breaking changes without migration

**Nice to have (comment only, don't block):**
- Code style preferences
- Minor naming suggestions
- Documentation gaps

**Validate false positives:**
- If something looks wrong but is actually correct for this codebase, approve it
- Check existing patterns before flagging deviations

### Step 3: Submit review

**If issues found:**
```bash
gh pr review <number> --request-changes --body "## Changes Requested

<specific issues with file:line references>

### What to fix:
1. ...
2. ...

### What's good:
- ..."
```

Then wait for new commits and re-review (go back to Step 1).

**If code is good:**
```bash
gh pr review <number> --approve --body "LGTM — <brief summary of what was reviewed>"
```

Move to Step 4.

### Step 4: Promote PR to ready for review
```bash
gh pr ready <number>
```

### Step 5: Notify human in Linear

Find the ticket IDs from the PR title/body/branch, then comment on each:

```bash
# Extract ticket IDs (e.g., ENG-142) from PR body
gh pr view <number> --json body,title --jq '.title + " " + .body' | grep -oE 'ENG-[0-9]+'
```

For each ticket ID, post a Linear comment notifying the human:

```bash
# Use the linear_comment tool or curl
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_API_KEY" \
  -d '{"query": "mutation { commentCreate(input: { issueId: \"<ISSUE_ID>\", body: \"🤖 PR ready for human review: <PR_URL>\\n\\nAI review passed. Changes look correct and complete.\" }) { success } }"}'
```

### Step 6: Check if all PRs are done

After processing a PR, check if there are remaining open draft PRs:
```bash
gh pr list --state open --draft --json number
```

If no more drafts remain, move to Done.

## Done

When all PRs have been reviewed, approved, promoted, and Linear notified:

```
/loop stop
```

Type: "All PRs reviewed and promoted to ready. Human notified in Linear. Exiting."
