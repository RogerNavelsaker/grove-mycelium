import type { Command } from "commander";
import { loadConfig } from "../config.ts";
import { accent, brand, muted, outputJson } from "../output.ts";
import { TaskPool } from "../pool.ts";
import type { TaskStatus } from "../types.ts";

export function register(program: Command): void {
	program
		.command("tasks")
		.description("List tasks with filtering")
		.option("--status <status>", "Filter by status (pending, claimed, done, failed)")
		.option("--intent <id>", "Filter by intent ID")
		.option("--limit <n>", "Max tasks to show", "50")
		.action(async (options: { status?: string; intent?: string; limit?: string }) => {
			const jsonMode = program.opts().json;
			const root = process.cwd();
			const config = await loadConfig(root);
			const pool = new TaskPool(`${root}/${config.pool.database}`);

			try {
				const tasks = pool.listTasks(options.intent, options.status as TaskStatus | undefined);
				const limit = Number.parseInt(options.limit ?? "50", 10);
				const shown = tasks.slice(0, limit);

				if (jsonMode) {
					outputJson({ success: true, command: "tasks", tasks: shown, total: tasks.length });
				} else {
					if (shown.length === 0) {
						console.log(muted("No tasks found."));
						return;
					}
					for (const task of shown) {
						const statusIcon =
							task.status === "done"
								? brand("\u2713")
								: task.status === "failed"
									? "\x1b[31m\u2717\x1b[0m"
									: task.status === "claimed"
										? "\x1b[36m>\x1b[0m"
										: muted("-");
						console.log(
							`${statusIcon} ${accent(task.id)} ${task.payload.description}  ${muted(`[${task.status}]`)}`,
						);
					}
					if (tasks.length > limit) {
						console.log(muted(`\n  ... and ${tasks.length - limit} more`));
					}
				}
			} finally {
				pool.close();
			}
		});
}
