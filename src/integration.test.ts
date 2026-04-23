/**
 * Integration tests: full decompose → execute → merge cycle.
 *
 * These tests exercise the programmatic interfaces of the pool, worker
 * components, watcher, and merge queue as they interact end-to-end.
 * External CLIs (claude, tmux) are not invoked — execution is simulated
 * by directly manipulating pool state and git worktrees.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WatchOptions } from "./commands/watch.ts";
import { runWatchTick } from "./commands/watch.ts";
import { MergeQueue } from "./merge.ts";
import { TaskPool } from "./pool.ts";
import type { TaskPayload } from "./types.ts";
import { createWorktree, deleteBranch, mergeWorktree, removeWorktree } from "./worktree.ts";

// ─── Shared helpers ──────────────────────────────────────────────────────────

const WATCH_OPTIONS: WatchOptions = {
	pollInterval: 10,
	autoRedecompose: false,
	seedsAutoClose: false,
	once: false,
	daemon: false,
	jsonMode: false,
	verbose: false,
	root: process.cwd(),
};

const PAYLOAD: TaskPayload = {
	description: "test task",
	fileScope: ["src/foo.ts"],
	context: "context",
	acceptanceCriteria: "it works",
};

async function git(
	args: string[],
	cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const exitCode = await proc.exited;
	return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

async function createRepo(): Promise<string> {
	const dir = join(tmpdir(), `integration-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	await git(["init", "--initial-branch=main"], dir);
	await git(["config", "user.email", "test@test.com"], dir);
	await git(["config", "user.name", "Test"], dir);
	await Bun.write(join(dir, "README.md"), "# Test\n");
	await git(["add", "."], dir);
	await git(["commit", "-m", "init"], dir);
	return dir;
}

// ─── Test lifecycle ───────────────────────────────────────────────────────────

const tmpDirs: string[] = [];

afterEach(() => {
	for (const dir of tmpDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ─── 1. Full lifecycle: decompose → execute → watch satisfy ───────────────────

describe("full lifecycle — pool state transitions", () => {
	let pool: TaskPool;

	beforeEach(() => {
		pool = new TaskPool(":memory:");
	});

	afterEach(() => {
		pool.close();
	});

	test("intent transitions active → satisfied after all tasks complete", async () => {
		// Decompose phase: create intent + 2 independent tasks
		pool.createIntent("i1", "Migrate auth", null, null);
		pool.createTask("t1", "i1", PAYLOAD, null, 300);
		pool.createTask("t2", "i1", PAYLOAD, null, 300);

		// Execute phase: workers claim and complete
		const a = pool.claimTask("worker-1");
		const b = pool.claimTask("worker-2");
		expect(a).not.toBeNull();
		expect(b).not.toBeNull();

		pool.completeTask(a!.id, { summary: "done", filesChanged: [], exitCode: 0 });
		pool.completeTask(b!.id, { summary: "done", filesChanged: [], exitCode: 0 });

		// Watch tick should detect satisfaction
		const tick = await runWatchTick(pool, WATCH_OPTIONS, 1);
		expect(tick.satisfied).toContain("i1");

		const intent = pool.getIntent("i1");
		expect(intent?.status).toBe("satisfied");
	});

	test("stats reflect correct counts at each lifecycle stage", async () => {
		pool.createIntent("i1", "Build X", null, null);
		pool.createTask("t1", "i1", PAYLOAD, null, 300);
		pool.createTask("t2", "i1", PAYLOAD, null, 300);
		pool.createTask("t3", "i1", PAYLOAD, null, 300);

		// After decompose: all pending
		expect(pool.stats()).toEqual({ total: 3, pending: 3, claimed: 0, done: 0, failed: 0 });

		// Worker claims t1
		const t1 = pool.claimTask("w1");
		expect(pool.stats()).toEqual({ total: 3, pending: 2, claimed: 1, done: 0, failed: 0 });

		// t1 completes successfully
		pool.completeTask(t1!.id, { summary: "ok", filesChanged: [], exitCode: 0 });
		expect(pool.stats()).toEqual({ total: 3, pending: 2, claimed: 0, done: 1, failed: 0 });

		// t2 claimed + completed
		const t2 = pool.claimTask("w2");
		pool.completeTask(t2!.id, { summary: "ok", filesChanged: [], exitCode: 0 });

		// t3 claimed + fails
		const t3 = pool.claimTask("w3");
		pool.completeTask(t3!.id, { summary: "err", filesChanged: [], exitCode: 1 });

		const final = pool.stats();
		expect(final.done).toBe(2);
		expect(final.failed).toBe(1);
		expect(final.pending).toBe(0);
		expect(final.claimed).toBe(0);
	});

	test("intent stays active while tasks are in-progress", async () => {
		pool.createIntent("i1", "Refactor", null, null);
		pool.createTask("t1", "i1", PAYLOAD, null, 300);
		pool.createTask("t2", "i1", PAYLOAD, null, 300);

		// Complete only one of two tasks
		const t1 = pool.claimTask("w1");
		pool.completeTask(t1!.id, { summary: "ok", filesChanged: [], exitCode: 0 });

		const tick = await runWatchTick(pool, WATCH_OPTIONS, 1);
		expect(tick.satisfied).toHaveLength(0);
		expect(pool.getIntent("i1")?.status).toBe("active");
	});

	test("failed intent detected when all tasks fail", async () => {
		pool.createIntent("i1", "Doomed task", null, null);
		pool.createTask("t1", "i1", PAYLOAD, null, 300);

		const t1 = pool.claimTask("w1");
		pool.completeTask(t1!.id, { summary: "failed", filesChanged: [], exitCode: 1 });

		const tick = await runWatchTick(pool, { ...WATCH_OPTIONS, autoRedecompose: false }, 1);
		expect(tick.satisfied).toHaveLength(0);
		expect(pool.getIntent("i1")?.status).toBe("failed");
	});
});

// ─── 2. Dependency chain — topological execution order ───────────────────────

describe("dependency chain — execution ordering", () => {
	let pool: TaskPool;

	beforeEach(() => {
		pool = new TaskPool(":memory:");
	});

	afterEach(() => {
		pool.close();
	});

	test("blocked task is not claimable until dependency completes", () => {
		pool.createIntent("i1", "Build feature", null, null);
		pool.createTask("t-base", "i1", PAYLOAD, null, 300);
		pool.createTask("t-tests", "i1", PAYLOAD, ["t-base"], 300);
		pool.createTask("t-docs", "i1", PAYLOAD, ["t-base"], 300);

		// Only t-base should be available
		const first = pool.claimTask("w1");
		expect(first?.id).toBe("t-base");

		// t-tests and t-docs are blocked
		expect(pool.claimTask("w2")).toBeNull();

		// Complete t-base
		pool.completeTask("t-base", { summary: "done", filesChanged: [], exitCode: 0 });

		// Now both dependents are unblocked
		const second = pool.claimTask("w2");
		const third = pool.claimTask("w3");
		expect(second).not.toBeNull();
		expect(third).not.toBeNull();
		const claimedIds = new Set([second!.id, third!.id]);
		expect(claimedIds).toContain("t-tests");
		expect(claimedIds).toContain("t-docs");
	});

	test("three-level dependency chain executes in correct order", () => {
		pool.createIntent("i1", "Multi-step", null, null);
		pool.createTask("t1", "i1", PAYLOAD, null, 300);
		pool.createTask("t2", "i1", PAYLOAD, ["t1"], 300);
		pool.createTask("t3", "i1", PAYLOAD, ["t2"], 300);

		// Only t1 available
		const a = pool.claimTask("w1");
		expect(a?.id).toBe("t1");
		expect(pool.claimTask("w2")).toBeNull();

		pool.completeTask("t1", { summary: "done", filesChanged: [], exitCode: 0 });

		// t2 now available, t3 still blocked
		const b = pool.claimTask("w2");
		expect(b?.id).toBe("t2");
		expect(pool.claimTask("w3")).toBeNull();

		pool.completeTask("t2", { summary: "done", filesChanged: [], exitCode: 0 });

		const c = pool.claimTask("w3");
		expect(c?.id).toBe("t3");
	});

	test("full dependency chain completes and intent is satisfied", async () => {
		pool.createIntent("i1", "Staged work", null, null);
		pool.createTask("t1", "i1", PAYLOAD, null, 300);
		pool.createTask("t2", "i1", PAYLOAD, ["t1"], 300);

		pool.completeTask(pool.claimTask("w1")!.id, { summary: "ok", filesChanged: [], exitCode: 0 });
		pool.completeTask(pool.claimTask("w2")!.id, { summary: "ok", filesChanged: [], exitCode: 0 });

		const tick = await runWatchTick(pool, WATCH_OPTIONS, 1);
		expect(tick.satisfied).toContain("i1");
	});
});

// ─── 3. Multi-worker parallel execution ──────────────────────────────────────

describe("multi-worker parallel execution", () => {
	let pool: TaskPool;

	beforeEach(() => {
		pool = new TaskPool(":memory:");
	});

	afterEach(() => {
		pool.close();
	});

	test("multiple independent tasks are claimed by different workers", () => {
		pool.createIntent("i1", "Batch work", null, null);
		for (let i = 1; i <= 5; i++) {
			pool.createTask(`t${i}`, "i1", PAYLOAD, null, 300);
		}

		const claimed = [];
		for (let w = 1; w <= 5; w++) {
			const task = pool.claimTask(`worker-${w}`);
			expect(task).not.toBeNull();
			claimed.push(task!);
		}

		// All 5 distinct tasks claimed
		const ids = new Set(claimed.map((t) => t.id));
		expect(ids.size).toBe(5);

		// No more available
		expect(pool.claimTask("worker-6")).toBeNull();
	});

	test("workers from two intents can execute concurrently", () => {
		pool.createIntent("i1", "Intent A", null, null);
		pool.createIntent("i2", "Intent B", null, null);
		pool.createTask("ta", "i1", PAYLOAD, null, 300);
		pool.createTask("tb", "i2", PAYLOAD, null, 300);

		const a = pool.claimTask("w1");
		const b = pool.claimTask("w2");

		expect(a).not.toBeNull();
		expect(b).not.toBeNull();
		expect(a!.id).not.toBe(b!.id);

		pool.completeTask(a!.id, { summary: "ok", filesChanged: [], exitCode: 0 });
		pool.completeTask(b!.id, { summary: "ok", filesChanged: [], exitCode: 0 });

		expect(pool.stats()).toMatchObject({ done: 2, pending: 0, claimed: 0 });
	});
});

// ─── 4. TTL expiry — stale task reclaimed ────────────────────────────────────

describe("TTL expiry and re-execution", () => {
	let pool: TaskPool;

	beforeEach(() => {
		pool = new TaskPool(":memory:");
	});

	afterEach(() => {
		pool.close();
	});

	test("stale task is expired by watch tick and reclaimed by another worker", async () => {
		pool.createIntent("i1", "Flaky task", null, null);
		pool.createTask("t1", "i1", PAYLOAD, null, 1); // 1s TTL

		pool.claimTask("w1");

		// Backdate claimed_at to trigger expiry
		const db = (pool as unknown as { db: { exec: (s: string) => void } }).db;
		db.exec("UPDATE tasks SET claimed_at = claimed_at - 10 WHERE id = 't1'");

		// Watch tick expires it
		const tick = await runWatchTick(pool, WATCH_OPTIONS, 1);
		expect(tick.expired).toContain("t1");

		// Task is now pending again
		const task = pool.getTask("t1");
		expect(task?.status).toBe("pending");
		expect(task?.claimedBy).toBeNull();

		// Second worker reclaims and completes it
		const reclaimed = pool.claimTask("w2");
		expect(reclaimed?.id).toBe("t1");
		expect(reclaimed?.claimedBy).toBe("w2");

		pool.completeTask("t1", { summary: "retry succeeded", filesChanged: [], exitCode: 0 });

		const tick2 = await runWatchTick(pool, WATCH_OPTIONS, 2);
		expect(tick2.satisfied).toContain("i1");
	});

	test("non-expired task is not reclaimed during watch tick", async () => {
		pool.createIntent("i1", "Fast task", null, null);
		pool.createTask("t1", "i1", PAYLOAD, null, 300); // 300s TTL
		pool.claimTask("w1");

		const tick = await runWatchTick(pool, WATCH_OPTIONS, 1);
		expect(tick.expired).toHaveLength(0);

		// Task stays claimed
		expect(pool.getTask("t1")?.status).toBe("claimed");
	});
});

// ─── 5. Worktree → execute → merge integration (git-backed) ──────────────────

describe("worktree lifecycle — create, execute, merge", () => {
	test("task worktree is created, executed, merged back to main, and cleaned up", async () => {
		const repoRoot = await createRepo();
		tmpDirs.push(repoRoot);

		const worktreeBase = join(repoRoot, ".mycelium", "worktrees");
		mkdirSync(worktreeBase, { recursive: true });

		const pool = new TaskPool(":memory:");
		const taskId = "integ-task-1";

		pool.createIntent("i1", "Write output file", null, null);
		pool.createTask(taskId, "i1", PAYLOAD, null, 300);

		const task = pool.claimTask("w1");
		expect(task?.id).toBe(taskId);

		// Simulate worker: create worktree
		const worktreePath = await createWorktree(taskId, worktreeBase, repoRoot);

		// Simulate task execution: write a file and commit
		await Bun.write(join(worktreePath, "output.txt"), "task output\n");
		await git(["add", "."], worktreePath);
		await git(["commit", "-m", `worker(${taskId}): add output.txt`], worktreePath);

		const branch = `mycelium/task-${taskId}`;

		// Merge back to main
		const mergeResult = await mergeWorktree(branch, "main", repoRoot);
		expect(mergeResult.success).toBe(true);
		expect(mergeResult.commitSha).toBeDefined();

		// output.txt should now be on main
		const { exitCode } = await git(["ls-files", "--error-unmatch", "output.txt"], repoRoot);
		expect(exitCode).toBe(0);

		// Complete task in pool
		pool.completeTask(taskId, {
			summary: "output.txt written",
			filesChanged: ["output.txt"],
			commitSha: mergeResult.commitSha,
			exitCode: 0,
		});

		// Cleanup: remove worktree and branch
		await removeWorktree(worktreePath, repoRoot);
		await deleteBranch(branch, repoRoot);

		// Watch tick: intent should be satisfied
		const tick = await runWatchTick(pool, WATCH_OPTIONS, 1);
		expect(tick.satisfied).toContain("i1");

		pool.close();
	});

	test("multiple task worktrees merge cleanly via MergeQueue FIFO", async () => {
		const repoRoot = await createRepo();
		tmpDirs.push(repoRoot);

		const worktreeBase = join(repoRoot, ".mycelium", "worktrees");
		mkdirSync(worktreeBase, { recursive: true });

		const pool = new TaskPool(":memory:");
		pool.createIntent("i1", "Multi-file work", null, null);
		pool.createTask("task-a", "i1", PAYLOAD, null, 300);
		pool.createTask("task-b", "i1", PAYLOAD, null, 300);

		const mergeQueue = new MergeQueue(repoRoot, "main", {
			aiResolveEnabled: false,
			reimagineEnabled: false,
		});

		for (const taskId of ["task-a", "task-b"]) {
			const task = pool.claimTask(`worker-${taskId}`);
			expect(task?.id).toBe(taskId);

			const worktreePath = await createWorktree(taskId, worktreeBase, repoRoot);

			// Each task writes its own file (no conflicts)
			await Bun.write(join(worktreePath, `${taskId}.txt`), `${taskId} output\n`);
			await git(["add", "."], worktreePath);
			await git(["commit", "-m", `worker(${taskId}): add ${taskId}.txt`], worktreePath);

			pool.completeTask(taskId, {
				summary: "done",
				filesChanged: [`${taskId}.txt`],
				exitCode: 0,
			});

			mergeQueue.enqueue(taskId, `mycelium/task-${taskId}`);

			await removeWorktree(worktreePath, repoRoot);
		}

		// Process all via FIFO merge queue
		const processed = await mergeQueue.processAll();
		expect(processed).toHaveLength(2);
		expect(processed[0]?.status).toBe("merged");
		expect(processed[1]?.status).toBe("merged");

		// Both files should be on main
		for (const taskId of ["task-a", "task-b"]) {
			const { exitCode } = await git(["ls-files", "--error-unmatch", `${taskId}.txt`], repoRoot);
			expect(exitCode).toBe(0);

			await deleteBranch(`mycelium/task-${taskId}`, repoRoot).catch(() => {});
		}

		// Intent should be satisfied
		const tick = await runWatchTick(pool, WATCH_OPTIONS, 1);
		expect(tick.satisfied).toContain("i1");

		pool.close();
	});
});

// ─── 6. MergeQueue + pool state consistency ──────────────────────────────────

describe("MergeQueue + pool integration", () => {
	test("pool stats after merge reflect completed tasks", async () => {
		const repoRoot = await createRepo();
		tmpDirs.push(repoRoot);

		const worktreeBase = join(repoRoot, ".mycelium", "worktrees");
		mkdirSync(worktreeBase, { recursive: true });

		const pool = new TaskPool(":memory:");
		pool.createIntent("i1", "Build three files", null, null);
		pool.createTask("t1", "i1", PAYLOAD, null, 300);
		pool.createTask("t2", "i1", PAYLOAD, null, 300);
		pool.createTask("t3", "i1", PAYLOAD, null, 300);

		const q = new MergeQueue(repoRoot, "main", {
			aiResolveEnabled: false,
			reimagineEnabled: false,
		});

		for (const id of ["t1", "t2", "t3"]) {
			pool.claimTask(`worker-${id}`);
			const worktreePath = await createWorktree(id, worktreeBase, repoRoot);

			await Bun.write(join(worktreePath, `${id}.txt`), `content for ${id}\n`);
			await git(["add", "."], worktreePath);
			await git(["commit", "-m", `task ${id}`], worktreePath);

			pool.completeTask(id, { summary: "ok", filesChanged: [`${id}.txt`], exitCode: 0 });
			q.enqueue(id, `mycelium/task-${id}`);

			await removeWorktree(worktreePath, repoRoot);
		}

		expect(pool.stats()).toMatchObject({ done: 3, pending: 0, claimed: 0, failed: 0 });

		const processed = await q.processAll();
		expect(processed.filter((e) => e.status === "merged")).toHaveLength(3);

		// Cleanup branches
		for (const id of ["t1", "t2", "t3"]) {
			await deleteBranch(`mycelium/task-${id}`, repoRoot).catch(() => {});
		}

		pool.close();
	});
});

// ─── 7. Watch tick — multiple intents independent handling ────────────────────

describe("watch tick — multiple intents", () => {
	let pool: TaskPool;

	beforeEach(() => {
		pool = new TaskPool(":memory:");
	});

	afterEach(() => {
		pool.close();
	});

	test("satisfied and failed intents handled independently in same tick", async () => {
		// i1: all tasks done
		pool.createIntent("i1", "Success intent", null, null);
		pool.createTask("t1", "i1", PAYLOAD, null, 300);
		pool.completeTask(pool.claimTask("w1")!.id, { summary: "ok", filesChanged: [], exitCode: 0 });

		// i2: all tasks failed
		pool.createIntent("i2", "Failed intent", null, null);
		pool.createTask("t2", "i2", PAYLOAD, null, 300);
		pool.completeTask(pool.claimTask("w2")!.id, {
			summary: "err",
			filesChanged: [],
			exitCode: 1,
		});

		// i3: still in progress
		pool.createIntent("i3", "In-progress intent", null, null);
		pool.createTask("t3", "i3", PAYLOAD, null, 300);
		pool.claimTask("w3"); // still claimed

		const tick = await runWatchTick(pool, { ...WATCH_OPTIONS, autoRedecompose: false }, 1);

		expect(tick.satisfied).toContain("i1");
		expect(tick.satisfied).not.toContain("i2");
		expect(tick.satisfied).not.toContain("i3");

		expect(pool.getIntent("i1")?.status).toBe("satisfied");
		expect(pool.getIntent("i2")?.status).toBe("failed");
		expect(pool.getIntent("i3")?.status).toBe("active");
	});

	test("watch tick returns accurate global stats across all intents", async () => {
		pool.createIntent("i1", "A", null, null);
		pool.createIntent("i2", "B", null, null);
		pool.createTask("t1", "i1", PAYLOAD, null, 300);
		pool.createTask("t2", "i1", PAYLOAD, null, 300);
		pool.createTask("t3", "i2", PAYLOAD, null, 300);

		pool.completeTask(pool.claimTask("w1")!.id, { summary: "ok", filesChanged: [], exitCode: 0 });
		pool.claimTask("w2"); // t2 still claimed

		const tick = await runWatchTick(pool, WATCH_OPTIONS, 1);

		expect(tick.stats.total).toBe(3);
		expect(tick.stats.done).toBe(1);
		expect(tick.stats.claimed).toBe(1);
		expect(tick.stats.pending).toBe(1);
		expect(tick.stats.failed).toBe(0);
	});
});
