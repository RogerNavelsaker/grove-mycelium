/**
 * Tests for mc logs — worker log viewer.
 *
 * Uses the subprocess pattern: spin up a temp directory, seed log files and
 * pool DB, then run `mc logs --json` and assert on the parsed JSON output.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TaskPool } from "../pool.ts";
import type { TaskPayload } from "../types.ts";

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

describe("mc logs", () => {
	let tmpDir: string;
	const INTENT_ID = "intent-logs-1";
	const TASK_A = "taskA";
	const TASK_B = "taskB";
	const WORKER_1 = "worker-1";
	const WORKER_2 = "worker-2";

	beforeAll(async () => {
		tmpDir = `/tmp/mc-test-logs-${Date.now()}`;
		mkdirSync(tmpDir, { recursive: true });
		await run(["init"], tmpDir);

		// Seed the task pool
		const dbPath = join(tmpDir, ".mycelium/tasks.db");
		const pool = new TaskPool(dbPath);
		const payload: TaskPayload = {
			description: "test task",
			fileScope: [],
			context: "",
			acceptanceCriteria: "",
		};
		pool.createIntent(INTENT_ID, "test intent", null, null);
		pool.createTask(TASK_A, INTENT_ID, payload, null, 300);
		pool.createTask(TASK_B, INTENT_ID, payload, null, 300);
		pool.close();

		// Write fake log files
		const logsDir = join(tmpDir, ".mycelium/logs");
		mkdirSync(logsDir, { recursive: true });
		writeFileSync(
			join(logsDir, `${WORKER_1}-${TASK_A}.log`),
			"=== stdout ===\nhello from task A\n=== stderr ===\n",
		);
		writeFileSync(
			join(logsDir, `${WORKER_2}-${TASK_B}.log`),
			"=== stdout ===\nhello from task B\n=== stderr ===\n",
		);
	});

	afterAll(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns all log files with no filters", async () => {
		const { stdout, exitCode } = await run(["logs"], tmpDir);
		const result = JSON.parse(stdout) as {
			success: boolean;
			command: string;
			files: { file: string; content: string }[];
		};
		expect(exitCode).toBe(0);
		expect(result.success).toBe(true);
		expect(result.command).toBe("logs");
		expect(result.files).toHaveLength(2);
		const names = result.files.map((f) => f.file).sort();
		expect(names).toContain(`${WORKER_1}-${TASK_A}.log`);
		expect(names).toContain(`${WORKER_2}-${TASK_B}.log`);
	});

	it("includes file content in results", async () => {
		const { stdout } = await run(["logs", "--worker", WORKER_1], tmpDir);
		const result = JSON.parse(stdout) as { files: { file: string; content: string }[] };
		expect(result.files[0]?.content).toContain("hello from task A");
	});

	it("filters by --worker", async () => {
		const { stdout, exitCode } = await run(["logs", "--worker", WORKER_1], tmpDir);
		const result = JSON.parse(stdout) as { files: { file: string }[] };
		expect(exitCode).toBe(0);
		expect(result.files).toHaveLength(1);
		expect(result.files[0]?.file).toBe(`${WORKER_1}-${TASK_A}.log`);
	});

	it("filters by --intent", async () => {
		const { stdout, exitCode } = await run(["logs", "--intent", INTENT_ID], tmpDir);
		const result = JSON.parse(stdout) as { files: { file: string }[] };
		expect(exitCode).toBe(0);
		expect(result.files).toHaveLength(2);
	});

	it("returns empty files array when worker has no logs", async () => {
		const { stdout, exitCode } = await run(["logs", "--worker", "worker-99"], tmpDir);
		const result = JSON.parse(stdout) as { success: boolean; files: unknown[] };
		expect(exitCode).toBe(0);
		expect(result.success).toBe(true);
		expect(result.files).toHaveLength(0);
	});

	it("returns empty files array when logs directory does not exist", async () => {
		const emptyDir = `/tmp/mc-test-logs-empty-${Date.now()}`;
		mkdirSync(emptyDir, { recursive: true });
		try {
			await run(["init"], emptyDir);
			const { stdout, exitCode } = await run(["logs"], emptyDir);
			const result = JSON.parse(stdout) as { success: boolean; files: unknown[] };
			expect(exitCode).toBe(0);
			expect(result.success).toBe(true);
			expect(result.files).toHaveLength(0);
		} finally {
			rmSync(emptyDir, { recursive: true, force: true });
		}
	});
});
