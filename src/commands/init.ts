import { existsSync, mkdirSync } from "node:fs";
import type { Command } from "commander";
import { generateDefaultConfig } from "../config.ts";
import { brand, muted, outputJson, printError, printSuccess } from "../output.ts";
import { TaskPool } from "../pool.ts";

export function register(program: Command): void {
	program
		.command("init")
		.description("Initialize .mycelium/ directory and task pool")
		.option("--force", "Overwrite existing config")
		.action(async (options: { force?: boolean }) => {
			const jsonMode = program.opts().json;
			const root = process.cwd();
			const myceliumDir = `${root}/.mycelium`;

			if (existsSync(`${myceliumDir}/config.yaml`) && !options.force) {
				if (jsonMode) {
					outputJson({ success: false, command: "init", error: "Already initialized" });
				} else {
					printError("Already initialized. Use --force to overwrite.");
				}
				process.exitCode = 1;
				return;
			}

			mkdirSync(myceliumDir, { recursive: true });
			mkdirSync(`${myceliumDir}/worktrees`, { recursive: true });
			mkdirSync(`${myceliumDir}/logs`, { recursive: true });

			let projectName = root.split("/").pop() ?? "project";
			try {
				const pkg = await Bun.file(`${root}/package.json`).json();
				if (typeof pkg.name === "string") {
					projectName = pkg.name.replace(/^@[^/]+\//, "");
				}
			} catch {
				// Use directory name
			}

			const configContent = generateDefaultConfig(projectName);
			await Bun.write(`${myceliumDir}/config.yaml`, configContent);

			await Bun.write(
				`${myceliumDir}/.gitignore`,
				[
					"# Runtime state (not tracked)",
					"*.db",
					"*.db-wal",
					"*.db-shm",
					"worktrees/",
					"logs/",
					"config.local.yaml",
					"",
				].join("\n"),
			);

			const pool = new TaskPool(`${myceliumDir}/tasks.db`);
			pool.close();

			if (jsonMode) {
				outputJson({
					success: true,
					command: "init",
					path: myceliumDir,
					files: ["config.yaml", ".gitignore", "tasks.db"],
				});
			} else {
				printSuccess("Initialized .mycelium/");
				console.log(`  ${muted("config")}   ${brand(".mycelium/config.yaml")}`);
				console.log(`  ${muted("pool")}     ${brand(".mycelium/tasks.db")}`);
				console.log(`  ${muted("logs")}     ${brand(".mycelium/logs/")}`);
				console.log(`  ${muted("worktrees")} ${brand(".mycelium/worktrees/")}`);
			}
		});
}
