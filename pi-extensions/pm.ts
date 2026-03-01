/**
 * Product Management Extension
 *
 * Commands:
 *   /pm:health           — Project health scorecard
 *   /pm:signals [source] — Analyze product signals
 *   /pm:roadmap [area]   — Generate Now/Next/Later roadmap
 *   /pm:prd <idea>       — Generate a PRD
 *   /pm:refine           — Refine current Linear ticket
 *   /pm:prioritize       — RICE-score open items
 *   /pm:status           — Cross-reference Linear board with GitHub reality
 *
 * Tools:
 *   pm_signals — Fetch product signals from Linear + GitHub
 *   pm_health  — Project health metrics
 */

import { spawnSync } from "node:child_process";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { Container, Text, type Component } from "@mariozechner/pi-tui";

// ── Helpers ──────────────────────────────────────────────────────────────────

const LINEAR_API = "https://api.linear.app/graphql";

/** Resolve a secret: process.env → macOS Keychain → ~/.config/linear/env */
function resolveSecret(name: string): string | undefined {
	if (process.env[name]) return process.env[name];
	// macOS Keychain
	try {
		const r = spawnSync("security", ["find-generic-password", "-a", process.env.USER || "", "-s", name, "-w"],
			{ encoding: "utf-8", timeout: 2000 });
		if (r.status === 0 && r.stdout.trim()) {
			process.env[name] = r.stdout.trim(); // cache for this session
			return r.stdout.trim();
		}
	} catch {}
	// ~/.config/linear/env fallback
	try {
		const envFile = spawnSync("sh", ["-c", `source ~/.config/linear/env 2>/dev/null && echo "$${name}"`],
			{ encoding: "utf-8", timeout: 2000 });
		if (envFile.status === 0 && envFile.stdout.trim()) {
			process.env[name] = envFile.stdout.trim();
			return envFile.stdout.trim();
		}
	} catch {}
	return undefined;
}

function getLinearKey(): string | undefined { return resolveSecret("LINEAR_API_KEY"); }
function getLinearTeamId(): string | undefined { return resolveSecret("LINEAR_TEAM_ID"); }

function linearQuery(query: string): any | null {
	const key = getLinearKey();
	if (!key) return null;
	try {
		const r = spawnSync("curl", [
			"-s", "-X", "POST", LINEAR_API,
			"-H", "Content-Type: application/json",
			"-H", `Authorization: ${key}`,
			"-d", JSON.stringify({ query }),
		], { encoding: "utf-8", timeout: 15000 });
		if (r.status !== 0) return null;
		return JSON.parse(r.stdout).data;
	} catch { return null; }
}

/** Resolve the project root — walk up from cwd to find .git */
function findGitRoot(): string {
	try {
		const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8", timeout: 2000 });
		if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
	} catch {}
	return process.cwd();
}

let _gitRoot: string | undefined;
function gitRoot(): string {
	if (!_gitRoot) _gitRoot = findGitRoot();
	return _gitRoot;
}

function gh(...args: string[]): string | null {
	try {
		const r = spawnSync("gh", args, { encoding: "utf-8", timeout: 10000, cwd: gitRoot() });
		return r.status === 0 ? r.stdout.trim() : null;
	} catch { return null; }
}

function gitCmd(...args: string[]): string {
	try {
		const r = spawnSync("git", args, { encoding: "utf-8", timeout: 5000, cwd: gitRoot() });
		return r.status === 0 ? r.stdout.trim() : "";
	} catch { return ""; }
}

// ── Data fetchers ────────────────────────────────────────────────────────────

interface HealthData {
	linear: {
		cycleName: string;
		cycleProgress: number;
		cycleScope: number;
		cycleCompleted: number;
		issuesByState: Record<string, number>;
		totalOpen: number;
		bugs: number;
		staleCount: number;
	} | null;
	github: {
		openPRs: number;
		drafts: number;
		noReview: number;
		ciRuns: { name: string; conclusion: string }[];
		ciPassRate: number;
	} | null;
	git: {
		commitsMonth: number;
		commitsWeek: number;
		staleBranches: string[];
	};
}

