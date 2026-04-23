/**
 * Mycelium worker loop: claim → execute → report cycle.
 *
 * Each worker is a persistent process (running inside a tmux session) that
 * atomically claims tasks from the shared pool, executes them in an isolated
 * git worktree, writes results back, and loops until idle-timeout expires.
 *
 * Invoked by `mc spawn` as:
 *   bun run /path/to/src/worker.ts --worker-id worker-1 --db /path/tasks.db \
 *     --repo-root /path/to/repo --worktree-base /path/.mycelium/worktrees \
 *     --canonical-branch main --runtime claude --model sonnet \
 *     --poll-interval 5 --idle-timeout 60 --mulch
 */

import { mkdirSync } from "node:fs";
import { TaskPool } from "./pool.ts";
import type { TaskPayload, TaskResult } from "./types.ts";
import { createWorktree, deleteBranch, mergeWorktree, removeWorktree } from "./worktree.ts";

export interface WorkerOptions {
	workerId: string;
	dbPath: string;
	repoRoot: string;
	worktreeBase: string;
	canonicalBranch: string;
	runtime: string;
	model: string;
	pollInterval: number; // seconds
	idleTimeout: number; // seconds
	mulchEnabled: boolean;
}

/** Build the execution prompt sent to the runtime. */
function buildPrompt(payload: TaskPayload): string {
	const lines = [
		`Task: ${payload.description}`,
		"",
		`Acceptance criteria: ${payload.acceptanceCriteria}`,
	];
	if (payload.fileScope.length > 0) {
		lines.push("", `File scope: ${payload.fileScope.join(", ")}`);
	}
	if (payload.context) {
		lines.push("", `Context: ${payload.context}`);
	}
	if (payload.hints && payload.hints.length > 0) {
		lines.push("", `Hints: ${payload.hints.join("; ")}`);
	}
	return lines.join("\n");
}

/**
 * Execute a task in its worktree using the configured runtime.
 * Returns a TaskResult (exitCode 0 = success).
 */
async function executeTask(
	taskId: string,
	payload: TaskPayload,
	worktreePath: string,
	runtime: string,
	model: string,
	mulchEnabled: boolean,
	logPath: string,
): Promise<TaskResult> {
	// Load expertise if mulch is enabled
	if (mulchEnabled) {
		const mlArgs =
			payload.fileScope.length > 0
				? ["ml", "prime", "--files", payload.fileScope.join(",")]
				: ["ml", "prime", "--context"];
		const mlProc = Bun.spawn(mlArgs, { cwd: worktreePath, stdout: "pipe", stderr: "pipe" });
		await mlProc.exited;
	}

	const prompt = buildPrompt(payload);

	// Write task context file into the worktree for reference
	await Bun.write(`${worktreePath}/.mycelium-task.md`, `# Task: ${taskId}\n\n${prompt}\n`);

	let cmd: string[];
	if (runtime === "sapling") {
		cmd = ["sp", "--print", prompt];
	} else {
		// Default: claude runtime
		cmd = ["claude", "--print", "--model", model, prompt];
	}

	const logFile = Bun.file(logPath);
	const logWriter = logFile.writer();

	const proc = Bun.spawn(cmd, {
		cwd: worktreePath,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env },
	});

	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const exitCode = await proc.exited;

	const combined = `=== stdout ===\n${stdout}\n=== stderr ===\n${stderr}\n`;
	logWriter.write(combined);
	await logWriter.flush();
	logWriter.end();

	// Extract files changed from git diff in the worktree
	const diffProc = Bun.spawn(["git", "diff", "--name-only", "HEAD"], {
		cwd: worktreePath,
		stdout: "pipe",
		stderr: "pipe",
	});
	const diffOut = await new Response(diffProc.stdout).text();
	await diffProc.exited;
	const filesChanged = diffOut.trim().split("\n").filter(Boolean);

	// Auto-commit any changes in the worktree
	if (filesChanged.length > 0) {
		const addProc = Bun.spawn(["git", "add", "-A"], { cwd: worktreePath });
		await addProc.exited;
		const commitProc = Bun.spawn(
			["git", "commit", "-m", `worker(${taskId}): ${payload.description.slice(0, 72)}`],
			{ cwd: worktreePath, stdout: "pipe", stderr: "pipe" },
		);
		await commitProc.exited;
	}

	// Get commit SHA after potential commit
	const revProc = Bun.spawn(["git", "rev-parse", "HEAD"], {
		cwd: worktreePath,
		stdout: "pipe",
	});
	const revOut = (await new Response(revProc.stdout).text()).trim();
	await revProc.exited;

	return {
		summary:
			exitCode === 0 ? stdout.slice(0, 500) || "Task completed" : `Failed: ${stderr.slice(0, 500)}`,
		filesChanged,
		commitSha: revOut || undefined,
		errors: exitCode !== 0 ? [stderr.slice(0, 1000)] : undefined,
		exitCode,
	};
}

/**
 * Main worker loop.
 * Runs until idleTimeout expires with no tasks available.
 */
