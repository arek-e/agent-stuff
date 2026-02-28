/**
 * Tmux Management Extension
 *
 * - /tmux — overlay to list, switch, kill sessions and windows
 * - Ctrl+Alt+T — quick access
 * - tmux tool — agent can list/kill/rename sessions
 */

import { spawnSync } from "node:child_process";

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { Container, Key, Text, type SelectItem, SelectList, type Component } from "@mariozechner/pi-tui";

// ── Helpers ──────────────────────────────────────────────────────────────────

function tmux(...args: string[]): { ok: boolean; out: string } {
	const r = spawnSync("tmux", args, { encoding: "utf-8", timeout: 5000 });
	return { ok: r.status === 0, out: (r.stdout || "").trim() };
}

interface TmuxSession {
	name: string;
	windows: number;
	attached: boolean;
	created: string;
	activity: string;
}

interface TmuxWindow {
	session: string;
	index: string;
	name: string;
	panes: number;
	active: boolean;
	path: string;
}

function listSessions(): TmuxSession[] {
	const { ok, out } = tmux("list-sessions", "-F",
		"#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}\t#{session_activity}");
	if (!ok || !out) return [];
	return out.split("\n").map(line => {
		const [name, windows, attached, created, activity] = line.split("\t");
		return {
			name: name!,
			windows: parseInt(windows || "0"),
			attached: attached === "1",
			created: formatEpoch(created),
			activity: formatEpoch(activity),
		};
	});
}

function listWindows(session?: string): TmuxWindow[] {
	const args = session
		? ["list-windows", "-t", session, "-F", "#{session_name}\t#{window_index}\t#{window_name}\t#{window_panes}\t#{window_active}\t#{pane_current_path}"]
		: ["list-windows", "-a", "-F", "#{session_name}\t#{window_index}\t#{window_name}\t#{window_panes}\t#{window_active}\t#{pane_current_path}"];
	const { ok, out } = tmux(...args);
	if (!ok || !out) return [];
	return out.split("\n").map(line => {
		const [session, index, name, panes, active, path] = line.split("\t");
		return {
			session: session!, index: index!, name: name!,
			panes: parseInt(panes || "1"), active: active === "1",
			path: path || "",
		};
	});
}

function formatEpoch(epoch: string | undefined): string {
	if (!epoch) return "";
	try {
		const d = new Date(parseInt(epoch) * 1000);
		const now = Date.now();
		const diffMs = now - d.getTime();
		const mins = Math.floor(diffMs / 60000);
		if (mins < 1) return "just now";
		if (mins < 60) return `${mins}m ago`;
		const hours = Math.floor(mins / 60);
		if (hours < 24) return `${hours}h ago`;
		const days = Math.floor(hours / 24);
		return `${days}d ago`;
	} catch { return ""; }
}

function currentSession(): string | undefined {
	const { ok, out } = tmux("display-message", "-p", "#{session_name}");
	return ok ? out : undefined;
}

// ── BoxedOverlay ──────────────────────────────────────────────────────────────

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