function fetchHealthData(): HealthData {
	// ── Linear ──
	let linear: HealthData["linear"] = null;
	const teamId = getLinearTeamId();
	if (getLinearKey() && teamId) {
		const data = linearQuery(`{
			team(id: "${teamId}") {
				activeCycle {
					name
					startsAt
					endsAt
					progress
					scopeHistory
					completedScopeHistory
				}
				issues(first: 200) {
					nodes {
						state { name type }
						priority
						labels { nodes { name } }
						updatedAt
					}
				}
			}
		}`);
		if (data?.team) {
			const t = data.team;
			const cycle = t.activeCycle;
			const issues = t.issues?.nodes || [];
			const stateCount: Record<string, number> = {};
			let bugs = 0;
			let stale = 0;
			const thirtyDaysAgo = Date.now() - 30 * 86400000;

			for (const i of issues) {
				const sType = i.state?.type || "unknown";
				stateCount[sType] = (stateCount[sType] || 0) + 1;
				const labels = (i.labels?.nodes || []).map((l: any) => l.name.toLowerCase());
				if (labels.some((l: string) => l.includes("bug"))) bugs++;
				if (new Date(i.updatedAt).getTime() < thirtyDaysAgo &&
				    ["backlog", "unstarted", "started"].includes(sType)) stale++;
			}

			const openStates = ["backlog", "unstarted", "started"];
			const totalOpen = openStates.reduce((sum, s) => sum + (stateCount[s] || 0), 0);

			const scopeArr: number[] = cycle?.scopeHistory || [];
			const completedArr: number[] = cycle?.completedScopeHistory || [];
			const cycleScope = scopeArr.length > 0 ? scopeArr[scopeArr.length - 1]! : 0;
			const cycleCompleted = completedArr.length > 0 ? completedArr[completedArr.length - 1]! : 0;

			linear = {
				cycleName: cycle?.name || cycle?.startsAt?.slice(0, 10) || "none",
				cycleProgress: cycle?.progress ?? 0,
				cycleScope,
				cycleCompleted,
				issuesByState: stateCount,
				totalOpen,
				bugs,
				staleCount: stale,
			};
		}
	}

	// ── GitHub ──
	let github: HealthData["github"] = null;
	const prsRaw = gh("pr", "list", "--json", "number,state,isDraft,reviewDecision", "--limit", "50");
	const runsRaw = gh("run", "list", "--limit", "20", "--json", "name,status,conclusion");
	if (prsRaw) {
		try {
			const prs: any[] = JSON.parse(prsRaw);
			const ciRuns: any[] = runsRaw ? JSON.parse(runsRaw) : [];
			const completed = ciRuns.filter((r: any) => r.status === "completed");
			const passed = completed.filter((r: any) => r.conclusion === "success");

			github = {
				openPRs: prs.length,
				drafts: prs.filter((p: any) => p.isDraft).length,
				noReview: prs.filter((p: any) => !p.isDraft && !p.reviewDecision).length,
				ciRuns: completed.map((r: any) => ({ name: r.name, conclusion: r.conclusion })),
				ciPassRate: completed.length ? Math.round((passed.length / completed.length) * 100) : 100,
			};
		} catch {}
	}

	// ── Git ──
	const commitsMonth = parseInt(gitCmd("rev-list", "--count", "--since=30 days ago", "HEAD")) || 0;
	const commitsWeek = parseInt(gitCmd("rev-list", "--count", "--since=7 days ago", "HEAD")) || 0;

	return { linear, github, git: { commitsMonth, commitsWeek, staleBranches: [] } };
}

