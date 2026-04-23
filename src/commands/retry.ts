import type { Command } from "commander";
import { loadConfig } from "../config.ts";
import { outputJson, printError, printSuccess } from "../output.ts";
import { TaskPool } from "../pool.ts";

export function register(program: Command): void {
	program
		.command("retry")
		.argument("<task-id>", "Task ID to reset to pending")
		.description("Reset a failed task to pending for retry")
		.action(async (taskId: string) => {
			const jsonMode = program.opts().json;
			const root = process.cwd();
			const config = await loadConfig(root);
			const pool = new TaskPool(`${root}/${config.pool.database}`);

			try {
				const task = pool.getTask(taskId);
				if (!task) {
					if (jsonMode) {
						outputJson({ success: false, command: "retry", error: `Task not found: ${taskId}` });
					} else {
						printError(`Task not found: ${taskId}`);
					}
					process.exitCode = 1;
					return;
				}

				if (task.status !== "failed") {
					if (jsonMode) {
						outputJson({
							success: false,
							command: "retry",
							error: `Task is ${task.status}, not failed`,
						});
					} else {
						printError(`Task is ${task.status}, not failed`);
					}
					process.exitCode = 1;
					return;
				}

				pool.resetTask(taskId);

				if (jsonMode) {
					outputJson({ success: true, command: "retry", taskId });
				} else {
					printSuccess(`Reset ${taskId} to pending`);
				}
			} finally {
				pool.close();
			}
		});
}