export async function runWorkerLoop(options: WorkerOptions): Promise<void> {
	const {
		workerId,
		dbPath,
		repoRoot,
		worktreeBase,
		canonicalBranch,
		runtime,
		model,
		pollInterval,
		idleTimeout,
		mulchEnabled,
	} = options;

	const pool = new TaskPool(dbPath);
	const logsDir = `${repoRoot}/.mycelium/logs`;

	let idleSince: number | null = null;
	const pollMs = pollInterval * 1000;

	process.stdout.write(
		`[${workerId}] starting — poll=${pollInterval}s idle-timeout=${idleTimeout}s\n`,
	);

	while (true) {
		const task = pool.claimTask(workerId);

		if (!task) {
			if (idleSince === null) {
				idleSince = Date.now();
				process.stdout.write(`[${workerId}] idle — waiting for tasks\n`);
			}
			const idleSeconds = (Date.now() - idleSince) / 1000;
			if (idleSeconds >= idleTimeout) {
				process.stdout.write(`[${workerId}] idle timeout (${idleTimeout}s) — exiting\n`);
				break;
			}
			await Bun.sleep(pollMs);
			continue;
		}

		// Reset idle timer on successful claim
		idleSince = null;
		const { id: taskId, payload } = task;
		process.stdout.write(
			`[${workerId}] claimed task ${taskId}: ${payload.description.slice(0, 60)}\n`,
		);

		const taskBranch = `mycelium/task-${taskId}`;
		const logPath = `${logsDir}/${workerId}-${taskId}.log`;
		let worktreePath: string | null = null;

		try {
			// Ensure worktree base and logs directories exist
			mkdirSync(worktreeBase, { recursive: true });
			mkdirSync(logsDir, { recursive: true });

			// Create isolated worktree
			worktreePath = await createWorktree(taskId, worktreeBase, repoRoot);
			process.stdout.write(`[${workerId}] worktree created at ${worktreePath}\n`);

			// Execute task
			const result = await executeTask(
				taskId,
				payload,
				worktreePath,
				runtime,
				model,
				mulchEnabled,
				logPath,
			);

			// Merge back to canonical branch (best-effort — don't fail the task on merge error)
			if (result.exitCode === 0 && result.filesChanged.length > 0) {
				const mergeResult = await mergeWorktree(taskBranch, canonicalBranch, repoRoot);
				if (!mergeResult.success) {
					process.stderr.write(`[${workerId}] merge warning for ${taskId}: ${mergeResult.error}\n`);
				} else {
					process.stdout.write(`[${workerId}] merged ${taskId} → ${canonicalBranch}\n`);
				}
			}

			// Record mulch expertise after successful task execution
			if (mulchEnabled && result.exitCode === 0) {
				const mlArgs = [
					"ml",
					"record",
					"mycelium",
					"--type",
					"convention",
					"--description",
					`Task ${taskId}: ${payload.description.slice(0, 200)}`,
					"--outcome-status",
					"success",
					"--outcome-agent",
					workerId,
				];
				const mlProc = Bun.spawn(mlArgs, { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
				await mlProc.exited;
				process.stdout.write(`[${workerId}] mulch recorded for ${taskId}\n`);
			} else if (mulchEnabled && result.exitCode !== 0) {
				const mlArgs = [
					"ml",
					"record",
					"mycelium",
					"--type",
					"failure",
					"--description",
					`Task ${taskId}: ${payload.description.slice(0, 200)}`,
					"--resolution",
					result.summary.slice(0, 300),
					"--outcome-status",
					"failure",
					"--outcome-agent",
					workerId,
				];
				const mlProc = Bun.spawn(mlArgs, { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
				await mlProc.exited;
				process.stdout.write(`[${workerId}] mulch failure recorded for ${taskId}\n`);
			}

			// Record result
			pool.completeTask(taskId, result);
			process.stdout.write(`[${workerId}] completed task ${taskId} (exit=${result.exitCode})\n`);
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			process.stderr.write(`[${workerId}] error on task ${taskId}: ${errMsg}\n`);
			pool.completeTask(taskId, {
				summary: `Worker error: ${errMsg}`,
				filesChanged: [],
				errors: [errMsg],
				exitCode: 1,
			});
		} finally {
			// Always clean up the worktree
			if (worktreePath) {
				try {
					await removeWorktree(worktreePath, repoRoot);
					await deleteBranch(taskBranch, repoRoot);
				} catch (cleanupErr) {
					const msg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
					process.stderr.write(`[${workerId}] cleanup warning: ${msg}\n`);
				}
			}
		}
	}

	pool.close();
}

// --- CLI entrypoint (when run directly: bun run src/worker.ts --args) ---

if (import.meta.main) {
	const args = process.argv.slice(2);

	function flag(name: string, fallback: string): string {
		const idx = args.indexOf(`--${name}`);
		return idx !== -1 && args[idx + 1] ? (args[idx + 1] as string) : fallback;
	}

	function boolFlag(name: string): boolean {
		return args.includes(`--${name}`);
	}

	const options: WorkerOptions = {
		workerId: flag("worker-id", "worker-0"),
		dbPath: flag("db", ".mycelium/tasks.db"),
		repoRoot: flag("repo-root", process.cwd()),
		worktreeBase: flag("worktree-base", ".mycelium/worktrees"),
		canonicalBranch: flag("canonical-branch", "main"),
		runtime: flag("runtime", "claude"),
		model: flag("model", "sonnet"),
		pollInterval: Number.parseInt(flag("poll-interval", "5"), 10),
		idleTimeout: Number.parseInt(flag("idle-timeout", "60"), 10),
		mulchEnabled: boolFlag("mulch"),
	};

	runWorkerLoop(options).catch((err: unknown) => {
		const msg = err instanceof Error ? err.message : String(err);
		process.stderr.write(`Worker fatal error: ${msg}\n`);
		process.exit(1);
	});
}