function fetchSignals(source: string): { linear: any[]; github: any[] } {
	const signals: { linear: any[]; github: any[] } = { linear: [], github: [] };
	const teamId = getLinearTeamId();

	if ((source === "linear" || source === "all") && getLinearKey() && teamId) {
		const data = linearQuery(`{
			issues(
				filter: { team: { id: { eq: "${teamId}" } }, state: { type: { in: ["backlog", "unstarted"] } } }
				first: 100
				orderBy: createdAt
			) {
				nodes {
					identifier title description priority priorityLabel
					labels { nodes { name } }
					createdAt
					comments { nodes { body createdAt } }
				}
			}
		}`);
		if (data?.issues?.nodes) signals.linear = data.issues.nodes;
	}

	if (source === "github" || source === "all") {
		const raw = gh("issue", "list", "--json", "number,title,labels,body,createdAt,comments", "--limit", "100");
		if (raw) {
			try { signals.github = JSON.parse(raw); } catch {}
		}
	}

	return signals;
}

// ── Indicator helpers ────────────────────────────────────────────────────────

function indicator(value: number, green: number, yellow: number, invert = false): string {
	if (invert) return value <= green ? "🟢" : value <= yellow ? "🟡" : "🔴";
	return value >= green ? "🟢" : value >= yellow ? "🟡" : "🔴";
}

// ── BoxedOverlay ─────────────────────────────────────────────────────────────