export default function tmuxExtension(pi: ExtensionAPI) {
	if (!process.env.TMUX) return; // no-op outside tmux

	// ── Tool ──────────────────────────────────────────────────────────────

	pi.registerTool({
		name: "tmux",
		label: "Tmux",
		description:
			"Manage tmux sessions and windows. " +
			"Actions: list (show all sessions/windows), kill (kill a session), " +
			"rename (rename a session), new (create a session).",
		parameters: Type.Object({
			action: StringEnum(["list", "kill", "rename", "new"] as const),
			session: Type.Optional(Type.String({ description: "Session name (for kill/rename)" })),
			name: Type.Optional(Type.String({ description: "New name (for rename/new)" })),
			cwd: Type.Optional(Type.String({ description: "Working directory (for new)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			switch (params.action) {
				case "list": {
					const sessions = listSessions();
					if (sessions.length === 0) {
						return { content: [{ type: "text", text: "No tmux sessions." }], details: { success: true, sessions: [] } };
					}
					const cur = currentSession();
					const lines = sessions.map(s => {
						const marker = s.name === cur ? "● " : "  ";
						const att = s.attached ? " (attached)" : "";
						return `${marker}${s.name} — ${s.windows} window${s.windows !== 1 ? "s" : ""}${att}, active ${s.activity}`;
					});
					return {
						content: [{ type: "text", text: lines.join("\n") }],
						details: { success: true, sessions },
					};
				}
				case "kill": {
					if (!params.session) {
						return { content: [{ type: "text", text: "Specify session name to kill." }], details: { success: false } };
					}
					const cur = currentSession();
					if (params.session === cur) {
						return { content: [{ type: "text", text: "Cannot kill the current session." }], details: { success: false } };
					}
					const { ok } = tmux("kill-session", "-t", params.session);
					return {
						content: [{ type: "text", text: ok ? `Killed session: ${params.session}` : `Failed to kill: ${params.session}` }],
						details: { success: ok },
					};
				}
				case "rename": {
					if (!params.session || !params.name) {
						return { content: [{ type: "text", text: "Specify session and name." }], details: { success: false } };
					}
					const { ok } = tmux("rename-session", "-t", params.session, params.name);
					return {
						content: [{ type: "text", text: ok ? `Renamed ${params.session} → ${params.name}` : `Failed to rename` }],
						details: { success: ok },
					};
				}
				case "new": {
					const name = params.name || `session-${Date.now()}`;
					const args = ["new-session", "-d", "-s", name];
					if (params.cwd) args.push("-c", params.cwd);
					const { ok } = tmux(...args);
					return {
						content: [{ type: "text", text: ok ? `Created session: ${name}` : `Failed to create session` }],
						details: { success: ok },
					};
				}
			}
		},

		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("tmux")) +
				theme.fg("dim", ` ${args.action ?? "..."}`) +
				(args.session ? theme.fg("muted", ` ${args.session}`) : ""),
				0, 0
			);
		},

		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("dim", "⟳ …"), 0, 0);
			return new Text(
				result.details?.success ? theme.fg("success", "✓") : theme.fg("error", "✗"),
				0, 0
			);
		},
	});

	// ── Overlay ───────────────────────────────────────────────────────────

	async function showTmuxOverlay(ctx: ExtensionCommandContext) {
		const sessions = listSessions();
		const windows = listWindows();
		const cur = currentSession();

		type Action = { action: "switch"; target: string }
		            | { action: "kill"; target: string; label: string }
		            | { action: "new" };

		// Build items: sessions → windows
		const items: SelectItem[] = [];
		for (const s of sessions) {
			const isCur = s.name === cur;
			const marker = isCur ? "●" : " ";
			const att = s.attached ? " (attached)" : "";
			items.push({
				value: JSON.stringify({ action: "switch", target: `${s.name}:` }),
				label: `${marker} ${s.name}${att}`,
				description: `${s.windows} win, active ${s.activity}`,
			});

			// Show windows under each session
			const sessionWindows = windows.filter(w => w.session === s.name);
			for (const w of sessionWindows) {
				const wActive = w.active ? "▸" : " ";
				items.push({
					value: JSON.stringify({ action: "switch", target: `${s.name}:${w.index}` }),
					label: `   ${wActive} ${w.index}: ${w.name}`,
					description: w.path.replace(process.env.HOME || "", "~"),
				});
			}
		}

		items.push({ value: JSON.stringify({ action: "new" }), label: "+ New session", description: "" });

		const result = await ctx.ui.custom<Action | undefined>(
			(tui, theme, _kb, done) => {
				const inner = new Container();
				inner.addChild(new Text(" " + theme.fg("accent", theme.bold("Tmux Sessions")), 0, 0));
				inner.addChild(new Text("", 0, 0));

				const selectList = new SelectList(items, Math.min(items.length, 18), {
					selectedPrefix: (t) => theme.fg("accent", t),
					selectedText: (t) => theme.fg("accent", t),
					description: (t) => theme.fg("muted", t),
					scrollInfo: (t) => theme.fg("dim", t),
					noMatch: (t) => theme.fg("warning", t),
				});
				selectList.searchable = true;

				selectList.onSelect = (item) => {
					const parsed = JSON.parse(item.value);
					if (parsed.action === "new") { done({ action: "new" }); return; }
					// Check if this is a session header — offer kill for non-current
					const sessions2 = listSessions();
					const target = parsed.target.split(":")[0];
					const isCurrent = target === currentSession();
					if (isCurrent) {
						done({ action: "switch", target: parsed.target });
					} else {
						done({ action: "switch", target: parsed.target });
					}
				};
				selectList.onCancel = () => done(undefined);

				inner.addChild(selectList);
				inner.addChild(new Text("", 0, 0));
				inner.addChild(new Text(theme.fg("dim", " enter switch  d kill  esc cancel"), 0, 0));

				const box = new BoxedOverlay(inner, (s) => theme.fg("accent", s));

				// Handle 'd' for delete
				const origHandle = selectList.handleInput.bind(selectList);
				return {
					render: (w) => box.render(w),
					invalidate: () => box.invalidate(),
					handleInput: (data) => {
						if (data === "d" || data === "D") {
							const idx = (selectList as any).selectedIndex ?? 0;
							const item = items[idx];
							if (item) {
								try {
									const parsed = JSON.parse(item.value);
									const target = parsed.target?.split(":")[0];
									if (target && target !== currentSession()) {
										done({ action: "kill", target, label: item.label.trim() });
										return;
									}
								} catch {}
							}
						}
						origHandle(data);
						tui.requestRender();
					},
				};
			},
			{ overlay: true },
		);

		if (!result) return;

		if (result.action === "new") {
			const name = await ctx.ui.input("Session name", "my-session");
			if (!name) return;
			const { ok } = tmux("new-session", "-d", "-s", name);
			ctx.ui.notify(ok ? `Created: ${name}` : "Failed to create session", ok ? "info" : "error");
		} else if (result.action === "kill") {
			const ok = await ctx.ui.confirm("Kill session?", result.label);
			if (!ok) return;
			const { ok: killed } = tmux("kill-session", "-t", result.target);
			ctx.ui.notify(killed ? `Killed: ${result.target}` : "Failed", killed ? "info" : "error");
		} else if (result.action === "switch") {
			tmux("switch-client", "-t", result.target);
		}
	}

	// ── Commands & shortcuts ──────────────────────────────────────────────

	pi.registerCommand("tmux", {
		description: "Manage tmux sessions and windows",
		handler: async (_args, ctx) => { await showTmuxOverlay(ctx); },
	});

	pi.registerShortcut(Key.ctrlAlt("t"), {
		description: "Tmux session manager (Ctrl+Alt+T)",
		handler: async (ctx) => { await showTmuxOverlay(ctx as ExtensionCommandContext); },
	});
}
