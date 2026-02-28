/**
 * Quickfix Extension
 *
 * Parses error output from build/test/lint commands into a structured list.
 * The agent can work through errors methodically.
 *
 * - Tool: quickfix — runs a command, parses errors, returns structured list
 * - Command: /quickfix — re-runs last command and shows errors in overlay
 * - Widget: shows error count when errors are active
 */

import { spawnSync } from "node:child_process";

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Container, Text, type SelectItem, SelectList, type Component } from "@mariozechner/pi-tui";

// ── Types ────────────────────────────────────────────────────────────────────

interface QuickfixEntry {
	file: string;
	line: number;
	col?: number;
	severity: "error" | "warning" | "info";
	message: string;
	source?: string; // e.g. "TS2339", "no-unused-vars"
}

// ── Error Parsers ────────────────────────────────────────────────────────────

// TypeScript: src/file.ts(10,5): error TS2339: Property 'x' does not exist
const TS_PATTERN = /^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.+)$/;

// ESLint / generic: src/file.ts:10:5: error  no-unused-vars  'x' is defined but never used
const ESLINT_PATTERN = /^(.+?):(\d+):(\d+):\s*(error|warning)\s+(.+?)\s{2,}(.+)$/;

// Generic file:line:col: message (gcc, rustc, go, python tracebacks)
const GENERIC_PATTERN = /^(.+?):(\d+):(\d+)?:?\s*(error|warning|note|info)?:?\s*(.+)$/;

// Jest / Vitest: ● Test suite failed to run
// FAIL src/file.test.ts
const JEST_FAIL_PATTERN = /^\s*FAIL\s+(.+)$/;

// Jest error with line: at Object.<anonymous> (src/file.test.ts:42:5)
const JEST_LOCATION_PATTERN = /at\s+.+?\((.+?):(\d+):(\d+)\)/;

function parseErrors(output: string): QuickfixEntry[] {
	const entries: QuickfixEntry[] = [];
	const lines = output.split("\n");
	const seen = new Set<string>();

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!.trim();
		if (!line) continue;

		let entry: QuickfixEntry | undefined;

		// TypeScript
		let m = line.match(TS_PATTERN);
		if (m) {
			entry = {
				file: m[1]!, line: parseInt(m[2]!), col: parseInt(m[3]!),
				severity: m[4] as "error" | "warning", source: m[5], message: m[6]!,
			};
		}

		// ESLint
		if (!entry) {
			m = line.match(ESLINT_PATTERN);
			if (m) {
				entry = {
					file: m[1]!, line: parseInt(m[2]!), col: parseInt(m[3]!),
					severity: m[4] as "error" | "warning", source: m[5], message: m[6]!,
				};
			}
		}

		// Generic file:line:col
		if (!entry) {
			m = line.match(GENERIC_PATTERN);
			if (m && m[1] && !m[1].startsWith("node_modules") && !m[1].includes("://")) {
				const sev = m[4]?.toLowerCase();
				entry = {
					file: m[1], line: parseInt(m[2]!),
					col: m[3] ? parseInt(m[3]) : undefined,
					severity: sev === "warning" ? "warning" : sev === "info" ? "info" : "error",
					message: m[5]!,
				};
			}
		}

		if (entry) {
			const key = `${entry.file}:${entry.line}:${entry.message}`;
			if (!seen.has(key)) {
				seen.add(key);
				entries.push(entry);
			}
		}
	}

	return entries;
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

