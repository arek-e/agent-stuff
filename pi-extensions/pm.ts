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

function linearQuery(query: string): any | null {
	const key = process.env.LINEAR_API_KEY;
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

function gh(...args: string[]): string | null {
	try {
		const r = spawnSync("gh", args, { encoding: "utf-8", timeout: 10000 });
		return r.status === 0 ? r.stdout.trim() : null;
	} catch { return null; }
}

function gitCmd(...args: string[]): string {
	try {
		const r = spawnSync("git", args, { encoding: "utf-8", timeout: 5000 });
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
	const teamId = process.env.LINEAR_TEAM_ID;
	if (process.env.LINEAR_API_KEY && teamId) {
		const data = linearQuery(`{
			team(id: "${teamId}") {
				activeCycle {
					name
					progress { scope completed }
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

			linear = {
				cycleName: cycle?.name || "none",
				cycleProgress: cycle?.progress?.completed || 0,
				cycleScope: cycle?.progress?.scope || 0,
				cycleCompleted: cycle?.progress?.completed || 0,
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
	const teamId = process.env.LINEAR_TEAM_ID;

	if ((source === "linear" || source === "all") && process.env.LINEAR_API_KEY && teamId) {
		const data = linearQuery(`{
			issues(
				filter: { team: { key: { eq: "${teamId}" } }, state: { type: { in: ["backlog", "unstarted"] } } }
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
			ctx.ui.sendUserMessage(
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
			ctx.ui.sendUserMessage(
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
			ctx.ui.sendUserMessage(
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
			ctx.ui.sendUserMessage(
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
			ctx.ui.sendUserMessage(
				`Fetch open issues from Linear and GitHub using the pm_signals tool with source="all". ` +
				`Then apply RICE scoring (Reach × Impact × Confidence / Effort) to each item. ` +
				`Output a prioritized table sorted by RICE score, with your reasoning for each score.`
			);
		},
	});
}
