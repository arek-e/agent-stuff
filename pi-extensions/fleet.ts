/**
 * Fleet Orchestrator Extension
 *
 * Commands:
 *   /spawn <ticket>       — Spin up worker+reviewer pair for a ticket
 *   /spawn-cycle          — Spawn pairs for all tickets in the current cycle
 *   /spawn-backlog <n>    — Spawn top N RICE-scored backlog items
 *   /fleet                — Show status of all running agent pairs
 *   /fleet stop           — Stop all agent sessions
 *   /fleet stop <ticket>  — Stop a specific ticket's sessions
 *
 * Each ticket gets a tmux window with split panes:
 *   Left pane  = worker (implements the ticket)
 *   Right pane = reviewer (reviews the PR)
 */

import { spawnSync, execSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

// ── Config ───────────────────────────────────────────────────────────────────

const PIT = "/Users/alex/bin/pi-tmux";
const WORKTREE_BASE = `${process.env.HOME}/projects/v2`;
const FLEET_SESSION = "fleet";    // tmux session that holds all ticket windows
const BOOT_DELAY = 12;            // seconds to wait for pi to boot
const MAX_CONCURRENT = 5;         // max simultaneous pairs

// Resolve the project repo root — prefer teampitch, fall back to git root of cwd
function resolveProjectRoot(cwd: string): string {
	// Check if teampitch exists (our main project)
	const teampitch = `${process.env.HOME}/projects/teampitch`;
	if (existsSync(`${teampitch}/.git`)) return teampitch;
	return gitRoot(cwd);
}

// ── Types ────────────────────────────────────────────────────────────────────

interface AgentPair {
	ticket: string;
	title: string;
	branch: string;
	worktree: string;
	window: string;
	startedAt: number;
	status: "working" | "pr-created" | "in-review" | "approved" | "merged" | "done" | "error";
}

// ── State ────────────────────────────────────────────────────────────────────

const pairs = new Map<string, AgentPair>();

// ── Helpers ──────────────────────────────────────────────────────────────────

function resolveSecret(name: string): string | undefined {
	if (process.env[name]) return process.env[name];
	try {
		const r = spawnSync("security", ["find-generic-password", "-a", process.env.USER!, "-s", name, "-w"],
			{ encoding: "utf-8", timeout: 3000 });
		if (r.status === 0 && r.stdout.trim()) {
			process.env[name] = r.stdout.trim();
			return r.stdout.trim();
		}
	} catch {}
	return undefined;
}

function linearQuery(query: string): any | null {
	const key = resolveSecret("LINEAR_API_KEY");
	if (!key) return null;
	try {
		const r = spawnSync("curl", [
			"-s", "-X", "POST", "https://api.linear.app/graphql",
			"-H", "Content-Type: application/json",
			"-H", `Authorization: ${key}`,
			"-d", JSON.stringify({ query }),
		], { encoding: "utf-8", timeout: 15000 });
		if (r.status !== 0) return null;
		return JSON.parse(r.stdout).data;
	} catch { return null; }
}

function gitRoot(cwd: string): string {
	try {
		const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf-8", timeout: 2000 });
		return r.status === 0 ? r.stdout.trim() : cwd;
	} catch { return cwd; }
}

function tmux(...args: string[]): { ok: boolean; output: string } {
	const r = spawnSync("tmux", args, { encoding: "utf-8", timeout: 5000 });
	return { ok: r.status === 0, output: (r.stdout || "").trim() };
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function ticketToBranch(ticket: string): string {
	return `agent/${ticket.toLowerCase()}`;
}

function ticketToWorktree(ticket: string): string {
	return `${WORKTREE_BASE}/tp-${ticket.toLowerCase().replace("-", "")}`;
}

// ── Core: Spawn a worker+reviewer pair ───────────────────────────────────────

async function spawnPair(
	ticket: string,
	title: string,
	description: string,
	cwd: string,
	ctx: ExtensionContext,
): Promise<boolean> {
	const root = resolveProjectRoot(cwd);
	const branch = ticketToBranch(ticket);
	const worktree = ticketToWorktree(ticket);
	const windowName = ticket.toLowerCase();

	// 1. Detect default branch
	let defaultBranch = "main";
	try {
		const r = spawnSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"], {
			cwd: root, encoding: "utf-8", timeout: 3000,
		});
		if (r.status === 0 && r.stdout.trim()) {
			defaultBranch = r.stdout.trim().replace("origin/", "");
		}
	} catch {}

	// 2. Create worktree
	if (!existsSync(worktree)) {
		const r = spawnSync("git", ["worktree", "add", worktree, "-b", branch, defaultBranch], {
			cwd: root, encoding: "utf-8", timeout: 10000,
		});
		if (r.status !== 0) {
			ctx.ui.notify(`Failed to create worktree: ${r.stderr}`, "error");
			return false;
		}
	}

	// 2. Install deps
	spawnSync("bun", ["install", "--frozen-lockfile"], { cwd: worktree, encoding: "utf-8", timeout: 60000 });

	// 3. Write task file
	const taskDir = `${worktree}/.pi`;
	mkdirSync(taskDir, { recursive: true });
	writeFileSync(`${taskDir}/task.md`, `# Agent Task: ${ticket}

## Ticket: ${ticket} — ${title}

${description}

---

## Lifecycle

### Phase 1: Implement
1. Read the codebase — understand existing patterns before changing anything
2. Implement the changes described above
3. Run \`bun run typecheck\` — fix errors before committing
4. Commit: \`feat/fix(scope): description (${ticket})\`

### Phase 2: Create PR
1. Push: \`git push -u origin ${branch}\`
2. Create draft PR with the \`gh_pr_create\` tool

### Phase 3: Review Loop
After creating the PR, enter review feedback loop:
1. Check: \`gh pr view --json reviewDecision,reviews\`
2. CHANGES_REQUESTED → read comments, fix, push, wait for re-review
3. APPROVED → move to Phase 4
4. If no reviews after 5 minutes, continue waiting

### Phase 4: Done
\`/loop stop\`
`);

	// 4. Ensure fleet tmux session exists
	const { ok: sessionExists } = tmux("has-session", "-t", FLEET_SESSION);
	if (!sessionExists) {
		tmux("new-session", "-d", "-s", FLEET_SESSION, "-c", worktree, "-n", windowName);
	} else {
		tmux("new-window", "-t", FLEET_SESSION, "-n", windowName, "-c", worktree);
	}

	// 5. Start worker in left pane
	tmux("send-keys", "-t", `${FLEET_SESSION}:${windowName}`, `cd ${worktree} && ${PIT}`, "Enter");
	await sleep(BOOT_DELAY * 1000);

	// Send task to worker
	tmux("send-keys", "-t", `${FLEET_SESSION}:${windowName}`,
		`Read .pi/task.md and implement ${ticket}. Follow the lifecycle exactly — implement, create PR, then enter review loop. When approved, /loop stop.`, "Enter");
	await sleep(2000);
	tmux("send-keys", "-t", `${FLEET_SESSION}:${windowName}`, "/loop auto", "Enter");

	// 6. Split pane for reviewer
	tmux("split-window", "-h", "-t", `${FLEET_SESSION}:${windowName}`, "-c", worktree);
	tmux("send-keys", "-t", `${FLEET_SESSION}:${windowName}.1`, `cd ${worktree} && ${PIT}`, "Enter");
	await sleep(BOOT_DELAY * 1000);

	// Send reviewer task
	tmux("send-keys", "-t", `${FLEET_SESSION}:${windowName}.1`,
		`You are the reviewer for ${ticket}. Read .pi/task.md to understand the ticket. Wait for a draft PR on branch ${branch}, then review it. Use 'gh pr list --state open --draft' to find it. Review the diff with 'gh pr diff'. If issues: gh pr review --request-changes. If good: gh pr review --approve, then use gh_pr_ready tool with ticketIds ["${ticket}"] to mark ready and notify in Linear. When done, /loop stop.`, "Enter");
	await sleep(2000);
	tmux("send-keys", "-t", `${FLEET_SESSION}:${windowName}.1`, "/loop auto", "Enter");

	// 7. Track the pair
	pairs.set(ticket, {
		ticket,
		title,
		branch,
		worktree,
		window: windowName,
		startedAt: Date.now(),
		status: "working",
	});

	return true;
}

