import type { Command } from "commander";
import { loadConfig } from "../config.ts";
import { accent, brand, muted, outputJson, printError } from "../output.ts";
import { TaskPool } from "../pool.ts";

export function register(program: Command): void {
	program
		.command("show")
		.argument("<id>", "Task or intent ID")
		.description("Show detailed task or intent view")
		.action(async (id: string) => {
			const jsonMode = program.opts().json;
			const root = process.cwd();
			const config = await loadConfig(root);
			const pool = new TaskPool(`${root}/${config.pool.database}`);

			try {
				// Try task first, then intent
				const task = pool.getTask(id);
				if (task) {
					if (jsonMode) {
						outputJson({ success: true, command: "show", type: "task", data: task });
					} else {
						console.log(`${accent(task.id)}  ${brand(task.status)}`);
						console.log(`Intent:  ${muted(task.intentId)}`);
						console.log(`Desc:    ${task.payload.description}`);
						console.log(`Files:   ${task.payload.fileScope.join(", ") || muted("none")}`);
						if (task.dependsOn?.length) {
							console.log(`Deps:    ${task.dependsOn.map((d) => accent(d)).join(", ")}`);
						}
						if (task.claimedBy) console.log(`Worker:  ${task.claimedBy}`);
						if (task.result) {
							console.log(`\nResult:  ${task.result.summary}`);
							if (task.result.filesChanged.length) {
								console.log(`Changed: ${task.result.filesChanged.join(", ")}`);
							}
						}
					}
					return;
				}

				const intent = pool.getIntent(id);
				if (intent) {
					const stats = pool.stats(id);
					if (jsonMode) {
						outputJson({
							success: true,
							command: "show",
							type: "intent",
							data: intent,
							tasks: stats,
						});
					} else {
						console.log(`${accent(intent.id)}  ${brand(intent.status)}`);
						console.log(`Desc:    ${intent.description}`);
						if (intent.seedId) console.log(`Seed:    ${muted(intent.seedId)}`);
						console.log(
							`Tasks:   ${stats.total} (${brand(`${stats.done} done`)}, ${muted(`${stats.pending} pending`)}, ${stats.failed > 0 ? `\x1b[31m${stats.failed} failed\x1b[0m` : ""})`,
						);
					}
					return;
				}

				if (jsonMode) {
					outputJson({ success: false, command: "show", error: `Not found: ${id}` });
				} else {
					printError(`Not found: ${id}`);
				}
				process.exitCode = 1;
			} finally {
				pool.close();
			}
		});
}
