/**
 * Workflow Chains Extension
 *
 * - /ticket-to-pr [task] — auto: scout → plan → implement → test → commit → PR
 * - /auto-implement [task] — auto: scout → plan → implement
 * - /caffeinate — toggle Mac sleep prevention
 * - Caffeinate auto-starts during agent runs (lock screen, walk away)
 */

import { spawn, type ChildProcess } from "node:child_process";

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

// ── Caffeinate ───────────────────────────────────────────────────────────────

let caffeinateProc: ChildProcess | undefined;

function startCaffeinate(): void {
	if (caffeinateProc) return;
	try {
		// -dims: prevent display sleep, idle sleep, system sleep
		caffeinateProc = spawn("caffeinate", ["-dims"], {
			stdio: "ignore",
			detached: true,
		});
		caffeinateProc.unref();
	} catch {}
}

function stopCaffeinate(): void {
	if (!caffeinateProc) return;
	try { caffeinateProc.kill(); } catch {}
	caffeinateProc = undefined;
}

// ── Chain definitions ────────────────────────────────────────────────────────

function ticketToPrSteps(task: string): string[] {
	return [
		`Use the scout subagent to investigate the codebase for: ${task}

Find relevant files, existing patterns, dependencies, and test locations. Return a compressed context summary.`,

		`Use the planner subagent with the scout's findings above to create a detailed implementation plan for: ${task}

List specific files to change, functions to modify, and the order of operations.`,

		`Use the worker subagent to implement the plan above. Make all code changes following existing patterns. Run a quick sanity check after each major change.`,

		`Use the tester subagent to write or update tests for the changes just made. Run the tests and fix any failures.`,

		`Stage all changes with git add, then use the commit-message subagent to generate semantic commit messages. Apply them.`,

		`Use the pr-writer subagent to write a PR description, then create the PR with gh_pr_create.`,
	];
}

function autoImplementSteps(task: string): string[] {
	return [
		`Use the scout subagent to investigate the codebase for: ${task}

Find relevant files, existing patterns, dependencies. Return a compressed context summary.`,

		`Use the planner subagent with the scout's findings above to create a detailed implementation plan for: ${task}`,

		`Use the worker subagent to implement the plan above. Make all code changes following existing patterns.`,
	];
}

// ── Chain runner ─────────────────────────────────────────────────────────────

async function runChain(steps: string[], ctx: ExtensionCommandContext): Promise<void> {
	for (let i = 0; i < steps.length; i++) {
		const step = steps[i]!;
		const label = `Step ${i + 1}/${steps.length}`;

		// Send the step as a user message — agent will execute it
		ctx.ui.sendUserMessage(`[${label}] ${step}`);

		// Wait for agent to finish this step before sending next
		await ctx.waitForIdle();
	}
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function workflowsExtension(pi: ExtensionAPI) {

	// ── Caffeinate: auto-start during agent runs ──────────────────────────

	pi.on("agent_start", async () => { startCaffeinate(); });
	pi.on("agent_end", async () => { stopCaffeinate(); });
	pi.on("session_shutdown", () => { stopCaffeinate(); });

	// ── Commands ──────────────────────────────────────────────────────────

	pi.registerCommand("ticket-to-pr", {
		description: "Full auto workflow: scout → plan → implement → test → commit → PR",
		handler: async (args, ctx) => {
			let task = args;
			if (!task) {
				task = await ctx.ui.input("What are we building?");
				if (!task) return;
			}
			await runChain(ticketToPrSteps(task), ctx);
		},
	});

	pi.registerCommand("auto-implement", {
		description: "Auto workflow: scout → plan → implement",
		handler: async (args, ctx) => {
			const task = args || await ctx.ui.input("What to implement?");
			if (!task) return;
			await runChain(autoImplementSteps(task), ctx);
		},
	});

	pi.registerCommand("caffeinate", {
		description: "Toggle Mac sleep prevention",
		handler: async (_args, ctx) => {
			if (caffeinateProc) {
				stopCaffeinate();
				ctx.ui.notify("☕ OFF — Mac can sleep", "info");
			} else {
				startCaffeinate();
				ctx.ui.notify("☕ ON — Mac stays awake", "info");
			}
		},
	});
}