// ── Core: Get ticket info from Linear ────────────────────────────────────────

function fetchTicket(identifier: string): { title: string; description: string } | null {
	const data = linearQuery(`{ issue(id: "${identifier}") { title description } }`);
	return data?.issue ? { title: data.issue.title, description: data.issue.description || "" } : null;
}

function fetchCycleTickets(): Array<{ identifier: string; title: string; description: string }> {
	const teamId = resolveSecret("LINEAR_TEAM_ID");
	if (!teamId) return [];
	const data = linearQuery(`{
		team(id: "${teamId}") {
			activeCycle {
				issues(filter: { state: { type: { in: ["backlog", "unstarted"] } } }) {
					nodes { identifier title description }
				}
			}
		}
	}`);
	return data?.team?.activeCycle?.issues?.nodes || [];
}

function fetchTopBacklog(n: number): Array<{ identifier: string; title: string; description: string }> {
	const teamId = resolveSecret("LINEAR_TEAM_ID");
	if (!teamId) return [];
	const data = linearQuery(`{
		team(id: "${teamId}") {
			issues(first: 50, filter: {
				state: { type: { in: ["backlog", "unstarted"] } }
			}, orderBy: updatedAt) {
				nodes { identifier title description priority }
			}
		}
	}`);
	const nodes: Array<{ identifier: string; title: string; description: string; priority: number }> = data?.team?.issues?.nodes || [];
	// Sort by priority client-side (1=urgent, 2=high, 3=medium, 4=low, 0=none→last)
	nodes.sort((a, b) => (a.priority || 99) - (b.priority || 99));
	return nodes.slice(0, n);
}

