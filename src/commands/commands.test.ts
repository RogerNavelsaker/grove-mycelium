/**
 * Integration tests for CLI commands: init, status, show, tasks
 *
 * Each test spins up a temporary directory, runs `mc <cmd> --json` as a
 * subprocess, and asserts on the parsed JSON output.  Using a subprocess
 * avoids any shared-state issues between commander registrations and keeps
 * tests independent of the test runner's process.cwd().
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { TaskPool } from "../pool.ts";
import type { TaskPayload } from "../types.ts";

// Path to the CLI entry point in this worktree
const CLI = join(import.meta.dir, "../index.ts");

async function run(
	args: string[],
	cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(["bun", "run", CLI, "--json", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	await proc.exited;
	return { stdout, stderr, exitCode: proc.exitCode ?? 0 };
}

// --- init ---

describe("mc init", () => {
	let tmpDir: string;

	beforeAll(() => {
		tmpDir = `/tmp/mc-test-init-${Date.now()}`;
		mkdirSync(tmpDir, { recursive: true });
	});

	afterAll(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("initializes and returns success JSON", async () => {
		const { stdout, exitCode } = await run(["init"], tmpDir);
		const result = JSON.parse(stdout) as {
			success: boolean;
			command: string;
			path: string;
			files: string[];
		};
		expect(exitCode).toBe(0);
		expect(result.success).toBe(true);
		expect(result.command).toBe("init");
		expect(result.files).toContain("config.yaml");
		expect(result.files).toContain("tasks.db");
	});

	it("fails with success:false if already initialized (no --force)", async () => {
		// tmpDir is already initialized from previous test
		const { stdout, exitCode } = await run(["init"], tmpDir);
		const result = JSON.parse(stdout) as { success: boolean; error: string };
		expect(exitCode).toBe(1);
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/already initialized/i);
	});

	it("re-initializes with --force", async () => {
		const { stdout, exitCode } = await run(["init", "--force"], tmpDir);
		const result = JSON.parse(stdout) as { success: boolean };
		expect(exitCode).toBe(0);
		expect(result.success).toBe(true);
	});
});

// --- status ---

describe("mc status", () => {
	let tmpDir: string;

	beforeAll(async () => {
		tmpDir = `/tmp/mc-test-status-${Date.now()}`;
		mkdirSync(tmpDir, { recursive: true });
		// Initialize first
		await run(["init"], tmpDir);
	});

	afterAll(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns success JSON with zero counts on empty pool", async () => {
		const { stdout, exitCode } = await run(["status"], tmpDir);
		const result = JSON.parse(stdout) as {
			success: boolean;
			intents: number;
			tasks: { total: number };
		};
		expect(exitCode).toBe(0);
		expect(result.success).toBe(true);
		expect(result.intents).toBe(0);
		expect(result.tasks.total).toBe(0);
	});

	it("reflects tasks after adding them to the pool", async () => {
		const dbPath = join(tmpDir, ".mycelium/tasks.db");
		const p = new TaskPool(dbPath);
		const payload: TaskPayload = {
			description: "test",
			fileScope: [],
			context: "",
			acceptanceCriteria: "",
		};
		p.createIntent("i1", "test intent", null, null);
		p.createTask("t1", "i1", payload, null, 300);
		p.close();

		const { stdout } = await run(["status"], tmpDir);
		const result = JSON.parse(stdout) as { tasks: { total: number; pending: number } };
		expect(result.tasks.total).toBe(1);
		expect(result.tasks.pending).toBe(1);
	});
});

// --- show ---

describe("mc show", () => {
	let tmpDir: string;
	const INTENT_ID = "intent-show-1";
	const TASK_ID = "task-show-1";

	beforeAll(async () => {
		tmpDir = `/tmp/mc-test-show-${Date.now()}`;
		mkdirSync(tmpDir, { recursive: true });
		await run(["init"], tmpDir);

		const dbPath = join(tmpDir, ".mycelium/tasks.db");
		const p = new TaskPool(dbPath);
		const payload: TaskPayload = {
			description: "implement feature",
			fileScope: ["src/foo.ts"],
			context: "ctx",
			acceptanceCriteria: "tests pass",
		};
		p.createIntent(INTENT_ID, "build the thing", "seed-1", null);
		p.createTask(TASK_ID, INTENT_ID, payload, null, 300);
		p.close();
	});

	afterAll(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns task data when given a task id", async () => {
		const { stdout, exitCode } = await run(["show", TASK_ID], tmpDir);
		const result = JSON.parse(stdout) as {
			success: boolean;
			type: string;
			data: { id: string; status: string };
		};
		expect(exitCode).toBe(0);
		expect(result.success).toBe(true);
		expect(result.type).toBe("task");
		expect(result.data.id).toBe(TASK_ID);
		expect(result.data.status).toBe("pending");
	});

	it("returns intent data when given an intent id", async () => {
		const { stdout, exitCode } = await run(["show", INTENT_ID], tmpDir);
		const result = JSON.parse(stdout) as {
			success: boolean;
			type: string;
			data: { id: string; description: string };
			tasks: { total: number };
		};
		expect(exitCode).toBe(0);
		expect(result.success).toBe(true);
		expect(result.type).toBe("intent");
		expect(result.data.id).toBe(INTENT_ID);
		expect(result.data.description).toBe("build the thing");
		expect(result.tasks.total).toBe(1);
	});

	it("returns success:false for unknown id", async () => {
		const { stdout, exitCode } = await run(["show", "does-not-exist"], tmpDir);
		const result = JSON.parse(stdout) as { success: boolean; error: string };
		expect(exitCode).toBe(1);
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/not found/i);
	});
});

// --- tasks ---

describe("mc tasks", () => {
	let tmpDir: string;

	beforeAll(async () => {
		tmpDir = `/tmp/mc-test-tasks-${Date.now()}`;
		mkdirSync(tmpDir, { recursive: true });
		await run(["init"], tmpDir);

		const dbPath = join(tmpDir, ".mycelium/tasks.db");
		const p = new TaskPool(dbPath);
		const payload: TaskPayload = {
			description: "do work",
			fileScope: [],
			context: "",
			acceptanceCriteria: "",
		};
		p.createIntent("i1", "intent", null, null);
		p.createTask("ta", "i1", payload, null, 300);
		p.createTask("tb", "i1", payload, null, 300);
		p.claimTask("w1"); // ta → claimed
		p.close();
	});

	afterAll(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns all tasks", async () => {
		const { stdout, exitCode } = await run(["tasks"], tmpDir);
		const result = JSON.parse(stdout) as { success: boolean; tasks: unknown[]; total: number };
		expect(exitCode).toBe(0);
		expect(result.success).toBe(true);
		expect(result.total).toBe(2);
	});

	it("filters by status=pending", async () => {
		const { stdout } = await run(["tasks", "--status", "pending"], tmpDir);
		const result = JSON.parse(stdout) as { tasks: Array<{ status: string }> };
		expect(result.tasks.every((t) => t.status === "pending")).toBe(true);
		expect(result.tasks).toHaveLength(1);
	});

	it("filters by status=claimed", async () => {
		const { stdout } = await run(["tasks", "--status", "claimed"], tmpDir);
		const result = JSON.parse(stdout) as { tasks: Array<{ id: string }> };
		expect(result.tasks).toHaveLength(1);
		expect(result.tasks[0]?.id).toBe("ta");
	});

	it("filters by intent", async () => {
		const { stdout } = await run(["tasks", "--intent", "i1"], tmpDir);
		const result = JSON.parse(stdout) as { total: number };
		expect(result.total).toBe(2);
	});

	it("respects --limit", async () => {
		const { stdout } = await run(["tasks", "--limit", "1"], tmpDir);
		const result = JSON.parse(stdout) as { tasks: unknown[]; total: number };
		expect(result.tasks).toHaveLength(1);
		expect(result.total).toBe(2);
	});
});
