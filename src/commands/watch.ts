import { existsSync } from "node:fs";
import type { Command } from "commander";
import { loadConfig } from "../config.ts";
import { accent, brand, muted, outputJson, printError, printInfo, setQuiet } from "../output.ts";
import { TaskPool } from "../pool.ts";
import type { Intent } from "../types.ts";

export interface WatchOptions {
	pollInterval: number;
	autoRedecompose: boolean;
	seedsAutoClose: boolean;
	once: boolean;
	daemon: boolean;
	jsonMode: boolean;
	verbose: boolean;
	root: string;
}

export interface TickResult {
	tick: number;
	timestamp: string;
	stats: { pending: number; claimed: number; done: number; failed: number; total: number };
	expired: string[];
	satisfied: string[];
	redecomposed: string[];
	closedSeeds: string[];
}

export async function runWatchTick(
	pool: TaskPool,
	options: WatchOptions,
	tickNumber: number,
): Promise<TickResult> {
	const timestamp = new Date().toISOString();

	// a. Expire stale claimed tasks
	const expiredTasks = pool.expireStale();
	const expired = expiredTasks.map((t) => t.id);

	if (options.verbose && expired.length > 0) {
		printInfo(`Expired ${expired.length} stale task(s): ${expired.join(", ")}`);
	}

	// b. Get global stats
	const stats = pool.stats();

	// c. Check each active intent
	const satisfied: string[] = [];
	const closedSeeds: string[] = [];
	const failedIntents: Intent[] = [];

	const activeIntents = pool.listIntents("active");
	for (const intent of activeIntents) {
		const tasks = pool.listTasks(intent.id);
		if (tasks.length === 0) continue;

		// All tasks done → satisfied
		if (tasks.every((t) => t.status === "done")) {
			pool.updateIntentStatus(intent.id, "satisfied");
			satisfied.push(intent.id);

			// Auto-close the associated seed issue if configured
			if (options.seedsAutoClose && intent.seedId) {
				const proc = Bun.spawn(
					[
						"sd",
						"close",
						intent.seedId,
						"--reason",
						`Intent ${intent.id} satisfied — all tasks completed`,
					],
					{ stdout: "pipe", stderr: "pipe" },
				);
				await proc.exited;
				closedSeeds.push(intent.seedId);
			}

			if (options.verbose) {
				printInfo(`Intent ${intent.id} satisfied`);
			}
			continue;
		}

		// All tasks terminal (done|failed) with at least one failed → failed intent
		const allTerminal = tasks.every((t) => t.status === "done" || t.status === "failed");
		const anyFailed = tasks.some((t) => t.status === "failed");
		if (allTerminal && anyFailed) {
			failedIntents.push(intent);
		}
	}

	// d. Re-decompose or mark-failed for stalled intents
	const redecomposed: string[] = [];

	if (options.autoRedecompose && failedIntents.length > 0) {
		for (const intent of failedIntents) {
			const proc = Bun.spawn(
				[
					"bun",
					"run",
					"src/index.ts",
					"decompose",
					intent.description,
					"--re-decompose",
					intent.id,
				],
				{ cwd: options.root, stdout: "pipe", stderr: "pipe" },
			);
			await proc.exited;
			redecomposed.push(intent.id);
			if (options.verbose) {
				printInfo(`Re-decomposed intent ${intent.id}`);
			}
		}
	} else if (!options.autoRedecompose) {
		// Mark stalled intents as failed so they don't re-trigger every tick
		for (const intent of failedIntents) {
			pool.updateIntentStatus(intent.id, "failed");
		}
	}

	return {
		tick: tickNumber,
		timestamp,
		stats,
		expired,
		satisfied,
		redecomposed,
		closedSeeds,
	};
}

function formatTick(result: TickResult): string {
	const time = new Date(result.timestamp).toTimeString().slice(0, 8);
	const { pending, claimed, done, failed } = result.stats;
	const failedStr = failed > 0 ? `\x1b[31m${failed} failed\x1b[0m` : muted(`${failed} failed`);
	let line =
		`${brand("[watch]")} ${muted(time)} — ` +
		`${muted(`${pending} pending`)}  ${muted(`${claimed} claimed`)}  ${accent(`${done} done`)}  ${failedStr}` +
		` | ${muted(`expired: ${result.expired.length}`)} | ${muted(`satisfied: ${result.satisfied.length}`)}`;
	if (result.redecomposed.length > 0) {
		line += ` | ${muted(`re-decomposed: ${result.redecomposed.length}`)}`;
	}
	if (result.closedSeeds.length > 0) {
		line += ` | ${muted(`closed-seeds: ${result.closedSeeds.length}`)}`;
	}
	return line;
}

export async function runWatchLoop(pool: TaskPool, options: WatchOptions): Promise<void> {
	let running = true;
	let tick = 0;

	const stop = () => {
		running = false;
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);

	try {
		while (running) {
			tick++;
			const result = await runWatchTick(pool, options, tick);

			if (options.jsonMode) {
				outputJson({ command: "watch", ...result });
			} else if (!options.daemon) {
				console.log(formatTick(result));
			}

			if (options.once || !running) break;

			await Bun.sleep(options.pollInterval * 1000);
		}
	} finally {
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
		if (!options.jsonMode && !options.daemon) {
			printInfo(`Watcher stopped after ${tick} tick(s)`);
		}
	}
}

export function register(program: Command): void {
	program
		.command("watch")
		.description("Monitor state surface, trigger re-decomposition, expire TTLs")
		.option("--daemon", "Suppress interactive output (quiet mode)")
		.option("--poll-interval <seconds>", "Seconds between state checks", "10")
		.option("--no-redecompose", "Disable auto re-decomposition")
		.option("--once", "Run a single tick and exit")
		.action(
			async (options: {
				daemon?: boolean;
				pollInterval?: string;
				redecompose?: boolean;
				once?: boolean;
			}) => {
				const jsonMode = program.opts().json as boolean;
				const verbose = (program.opts().verbose as boolean) ?? false;
				const root = process.cwd();

				// Require initialized .mycelium/
				if (!existsSync(`${root}/.mycelium/config.yaml`)) {
					if (jsonMode) {
						outputJson({
							success: false,
							command: "watch",
							error: "Not initialized. Run mc init first.",
						});
					} else {
						printError("Not initialized. Run mc init first.");
					}
					process.exitCode = 1;
					return;
				}

				const config = await loadConfig(root);
				const pollInterval = Number.parseInt(
					options.pollInterval ?? String(config.watcher.pollInterval),
					10,
				);
				// options.redecompose is false when --no-redecompose is passed (Commander negation)
				const autoRedecompose = (options.redecompose ?? true) && config.watcher.autoRedecompose;
				const once = options.once ?? false;
				const daemon = options.daemon ?? false;

				if (daemon && !jsonMode) {
					setQuiet(true);
				}

				const watchOptions: WatchOptions = {
					pollInterval,
					autoRedecompose,
					seedsAutoClose: config.seeds.autoClose,
					once,
					daemon,
					jsonMode,
					verbose,
					root,
				};

				if (!jsonMode && !daemon) {
					console.log(
						`${brand("mycelium")} ${muted("watch")} — poll every ${pollInterval}s${once ? " (once)" : ""}`,
					);
				}

				const pool = new TaskPool(`${root}/${config.pool.database}`);

				try {
					await runWatchLoop(pool, watchOptions);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					if (jsonMode) {
						outputJson({ success: false, command: "watch", error: msg });
					} else {
						printError(msg);
					}
					process.exitCode = 1;
				} finally {
					pool.close();
				}
			},
		);
}