// ── Core: Check fleet status ─────────────────────────────────────────────────

function refreshPairStatus(cwd: string): void {
	for (const [ticket, pair] of pairs) {
		// Check if PR exists
		const prResult = spawnSync("gh", ["pr", "list", "--head", pair.branch, "--json", "number,state,reviewDecision,isDraft", "--limit", "1"], {
			cwd: pair.worktree, encoding: "utf-8", timeout: 8000,
		});
		if (prResult.status === 0) {
			try {
				const prs = JSON.parse(prResult.stdout);
				if (prs.length > 0) {
					const pr = prs[0];
					if (pr.state === "MERGED") pair.status = "merged";
					else if (pr.reviewDecision === "APPROVED") pair.status = pr.isDraft ? "approved" : "done";
					else if (pr.reviewDecision === "CHANGES_REQUESTED") pair.status = "in-review";
					else pair.status = "pr-created";
				}
			} catch {}
		}

		// Check if tmux window still exists
		const { ok } = tmux("has-session", "-t", `${FLEET_SESSION}:${pair.window}`);
		if (!ok && pair.status !== "merged" && pair.status !== "done") {
			pair.status = "done";
		}
	}
}

function stopPair(ticket: string): boolean {
	const pair = pairs.get(ticket);
	if (!pair) return false;

	// Kill tmux window (both panes)
	tmux("kill-window", "-t", `${FLEET_SESSION}:${pair.window}`);

	// Optionally remove worktree
	// spawnSync("git", ["worktree", "remove", pair.worktree], { encoding: "utf-8" });

	pairs.delete(ticket);
	return true;
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function fleetExtension(pi: ExtensionAPI) {

	// ── /spawn <ticket> ──────────────────────────────────────────────────

	pi.registerCommand("spawn", {
		description: "Spawn worker+reviewer pair for a ticket. Usage: /spawn ENG-142",
		async handler(args, ctx) {
			const ticket = args.trim().toUpperCase();
			if (!ticket || !ticket.match(/^[A-Z]+-\d+$/)) {
				ctx.ui.notify("Usage: /spawn ENG-142", "error");
				return;
			}

			if (pairs.has(ticket)) {
				ctx.ui.notify(`${ticket} already has agents running`, "warning");
				return;
			}

			ctx.ui.notify(`Spawning agents for ${ticket}...`, "info");

			const info = fetchTicket(ticket);
			if (!info) {
				ctx.ui.notify(`Could not fetch ${ticket} from Linear`, "error");
				return;
			}

			const ok = await spawnPair(ticket, info.title, info.description, ctx.cwd, ctx);
			if (ok) {
				ctx.ui.notify(`✓ ${ticket} — worker + reviewer running in fleet:${ticket.toLowerCase()}`, "info");
			}
		},
	});

	// ── /spawn-cycle ─────────────────────────────────────────────────────

	pi.registerCommand("spawn-cycle", {
		description: "Spawn agent pairs for all unstarted cycle tickets. Usage: /spawn-cycle [max]",
		async handler(args, ctx) {
			const max = Math.min(parseInt(args.trim() || "5", 10), MAX_CONCURRENT);
			const tickets = fetchCycleTickets();

			if (tickets.length === 0) {
				ctx.ui.notify("No unstarted tickets in current cycle", "warning");
				return;
			}

			const available = MAX_CONCURRENT - pairs.size;
			if (available <= 0) {
				ctx.ui.notify(`Fleet full (${pairs.size}/${MAX_CONCURRENT}). Use /fleet stop to free slots.`, "warning");
				return;
			}

			const toSpawn = tickets.filter(t => !pairs.has(t.identifier)).slice(0, Math.min(max, available));
			ctx.ui.notify(`Spawning ${toSpawn.length} agent pairs from cycle (limit: ${MAX_CONCURRENT})...`, "info");

			for (const t of toSpawn) {
				if (pairs.size >= MAX_CONCURRENT) {
					ctx.ui.notify(`Hit limit (${MAX_CONCURRENT}). Stopping.`, "warning");
					break;
				}
				const ok = await spawnPair(t.identifier, t.title, t.description, ctx.cwd, ctx);
				if (ok) ctx.ui.notify(`✓ ${t.identifier} — spawned (${pairs.size}/${MAX_CONCURRENT})`, "info");
				else ctx.ui.notify(`✗ ${t.identifier} — failed`, "error");
				await sleep(2000);
			}

			ctx.ui.notify(`Fleet: ${pairs.size} pairs running`, "info");
		},
	});

	// ── /spawn-backlog <n> ───────────────────────────────────────────────

	pi.registerCommand("spawn-backlog", {
		description: "Spawn agent pairs for top N backlog items. Usage: /spawn-backlog [count]",
		async handler(args, ctx) {
			const count = Math.min(parseInt(args.trim() || "3", 10), MAX_CONCURRENT);
			const tickets = fetchTopBacklog(count + pairs.size); // fetch extra to account for already-running

			if (tickets.length === 0) {
				ctx.ui.notify("No backlog tickets found", "warning");
				return;
			}

			const available = MAX_CONCURRENT - pairs.size;
			if (available <= 0) {
				ctx.ui.notify(`Fleet full (${pairs.size}/${MAX_CONCURRENT}). Use /fleet stop to free slots.`, "warning");
				return;
			}

			const toSpawn = tickets.filter(t => !pairs.has(t.identifier)).slice(0, Math.min(count, available));
			ctx.ui.notify(`Spawning ${toSpawn.length} agent pairs from backlog (limit: ${MAX_CONCURRENT})...`, "info");

			for (const t of toSpawn) {
				if (pairs.size >= MAX_CONCURRENT) {
					ctx.ui.notify(`Hit limit (${MAX_CONCURRENT}). Stopping.`, "warning");
					break;
				}
				const ok = await spawnPair(t.identifier, t.title, t.description || "", ctx.cwd, ctx);
				if (ok) ctx.ui.notify(`✓ ${t.identifier} — spawned (${pairs.size}/${MAX_CONCURRENT})`, "info");
				else ctx.ui.notify(`✗ ${t.identifier} — failed`, "error");
				await sleep(2000);
			}
		},
	});

	// ── /fleet [stop] [ticket] ───────────────────────────────────────────

	pi.registerCommand("fleet", {
		description: "Fleet status. Usage: /fleet | /fleet stop | /fleet stop ENG-142",
		async handler(args, ctx) {
			const parts = args.trim().split(/\s+/);
			const action = parts[0]?.toLowerCase();
			const ticket = parts[1]?.toUpperCase();

			if (action === "stop") {
				if (ticket) {
					const ok = stopPair(ticket);
					ctx.ui.notify(ok ? `Stopped ${ticket}` : `${ticket} not found`, ok ? "info" : "warning");
				} else {
					const tickets = [...pairs.keys()];
					for (const t of tickets) stopPair(t);
					tmux("kill-session", "-t", FLEET_SESSION);
					ctx.ui.notify(`Stopped all ${tickets.length} pairs`, "info");
				}
				return;
			}

			// Status display
			refreshPairStatus(ctx.cwd);

			if (pairs.size === 0) {
				pi.sendUserMessage("No agent pairs running. Use `/spawn ENG-142` to start one.");
				return;
			}

			const statusIcon: Record<string, string> = {
				working: "🔨",
				"pr-created": "📋",
				"in-review": "🔄",
				approved: "✅",
				merged: "🟣",
				done: "✓",
				error: "❌",
			};

			const lines = ["## Fleet Status\n"];
			lines.push("| Status | Ticket | Title | Branch | Age |");
			lines.push("|--------|--------|-------|--------|-----|");

			for (const [, p] of pairs) {
				const age = Math.round((Date.now() - p.startedAt) / 60000);
				const icon = statusIcon[p.status] || "?";
				lines.push(`| ${icon} ${p.status} | ${p.ticket} | ${p.title.slice(0, 40)} | \`${p.branch}\` | ${age}m |`);
			}

			lines.push(`\nTotal: ${pairs.size} pairs`);
			lines.push(`\nTmux: \`tmux attach -t ${FLEET_SESSION}\` then \`Ctrl-b n\` to switch tickets`);

			pi.sendUserMessage(lines.join("\n"));
		},
	});

	// ── Footer status ────────────────────────────────────────────────────

	pi.on("agent_end", async (_event, ctx) => {
		if (pairs.size > 0) {
			refreshPairStatus(ctx.cwd);
			const working = [...pairs.values()].filter(p => p.status === "working").length;
			const review = [...pairs.values()].filter(p => ["pr-created", "in-review"].includes(p.status)).length;
			const done = [...pairs.values()].filter(p => ["approved", "merged", "done"].includes(p.status)).length;
			const theme = ctx.ui.theme;
			const badge = [
				working > 0 ? theme.fg("warning", `⚡${working}`) : "",
				review > 0 ? theme.fg("accent", `🔄${review}`) : "",
				done > 0 ? theme.fg("success", `✓${done}`) : "",
			].filter(Boolean).join(" ");
			ctx.ui.setStatus("fleet", `Fleet: ${badge}`);
		}
	});
}
