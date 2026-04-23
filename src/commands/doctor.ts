import { existsSync, mkdirSync } from "node:fs";
import type { Command } from "commander";
import { generateDefaultConfig } from "../config.ts";
import { brand, muted, outputJson, printError, printInfo, printSuccess } from "../output.ts";
import { TaskPool } from "../pool.ts";

interface Check {
	name: string;
	status: "pass" | "fail" | "warn";
	message: string;
	fixed?: boolean;
}

async function runGit(
	args: string[],
	cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout: stdout.trim(), stderr: stderr.trim(), code };
}

export function register(program: Command): void {
	program
		.command("doctor")
		.description("Health checks for mycelium installation")
		.option("--fix", "Attempt to fix issues")
		.action(async (options: { fix?: boolean }) => {
			const jsonMode = program.opts().json;
			const root = process.cwd();
			const checks: Check[] = [];

			// Check .mycelium/ exists
			if (existsSync(`${root}/.mycelium`)) {
				checks.push({ name: ".mycelium directory", status: "pass", message: "Found" });
			} else if (options.fix) {
				try {
					mkdirSync(`${root}/.mycelium`, { recursive: true });
					checks.push({
						name: ".mycelium directory",
						status: "pass",
						message: "Created by --fix",
						fixed: true,
					});
				} catch (e) {
					checks.push({
						name: ".mycelium directory",
						status: "fail",
						message: `Failed to create: ${e instanceof Error ? e.message : String(e)}`,
					});
				}
			} else {
				checks.push({
					name: ".mycelium directory",
					status: "fail",
					message: "Missing — run mc init",
				});
			}

			// Check config
			if (existsSync(`${root}/.mycelium/config.yaml`)) {
				checks.push({ name: "config.yaml", status: "pass", message: "Found" });
			} else if (options.fix && existsSync(`${root}/.mycelium`)) {
				try {
					const projectName = root.split("/").pop() ?? "mycelium";
					const yaml = generateDefaultConfig(projectName);
					await Bun.write(`${root}/.mycelium/config.yaml`, yaml);
					checks.push({
						name: "config.yaml",
						status: "pass",
						message: "Generated default by --fix",
						fixed: true,
					});
				} catch (e) {
					checks.push({
						name: "config.yaml",
						status: "fail",
						message: `Failed to generate: ${e instanceof Error ? e.message : String(e)}`,
					});
				}
			} else {
				checks.push({
					name: "config.yaml",
					status: "fail",
					message: "Missing — run mc init",
				});
			}

			// Check task pool DB
			if (existsSync(`${root}/.mycelium/tasks.db`)) {
				checks.push({ name: "tasks.db", status: "pass", message: "Found" });
			} else if (options.fix && existsSync(`${root}/.mycelium`)) {
				try {
					const pool = new TaskPool(`${root}/.mycelium/tasks.db`);
					pool.close();
					checks.push({
						name: "tasks.db",
						status: "pass",
						message: "Created empty pool by --fix",
						fixed: true,
					});
				} catch (e) {
					checks.push({
						name: "tasks.db",
						status: "warn",
						message: `Could not pre-create: ${e instanceof Error ? e.message : String(e)}`,
					});
				}
			} else {
				checks.push({
					name: "tasks.db",
					status: "warn",
					message: "Missing — will be created on first use",
				});
			}

			// Check for orphaned worktrees
			if (existsSync(`${root}/.mycelium/worktrees`)) {
				const entries = await Array.fromAsync(
					new Bun.Glob("*").scan({ cwd: `${root}/.mycelium/worktrees`, onlyFiles: false }),
				);
				if (entries.length > 0) {
					if (options.fix) {
						const removed: string[] = [];
						const failed: string[] = [];
						for (const entry of entries) {
							const worktreePath = `${root}/.mycelium/worktrees/${entry}`;
							const result = await runGit(["worktree", "remove", worktreePath, "--force"], root);
							if (result.code === 0) {
								removed.push(entry);
							} else {
								failed.push(entry);
							}
						}
						if (failed.length === 0) {
							checks.push({
								name: "worktrees",
								status: "pass",
								message: `Removed ${removed.length} orphaned worktree(s) by --fix`,
								fixed: true,
							});
						} else {
							checks.push({
								name: "worktrees",
								status: "warn",
								message: `Removed ${removed.length}, failed to remove ${failed.length}: ${failed.join(", ")}`,
							});
						}
					} else {
						checks.push({
							name: "worktrees",
							status: "warn",
							message: `${entries.length} worktree(s) present`,
						});
					}
				} else {
					checks.push({ name: "worktrees", status: "pass", message: "Clean" });
				}
			}

			const fixedCount = checks.filter((c) => c.fixed).length;

			if (jsonMode) {
				const allPassed = checks.every((c) => c.status === "pass");
				outputJson({ success: allPassed, command: "doctor", checks, fixed: fixedCount });
			} else {
				for (const check of checks) {
					const icon =
						check.status === "pass"
							? brand("\u2713")
							: check.status === "warn"
								? "\x1b[33m!\x1b[0m"
								: "\x1b[31m\u2717\x1b[0m";
					console.log(`${icon} ${check.name}  ${muted(check.message)}`);
				}
				if (options.fix && fixedCount > 0) {
					printInfo(`Fixed ${fixedCount} issue(s)`);
				}
				const failures = checks.filter((c) => c.status === "fail");
				if (failures.length > 0) {
					printError(`${failures.length} check(s) failed`);
					process.exitCode = 1;
				} else {
					printSuccess("All checks passed");
				}
			}
		});
}