class BoxedOverlay implements Component {
	constructor(private inner: Component, private color: (s: string) => string) {}
	invalidate() { this.inner.invalidate(); }
	render(width: number): string[] {
		const w = Math.max(1, width - 2);
		const lines = this.inner.render(w);
		return [
			this.color("┌" + "─".repeat(w) + "┐"),
			...lines.map(l => this.color("│") + l + this.color("│")),
			this.color("└" + "─".repeat(w) + "┘"),
		];
	}
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function pmExtension(pi: ExtensionAPI) {

	// Reset git root cache on session start (cwd may change)
	pi.on("session_start", async () => { _gitRoot = undefined; });

	// ── Tools ────────────────────────────────────────────────────────────

	pi.registerTool({
		name: "pm_signals",
		label: "PM Signals",
		description:
			"Fetch and aggregate product signals from Linear issues, GitHub issues, " +
			"and other sources. Returns raw signal data for analysis.",
		parameters: Type.Object({
			source: StringEnum(["linear", "github", "all"] as const),
			area: Type.Optional(Type.String({ description: "Filter by area/label" })),
		}),
		async execute(_id, params) {
			const signals = fetchSignals(params.source);
			const totalLinear = signals.linear.length;
			const totalGitHub = signals.github.length;

			// Filter by area if specified
			if (params.area) {
				const area = params.area.toLowerCase();
				signals.linear = signals.linear.filter((i: any) =>
					(i.labels?.nodes || []).some((l: any) => l.name.toLowerCase().includes(area)) ||
					(i.title || "").toLowerCase().includes(area)
				);
				signals.github = signals.github.filter((i: any) =>
					(i.labels || []).some((l: any) => (l.name || "").toLowerCase().includes(area)) ||
					(i.title || "").toLowerCase().includes(area)
				);
			}

			const summary = [
				`Fetched ${signals.linear.length} Linear issues (of ${totalLinear})`,
				`Fetched ${signals.github.length} GitHub issues (of ${totalGitHub})`,
				params.area ? `Filtered by: ${params.area}` : "",
			].filter(Boolean).join("\n");

			return {
				content: [{ type: "text", text: summary + "\n\n" + JSON.stringify(signals, null, 2) }],
				details: { success: true, linearCount: signals.linear.length, githubCount: signals.github.length },
			};
		},

		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("dim", "⟳ fetching…"), 0, 0);
			const d = result.details as any;
			return new Text(
				theme.fg("success", `✓ ${d?.linearCount || 0} Linear + ${d?.githubCount || 0} GitHub signals`),
				0, 0
			);
		},
	});

	pi.registerTool({
		name: "pm_health",
		label: "PM Health",
		description:
			"Get project health metrics from Linear (cycle progress, bugs, stale tickets) " +
			"and GitHub (PRs, CI pass rate). Returns a health scorecard.",
		parameters: Type.Object({}),
		async execute() {
			const h = fetchHealthData();
			const lines: string[] = ["## Project Health\n"];

			if (h.linear) {
				const l = h.linear;
				const pct = l.cycleScope > 0 ? Math.round((l.cycleCompleted / l.cycleScope) * 100) : 0;
				const bugPct = l.totalOpen > 0 ? Math.round((l.bugs / l.totalOpen) * 100) : 0;
				lines.push(`### Linear — ${l.cycleName}`);
				lines.push(`${indicator(pct, 70, 40)} Cycle: ${pct}% (${l.cycleCompleted}/${l.cycleScope})`);
				lines.push(`${indicator(bugPct, 15, 30, true)} Bugs: ${bugPct}% (${l.bugs}/${l.totalOpen} open)`);
				lines.push(`${indicator(l.staleCount, 5, 15, true)} Stale: ${l.staleCount} tickets >30d untouched`);
				lines.push(`Open: ${JSON.stringify(l.issuesByState)}\n`);
			} else {
				lines.push("⚠️ Linear: no data (check LINEAR_API_KEY and LINEAR_TEAM_ID)\n");
			}

			if (h.github) {
				const g = h.github;
				lines.push(`### GitHub`);
				lines.push(`${indicator(g.ciPassRate, 95, 80)} CI: ${g.ciPassRate}% pass rate`);
				lines.push(`PRs: ${g.openPRs} open (${g.drafts} draft, ${g.noReview} awaiting review)`);
				lines.push(`${indicator(g.noReview, 2, 4, true)} No review: ${g.noReview} PRs\n`);
			} else {
				lines.push("⚠️ GitHub: no data (check gh CLI auth)\n");
			}

			lines.push(`### Git Activity`);
			lines.push(`Commits: ${h.git.commitsWeek} this week, ${h.git.commitsMonth} this month`);

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { success: true },
			};
		},
	});

	// ── Commands ──────────────────────────────────────────────────────────

	pi.registerCommand("pm:health", {
		description: "Project health scorecard",
		handler: async (_args, ctx) => {
			const h = fetchHealthData();
			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				const inner = new Container();
				inner.addChild(new Text(" " + theme.fg("accent", theme.bold("🏥 Project Health")), 0, 0));
				inner.addChild(new Text("", 0, 0));

				if (h.linear) {
					const l = h.linear;
					const pct = l.cycleScope > 0 ? Math.round((l.cycleCompleted / l.cycleScope) * 100) : 0;
					const bugPct = l.totalOpen > 0 ? Math.round((l.bugs / l.totalOpen) * 100) : 0;
					inner.addChild(new Text(theme.fg("accent", ` Linear — ${l.cycleName}`), 0, 0));
					inner.addChild(new Text(` ${indicator(pct, 70, 40)} Cycle progress: ${pct}%`, 0, 0));
					inner.addChild(new Text(` ${indicator(bugPct, 15, 30, true)} Bug ratio: ${bugPct}% (${l.bugs} bugs / ${l.totalOpen} open)`, 0, 0));
					inner.addChild(new Text(` ${indicator(l.staleCount, 5, 15, true)} Stale tickets: ${l.staleCount} (>30d untouched)`, 0, 0));
				} else {
					inner.addChild(new Text(theme.fg("warning", " ⚠ Linear: set LINEAR_API_KEY + LINEAR_TEAM_ID"), 0, 0));
				}

				inner.addChild(new Text("", 0, 0));

				if (h.github) {
					const g = h.github;
					inner.addChild(new Text(theme.fg("accent", " GitHub"), 0, 0));
					inner.addChild(new Text(` ${indicator(g.ciPassRate, 95, 80)} CI pass rate: ${g.ciPassRate}%`, 0, 0));
					inner.addChild(new Text(` Open PRs: ${g.openPRs} (${g.drafts} draft)`, 0, 0));
					inner.addChild(new Text(` ${indicator(g.noReview, 2, 4, true)} Awaiting review: ${g.noReview}`, 0, 0));
				} else {
					inner.addChild(new Text(theme.fg("warning", " ⚠ GitHub: check gh auth"), 0, 0));
				}

				inner.addChild(new Text("", 0, 0));
				inner.addChild(new Text(theme.fg("accent", " Git Activity"), 0, 0));
				inner.addChild(new Text(` Commits: ${h.git.commitsWeek} this week, ${h.git.commitsMonth} this month`, 0, 0));
				inner.addChild(new Text("", 0, 0));
				inner.addChild(new Text(theme.fg("dim", " esc close"), 0, 0));

				const box = new BoxedOverlay(inner, (s) => theme.fg("accent", s));
				return {
					render: (w) => box.render(w),
					invalidate: () => box.invalidate(),
					handleInput: (data) => { if (data === "\x1b" || data === "q") done(); },
				};
			}, { overlay: true });
		},
	});

	pi.registerCommand("pm:signals", {
		description: "Analyze product signals (usage: /pm:signals [linear|github|all])",
		handler: async (args, ctx) => {
			const source = args?.trim() || "all";
			pi.sendUserMessage(
				`Use the signal-analyzer subagent to analyze product signals from ${source}. ` +
				`First use the pm_signals tool with source="${source}" to fetch the data, ` +
				`then analyze it: cluster themes, score impact, identify root causes, and suggest tickets.`
			);
		},
	});

	pi.registerCommand("pm:roadmap", {
		description: "Generate Now/Next/Later roadmap (usage: /pm:roadmap [area])",
		handler: async (args, ctx) => {
			const area = args?.trim();
			pi.sendUserMessage(
				`Use the roadmap-manager subagent to generate a Now/Next/Later product roadmap` +
				(area ? ` focused on ${area}` : "") +
				`. Fetch data from Linear (cycles, backlog) and GitHub (open PRs), ` +
				`apply RICE scoring to backlog items, and identify risks and dependencies.`
			);
		},
	});

	pi.registerCommand("pm:prd", {
		description: "Generate a PRD (usage: /pm:prd <feature idea>)",
		handler: async (args, ctx) => {
			const idea = args?.trim();
			if (!idea) {
				ctx.ui.notify("Usage: /pm:prd <feature idea>", "warning");
				return;
			}
			pi.sendUserMessage(
				`Use the prd-writer subagent to generate a full PRD for: ${idea}\n\n` +
				`Scan the codebase to ground technical considerations in reality. ` +
				`Include problem statement, user stories, acceptance criteria, ` +
				`technical notes with actual file paths, success metrics, and open questions.`
			);
		},
	});

	pi.registerCommand("pm:refine", {
		description: "Refine current Linear ticket with acceptance criteria, edge cases, tech notes",
		handler: async (_args, ctx) => {
			pi.sendUserMessage(
				`Use the ticket-refiner subagent to improve the current Linear ticket. ` +
				`First read the ticket with read_linear_ticket, then scan the codebase for context. ` +
				`Add acceptance criteria (Given/When/Then), edge cases, technical notes ` +
				`with specific file paths, and an estimate. Flag any ambiguities.`
			);
		},
	});

	pi.registerCommand("pm:prioritize", {
		description: "RICE-score open issues",
		handler: async (_args, ctx) => {
			pi.sendUserMessage(
				`Fetch open issues from Linear and GitHub using the pm_signals tool with source="all". ` +
				`Then apply RICE scoring (Reach × Impact × Confidence / Effort) to each item. ` +
				`Output a prioritized table sorted by RICE score, with your reasoning for each score.`
			);
		},
	});

	// ── Status: Linear ↔ GitHub cross-reference ──────────────────────────

	pi.registerCommand("pm:status", {
		description: "Cross-reference Linear board with GitHub reality — find discrepancies",
		handler: async (_args, ctx) => {
			const status = fetchProjectStatus();

			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				const inner = new Container();
				const accent = (s: string) => theme.fg("accent", s);
				const dim = (s: string) => theme.fg("dim", s);
				const warn = (s: string) => theme.fg("warning", s);
				const err = (s: string) => theme.fg("error", s);
				const ok = (s: string) => theme.fg("success", s);

				inner.addChild(new Text(" " + accent(theme.bold("📋 Project Status — Linear ↔ GitHub")), 0, 0));
				inner.addChild(new Text("", 0, 0));

				if (status.tickets.length === 0) {
					inner.addChild(new Text(warn(" No active tickets found. Check LINEAR_API_KEY + LINEAR_TEAM_ID"), 0, 0));
				} else {
					// Group by state
					const groups: Record<string, typeof status.tickets> = {};
					for (const t of status.tickets) {
						const g = t.linearState || "unknown";
						if (!groups[g]) groups[g] = [];
						groups[g]!.push(t);
					}

					const stateOrder = ["In Progress", "In Review", "Done", "Todo", "Backlog"];
					const sortedStates = Object.keys(groups).sort((a, b) => {
						const ai = stateOrder.indexOf(a);
						const bi = stateOrder.indexOf(b);
						return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
					});

					for (const state of sortedStates) {
						const tickets = groups[state]!;
						inner.addChild(new Text(" " + accent(theme.bold(`${state} (${tickets.length})`)), 0, 0));

						for (const t of tickets) {
							// Build status line
							let ghStatus = "";
							if (t.pr) {
								const ciIcon = t.ci === "pass" ? ok("✓") : t.ci === "fail" ? err("✗") : dim("⟳");
								const prLabel = t.pr.isDraft ? dim("draft") : t.pr.reviewDecision === "APPROVED" ? ok("approved") : warn("review");
								ghStatus = ` PR #${t.pr.number} ${prLabel} CI:${ciIcon}`;
							} else if (t.hasBranch) {
								ghStatus = dim(" branch only, no PR");
							} else {
								ghStatus = dim(" no branch");
							}

							// Flag discrepancies
							let flag = "";
							for (const d of t.discrepancies) {
								flag += " " + warn(`⚠ ${d}`);
							}

							inner.addChild(new Text(
								`  ${dim(t.id)} ${t.title.slice(0, 50)}` + ghStatus + flag,
								0, 0
							));
						}
						inner.addChild(new Text("", 0, 0));
					}
				}

				// Summary
				if (status.discrepancies.length > 0) {
					inner.addChild(new Text(" " + warn(theme.bold(`⚠ ${status.discrepancies.length} discrepancies`)), 0, 0));
					for (const d of status.discrepancies.slice(0, 8)) {
						inner.addChild(new Text("  " + warn(`• ${d}`), 0, 0));
					}
					inner.addChild(new Text("", 0, 0));
				} else {
					inner.addChild(new Text(" " + ok("✓ Board and GitHub are in sync"), 0, 0));
					inner.addChild(new Text("", 0, 0));
				}

				inner.addChild(new Text(dim(" esc close  │  /pm:status to refresh"), 0, 0));

				const box = new BoxedOverlay(inner, (s) => theme.fg("accent", s));
				return {
					render: (w) => box.render(w),
					invalidate: () => box.invalidate(),
					handleInput: (data) => { if (data === "\x1b" || data === "q") done(); },
				};
			}, { overlay: true });
		},
	});
}

