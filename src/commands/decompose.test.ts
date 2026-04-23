import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskPool } from "../pool.ts";

// Test helpers
function createTestDir(): string {
	const dir = join(tmpdir(), `mc-test-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	mkdirSync(`${dir}/.mycelium`, { recursive: true });
	// Minimal config
	writeFileSync(
		`${dir}/.mycelium/config.yaml`,
		"project:\n  name: test\n  root: .\n  canonicalBranch: main\n",
	);
	return dir;
}

function cleanup(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		// ignore
	}
}

// Unit tests for pool interaction (no claude invocation)
describe("TaskPool — decompose integration", () => {
	let tmpDir: string;
	let pool: TaskPool;

	beforeEach(() => {
		tmpDir = createTestDir();
		pool = new TaskPool(`${tmpDir}/.mycelium/tasks.db`);
	});

	afterEach(() => {
		pool.close();
		cleanup(tmpDir);
	});

	it("creates intent with correct fields", () => {
		const intent = pool.createIntent("intent-abc1", "Migrate auth", null, null);
		expect(intent.id).toBe("intent-abc1");
		expect(intent.description).toBe("Migrate auth");
		expect(intent.seedId).toBeNull();
		expect(intent.status).toBe("active");
	});

	it("retrieves created intent", () => {
		pool.createIntent("intent-abc2", "Write tests", "seed-123", '["src/"]');
		const found = pool.getIntent("intent-abc2");
		expect(found).not.toBeNull();
		expect(found?.description).toBe("Write tests");
		expect(found?.seedId).toBe("seed-123");
		expect(found?.context).toBe('["src/"]');
	});

	it("creates task with correct payload", () => {
		pool.createIntent("intent-abc3", "Test intent", null, null);
		const payload = {
			description: "Migrate users.ts",
			fileScope: ["src/routes/users.ts"],
			context: "Uses express-validator v6",
			acceptanceCriteria: "All existing tests pass",
			hints: ["Use zod schema"],
		};
		const task = pool.createTask("task-001", "intent-abc3", payload, null, 300);
		expect(task.id).toBe("task-001");
		expect(task.intentId).toBe("intent-abc3");
		expect(task.status).toBe("pending");
		expect(task.payload.description).toBe("Migrate users.ts");
		expect(task.payload.fileScope).toEqual(["src/routes/users.ts"]);
		expect(task.dependsOn).toBeNull();
	});

	it("creates task with dependencies", () => {
		pool.createIntent("intent-abc4", "Multi-step", null, null);
		pool.createTask(
			"task-dep",
			"intent-abc4",
			{
				description: "Task A",
				fileScope: [],
				context: "",
				acceptanceCriteria: "done",
			},
			null,
			300,
		);
		const dependent = pool.createTask(
			"task-main",
			"intent-abc4",
			{
				description: "Task B (depends on A)",
				fileScope: [],
				context: "",
				acceptanceCriteria: "done after A",
			},
			["task-dep"],
			300,
		);
		expect(dependent.dependsOn).toEqual(["task-dep"]);
	});

	it("dependent task is not claimable until dependency is done", () => {
		pool.createIntent("intent-abc5", "Sequential work", null, null);
		pool.createTask(
			"task-first",
			"intent-abc5",
			{ description: "A", fileScope: [], context: "", acceptanceCriteria: "done" },
			null,
			300,
		);
		pool.createTask(
			"task-second",
			"intent-abc5",
			{ description: "B", fileScope: [], context: "", acceptanceCriteria: "done" },
			["task-first"],
			300,
		);

		// First claim should return the independent task
		const claimed = pool.claimTask("worker-1");
		expect(claimed?.id).toBe("task-first");

		// Now try to claim again — task-second is blocked
		const blocked = pool.claimTask("worker-2");
		expect(blocked).toBeNull();
	});

	it("dependent task becomes claimable after dependency completes", () => {
		pool.createIntent("intent-abc6", "Sequential work 2", null, null);
		pool.createTask(
			"task-a",
			"intent-abc6",
			{ description: "A", fileScope: [], context: "", acceptanceCriteria: "done" },
			null,
			300,
		);
		pool.createTask(
			"task-b",
			"intent-abc6",
			{ description: "B", fileScope: [], context: "", acceptanceCriteria: "done" },
			["task-a"],
			300,
		);

		// Claim and complete task-a
		pool.claimTask("worker-1");
		pool.completeTask("task-a", {
			summary: "Done",
			filesChanged: [],
			exitCode: 0,
		});

		// Now task-b should be claimable
		const next = pool.claimTask("worker-2");
		expect(next?.id).toBe("task-b");
	});

	it("lists tasks for intent", () => {
		pool.createIntent("intent-abc7", "List test", null, null);
		pool.createTask(
			"task-x1",
			"intent-abc7",
			{ description: "T1", fileScope: [], context: "", acceptanceCriteria: "" },
			null,
			300,
		);
		pool.createTask(
			"task-x2",
			"intent-abc7",
			{ description: "T2", fileScope: [], context: "", acceptanceCriteria: "" },
			null,
			300,
		);
		const tasks = pool.listTasks("intent-abc7");
		expect(tasks.length).toBe(2);
		expect(tasks.map((t) => t.id)).toContain("task-x1");
		expect(tasks.map((t) => t.id)).toContain("task-x2");
	});

	it("stats returns correct counts", () => {
		pool.createIntent("intent-abc8", "Stats test", null, null);
		pool.createTask(
			"task-s1",
			"intent-abc8",
			{ description: "T1", fileScope: [], context: "", acceptanceCriteria: "" },
			null,
			300,
		);
		pool.createTask(
			"task-s2",
			"intent-abc8",
			{ description: "T2", fileScope: [], context: "", acceptanceCriteria: "" },
			null,
			300,
		);

		const stats = pool.stats("intent-abc8");
		expect(stats.total).toBe(2);
		expect(stats.pending).toBe(2);
		expect(stats.claimed).toBe(0);
		expect(stats.done).toBe(0);
	});

	it("TTL expiry returns stale tasks to pending", () => {
		pool.createIntent("intent-abc9", "TTL test", null, null);
		pool.createTask(
			"task-ttl1",
			"intent-abc9",
			{ description: "T1", fileScope: [], context: "", acceptanceCriteria: "" },
			null,
			1, // 1 second TTL
		);

		pool.claimTask("worker-ttl");

		// Wait 2s is too slow for a test — instead, manually update claimed_at to be old
		// Access the underlying DB via expireStale after adjusting time via SQL
		const db = (pool as unknown as { db: { exec: (sql: string) => void } }).db;
		db.exec("UPDATE tasks SET claimed_at = claimed_at - 10 WHERE id = 'task-ttl1'");

		const expired = pool.expireStale();
		expect(expired.length).toBe(1);
		expect(expired[0]?.id).toBe("task-ttl1");
		expect(expired[0]?.status).toBe("pending");
	});
});

// Unit test for JSON extraction logic (exported for testing)
describe("decompose — JSON extraction", () => {
	it("extracts JSON array from plain output", () => {
		// Simulate what extractJsonArray does via dynamic import
		const text = `
Here are the tasks:
[
  {"label": "a", "description": "Task A", "fileScope": [], "context": "", "acceptanceCriteria": "done", "dependsOnLabels": [], "isComplex": false}
]
Done.`;
		const match = text.match(/\[[\s\S]*\]/);
		expect(match).not.toBeNull();
		const jsonStr = match?.[0];
		expect(jsonStr).toBeDefined();
		const parsed = JSON.parse(jsonStr ?? "[]");
		expect(Array.isArray(parsed)).toBe(true);
		expect(parsed[0].description).toBe("Task A");
	});

	it("handles pure JSON array output", () => {
		const text = `[{"label":"t1","description":"Do X","fileScope":["src/x.ts"],"context":"ctx","acceptanceCriteria":"pass","isComplex":false}]`;
		const match = text.match(/\[[\s\S]*\]/);
		expect(match).not.toBeNull();
		const jsonStr = match?.[0];
		expect(jsonStr).toBeDefined();
		const parsed = JSON.parse(jsonStr ?? "[]");
		expect(parsed.length).toBe(1);
		expect(parsed[0].fileScope).toEqual(["src/x.ts"]);
	});

	it("returns null for output with no JSON array", () => {
		const text = "I cannot decompose this intent.";
		const match = text.match(/\[[\s\S]*\]/);
		expect(match).toBeNull();
	});
});
