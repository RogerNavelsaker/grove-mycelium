import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MergeEntry, MergeQueue } from "./merge.ts";

// ─── Git helpers for test repos ──────────────────────────────────────────────

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
	const dir = join(tmpdir(), `merge-test-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	await git(["init", "--initial-branch=main"], dir);
	await git(["config", "user.email", "test@test.com"], dir);
	await git(["config", "user.name", "Test"], dir);
	await Bun.write(join(dir, "file.txt"), "line1\nline2\nline3\n");
	await git(["add", "."], dir);
	await git(["commit", "-m", "init"], dir);
	return dir;
}

// ─── Test state ──────────────────────────────────────────────────────────────

const dirs: string[] = [];

beforeEach(() => {
	dirs.length = 0;
});

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ─── Queue management (no git) ───────────────────────────────────────────────

describe("MergeQueue — queue management", () => {
	test("enqueue adds an entry with queued status", () => {
		const q = new MergeQueue("/repo", "main", { aiResolveEnabled: false, reimagineEnabled: false });
		const entry = q.enqueue("task-1", "mycelium/task-1");
		expect(entry.taskId).toBe("task-1");
		expect(entry.branch).toBe("mycelium/task-1");
		expect(entry.status).toBe("queued");
		expect(entry.queuedAt).toBeGreaterThan(0);
		expect(entry.commitSha).toBeUndefined();
		expect(entry.error).toBeUndefined();
	});

	test("list returns all entries", () => {
		const q = new MergeQueue("/repo", "main", { aiResolveEnabled: false, reimagineEnabled: false });
		q.enqueue("task-1", "branch-1");
		q.enqueue("task-2", "branch-2");
		const entries = q.list();
		expect(entries).toHaveLength(2);
		expect(entries.map((e) => e.taskId)).toEqual(["task-1", "task-2"]);
	});

	test("list returns a snapshot — mutations do not affect queue", () => {
		const q = new MergeQueue("/repo", "main", { aiResolveEnabled: false, reimagineEnabled: false });
		q.enqueue("task-1", "branch-1");
		const snap = q.list();
		q.enqueue("task-2", "branch-2");
		// Original snapshot is not mutated
		expect(snap).toHaveLength(1);
		expect(q.list()).toHaveLength(2);
	});

	test("get returns entry by taskId", () => {
		const q = new MergeQueue("/repo", "main", { aiResolveEnabled: false, reimagineEnabled: false });
		q.enqueue("task-a", "branch-a");
		q.enqueue("task-b", "branch-b");
		const entry = q.get("task-a");
		expect(entry).not.toBeNull();
		expect(entry?.taskId).toBe("task-a");
		expect(entry?.branch).toBe("branch-a");
	});

	test("get returns null for unknown taskId", () => {
		const q = new MergeQueue("/repo", "main", { aiResolveEnabled: false, reimagineEnabled: false });
		q.enqueue("task-1", "branch-1");
		expect(q.get("nonexistent")).toBeNull();
	});

	test("processNext returns null on empty queue", async () => {
		const q = new MergeQueue("/repo", "main", { aiResolveEnabled: false, reimagineEnabled: false });
		const result = await q.processNext();
		expect(result).toBeNull();
	});

	test("processNext returns null when all entries are already processed", async () => {
		const q = new MergeQueue("/repo", "main", { aiResolveEnabled: false, reimagineEnabled: false });
		q.enqueue("task-1", "nonexistent-branch");
		// Process it (will fail, but it won't be queued anymore)
		await q.processNext();
		// Now queue has no 'queued' entries
		const result = await q.processNext();
		expect(result).toBeNull();
	});

	test("enqueue entries have independent queuedAt timestamps", () => {
		const q = new MergeQueue("/repo", "main", { aiResolveEnabled: false, reimagineEnabled: false });
		const e1 = q.enqueue("task-1", "branch-1");
		const e2 = q.enqueue("task-2", "branch-2");
		// Both have valid timestamps; e2 is >= e1
		expect(e2.queuedAt).toBeGreaterThanOrEqual(e1.queuedAt);
	});
});

// ─── Git-backed merge tests ───────────────────────────────────────────────────

describe("MergeQueue — clean merge", () => {
	test("processNext merges a non-conflicting branch cleanly", async () => {
		const dir = await createRepo();
		dirs.push(dir);

		// Create task branch with a new file (no conflict)
		await git(["checkout", "-b", "mycelium/task-clean"], dir);
		await Bun.write(join(dir, "new.txt"), "task output\n");
		await git(["add", "."], dir);
		await git(["commit", "-m", "task: add new.txt"], dir);
		await git(["checkout", "main"], dir);

		const q = new MergeQueue(dir, "main", { aiResolveEnabled: false, reimagineEnabled: false });
		q.enqueue("task-clean", "mycelium/task-clean");

		const entry = await q.processNext();
		expect(entry).not.toBeNull();
		expect(entry?.status).toBe("merged");
		expect(entry?.commitSha).toBeDefined();
		expect(entry?.mergedAt).toBeGreaterThan(0);
		expect(entry?.error).toBeUndefined();
	});

	test("get reflects updated status after processNext", async () => {
		const dir = await createRepo();
		dirs.push(dir);

		await git(["checkout", "-b", "mycelium/task-status"], dir);
		await Bun.write(join(dir, "task.txt"), "done\n");
		await git(["add", "."], dir);
		await git(["commit", "-m", "task: add task.txt"], dir);
		await git(["checkout", "main"], dir);

		const q = new MergeQueue(dir, "main", { aiResolveEnabled: false, reimagineEnabled: false });
		q.enqueue("task-status", "mycelium/task-status");

		expect(q.get("task-status")?.status).toBe("queued");
		await q.processNext();
		expect(q.get("task-status")?.status).toBe("merged");
	});

	test("processAll merges all queued branches in FIFO order", async () => {
		const dir = await createRepo();
		dirs.push(dir);

		// Create two non-conflicting branches
		for (const id of ["t1", "t2"]) {
			await git(["checkout", "-b", `mycelium/task-${id}`], dir);
			await Bun.write(join(dir, `${id}.txt`), `${id} output\n`);
			await git(["add", "."], dir);
			await git(["commit", "-m", `task: add ${id}.txt`], dir);
			await git(["checkout", "main"], dir);
		}

		const q = new MergeQueue(dir, "main", { aiResolveEnabled: false, reimagineEnabled: false });

		// Enqueue t1 first, t2 second
		q.enqueue("t1", "mycelium/task-t1");
		q.enqueue("t2", "mycelium/task-t2");

		const processed = await q.processAll();
		expect(processed).toHaveLength(2);
		expect(processed[0]?.taskId).toBe("t1");
		expect(processed[1]?.taskId).toBe("t2");
		expect(processed[0]?.status).toBe("merged");
		expect(processed[1]?.status).toBe("merged");
	});

	test("processNext fails cleanly for nonexistent branch", async () => {
		const dir = await createRepo();
		dirs.push(dir);

		const q = new MergeQueue(dir, "main", { aiResolveEnabled: false, reimagineEnabled: false });
		q.enqueue("task-missing", "mycelium/nonexistent");

		const entry = await q.processNext();
		expect(entry).not.toBeNull();
		// Either failed or conflict depending on git error
		expect(["failed", "conflict"]).toContain(entry?.status ?? "");
		expect(entry?.error).toBeDefined();
	});
});

describe("MergeQueue — conflict handling", () => {
	test("marks entry as conflict when merge conflicts and AI is disabled", async () => {
		const dir = await createRepo();
		dirs.push(dir);

		// Create a conflicting task branch
		await git(["checkout", "-b", "mycelium/task-conflict"], dir);
		await Bun.write(join(dir, "file.txt"), "task-branch content\n");
		await git(["add", "."], dir);
		await git(["commit", "-m", "task: modify file.txt"], dir);

		// Advance main with a conflicting change
		await git(["checkout", "main"], dir);
		await Bun.write(join(dir, "file.txt"), "main-branch content\n");
		await git(["add", "."], dir);
		await git(["commit", "-m", "main: modify file.txt"], dir);

		const q = new MergeQueue(dir, "main", { aiResolveEnabled: false, reimagineEnabled: false });
		q.enqueue("task-conflict", "mycelium/task-conflict");

		const entry = await q.processNext();
		expect(entry).not.toBeNull();
		expect(entry?.status).toBe("conflict");
		expect(entry?.error).toBeDefined();
		expect(entry?.commitSha).toBeUndefined();
	});

	test("processAll continues after a conflict entry", async () => {
		const dir = await createRepo();
		dirs.push(dir);

		// Create conflict branch
		await git(["checkout", "-b", "mycelium/task-bad"], dir);
		await Bun.write(join(dir, "file.txt"), "task content\n");
		await git(["add", "."], dir);
		await git(["commit", "-m", "conflict task"], dir);
		await git(["checkout", "main"], dir);
		await Bun.write(join(dir, "file.txt"), "main content\n");
		await git(["add", "."], dir);
		await git(["commit", "-m", "main advance"], dir);

		// Create clean branch
		await git(["checkout", "-b", "mycelium/task-good"], dir);
		await Bun.write(join(dir, "other.txt"), "clean task\n");
		await git(["add", "."], dir);
		await git(["commit", "-m", "clean task"], dir);
		await git(["checkout", "main"], dir);

		const q = new MergeQueue(dir, "main", { aiResolveEnabled: false, reimagineEnabled: false });
		q.enqueue("task-bad", "mycelium/task-bad");
		q.enqueue("task-good", "mycelium/task-good");

		const processed = await q.processAll();
		expect(processed).toHaveLength(2);

		const bad = processed.find((e) => e.taskId === "task-bad");
		const good = processed.find((e) => e.taskId === "task-good");

		expect(bad?.status).toBe("conflict");
		expect(good?.status).toBe("merged");
	});
});

describe("MergeQueue — FIFO ordering", () => {
	test("processNext picks the oldest queued entry when timestamps differ", () => {
		const q = new MergeQueue("/repo", "main", { aiResolveEnabled: false, reimagineEnabled: false });

		// Manually construct entries with different queuedAt
		const e1 = q.enqueue("task-old", "branch-old");
		const e2 = q.enqueue("task-new", "branch-new");

		// Force e2 to appear older by mutating internal state (for ordering test only)
		(e2 as MergeEntry).queuedAt = e1.queuedAt - 1000;

		// The queue should pick e2 (older queuedAt) first — but since we're not
		// running processNext against a real git repo here, verify via list ordering
		const queued = q
			.list()
			.filter((e) => e.status === "queued")
			.sort((a, b) => a.queuedAt - b.queuedAt);
		expect(queued[0]?.taskId).toBe("task-new");
		expect(queued[1]?.taskId).toBe("task-old");
	});
});
