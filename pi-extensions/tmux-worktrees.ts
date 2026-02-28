/**
 * Tmux Worktrees Extension
 *
 * - Worktree overlay (Alt+W / /worktrees): switch, create, remove merged
 * - Tmux border: yellow on agent_end, reset on agent_start
 * - Footer: tmux:<branch>
 * - Pane watcher: closes pane on real shutdown, survives /reload
 */

import { execSync, spawnSync, spawn } from "node:child_process";
import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Container, Key, Text, type SelectItem, SelectList, type Component } from "@mariozechner/pi-tui";

// ── Types ────────────────────────────────────────────────────────────────────

interface Worktree {
	path: string;
	branch: string;
	commit: string;
	isCurrent: boolean;
}

interface PrInfo {
	number: number;
	state: string;   // "OPEN" | "MERGED" | "CLOSED"
	isDraft: boolean;
	title: string;
	headRefName: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseTicketId(branch: string): string | undefined {
	const match = branch.match(/^([a-zA-Z]+-\d+)/);
	return match ? match[1]!.toUpperCase() : undefined;
}

function getCurrentBranch(cwd: string): string | undefined {
	try {
		return execSync("git symbolic-ref --short HEAD", { cwd, encoding: "utf-8" }).trim();
	} catch {
		return undefined;
	}
}

function listWorktrees(cwd: string): Worktree[] {
	let output: string;
	try {
		output = execSync("git worktree list --porcelain", { cwd, encoding: "utf-8" });
	} catch {
		return [];
	}

	const worktrees: Worktree[] = [];
	let current: Partial<Worktree> = {};

	for (const line of output.split("\n")) {
		if (line.startsWith("worktree ")) {
			if (current.path) worktrees.push(current as Worktree);
			current = { path: line.slice(9), branch: "", commit: "", isCurrent: false };
		} else if (line.startsWith("HEAD ")) {
			current.commit = line.slice(5, 12);
		} else if (line.startsWith("branch ")) {
			current.branch = line.slice(7).replace(/^refs\/heads\//, "");
		} else if (line === "") {
			if (current.path) worktrees.push(current as Worktree);
			current = {};
		}
	}
	if (current.path) worktrees.push(current as Worktree);

	const currentBranch = getCurrentBranch(cwd);
	for (const wt of worktrees) wt.isCurrent = wt.branch === currentBranch;

	return worktrees;
}

function tmuxRun(...args: string[]): string | undefined {
	const result = spawnSync("tmux", args, { encoding: "utf-8" });
	return result.status === 0 ? result.stdout.trim() : undefined;
}

function getPaneId(): string | undefined {
	return tmuxRun("display-message", "-p", "#{pane_id}");
}



function setAttentionWidgets(ctx: ExtensionContext): void {
	const theme = ctx.ui.theme;
	ctx.ui.setWidget("attn", [theme.fg("warning", " ● ready")], "above");
}

function clearAttentionWidgets(ctx: ExtensionContext): void {
	ctx.ui.setWidget("attn", undefined);
}

function fetchAllPrInfo(cwd: string): Map<string, PrInfo> {
	try {
		const result = spawnSync("gh", [
			"pr", "list",
			"--json", "number,headRefName,state,isDraft,title",
			"--state", "all", "--limit", "50",
		], { cwd, encoding: "utf-8", timeout: 8000 });
		if (result.status !== 0) return new Map();
		const prs: PrInfo[] = JSON.parse(result.stdout);
		const map = new Map<string, PrInfo>();
		for (const pr of prs) map.set(pr.headRefName, pr);
		return map;
	} catch {
		return new Map();
	}
}

// ── BoxedOverlay ──────────────────────────────────────────────────────────────
// Wraps a component in a visible ┌─┐ │ │ └─┘ box border.

class BoxedOverlay implements Component {
	constructor(
		private inner: Component,
		private color: (s: string) => string,
	) {}

	invalidate() { this.inner.invalidate(); }

	render(width: number): string[] {
		const innerWidth = Math.max(1, width - 2);
		const innerLines = this.inner.render(innerWidth);
		const top    = this.color("┌" + "─".repeat(innerWidth) + "┐");
		const bottom = this.color("└" + "─".repeat(innerWidth) + "┘");
		const mid    = innerLines.map(l => this.color("│") + l + this.color("│"));
		return [top, ...mid, bottom];
	}
}

// ── Extension ─────────────────────────────────────────────────────────────────

export default function tmuxWorktreesExtension(pi: ExtensionAPI) {
	let isInTmux = false;
	let paneId: string | undefined;
	let watcherPid: number | undefined;
	let latestCtx: ExtensionContext | undefined;

	// ── Session start ────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		if (watcherPid) {
			try { process.kill(watcherPid, "SIGTERM"); } catch {}
			watcherPid = undefined;
		}

		latestCtx = ctx;
		isInTmux = !!process.env.TMUX;
		if (isInTmux) paneId = getPaneId();

		updateStatus(ctx);
	});

	// ── Border attention ─────────────────────────────────────────────────

	pi.on("agent_start", async (_event, ctx) => {
		latestCtx = ctx;
		clearAttentionWidgets(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		latestCtx = ctx;
		setAttentionWidgets(ctx);
	});

	// ── Shutdown / pane watcher ──────────────────────────────────────────

	pi.on("session_shutdown", () => {
		if (latestCtx) clearAttentionWidgets(latestCtx);
		if (isInTmux && paneId) {
			const capturedPane = paneId;
			const parentPid = process.pid;
			const watcher = spawn(
				"bash",
				["-c", `while kill -0 ${parentPid} 2>/dev/null; do sleep 0.2; done; tmux kill-pane -t '${capturedPane}'`],
				{ detached: true, stdio: "ignore" }
			);
			watcher.unref();
			watcherPid = watcher.pid;
		}
	});

	// ── Footer ───────────────────────────────────────────────────────────

	function updateStatus(ctx: ExtensionContext) {
		const branch = getCurrentBranch(ctx.cwd);
		if (branch && isInTmux) {
			const theme = ctx.ui.theme;
			ctx.ui.setStatus("tmux-branch", theme.fg("dim", "tmux:") + theme.fg("accent", branch));
		}
	}

	// ── Commands & shortcuts ─────────────────────────────────────────────

	pi.registerCommand("worktrees", {
		description: "Switch between git worktrees",
		handler: async (_args, ctx) => { await showWorktreeOverlay(ctx); },
	});

	pi.registerShortcut(Key.ctrlAlt("w"), {
		description: "Switch between git worktrees (Ctrl+Alt+W)",
		handler: async (ctx) => { await showWorktreeOverlay(ctx as ExtensionCommandContext); },
	});

	// ── /split command ────────────────────────────────────────────────────

	pi.registerCommand("split", {
		description: "Split tmux pane with the same session context. Usage: /split [h|v]",
		handler: async (args, ctx) => {
			if (!isInTmux) {
				ctx.ui.notify("Not inside tmux — cannot split", "warning");
				return;
			}

			const orientation = args.trim() === "v" ? "v" : "h";

			// Get current session file and copy it
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) {
				ctx.ui.notify("No session file found — start a conversation first", "warning");
				return;
			}

			const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
			const newSessionFile = join(dirname(sessionFile), `split-${timestamp}.jsonl`);

			try {
				copyFileSync(sessionFile, newSessionFile);
			} catch (e) {
				ctx.ui.notify(`Failed to copy session: ${e}`, "error");
				return;
			}

			const ticket = process.env.PI_LINEAR_TICKET ? `PI_LINEAR_TICKET=${process.env.PI_LINEAR_TICKET} ` : "";
			const newPane = tmuxRun(
				"split-window", `-${orientation}`, "-c", ctx.cwd,
				`${ticket}pi --session ${JSON.stringify(newSessionFile)}`
			);

			if (!newPane) ctx.ui.notify("Failed to split pane", "error");
		},
	});

	pi.registerShortcut(Key.ctrlAlt("s"), {
		description: "Split pane horizontally with same session context (Ctrl+Alt+S)",
		handler: async (ctx) => {
			const cmdCtx = ctx as ExtensionCommandContext;
			if (!isInTmux) { cmdCtx.ui.notify("Not inside tmux", "warning"); return; }

			const sessionFile = cmdCtx.sessionManager.getSessionFile();
			if (!sessionFile) { cmdCtx.ui.notify("No session file", "warning"); return; }

			const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
			const newSessionFile = join(dirname(sessionFile), `split-${timestamp}.jsonl`);

			try { copyFileSync(sessionFile, newSessionFile); } catch { cmdCtx.ui.notify("Failed to copy session", "error"); return; }

			const ticket = process.env.PI_LINEAR_TICKET ? `PI_LINEAR_TICKET=${process.env.PI_LINEAR_TICKET} ` : "";
			tmuxRun("split-window", "-h", "-c", cmdCtx.cwd, `${ticket}pi --session ${JSON.stringify(newSessionFile)}`);
		},
	});

	// ── Worktree overlay ──────────────────────────────────────────────────

	async function showWorktreeOverlay(ctx: ExtensionCommandContext) {
		const worktrees = listWorktrees(ctx.cwd);
		if (worktrees.length === 0) { ctx.ui.notify("No git worktrees found", "warning"); return; }

		ctx.ui.notify("Loading PR info…", "info");
		const prMap = fetchAllPrInfo(ctx.cwd);

		type Action = { action: "switch"; path: string; branch: string }
		            | { action: "remove"; path: string; branch: string }
		            | { action: "create" };

		const enriched = worktrees.map(wt => ({ wt, pr: prMap.get(wt.branch) }));
		const sorted = [
			...enriched.filter(e => e.wt.isCurrent),
			...enriched.filter(e => !e.wt.isCurrent && e.pr?.state === "OPEN"),
			...enriched.filter(e => !e.wt.isCurrent && !e.pr),
			...enriched.filter(e => !e.wt.isCurrent && e.pr && e.pr.state !== "OPEN"),
		];

		const items: SelectItem[] = sorted.map(({ wt, pr }) => {
			const cur = wt.isCurrent ? "● " : "  ";
			const badge = pr
				? pr.state === "OPEN" ? (pr.isDraft ? " [draft]" : " [PR]")
				: pr.state === "MERGED" ? " [merged]" : " [closed]"
				: "";
			const ticket = parseTicketId(wt.branch);
			return {
				value: JSON.stringify({ path: wt.path, branch: wt.branch, done: pr?.state === "MERGED" || pr?.state === "CLOSED" }),
				label: `${cur}${wt.branch || "(detached)"}${badge}`,
				description: `${wt.commit}  ${ticket ?? ""}  ${wt.path}`,
			};
		});
		items.push({ value: "__create__", label: "+ Create new worktree", description: "Enter a branch name" });

		const result = await ctx.ui.custom<Action | undefined>(
			(tui, theme, _kb, done) => {
				const inner = new Container();
				inner.addChild(new Text(theme.fg("accent", theme.bold(" Worktrees")), 0, 0));
				inner.addChild(new Text("", 0, 0));

				const selectList = new SelectList(items, Math.min(items.length, 14), {
					selectedPrefix: (t) => theme.fg("accent", t),
					selectedText:   (t) => theme.fg("accent", t),
					description:    (t) => theme.fg("muted", t),
					scrollInfo:     (t) => theme.fg("dim", t),
					noMatch:        (t) => theme.fg("warning", t),
				});

				selectList.onSelect = (item) => {
					if (item.value === "__create__") { done({ action: "create" }); return; }
					const { path, branch, done: isDone } = JSON.parse(item.value);
					done(isDone ? { action: "remove", path, branch } : { action: "switch", path, branch });
				};
				selectList.onCancel = () => done(undefined);

				inner.addChild(selectList);
				inner.addChild(new Text("", 0, 0));
				inner.addChild(new Text(theme.fg("dim", " ↑↓ navigate  enter select  esc cancel  [merged] → remove"), 0, 0));

				const box = new BoxedOverlay(inner, (s) => theme.fg("accent", s));

				return {
					render:      (w) => box.render(w),
					invalidate:  ()  => box.invalidate(),
					handleInput: (d) => { selectList.handleInput(d); tui.requestRender(); },
				};
			},
			{ overlay: true },
		);

		if (!result) return;

		if (result.action === "create") {
			const branch = await ctx.ui.input("Branch name", "eng-123-my-feature");
			if (!branch) return;
			await createAndSwitchWorktree(branch, ctx);
		} else if (result.action === "switch") {
			await switchToWorktree(result.path, result.branch, ctx);
		} else if (result.action === "remove") {
			const ok = await ctx.ui.confirm("Remove worktree?", `${result.branch}\n${result.path}`);
			if (!ok) return;
			const r = spawnSync("git", ["worktree", "remove", result.path], { cwd: ctx.cwd, encoding: "utf-8" });
			if (r.status !== 0) ctx.ui.notify(`Failed: ${r.stderr}`, "error");
			else ctx.ui.notify(`Removed: ${result.branch}`, "info");
		}
	}

	async function switchToWorktree(path: string, branch: string, ctx: ExtensionCommandContext) {
		const session = process.env.PI_TMUX_SESSION;
		if (!isInTmux || !session) { ctx.ui.notify(`Worktree: ${path}`, "info"); return; }

		const windows = tmuxRun("list-windows", "-t", session, "-F", "#{window_name}:#{pane_current_path}");
		const existing = windows?.split("\n").find((w) => w.includes(path));
		if (existing) {
			tmuxRun("select-window", "-t", `${session}:${existing.split(":")[0]}`);
			ctx.ui.notify(`Switched to ${branch}`, "info");
		} else {
			const ticket = parseTicketId(branch);
			const envArgs = ticket ? `PI_LINEAR_TICKET=${ticket} ` : "";
			tmuxRun("new-window", "-t", session, "-n", branch, "-c", path, `${envArgs}pi`);
			ctx.ui.notify(`Opened ${branch} in new tmux window`, "info");
		}
	}

	async function createAndSwitchWorktree(branch: string, ctx: ExtensionCommandContext) {
		const repoRoot  = execSync("git rev-parse --show-toplevel", { cwd: ctx.cwd, encoding: "utf-8" }).trim();
		const parentDir = repoRoot.replace(/\/[^/]+$/, "");
		const wtPath    = `${parentDir}/${branch}`;

		let r = spawnSync("git", ["worktree", "add", wtPath, "-b", branch], { cwd: ctx.cwd, encoding: "utf-8" });
		if (r.status !== 0) {
			r = spawnSync("git", ["worktree", "add", wtPath, branch], { cwd: ctx.cwd, encoding: "utf-8" });
			if (r.status !== 0) { ctx.ui.notify(`Failed: ${r.stderr}`, "error"); return; }
		}
		ctx.ui.notify(`Created worktree: ${branch}`, "info");
		await switchToWorktree(wtPath, branch, ctx);
	}
}
