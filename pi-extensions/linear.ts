/**
 * Linear Extension
 *
 * - Fetches ticket from PI_LINEAR_TICKET env or branch name on session start
 * - Injects ticket context into system prompt (before_agent_start)
 * - Footer: ENG-123 In Progress
 * - Tool: read_linear_ticket (with optional refetch)
 * - Command: /ticket — overlay showing ticket details
 */

import { spawnSync } from "node:child_process";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Container, Text, type Component } from "@mariozechner/pi-tui";

// ── Types ────────────────────────────────────────────────────────────────────

interface LinearTicket {
	id: string;
	title: string;
	description: string;
	state: string;
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

async function fetchLinearTicket(ticketId: string): Promise<LinearTicket | undefined> {
	const apiKey = process.env.LINEAR_API_KEY;
	if (!apiKey) return undefined;

	try {
		const query = JSON.stringify({
			query: `{ issue(id: "${ticketId}") { title description state { name } } }`,
		});

		const result = spawnSync("curl", [
			"-s", "-X", "POST",
			"https://api.linear.app/graphql",
			"-H", "Content-Type: application/json",
			"-H", `Authorization: ${apiKey}`,
			"-d", query,
		], { encoding: "utf-8", timeout: 10000 });

		if (result.status !== 0) return undefined;
		const data = JSON.parse(result.stdout);
		const issue = data?.data?.issue;
		if (!issue) return undefined;

		return {
			id: ticketId,
			title: issue.title || "",
			description: issue.description || "",
			state: issue.state?.name || "",
		};
	} catch {
		return undefined;
	}
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

// ── Extension ─────────────────────────────────────────────────────────────────

export default function linearExtension(pi: ExtensionAPI) {
	let ticket: LinearTicket | undefined;
	let ticketId: string | undefined;

	// ── Session start ────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		ticketId = process.env.PI_LINEAR_TICKET || undefined;
		if (!ticketId) {
			const branch = getCurrentBranch(ctx.cwd);
			if (branch) ticketId = parseTicketId(branch);
		}

		if (ticketId) ticket = await fetchLinearTicket(ticketId);

		updateStatus(ctx);
	});

	// ── System prompt injection ──────────────────────────────────────────

	pi.on("before_agent_start", async (event) => {
		if (!ticket) return undefined;

		const context = [
			`\n\n## Linear Ticket: ${ticket.id}`,
			`**Title:** ${ticket.title}`,
			ticket.state ? `**Status:** ${ticket.state}` : "",
			ticket.description ? `**Description:**\n${ticket.description}` : "",
		].filter(Boolean).join("\n");

		return { systemPrompt: event.systemPrompt + context };
	});

	// ── Footer ───────────────────────────────────────────────────────────

	function updateStatus(ctx: ExtensionContext) {
		if (!ticketId) return;
		const theme = ctx.ui.theme;
		const stateLabel = ticket?.state ? theme.fg("dim", ` ${ticket.state}`) : "";
		ctx.ui.setStatus("linear", theme.fg("warning", ticketId) + stateLabel);
	}

	// ── Tool: read_linear_ticket ─────────────────────────────────────────

	pi.registerTool({
		name: "read_linear_ticket",
		label: "Read Linear Ticket",
		description:
			"Read the current Linear ticket's full details (id, title, description, state). " +
			"Use refetch=true to pull the latest version from the API.",
		parameters: Type.Object({
			refetch: Type.Optional(Type.Boolean({ description: "Force a fresh fetch from Linear API" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (params.refetch && ticketId) {
				ticket = await fetchLinearTicket(ticketId);
				updateStatus(ctx);
			}

			if (!ticket) {
				return {
					content: [{ type: "text", text: ticketId
						? `No data for ${ticketId}. Is LINEAR_API_KEY set?`
						: "No Linear ticket on this branch." }],
					details: { success: false },
				};
			}

			const text = [
				`# ${ticket.id}: ${ticket.title}`,
				`**Status:** ${ticket.state || "Unknown"}`,
				"",
				ticket.description || "(no description)",
			].join("\n");

			return {
				content: [{ type: "text", text }],
				details: { success: true, ticket },
			};
		},

		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("read_linear_ticket")), 0, 0);
		},

		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("dim", "⟳ fetching…"), 0, 0);
			if (!result.details?.success) return new Text(theme.fg("warning", "– no ticket"), 0, 0);
			const t = result.details.ticket as LinearTicket;
			return new Text(
				theme.fg("warning", t.id) +
				theme.fg("dim", `  ${t.state}  `) +
				theme.fg("muted", t.title.slice(0, 60)),
				0, 0
			);
		},
	});

	// ── Command: /ticket ─────────────────────────────────────────────────

	pi.registerCommand("ticket", {
		description: "Show current Linear ticket details",
		handler: async (_args, ctx) => {
			if (!ticket) {
				ctx.ui.notify(
					ticketId ? `No data for ${ticketId} — is LINEAR_API_KEY set?` : "No ticket on this branch",
					"warning"
				);
				return;
			}

			await ctx.ui.custom<void>(
				(_tui, theme, _kb, done) => {
					const inner = new Container();
					inner.addChild(new Text(
						" " + theme.fg("warning", theme.bold(ticket!.id)) +
						theme.fg("dim", "  " + ticket!.state), 0, 0
					));
					inner.addChild(new Text(" " + theme.bold(ticket!.title), 0, 0));
					inner.addChild(new Text("", 0, 0));

					for (const line of (ticket!.description || "(no description)").split("\n").slice(0, 40)) {
						inner.addChild(new Text(theme.fg("muted", " " + line), 0, 0));
					}

					inner.addChild(new Text("", 0, 0));
					inner.addChild(new Text(theme.fg("dim", " esc / q  close"), 0, 0));

					const box = new BoxedOverlay(inner, (s) => theme.fg("accent", s));

					return {
						render:      (w) => box.render(w),
						invalidate:  ()  => box.invalidate(),
						handleInput: (d) => { if (d === "\x1b" || d === "q") done(undefined); },
					};
				},
				{ overlay: true },
			);
		},
	});
}
