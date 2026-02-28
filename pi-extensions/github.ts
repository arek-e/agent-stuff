/**
 * GitHub Extension
 *
 * - Tool: gh_pr_checks — fetch CI check results for current PR
 * - Tool: gh_pr_create — create a draft PR (always draft)
 * - Footer: PR ✓ / PR ✗2 / PR ⟳1
 * - CI poller: notifies on new check failures every 60s and after each agent turn
 */

import { spawnSync, spawn } from "node:child_process";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";

// ── Types ────────────────────────────────────────────────────────────────────

interface PrCheck {
	name: string;
	state: string;
	bucket: string; // "pass" | "fail" | "pending" | "skipping" | "cancel"
	link: string;
	description: string;
	workflow: string;
	startedAt: string;
	completedAt: string;
}

interface PrChecksResult {
	checks: PrCheck[];
	pass: number;
	fail: number;
	pending: number;
	skip: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseTicketId(branch: string): string | undefined {
	const match = branch.match(/^([a-zA-Z]+-\d+)/);
	return match ? match[1]!.toUpperCase() : undefined;
}

function getCurrentBranch(cwd: string): string | undefined {
	try {
		const { execSync } = require("node:child_process");
		return execSync("git symbolic-ref --short HEAD", { cwd, encoding: "utf-8" }).trim();
	} catch {
		return undefined;
	}
}

// Sync — used in tool execute (blocking is fine)
function fetchPrChecks(cwd: string, branch?: string): PrChecksResult | undefined {
	try {
		const args = ["pr", "checks", "--json", "name,state,bucket,link,description,workflow,startedAt,completedAt"];
		if (branch) args.push("--branch", branch);
		const result = spawnSync("gh", args, { cwd, encoding: "utf-8", timeout: 15000 });
		if (result.status !== 0) return undefined;
		const checks: PrCheck[] = JSON.parse(result.stdout);
		return summarize(checks);
	} catch {
		return undefined;
	}
}

// Async — used by poller and footer refresh (non-blocking)
function fetchPrChecksAsync(cwd: string, branch?: string): Promise<PrChecksResult | undefined> {
	return new Promise((resolve) => {
		const args = ["pr", "checks", "--json", "name,state,bucket,link,description,workflow,startedAt,completedAt"];
		if (branch) args.push("--branch", branch);
		const proc = spawn("gh", args, { cwd });
		let stdout = "";
		proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
		proc.on("close", (code) => {
			if (code !== 0) { resolve(undefined); return; }
			try { resolve(summarize(JSON.parse(stdout))); } catch { resolve(undefined); }
		});
		proc.on("error", () => resolve(undefined));
	});
}

function summarize(checks: PrCheck[]): PrChecksResult {
	return {
		checks,
		pass:    checks.filter(c => c.bucket === "pass").length,
		fail:    checks.filter(c => c.bucket === "fail").length,
		pending: checks.filter(c => c.bucket === "pending").length,
		skip:    checks.filter(c => c.bucket === "skipping" || c.bucket === "cancel").length,
	};
}

async function fetchLinearTicketTitle(ticketId: string): Promise<{ title: string; description: string } | undefined> {
	const apiKey = process.env.LINEAR_API_KEY;
	if (!apiKey) return undefined;
	try {
		const query = JSON.stringify({ query: `{ issue(id: "${ticketId}") { title description } }` });
		const r = spawnSync("curl", [
			"-s", "-X", "POST", "https://api.linear.app/graphql",
			"-H", "Content-Type: application/json",
			"-H", `Authorization: ${apiKey}`,
			"-d", query,
		], { encoding: "utf-8", timeout: 8000 });
		if (r.status !== 0) return undefined;
		const issue = JSON.parse(r.stdout)?.data?.issue;
		return issue ? { title: issue.title || "", description: issue.description || "" } : undefined;
	} catch {
		return undefined;
	}
}

function notifyOSC777(title: string, body: string): void {
	process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
}

// ── Extension ─────────────────────────────────────────────────────────────────

export default function githubExtension(pi: ExtensionAPI) {
	let prChecksResult: PrChecksResult | undefined;
	let lastFailedCheckNames = new Set<string>();
	let ciPollerId: ReturnType<typeof setInterval> | undefined;
	let latestCtx: ExtensionContext | undefined;

	// ── Session start ────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;

		// Initial PR checks fetch (background)
		fetchPrChecksAsync(ctx.cwd).then((result) => {
			if (!result) return;
			prChecksResult = result;
			lastFailedCheckNames = new Set(result.checks.filter(c => c.bucket === "fail").map(c => c.name));
			updateStatus(ctx);
		});

		// CI poller
		if (ciPollerId) clearInterval(ciPollerId);
		ciPollerId = setInterval(async () => {
			const cwd = latestCtx?.cwd ?? ctx.cwd;
			const result = await fetchPrChecksAsync(cwd);
			if (!result) return;

			const newFailed  = result.checks.filter(c => c.bucket === "fail").map(c => c.name);
			const brandNew   = newFailed.filter(n => !lastFailedCheckNames.has(n));

			lastFailedCheckNames = new Set(newFailed);
			prChecksResult = result;

			if (brandNew.length > 0) {
				latestCtx?.ui.notify(`CI failed: ${brandNew.join(", ")}`, "error");
				notifyOSC777("PI — CI Failed", brandNew.join(", "));
			}

			if (latestCtx) updateStatus(latestCtx);
		}, 60_000);
	});

	// ── After each agent turn ────────────────────────────────────────────

	pi.on("agent_end", async (_event, ctx) => {
		latestCtx = ctx;
		fetchPrChecksAsync(ctx.cwd).then((result) => {
			if (!result) return;
			const newFailed = result.checks.filter(c => c.bucket === "fail").map(c => c.name);
			const brandNew  = newFailed.filter(n => !lastFailedCheckNames.has(n));
			if (brandNew.length > 0) {
				ctx.ui.notify(`CI failed: ${brandNew.join(", ")}`, "error");
				notifyOSC777("PI — CI Failed", brandNew.join(", "));
			}
			lastFailedCheckNames = new Set(newFailed);
			prChecksResult = result;
			updateStatus(ctx);
		});
	});

	// ── Shutdown ─────────────────────────────────────────────────────────

	pi.on("session_shutdown", () => {
		if (ciPollerId) { clearInterval(ciPollerId); ciPollerId = undefined; }
		latestCtx = undefined;
	});

	// ── Footer ───────────────────────────────────────────────────────────

	function updateStatus(ctx: ExtensionContext) {
		const theme = ctx.ui.theme;
		if (!prChecksResult) return;
		const { pass, fail, pending } = prChecksResult;
		let badge: string;
		if (fail > 0)         badge = theme.fg("error",   `PR ✗${fail}`);
		else if (pending > 0) badge = theme.fg("warning", `PR ⟳${pending}`);
		else if (pass > 0)    badge = theme.fg("success", "PR ✓");
		else                  badge = theme.fg("dim",     "PR –");
		ctx.ui.setStatus("github-pr", badge);
	}

	// ── Tool: gh_pr_checks ───────────────────────────────────────────────

	pi.registerTool({
		name: "gh_pr_checks",
		label: "PR Checks",
		description:
			"Fetch GitHub CI check results for the current branch's pull request. " +
			"Returns each check's name, status, and link so you can identify failures and plan fixes. " +
			"Optionally specify a branch to check a different worktree's PR.",
		parameters: Type.Object({
			branch: Type.Optional(Type.String({ description: "Branch to check (defaults to current)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const result = fetchPrChecks(ctx.cwd, params.branch);
			if (!result) {
				return {
					content: [{ type: "text", text: "No PR found for this branch, or gh CLI not available." }],
					details: { success: false },
				};
			}

			const { checks, pass, fail, pending, skip } = result;
			const lines = [
				`PR Checks: ${pass} passed, ${fail} failed, ${pending} pending, ${skip} skipped`,
				"",
				...checks.map(c => {
					const icon = c.bucket === "pass" ? "✓" : c.bucket === "fail" ? "✗" : c.bucket === "pending" ? "⟳" : "–";
					const wf   = c.workflow ? `[${c.workflow}] ` : "";
					const desc = c.description ? ` — ${c.description}` : "";
					return `${icon} ${wf}${c.name}${desc}${c.link ? `\n  ${c.link}` : ""}`;
				}),
			];

			// Cache if checking current branch
			if (!params.branch && latestCtx) {
				prChecksResult = result;
				updateStatus(latestCtx);
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { success: true, pass, fail, pending, skip, checks },
			};
		},

		renderCall(args, theme) {
			const branch = args.branch ? ` (${args.branch})` : "";
			return new Text(theme.fg("toolTitle", theme.bold("gh_pr_checks")) + theme.fg("dim", branch), 0, 0);
		},

		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("dim", "⟳ fetching…"), 0, 0);
			if (!result.details?.success) return new Text(theme.fg("warning", "– no PR"), 0, 0);
			const { pass = 0, fail = 0, pending = 0 } = result.details as Record<string, number>;
			const parts: string[] = [];
			if (fail > 0)    parts.push(theme.fg("error",   `✗ ${fail} failed`));
			if (pending > 0) parts.push(theme.fg("warning", `⟳ ${pending} pending`));
			if (pass > 0)    parts.push(theme.fg("success", `✓ ${pass} passed`));
			return new Text(parts.join(theme.fg("dim", "  ")), 0, 0);
		},
	});

	// ── Tool: gh_pr_create (always draft) ───────────────────────────────

	pi.registerTool({
		name: "gh_pr_create",
		label: "Create Draft PR",
		description:
			"Create a GitHub pull request in draft mode. Always creates as draft — never ready for review. " +
			"Title and body default to the Linear ticket if available. " +
			"The user promotes it to ready when they decide.",
		parameters: Type.Object({
			title: Type.Optional(Type.String({ description: "PR title (defaults to Linear ticket title)" })),
			body:  Type.Optional(Type.String({ description: "PR body markdown (defaults to Linear ticket description)" })),
			base:  Type.Optional(Type.String({ description: "Base branch to merge into (defaults to repo default)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			// Resolve title/body — try params first, then Linear ticket
			let title = params.title;
			let body  = params.body ?? "";

			if (!title) {
				const branch = getCurrentBranch(ctx.cwd);
				const tId = branch ? parseTicketId(branch) : undefined;
				if (tId) {
					const t = await fetchLinearTicketTitle(tId);
					if (t) { title = t.title; body = body || t.description; }
				}
			}

			if (!title) {
				return {
					content: [{ type: "text", text: "No title provided and no Linear ticket found. Pass a title explicitly." }],
					details: { success: false },
				};
			}

			const confirmed = await ctx.ui.confirm(
				"Create draft PR?",
				`Title: ${title}\nBase: ${params.base || "default branch"}`,
			);
			if (!confirmed) {
				return { content: [{ type: "text", text: "Cancelled." }], details: { success: false, cancelled: true } };
			}

			const args = ["pr", "create", "--draft", "--title", title, "--body", body];
			if (params.base) args.push("--base", params.base);

			const r = spawnSync("gh", args, { cwd: ctx.cwd, encoding: "utf-8", timeout: 30000 });
			if (r.status !== 0) {
				return {
					content: [{ type: "text", text: `Failed:\n${r.stderr}` }],
					details: { success: false, error: r.stderr },
				};
			}

			const url = r.stdout.trim();

			// Refresh footer
			fetchPrChecksAsync(ctx.cwd).then((result) => {
				if (result && latestCtx) { prChecksResult = result; updateStatus(latestCtx); }
			});

			return {
				content: [{ type: "text", text: `Draft PR created: ${url}` }],
				details: { success: true, url },
			};
		},

		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("gh_pr_create")) + theme.fg("dim", " [draft]"), 0, 0);
		},

		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("dim", "⟳ creating…"), 0, 0);
			if (!result.details?.success) {
				return new Text(result.details?.cancelled ? theme.fg("dim", "– cancelled") : theme.fg("error", "✗ failed"), 0, 0);
			}
			return new Text(
				theme.fg("success", "✓ Draft PR  ") + theme.fg("muted", String(result.details.url ?? "")),
				0, 0
			);
		},
	});
}