export default function quickfixExtension(pi: ExtensionAPI) {
	let errors: QuickfixEntry[] = [];
	let lastCommand: string | undefined;
	let latestCtx: ExtensionContext | undefined;

	function updateWidget(ctx: ExtensionContext) {
		if (errors.length === 0) {
			ctx.ui.setWidget("quickfix", undefined);
			return;
		}
		const errCount = errors.filter(e => e.severity === "error").length;
		const warnCount = errors.filter(e => e.severity === "warning").length;
		const parts: string[] = [];
		if (errCount > 0) parts.push(ctx.ui.theme.fg("error", `✗ ${errCount} errors`));
		if (warnCount > 0) parts.push(ctx.ui.theme.fg("warning", `⚠ ${warnCount} warnings`));
		ctx.ui.setWidget("quickfix", [parts.join("  ")]);
	}

	pi.on("session_start", async (_event, ctx) => { latestCtx = ctx; });

	// ── Tool ──────────────────────────────────────────────────────────────

	pi.registerTool({
		name: "quickfix",
		label: "Quickfix",
		description:
			"Run a build/test/lint command and parse its output into a structured error list. " +
			"Returns file, line, column, severity, and message for each error. " +
			"Use this to systematically work through failures.",
		parameters: Type.Object({
			command: Type.String({ description: "Command to run (e.g. 'tsc --noEmit', 'eslint .', 'npm test')" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			lastCommand = params.command;

			const result = spawnSync("bash", ["-c", params.command], {
				cwd: ctx.cwd,
				encoding: "utf-8",
				timeout: 120000,
			});

			const output = (result.stdout || "") + "\n" + (result.stderr || "");
			errors = parseErrors(output);
			latestCtx = ctx;
			updateWidget(ctx);

			if (errors.length === 0 && result.status === 0) {
				return {
					content: [{ type: "text", text: "✓ No errors found." }],
					details: { success: true, errors: [], exitCode: result.status },
				};
			}

			if (errors.length === 0) {
				return {
					content: [{ type: "text", text: `Command exited with code ${result.status} but no parseable errors found.\n\nOutput:\n${output.slice(-2000)}` }],
					details: { success: false, errors: [], exitCode: result.status },
				};
			}

			const errCount = errors.filter(e => e.severity === "error").length;
			const warnCount = errors.filter(e => e.severity === "warning").length;

			const lines = [
				`Found ${errCount} errors, ${warnCount} warnings:`,
				"",
				...errors.map((e, i) => {
					const icon = e.severity === "error" ? "✗" : e.severity === "warning" ? "⚠" : "ℹ";
					const loc = e.col ? `${e.file}:${e.line}:${e.col}` : `${e.file}:${e.line}`;
					const src = e.source ? ` [${e.source}]` : "";
					return `${i + 1}. ${icon} ${loc}${src}\n   ${e.message}`;
				}),
			];

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { success: true, errors, exitCode: result.status, errorCount: errCount, warnCount },
			};
		},

		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("quickfix")) + theme.fg("dim", ` $ ${args.command ?? "..."}`),
				0, 0
			);
		},

		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("dim", "⟳ running…"), 0, 0);
			const errs = (result.details?.errorCount as number) ?? 0;
			const warns = (result.details?.warnCount as number) ?? 0;
			if (errs === 0 && warns === 0) return new Text(theme.fg("success", "✓ clean"), 0, 0);
			const parts: string[] = [];
			if (errs > 0) parts.push(theme.fg("error", `✗ ${errs}`));
			if (warns > 0) parts.push(theme.fg("warning", `⚠ ${warns}`));
			return new Text(parts.join("  "), 0, 0);
		},
	});

	// ── /quickfix command ─────────────────────────────────────────────────

	pi.registerCommand("quickfix", {
		description: "Show quickfix error list (re-runs last command if given)",
		handler: async (args, ctx) => {
			const cmd = args.trim() || lastCommand;

			if (cmd) {
				lastCommand = cmd;
				ctx.ui.notify(`Running: ${cmd}`, "info");
				const result = spawnSync("bash", ["-c", cmd], { cwd: ctx.cwd, encoding: "utf-8", timeout: 120000 });
				const output = (result.stdout || "") + "\n" + (result.stderr || "");
				errors = parseErrors(output);
				latestCtx = ctx;
				updateWidget(ctx);
			}

			if (errors.length === 0) {
				ctx.ui.notify(cmd ? "✓ No errors found" : "No errors. Run /quickfix <command> first", "info");
				return;
			}

			const items: SelectItem[] = errors.map((e, i) => {
				const icon = e.severity === "error" ? "✗" : "⚠";
				const loc = e.col ? `${e.file}:${e.line}:${e.col}` : `${e.file}:${e.line}`;
				return {
					value: String(i),
					label: `${icon} ${loc}`,
					description: e.message.slice(0, 80),
				};
			});

			await ctx.ui.custom<void>(
				(tui, theme, _kb, done) => {
					const inner = new Container();
					const errCount = errors.filter(e => e.severity === "error").length;
					const warnCount = errors.filter(e => e.severity === "warning").length;
					inner.addChild(new Text(
						" " + theme.fg("error", theme.bold(`Quickfix`)) +
						theme.fg("dim", `  ${errCount} errors, ${warnCount} warnings`),
						0, 0
					));
					inner.addChild(new Text("", 0, 0));

					const selectList = new SelectList(items, Math.min(items.length, 16), {
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

					const box = new BoxedOverlay(inner, (s) => theme.fg("error", s));

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
