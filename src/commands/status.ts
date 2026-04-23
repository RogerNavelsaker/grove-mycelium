import type { Command } from "commander";
import { loadConfig } from "../config.ts";
import { accent, brand, muted, outputJson } from "../output.ts";
import { TaskPool } from "../pool.ts";

export function register(program: Command): void {
	program
		.command("status")
		.description("Task pool overview and worker status")
		.option("--intent <id>", "Show status for a specific intent")
		.action(async (options: { intent?: string }) => {
			const jsonMode = program.opts().json;
			const root = process.cwd();
			const config = await loadConfig(root);
			const pool = new TaskPool(`${root}/${config.pool.database}`);

			try {
				const intents = pool.listIntents();
				const allStats = pool.stats(options.intent);

				if (jsonMode) {
					outputJson({
						success: true,
						command: "status",
						intents: intents.length,
						tasks: allStats,
					});
				} else {
					console.log(`${brand("mycelium")} ${muted("status")}\n`);
					console.log(
						`  ${accent("Intents:")} ${intents.length}   ${accent("Tasks:")} ${allStats.total}`,
					);
					console.log(
						`  ${brand("done")} ${allStats.done}  ${muted("pending")} ${allStats.pending}  ${muted("claimed")} ${allStats.claimed}  ${allStats.failed > 0 ? `\x1b[31mfailed\x1b[0m ${allStats.failed}` : ""}`,
					);
				}
			} finally {
				pool.close();
			}
		});
}
