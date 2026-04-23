import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { loadConfig } from "../config.ts";
import { accent, brand, muted, outputJson } from "../output.ts";
import { TaskPool } from "../pool.ts";

export function register(program: Command): void {
	program
		.command("logs")
		.description("View worker execution logs")
		.option("--worker <id>", "Filter by worker ID")
		.option("--intent <id>", "Filter by intent ID")
		.option("--follow", "Follow log output")
		.action(async (options: { worker?: string; intent?: string; follow?: boolean }) => {
			const jsonMode = program.opts().json as boolean;
			const root = process.cwd();
			const config = await loadConfig(root);
			const logsDir = join(root, ".mycelium/logs");

			if (!existsSync(logsDir)) {
				if (jsonMode) {
					outputJson({ success: true, command: "logs", files: [] });
				} else {
					console.log(muted("No logs found."));
				}
				return;
			}

			// Collect and sort log files
			let logFiles = readdirSync(logsDir)
				.filter((f) => f.endsWith(".log"))
				.sort();

			// Filter by worker ID prefix
			if (options.worker) {
				const prefix = `${options.worker}-`;
				logFiles = logFiles.filter((f) => f.startsWith(prefix));
			}

			// Filter by intent — look up task IDs in pool, match filenames by suffix
			if (options.intent) {
				const pool = new TaskPool(`${root}/${config.pool.database}`);
				try {
					const tasks = pool.listTasks(options.intent);
					logFiles = logFiles.filter((f) => tasks.some((t) => f.endsWith(`-${t.id}.log`)));
				} finally {
					pool.close();
				}
			}

			if (logFiles.length === 0) {
				if (jsonMode) {
					outputJson({ success: true, command: "logs", files: [] });
				} else {
					console.log(muted("No matching log files."));
				}
				return;
			}

			if (options.follow && !jsonMode) {
				// Follow mode: print existing content then poll for new bytes
				const fileOffsets = new Map<string, number>();

				const printNew = () => {
					let current = readdirSync(logsDir)
						.filter((f) => f.endsWith(".log"))
						.sort();
					if (options.worker) {
						current = current.filter((f) => f.startsWith(`${options.worker}-`));
					}
					for (const file of current) {
						const fullPath = join(logsDir, file);
						const content = readFileSync(fullPath, "utf8");
						const offset = fileOffsets.get(fullPath) ?? 0;
						if (content.length > offset) {
							if (offset === 0) {
								console.log(`\n${brand("===")} ${accent(file)} ${brand("===")}`);
							}
							process.stdout.write(content.slice(offset));
							fileOffsets.set(fullPath, content.length);
						}
					}
				};

				printNew();
				console.log(muted("\n[following — Ctrl+C to stop]"));

				for (;;) {
					await Bun.sleep(1000);
					printNew();
				}
			} else {
				// Normal mode: read all matching files and output
				const entries: { file: string; content: string }[] = [];
				for (const file of logFiles) {
					const content = readFileSync(join(logsDir, file), "utf8");
					entries.push({ file, content });
				}

				if (jsonMode) {
					outputJson({ success: true, command: "logs", files: entries });
				} else {
					for (const { file, content } of entries) {
						console.log(`${brand("===")} ${accent(file)} ${brand("===")}`);
						process.stdout.write(content);
						if (!content.endsWith("\n")) console.log();
					}
				}
			}
		});
}
