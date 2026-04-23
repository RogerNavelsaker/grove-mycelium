import type { Command } from "commander";
import { loadConfig } from "../config.ts";
import { outputJson, printError, printSuccess, printWarning } from "../output.ts";
import { TaskPool } from "../pool.ts";

export function register(program: Command): void {
	const cmd = program.command("pool").description("Task pool management");

	cmd
		.command("reset")
		.description("Clear task pool")
		.option("--intent <id>", "Only reset tasks for a specific intent")
		.option("--force", "Skip confirmation")
		.action(async (options: { intent?: string; force?: boolean }) => {
			const jsonMode = program.opts().json;
			const root = process.cwd();
			const config = await loadConfig(root);
			const pool = new TaskPool(`${root}/${config.pool.database}`);

			try {
				const stats = pool.stats(options.intent);
				if (stats.total === 0) {
					if (jsonMode) {
						outputJson({ success: true, command: "pool reset", deleted: 0 });
					} else {
						printWarning("Pool is already empty.");
					}
					return;
				}

				if (!options.force) {
					printError(`Use --force to confirm deletion of ${stats.total} tasks`);
					process.exitCode = 1;
					return;
				}

				pool.resetPool(options.intent);

				if (jsonMode) {
					outputJson({ success: true, command: "pool reset", deleted: stats.total });
				} else {
					printSuccess(
						`Cleared ${stats.total} tasks${options.intent ? ` for intent ${options.intent}` : ""}`,
					);
				}
			} finally {
				pool.close();
			}
		});
}
