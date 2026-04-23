import type { Command } from "commander";
import { brand, muted, outputJson, printError, printSuccess, printWarning } from "../output.ts";
import * as tmux from "../tmux.ts";

/** Session name prefix for all mycelium workers. */
const SESSION_PREFIX = "mycelium-worker-";

export function register(program: Command): void {
	program
		.command("stop")
		.argument("[worker-id]", "Worker to stop (e.g. worker-1)")
		.description("Terminate worker(s)")
		.option("--all", "Stop all running workers")
		.action(async (workerId: string | undefined, options: { all?: boolean }) => {
			const jsonMode = program.opts().json;

			if (!workerId && !options.all) {
				printError("Specify a worker ID or use --all");
				process.exitCode = 1;
				return;
			}

			const stopped: string[] = [];
			const notFound: string[] = [];

			if (options.all) {
				const sessions = await tmux.listSessions(SESSION_PREFIX);
				if (sessions.length === 0) {
					if (jsonMode) {
						outputJson({ success: true, command: "stop", stopped: [] });
					} else {
						printWarning("No running workers found.");
					}
					return;
				}

				for (const session of sessions) {
					try {
						await tmux.killSession(session);
						// Derive worker-N from session name
						const id = `worker-${session.slice(SESSION_PREFIX.length)}`;
						stopped.push(id);
						if (!jsonMode) {
							printSuccess(`Stopped ${brand(id)}  ${muted(`(${session})`)}`);
						}
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						printError(`Failed to stop ${session}: ${msg}`);
					}
				}
			} else if (workerId) {
				// worker-id may be given as "worker-1" or just "1"
				const num = workerId.startsWith("worker-") ? workerId.slice(7) : workerId;
				const sessionName = `${SESSION_PREFIX}${num}`;

				const exists = await tmux.hasSession(sessionName);
				if (!exists) {
					notFound.push(workerId);
					if (jsonMode) {
						outputJson({
							success: false,
							command: "stop",
							error: `Worker not found: ${workerId}`,
						});
					} else {
						printError(`Worker not found: ${workerId}`);
					}
					process.exitCode = 1;
					return;
				}

				await tmux.killSession(sessionName);
				stopped.push(workerId);
			}

			if (jsonMode) {
				outputJson({
					success: notFound.length === 0,
					command: "stop",
					stopped,
					notFound,
				});
			} else if (stopped.length > 0 && !options.all) {
				// --all already printed per-worker; only print summary for single stop
				printSuccess(`Stopped ${stopped.join(", ")}`);
			}
		});
}
