---
description: Full ticket-to-PR workflow: scout → plan → implement → test → commit → PR
---

Run this as a chain:

1. **scout**: Investigate the codebase for {task}. Find relevant files, existing patterns, and dependencies. Return a compressed context summary.

2. **planner**: Using the scout's findings, create a detailed implementation plan for {task}. List specific files to change, functions to modify, and the order of operations.

3. **worker**: Implement the plan. Make all code changes, following existing patterns. Run a quick sanity check after each major change.

4. **tester**: Write or update tests for all changed code. Run the tests and fix any failures.

5. **commit-message**: Stage all changes and generate semantic commit messages.

6. **pr-writer**: Write a PR description summarizing what was done and why.
