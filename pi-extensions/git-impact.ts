/**
 * Git Impact Analysis Extension
 *
 * Tool: git_impact — analyzes a file's importance and blast radius:
 *   - Who imports/depends on it
 *   - What tests cover it
 *   - Change frequency (churn)
 *   - Recent authors
 *   - Risk score
 */

import { spawnSync } from "node:child_process";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";

// ── Helpers ──────────────────────────────────────────────────────────────────

function run(cmd: string, args: string[], cwd: string): string {
	const r = spawnSync(cmd, args, { cwd, encoding: "utf-8", timeout: 15000 });
	return r.status === 0 ? r.stdout.trim() : "";
}

function findDependents(file: string, cwd: string): string[] {
	// Strip extension and leading ./ for import matching
	const base = file.replace(/\.[^.]+$/, "").replace(/^\.\//, "");
	const name = base.split("/").pop() || base;

	// Search for imports/requires referencing this file
	const patterns = [
		`from.*['"].*${name}['"]`,
		`require.*['"].*${name}['"]`,
		`import.*['"].*${name}['"]`,
	];

	const dependents = new Set<string>();
	for (const pattern of patterns) {
		const output = run("grep", ["-rl", "--include=*.ts", "--include=*.tsx",
			"--include=*.js", "--include=*.jsx", "--include=*.mjs",
			"-E", pattern, "."], cwd);
		for (const line of output.split("\n").filter(Boolean)) {
			const dep = line.replace(/^\.\//, "");
			if (dep !== file) dependents.add(dep);
		}
	}

	return [...dependents].sort();
}

function findTestFiles(file: string, cwd: string): string[] {
	const base = file.replace(/\.[^.]+$/, "").replace(/^\.\//, "");
	const name = base.split("/").pop() || "";

	// Common test file patterns
	const patterns = [
		`${name}.test.*`, `${name}.spec.*`, `${name}_test.*`,
		`test_${name}.*`, `test-${name}.*`,
	];

	const tests = new Set<string>();
	for (const pattern of patterns) {
		const output = run("find", [".", "-name", pattern,
			"-not", "-path", "*/node_modules/*",
			"-not", "-path", "*/.git/*"], cwd);
		for (const line of output.split("\n").filter(Boolean)) {
			tests.add(line.replace(/^\.\//, ""));
		}
	}

	// Also check if any test file imports this file
	const output = run("grep", ["-rl", "--include=*.test.*", "--include=*.spec.*",
		"-E", `['"].*${name}['"]`, "."], cwd);
	for (const line of output.split("\n").filter(Boolean)) {
		tests.add(line.replace(/^\.\//, ""));
	}

	return [...tests].sort();
}

function getChangeFrequency(file: string, cwd: string): { commits: number; daysActive: number } {
	const log = run("git", ["log", "--format=%H %aI", "--follow", "--", file], cwd);
	const lines = log.split("\n").filter(Boolean);
	if (lines.length === 0) return { commits: 0, daysActive: 0 };

	const dates = lines.map(l => l.split(" ")[1]!.slice(0, 10));
	const uniqueDays = new Set(dates);

	return { commits: lines.length, daysActive: uniqueDays.size };
}

function getRecentAuthors(file: string, cwd: string, limit = 5): { name: string; commits: number }[] {
	const output = run("git", ["log", "--format=%an", "-n", "50", "--follow", "--", file], cwd);
	const counts = new Map<string, number>();
	for (const name of output.split("\n").filter(Boolean)) {
		counts.set(name, (counts.get(name) || 0) + 1);
	}

	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, limit)
		.map(([name, commits]) => ({ name, commits }));
}

function getHotspots(cwd: string, limit = 10): { file: string; commits: number }[] {
	// Files with most commits in last 3 months
	const output = run("git", ["log", "--since=3 months ago", "--format=", "--name-only"], cwd);
	const counts = new Map<string, number>();
	for (const file of output.split("\n").filter(Boolean)) {
		if (file.includes("node_modules/") || file.includes(".git/")) continue;
		counts.set(file, (counts.get(file) || 0) + 1);
	}

	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, limit)
		.map(([file, commits]) => ({ file, commits }));
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function gitImpactExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "git_impact",
		label: "Git Impact",
		description:
			"Analyze a file's impact: who depends on it, what tests cover it, " +
			"change frequency, recent authors, and risk score. " +
			"Pass file='hotspots' to see the most frequently changed files.",
		parameters: Type.Object({
			file: Type.String({ description: "File path to analyze, or 'hotspots' for most-changed files" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (params.file === "hotspots") {
				const spots = getHotspots(ctx.cwd);
				if (spots.length === 0) {
					return { content: [{ type: "text", text: "No commit history found." }], details: { success: false } };
				}
				const lines = [
					"# Hot Spots (most changed files, last 3 months)",
					"",
					...spots.map((s, i) => `${i + 1}. **${s.file}** — ${s.commits} commits`),
				];
				return { content: [{ type: "text", text: lines.join("\n") }], details: { success: true, hotspots: spots } };
			}

			const dependents = findDependents(params.file, ctx.cwd);
			const tests = findTestFiles(params.file, ctx.cwd);
			const churn = getChangeFrequency(params.file, ctx.cwd);
			const authors = getRecentAuthors(params.file, ctx.cwd);

			// Risk score: high churn + many dependents + few tests = risky
			const riskFactors: string[] = [];
			if (dependents.length > 10) riskFactors.push("many dependents");
			if (dependents.length > 5 && tests.length === 0) riskFactors.push("no test coverage");
			if (churn.commits > 20) riskFactors.push("high churn");
			const risk = riskFactors.length >= 2 ? "HIGH" : riskFactors.length === 1 ? "MEDIUM" : "LOW";

			const lines = [
				`# Impact Analysis: ${params.file}`,
				"",
				`**Risk:** ${risk}${riskFactors.length > 0 ? ` (${riskFactors.join(", ")})` : ""}`,
				"",
				`## Dependents (${dependents.length})`,
				dependents.length > 0 ? dependents.map(d => `- ${d}`).join("\n") : "- (none found)",
				"",
				`## Test Coverage (${tests.length})`,
				tests.length > 0 ? tests.map(t => `- ${t}`).join("\n") : "- ⚠ No test files found",
				"",
				`## Change History`,
				`- ${churn.commits} commits, ${churn.daysActive} active days`,
				"",
				`## Recent Authors`,
				authors.length > 0
					? authors.map(a => `- ${a.name} (${a.commits} commits)`).join("\n")
					: "- (no history)",
			];

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { success: true, risk, dependents: dependents.length, tests: tests.length, churn, authors },
			};
		},

		renderCall(args, theme) {
			const file = args.file ?? "...";
			return new Text(
				theme.fg("toolTitle", theme.bold("git_impact")) +
				theme.fg("muted", ` ${file}`),
				0, 0
			);
		},

		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("dim", "⟳ analyzing…"), 0, 0);
			if (!result.details?.success) return new Text(theme.fg("warning", "– no data"), 0, 0);

			if (result.details.hotspots) {
				const spots = result.details.hotspots as { file: string; commits: number }[];
				return new Text(theme.fg("accent", `${spots.length} hot spots`), 0, 0);
			}

			const risk = result.details.risk as string;
			const deps = result.details.dependents as number;
			const tests = result.details.tests as number;
			const riskColor = risk === "HIGH" ? "error" : risk === "MEDIUM" ? "warning" : "success";
			return new Text(
				theme.fg(riskColor, risk) +
				theme.fg("dim", `  ${deps} dependents  ${tests} tests`),
				0, 0
			);
		},
	});
}
