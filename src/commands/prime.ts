import { existsSync } from "node:fs";
import type { Command } from "commander";
import { loadConfig } from "../config.ts";
import { outputJson } from "../output.ts";
import { TaskPool } from "../pool.ts";

export function register(program: Command): void {
	program
		.command("prime")
		.description("Inject mycelium session context for AI agents")
		.option("--compact", "Condensed quick-reference output")
		.action(async (options: { compact?: boolean }) => {
			const jsonMode = program.opts().json;
			const root = process.cwd();
			const hasMycelium = existsSync(`${root}/.mycelium`);

			const config = hasMycelium ? await loadConfig(root) : null;

			let poolStats: {
				pending: number;
				claimed: number;
				done: number;
				failed: number;
				total: number;
			} | null = null;

			if (hasMycelium && existsSync(`${root}/.mycelium/tasks.db`)) {
				let pool: TaskPool | null = null;
				try {
					pool = new TaskPool(`${root}/.mycelium/tasks.db`);
					poolStats = pool.stats();
				} catch {
					// pool unavailable
				} finally {
					pool?.close();
				}
			}

			if (jsonMode) {
				outputJson({
					success: true,
					command: "prime",
					project: config?.project.name ?? null,
					pool: poolStats,
					config: config
						? {
								canonicalBranch: config.project.canonicalBranch,
								workerCount: config.workers.defaultCount,
								workerRuntime: config.workers.runtime,
								decomposerModel: config.decomposer.model,
								ttl: config.pool.defaultTtl,
							}
						: null,
				});
				return;
			}

			if (options.compact) {
				const lines: string[] = ["```mycelium-session"];
				if (config) {
					lines.push(`project: ${config.project.name || "(unnamed)"}`);
					lines.push(`branch:  ${config.project.canonicalBranch}`);
					lines.push(`workers: ${config.workers.defaultCount} × ${config.workers.runtime}`);
				}
				if (poolStats) {
					lines.push(
						`pool:    ${poolStats.total} tasks  (${poolStats.pending} pending, ${poolStats.claimed} claimed, ${poolStats.done} done, ${poolStats.failed} failed)`,
					);
				} else {
					lines.push("pool:    No pool initialized");
				}
				lines.push("");
				lines.push("mc decompose '<intent>'   # create tasks");
				lines.push("mc spawn [n]              # start workers");
				lines.push("mc status                 # pool overview");
				lines.push("mc tasks                  # list tasks");
				lines.push("mc doctor                 # health checks");
				lines.push("```");
				console.log(lines.join("\n"));
				return;
			}

			// Full mode
			const out: string[] = [];

			out.push("# Mycelium Session Context");
			out.push("");

			// Session close protocol
			out.push("## Session Close Protocol");
			out.push("");
			out.push("Before ending your session:");
			out.push("- [ ] `mc sync` — commit .mycelium/ state");
			out.push("- [ ] `mc doctor` — verify health");
			out.push("- [ ] Close your seeds issue if work is complete");
			out.push("");

			// Architecture
			out.push("## Architecture");
			out.push("");
			out.push("```");
			out.push("Intent → Decomposer → Task Pool (SQLite) → Workers (tmux) → State Surface (repo)");
			out.push("              ↑                                                    │");
			out.push("              └──────────── state changes trigger re-decomposition ┘");
			out.push("```");
			out.push("");
			out.push("- **No agent-to-agent communication** — workers never talk to each other");
			out.push("- **No orchestrator during execution** — decomposer sets up work, then exits");
			out.push("- **Stateless workers** — spin up 3 or 30, doesn't matter");
			out.push(
				"- **Failure is boring** — worker dies? TTL expires, another worker picks up the task",
			);
			out.push("");

			// Pool status
			out.push("## Current Pool Status");
			out.push("");
			if (!hasMycelium) {
				out.push("`.mycelium/` not found — run `mc init` to initialize.");
			} else if (!poolStats) {
				out.push("No pool initialized (tasks.db not found).");
			} else {
				out.push("| Status    | Count |");
				out.push("|-----------|-------|");
				out.push(`| pending   | ${poolStats.pending} |`);
				out.push(`| claimed   | ${poolStats.claimed} |`);
				out.push(`| done      | ${poolStats.done} |`);
				out.push(`| failed    | ${poolStats.failed} |`);
				out.push(`| **total** | **${poolStats.total}** |`);
			}
			out.push("");

			// Config summary
			out.push("## Config Summary");
			out.push("");
			if (!config) {
				out.push("No config loaded (no .mycelium/ directory).");
			} else {
				out.push(`- **Project:** ${config.project.name || "(unnamed)"}`);
				out.push(`- **Canonical branch:** ${config.project.canonicalBranch}`);
				out.push(`- **Workers:** ${config.workers.defaultCount} × ${config.workers.runtime}`);
				out.push(`- **Decomposer model:** ${config.decomposer.model}`);
				out.push(`- **Task TTL:** ${config.pool.defaultTtl}s`);
			}
			out.push("");

			// CLI quick reference
			out.push("## CLI Quick Reference");
			out.push("");
			out.push("### Core Workflow");
			out.push("```");
			out.push("mc init                         Initialize .mycelium/ directory");
			out.push('mc decompose "<intent>"         Recursive decomposition into tasks');
			out.push("mc spawn [n]                    Spin up n workers (default: 3)");
			out.push("mc watch                        Monitor state, trigger re-decomposition");
			out.push("mc stop --all                   Terminate all workers");
			out.push("```");
			out.push("");
			out.push("### Task Management");
			out.push("```");
			out.push("mc status                       Pool overview");
			out.push("mc tasks                        List tasks");
			out.push("mc show <id>                    Detailed task or intent view");
			out.push("mc retry <task-id>              Reset failed task to pending");
			out.push("mc pool reset                   Clear task pool");
			out.push("```");
			out.push("");
			out.push("### Infrastructure");
			out.push("```");
			out.push("mc doctor [--fix]               Health checks (--fix auto-repairs)");
			out.push("mc logs [--follow]              Worker execution logs");
			out.push("mc prime [--compact]            Inject session context");
			out.push("mc sync [--status]              Stage and commit .mycelium/");
			out.push("mc upgrade                      Upgrade from npm");
			out.push("```");

			console.log(out.join("\n"));
		});
}
