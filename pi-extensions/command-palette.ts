/**
 * Command Palette Extension
 *
 * Ctrl+Alt+K opens a searchable overlay listing all available commands,
 * tools, and keyboard shortcuts. Selecting a command inserts it into the editor.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Container, Key, Text, type SelectItem, SelectList, type Component } from "@mariozechner/pi-tui";

// ── Types ────────────────────────────────────────────────────────────────────

interface PaletteEntry {
	label: string;
	description: string;
	type: "command" | "tool" | "shortcut" | "builtin";
	value: string; // what to insert into editor
}

// ── Discover commands from extension files ───────────────────────────────────

function discoverExtensions(extDir: string): PaletteEntry[] {
	const entries: PaletteEntry[] = [];

	let files: string[];
	try { files = readdirSync(extDir); } catch { return entries; }

	for (const name of files) {
		const fullPath = join(extDir, name);
		let content: string;

		try {
			const stat = statSync(fullPath);
			if (stat.isDirectory()) {
				// Check for index.ts in subdirectory
				const indexPath = join(fullPath, "index.ts");
				try { content = readFileSync(indexPath, "utf-8"); } catch { continue; }
			} else if (name.endsWith(".ts")) {
				content = readFileSync(fullPath, "utf-8");
			} else continue;
		} catch { continue; }

		const extName = name.replace(/\.ts$/, "");

		// Extract registerCommand calls
		const cmdRegex = /registerCommand\s*\(\s*["']([^"']+)["']\s*,\s*\{[^}]*description:\s*["']([^"']+)["']/g;
		let m;
		while ((m = cmdRegex.exec(content)) !== null) {
			entries.push({
				label: `/${m[1]}`,
				description: m[2]!,
				type: "command",
				value: `/${m[1]} `,
			});
		}

		// Extract registerTool calls
		const toolRegex = /registerTool\s*\(\s*\{[^}]*name:\s*["']([^"']+)["'][^}]*description:\s*["']([^"']*?)["']/gs;
		while ((m = toolRegex.exec(content)) !== null) {
			entries.push({
				label: m[1]!,
				description: m[2]!.slice(0, 80),
				type: "tool",
				value: `Use the ${m[1]} tool`,
			});
		}

		// Extract registerShortcut calls
		const shortcutRegex = /registerShortcut\s*\(\s*Key\.(\w+)\s*\(\s*["']([^"']+)["']\s*\)\s*,\s*\{[^}]*description:\s*["']([^"']+)["']/g;
		while ((m = shortcutRegex.exec(content)) !== null) {
			const modifier = m[1]!;
			const key = m[2]!;
			const keyLabel = modifier === "ctrlAlt" ? `Ctrl+Alt+${key.toUpperCase()}`
				: modifier === "ctrl" ? `Ctrl+${key.toUpperCase()}`
				: modifier === "alt" ? `Alt+${key.toUpperCase()}`
				: `${modifier}+${key}`;
			entries.push({
				label: keyLabel,
				description: m[3]!,
				type: "shortcut",
				value: "",
			});
		}
	}

	return entries;
}

// ── Built-in pi commands ─────────────────────────────────────────────────────

const BUILTINS: PaletteEntry[] = [
	{ label: "/new",     description: "Start a new session",                    type: "builtin", value: "/new" },
	{ label: "/resume",  description: "Pick from previous sessions",            type: "builtin", value: "/resume" },
	{ label: "/name",    description: "Set session display name",               type: "builtin", value: "/name " },
	{ label: "/session", description: "Show session info (path, tokens, cost)", type: "builtin", value: "/session" },
	{ label: "/tree",    description: "Navigate the session tree",              type: "builtin", value: "/tree" },
	{ label: "/fork",    description: "Create a new session from current branch", type: "builtin", value: "/fork" },
	{ label: "/reload",  description: "Reload extensions, skills, prompts",     type: "builtin", value: "/reload" },
	{ label: "/compact", description: "Compact the conversation",               type: "builtin", value: "/compact" },
	{ label: "/export",  description: "Export session to HTML",                 type: "builtin", value: "/export " },
	{ label: "/login",   description: "Login to a provider",                    type: "builtin", value: "/login" },
	{ label: "/model",   description: "Select model",                           type: "builtin", value: "/model " },
	{ label: "/tools",   description: "Manage active tools",                    type: "builtin", value: "/tools" },
	{ label: "/thinking", description: "Set thinking level",                    type: "builtin", value: "/thinking " },
	// Built-in shortcuts
	{ label: "Ctrl+L",       description: "Open model selector",            type: "shortcut", value: "" },
	{ label: "Ctrl+P",       description: "Cycle to next model",            type: "shortcut", value: "" },
	{ label: "Ctrl+O",       description: "Expand/collapse tool output",    type: "shortcut", value: "" },
	{ label: "Ctrl+T",       description: "Expand/collapse thinking",       type: "shortcut", value: "" },
	{ label: "Ctrl+G",       description: "Open in external editor",        type: "shortcut", value: "" },
	{ label: "Alt+Enter",    description: "Queue follow-up message",        type: "shortcut", value: "" },
	{ label: "Escape",       description: "Cancel / abort",                 type: "shortcut", value: "" },
];

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

// ── Extension ─────────────────────────────────────────────────────────────────

export default function commandPaletteExtension(pi: ExtensionAPI) {
	const extDir = join(homedir(), ".pi", "agent", "extensions");

	async function showPalette(ctx: ExtensionCommandContext) {
		const discovered = discoverExtensions(extDir);
		const all = [...BUILTINS, ...discovered];

		// Deduplicate by label
		const seen = new Set<string>();
		const unique = all.filter(e => {
			if (seen.has(e.label)) return false;
			seen.add(e.label);
			return true;
		});

		// Sort: commands first, then tools, then shortcuts
		const sorted = unique.sort((a, b) => {
			const order = { builtin: 0, command: 1, tool: 2, shortcut: 3 };
			return (order[a.type] ?? 9) - (order[b.type] ?? 9);
		});

		const typeLabel = { builtin: "cmd", command: "cmd", tool: "tool", shortcut: "key" };
		const items: SelectItem[] = sorted.map(e => ({
			value: e.value || e.label,
			label: `[${typeLabel[e.type]}] ${e.label}`,
			description: e.description,
		}));

		const result = await ctx.ui.custom<string | null>(
			(tui, theme, _kb, done) => {
				const inner = new Container();
				inner.addChild(new Text(" " + theme.fg("accent", theme.bold("Command Palette")) + theme.fg("dim", "  type to filter"), 0, 0));
				inner.addChild(new Text("", 0, 0));

				const selectList = new SelectList(items, Math.min(items.length, 18), {
					selectedPrefix: (t) => theme.fg("accent", t),
					selectedText: (t) => theme.fg("accent", t),
					description: (t) => theme.fg("muted", t),
					scrollInfo: (t) => theme.fg("dim", t),
					noMatch: (t) => theme.fg("warning", t),
				});
				selectList.searchable = true;

				selectList.onSelect = (item) => done(item.value);
				selectList.onCancel = () => done(null);

				inner.addChild(selectList);
				inner.addChild(new Text("", 0, 0));
				inner.addChild(new Text(theme.fg("dim", " enter select  esc cancel"), 0, 0));

				const box = new BoxedOverlay(inner, (s) => theme.fg("accent", s));

				return {
					render: (w) => box.render(w),
					invalidate: () => box.invalidate(),
					handleInput: (d) => { selectList.handleInput(d); tui.requestRender(); },
				};
			},
			{ overlay: true },
		);

		if (result && result.startsWith("/")) {
			ctx.ui.setEditorText(result);
		} else if (result) {
			ctx.ui.setEditorText(result);
		}
	}

	pi.registerCommand("commands", {
		description: "Open command palette",
		handler: async (_args, ctx) => { await showPalette(ctx); },
	});

	pi.registerShortcut(Key.ctrlAlt("k"), {
		description: "Open command palette (Ctrl+Alt+K)",
		handler: async (ctx) => { await showPalette(ctx as ExtensionCommandContext); },
	});
}
