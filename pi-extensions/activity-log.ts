/**
 * Activity Log Extension
 *
 * /log — shows a scannable list of everything the agent did this session:
 * tool calls, their arguments, success/failure, and timestamps.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Container, Text, type SelectItem, SelectList, type Component } from "@mariozechner/pi-tui";

// ── Types ────────────────────────────────────────────────────────────────────

interface LogEntry {
	timestamp: string;
	tool: string;
	args: string;
	success: boolean;
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

export default function activityLogExtension(pi: ExtensionAPI) {

	function summarizeToolArgs(toolName: string, content: unknown): string {
		if (!content) return "";
		if (typeof content === "string") return content.slice(0, 80);

		if (Array.isArray(content)) {
			const textParts = content
				.filter((c: any) => c?.type === "text" && c?.text)
				.map((c: any) => c.text as string);
			const joined = textParts.join(" ");

			// For known tools, extract key info
			if (toolName === "bash" || toolName === "Bash") {
				const cmdMatch = joined.match(/command['"]\s*:\s*['"](.+?)['"]/);
				return cmdMatch ? `$ ${cmdMatch[1]!.slice(0, 70)}` : joined.slice(0, 80);
			}
			if (toolName === "read" || toolName === "Read") {
				const pathMatch = joined.match(/path['"]\s*:\s*['"](.+?)['"]/);
				return pathMatch ? pathMatch[1]!.slice(0, 70) : joined.slice(0, 80);
			}
			if (toolName === "write" || toolName === "Write") {
				const pathMatch = joined.match(/path['"]\s*:\s*['"](.+?)['"]/);
				return pathMatch ? `write ${pathMatch[1]!.slice(0, 60)}` : joined.slice(0, 80);
			}
			if (toolName === "edit" || toolName === "Edit") {
				const pathMatch = joined.match(/path['"]\s*:\s*['"](.+?)['"]/);
				return pathMatch ? `edit ${pathMatch[1]!.slice(0, 60)}` : joined.slice(0, 80);
			}

			return joined.slice(0, 80);
		}

		return String(content).slice(0, 80);
	}

	function extractLogs(ctx: ExtensionCommandContext): LogEntry[] {
		const entries: LogEntry[] = [];

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message as any;

			// Tool calls from assistant messages
			if (msg.role === "assistant" && Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (block?.type === "tool_use") {
						const args = block.input
							? JSON.stringify(block.input).slice(0, 80)
							: "";
						entries.push({
							timestamp: entry.timestamp,
							tool: block.name || "unknown",
							args: formatToolArgs(block.name, block.input),
							success: true, // will be updated by result
						});
					}
				}
			}

			// Tool results
			if (msg.role === "toolResult") {
				const success = !String(msg.content?.[0]?.text ?? "").includes("Error");
				// Try to match with last entry of same tool
				for (let i = entries.length - 1; i >= 0; i--) {
					if (entries[i]!.tool === msg.toolName) {
						entries[i]!.success = success;
						break;
					}
				}
			}

			// Bash executions (! command)
			if (msg.role === "bashExecution") {
				entries.push({
					timestamp: entry.timestamp,
					tool: "bash (!)",
					args: `$ ${(msg.command || "").slice(0, 70)}`,
					success: msg.exitCode === 0 || msg.exitCode === undefined,
				});
			}
		}

		return entries;
	}

	function formatToolArgs(name: string, input: Record<string, unknown> | undefined): string {
		if (!input) return "";

		switch (name) {
			case "bash":
			case "Bash":
				return `$ ${String(input.command || "").slice(0, 70)}`;
			case "read":
			case "Read": {
				let s = String(input.path || "");
				if (input.offset) s += `:${input.offset}`;
				if (input.limit) s += `-${Number(input.offset || 1) + Number(input.limit)}`;
				return s.slice(0, 70);
			}
			case "write":
			case "Write":
				return `${input.path} (${String(input.content || "").split("\n").length} lines)`;
			case "edit":
			case "Edit":
				return String(input.path || "").slice(0, 70);
			default: {
				const s = JSON.stringify(input);
				return s.length > 80 ? s.slice(0, 77) + "…" : s;
			}
		}
	}

	function formatTime(iso: string): string {
		try {
			const d = new Date(iso);
			return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
		} catch {
			return "??:??";
		}
	}

	pi.registerCommand("log", {
		description: "Show activity log for this session",
		handler: async (_args, ctx) => {
			const logs = extractLogs(ctx);

			if (logs.length === 0) {
				ctx.ui.notify("No tool activity yet", "info");
				return;
			}

			const items: SelectItem[] = logs.map((l, i) => {
				const icon = l.success ? "✓" : "✗";
				const time = formatTime(l.timestamp);
				return {
					value: String(i),
					label: `${icon} ${time}  ${l.tool}`,
					description: l.args,
				};
			}).reverse(); // most recent first

			await ctx.ui.custom<void>(
				(tui, theme, _kb, done) => {
					const inner = new Container();
					inner.addChild(new Text(
						" " + theme.fg("accent", theme.bold("Activity Log")) +
						theme.fg("dim", `  ${logs.length} actions`),
						0, 0
					));
					inner.addChild(new Text("", 0, 0));

					const selectList = new SelectList(items, Math.min(items.length, 20), {
						selectedPrefix: (t) => theme.fg("accent", t),
						selectedText: (t) => theme.fg("accent", t),
						description: (t) => theme.fg("muted", t),
						scrollInfo: (t) => theme.fg("dim", t),
						noMatch: (t) => theme.fg("warning", t),
					});
					selectList.searchable = true;
					selectList.onSelect = () => done(undefined);
					selectList.onCancel = () => done(undefined);

					inner.addChild(selectList);
					inner.addChild(new Text("", 0, 0));
					inner.addChild(new Text(theme.fg("dim", " type to filter  esc close"), 0, 0));

					const box = new BoxedOverlay(inner, (s) => theme.fg("accent", s));

					return {
						render: (w) => box.render(w),
						invalidate: () => box.invalidate(),
						handleInput: (d) => { selectList.handleInput(d); tui.requestRender(); },
					};
				},
				{ overlay: true },
			);
		},
	});
}
