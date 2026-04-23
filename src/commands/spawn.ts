import { mkdirSync } from "node:fs";
import type { Command } from "commander";
import { loadConfig } from "../config.ts";
import { brand, muted, outputJson, printError, printInfo, printSuccess } from "../output.ts";
import * as tmux from "../tmux.ts";

/** Session name prefix for all mycelium workers. */
const SESSION_PREFIX = "mycelium-worker-";

/** Resolve the absolute path to src/worker.ts for this package. */
function workerScriptPath(): string {
	return new URL("../worker.ts", import.meta.url).pathname;
}

export function register(program: Command): void {
	program
		.command("spawn")
		.argument("[count]", "Number of workers to spawn", "3")
		.description("Spin up tmux workers to claim and execute tasks")
		.option("--runtime <name>", "Runtime for workers (claude, sapling)")
		.option("--ttl <seconds>", "Worker idle timeout before self-termination", "60")
		.option("--poll-interval <seconds>", "Seconds between task claims", "5")
		.action(
			async (
				countArg: string,
				options: { runtime?: string; ttl?: string; pollInterval?: string },
			) => {
				const jsonMode = program.opts().json;
				const root = process.cwd();
				const config = await loadConfig(root);

				const count = Number.parseInt(countArg, 10);
				if (Number.isNaN(count) || count < 1) {
					printError(`Invalid worker count: ${countArg}`);
					process.exitCode = 1;
					return;
				}

				const runtime = options.runtime ?? config.workers.runtime;
				const idleTimeout = Number.parseInt(options.ttl ?? String(config.workers.idleTimeout), 10);
				const pollInterval = Number.parseInt(
					options.pollInterval ?? String(config.workers.pollInterval),
					10,
				);
				const dbPath = `${root}/${config.pool.database}`;
				const worktreeBase = `${root}/${config.worktrees.baseDir}`;
				const canonicalBranch = config.project.canonicalBranch;
				const model = config.workers.model;
				const mulchFlag = config.mulch.enabled ? "--mulch" : "";
				const workerScript = workerScriptPath();

				// Ensure directories exist
				mkdirSync(`${root}/.mycelium/logs`, { recursive: true });
				mkdirSync(worktreeBase, { recursive: true });

				// Find the next available worker IDs (skip already-running sessions)
				const existing = await tmux.listSessions(SESSION_PREFIX);
				const existingNums = new Set(
					existing.map((s) => Number.parseInt(s.slice(SESSION_PREFIX.length), 10)),
				);

				const spawned: string[] = [];
				let nextId = 1;

				for (let i = 0; i < count; i++) {
					// Find next free number
					while (existingNums.has(nextId)) nextId++;
					const workerId = `worker-${nextId}`;
					const sessionName = `${SESSION_PREFIX}${nextId}`;
					existingNums.add(nextId);
					nextId++;

					try {
						await tmux.createSession(sessionName, root);

						// Build the worker loop command
						const workerCmd = [
							"bun",
							"run",
							workerScript,
							"--worker-id",
							workerId,
							"--db",
							dbPath,
							"--repo-root",
							root,
							"--worktree-base",
							worktreeBase,
							"--canonical-branch",
							canonicalBranch,
							"--runtime",
							runtime,
							"--model",
							model,
							"--poll-interval",
							String(pollInterval),
							"--idle-timeout",
							String(idleTimeout),
						];
						if (mulchFlag) workerCmd.push(mulchFlag);

						await tmux.sendKeys(sessionName, workerCmd.join(" "));
						spawned.push(workerId);

						if (!jsonMode) {
							printInfo(`${brand(workerId)}  session: ${muted(sessionName)}`);
						}
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						printError(`Failed to spawn ${workerId}: ${msg}`);
					}
				}

				if (jsonMode) {
					outputJson({
						success: spawned.length > 0,
						command: "spawn",
						workers: spawned,
						runtime,
						pollInterval,
						idleTimeout,
					});
				} else if (spawned.length > 0) {
					printSuccess(`Spawned ${spawned.length} worker(s)`);
					console.log(`  ${muted("runtime")}       ${runtime}`);
					console.log(`  ${muted("poll-interval")} ${pollInterval}s`);
					console.log(`  ${muted("idle-timeout")}  ${idleTimeout}s`);
				}

				if (spawned.length < count) {
					process.exitCode = 1;
				}
			},
		);
}