// ── Status cross-reference fetcher ───────────────────────────────────────────

interface TicketStatus {
	id: string;
	title: string;
	linearState: string;
	linearStateType: string;
	assignee: string;
	hasBranch: boolean;
	pr: { number: number; isDraft: boolean; reviewDecision: string; merged: boolean } | null;
	ci: "pass" | "fail" | "pending" | "none";
	discrepancies: string[];
}

interface ProjectStatus {
	tickets: TicketStatus[];
	discrepancies: string[];
}

function fetchProjectStatus(): ProjectStatus {
	const teamId = getLinearTeamId();
	const tickets: TicketStatus[] = [];
	const discrepancies: string[] = [];

	// Fetch active Linear issues (not backlog, not cancelled)
	if (!getLinearKey() || !teamId) {
		return { tickets: [], discrepancies: ["LINEAR_API_KEY or LINEAR_TEAM_ID not set"] };
	}

	const data = linearQuery(`{
		issues(
			filter: {
				team: { id: { eq: "${teamId}" } }
				state: { type: { in: ["started", "unstarted", "completed"] } }
			}
			first: 100
			orderBy: updatedAt
		) {
			nodes {
				identifier title
				state { name type }
				assignee { name }
				branchName
				updatedAt
			}
		}
	}`);

	if (!data?.issues?.nodes) {
		return { tickets: [], discrepancies: ["Failed to fetch Linear data"] };
	}

	// Fetch all GitHub PRs with branch info and CI
	const prsRaw = gh("pr", "list", "--state", "all", "--limit", "100",
		"--json", "number,headRefName,state,isDraft,reviewDecision,mergedAt,statusCheckRollup");
	let prs: any[] = [];
	if (prsRaw) {
		try { prs = JSON.parse(prsRaw); } catch {}
	}

	// Fetch branch list
	const branchesRaw = gitCmd("branch", "-r", "--format", "%(refname:short)");
	const branches = new Set(branchesRaw.split("\n").map(b => b.replace("origin/", "").trim()));

	// Cross-reference each Linear issue
	for (const issue of data.issues.nodes) {
		const id = issue.identifier;
		const state = issue.state?.name || "Unknown";
		const stateType = issue.state?.type || "unknown";
		const branchName = issue.branchName || "";
		const idLower = id.toLowerCase();

		// Find matching PR by branch name or ticket ID in branch
		const matchingPr = prs.find((p: any) => {
			const head = (p.headRefName || "").toLowerCase();
			return head === branchName.toLowerCase() ||
			       head.includes(idLower) ||
			       head.includes(idLower.replace("-", ""));
		});

		// Check if branch exists
		const hasBranch = branchName
			? branches.has(branchName) || [...branches].some(b => b.toLowerCase().includes(idLower))
			: [...branches].some(b => b.toLowerCase().includes(idLower));

		// CI status
		let ci: TicketStatus["ci"] = "none";
		if (matchingPr?.statusCheckRollup) {
			const checks = matchingPr.statusCheckRollup;
			if (Array.isArray(checks) && checks.length > 0) {
				const failed = checks.some((c: any) => c.conclusion === "FAILURE");
				const pending = checks.some((c: any) => c.status === "IN_PROGRESS" || c.status === "QUEUED");
				ci = failed ? "fail" : pending ? "pending" : "pass";
			}
		}

		const pr = matchingPr ? {
			number: matchingPr.number,
			isDraft: matchingPr.isDraft,
			reviewDecision: matchingPr.reviewDecision || "",
			merged: !!matchingPr.mergedAt,
		} : null;

		// Detect discrepancies
		const discs: string[] = [];

		if (stateType === "started" && !hasBranch && !pr) {
			discs.push(`${id} "In Progress" but no branch/PR`);
		}
		if (stateType === "started" && pr?.merged) {
			discs.push(`${id} "In Progress" but PR already merged`);
		}
		if (stateType === "completed" && pr && !pr.merged) {
			discs.push(`${id} "Done" in Linear but PR not merged`);
		}
		if (pr && ci === "fail") {
			discs.push(`${id} CI failing on PR #${pr.number}`);
		}
		if (stateType === "unstarted" && pr && !pr.isDraft) {
			discs.push(`${id} "Todo" but has active PR #${pr.number}`);
		}

		discrepancies.push(...discs);

		// Only include non-backlog tickets
		tickets.push({
			id,
			title: issue.title || "",
			linearState: state,
			linearStateType: stateType,
			assignee: issue.assignee?.name || "",
			hasBranch,
			pr,
			ci,
			discrepancies: discs,
		});
	}

	return { tickets, discrepancies };
}
