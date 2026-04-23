import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TaskPool } from "./pool.ts";
import type { TaskPayload, TaskResult } from "./types.ts";

const PAYLOAD: TaskPayload = {
	description: "Test task",
	fileScope: ["src/foo.ts"],
	context: "some context",
	acceptanceCriteria: "it works",
};

let pool: TaskPool;

beforeEach(() => {
	pool = new TaskPool(":memory:");
});

afterEach(() => {
	pool.close();
});

// --- Intent tests ---

describe("createIntent", () => {
	test("returns intent with correct fields", () => {
		const intent = pool.createIntent("i-1", "Build feature X", null, null);
		expect(intent.id).toBe("i-1");
		expect(intent.description).toBe("Build feature X");
		expect(intent.seedId).toBeNull();
		expect(intent.context).toBeNull();
		expect(intent.status).toBe("active");
		expect(intent.satisfiedAt).toBeNull();
		expect(intent.createdAt).toBeGreaterThan(0);
	});

	test("stores seedId and context when provided", () => {
		const intent = pool.createIntent("i-2", "Feature Y", "seed-42", "some context");
		expect(intent.seedId).toBe("seed-42");
		expect(intent.context).toBe("some context");
	});
});

describe("getIntent", () => {
	test("returns null for unknown id", () => {
		expect(pool.getIntent("nope")).toBeNull();
	});

	test("retrieves a created intent", () => {
		pool.createIntent("i-1", "Build X", null, null);
		const found = pool.getIntent("i-1");
		expect(found).not.toBeNull();
		expect(found!.id).toBe("i-1");
		expect(found!.description).toBe("Build X");
	});
});

describe("updateIntentStatus", () => {
	test("sets status to satisfied and records satisfiedAt", () => {
		pool.createIntent("i-1", "Build X", null, null);
		const before = Math.floor(Date.now() / 1000);
		pool.updateIntentStatus("i-1", "satisfied");
		const intent = pool.getIntent("i-1");
		expect(intent!.status).toBe("satisfied");
		expect(intent!.satisfiedAt).toBeGreaterThanOrEqual(before);
	});

	test("sets status to failed with null satisfiedAt", () => {
		pool.createIntent("i-1", "Build X", null, null);
		pool.updateIntentStatus("i-1", "failed");
		const intent = pool.getIntent("i-1");
		expect(intent!.status).toBe("failed");
		expect(intent!.satisfiedAt).toBeNull();
	});
});

describe("listIntents", () => {
	test("returns empty array when no intents", () => {
		expect(pool.listIntents()).toEqual([]);
	});

	test("returns all intents", () => {
		pool.createIntent("i-1", "First", null, null);
		pool.createIntent("i-2", "Second", null, null);
		const all = pool.listIntents();
		expect(all).toHaveLength(2);
		const ids = all.map((i) => i.id).sort();
		expect(ids).toEqual(["i-1", "i-2"]);
	});

	test("filters by status", () => {
		pool.createIntent("i-1", "Active", null, null);
		pool.createIntent("i-2", "Satisfied", null, null);
		pool.updateIntentStatus("i-2", "satisfied");
		const active = pool.listIntents("active");
		expect(active).toHaveLength(1);
		expect(active[0]!.id).toBe("i-1");
		const satisfied = pool.listIntents("satisfied");
		expect(satisfied).toHaveLength(1);
		expect(satisfied[0]!.id).toBe("i-2");
	});
});

// --- Task tests ---

describe("createTask", () => {
	test("returns task with correct fields", () => {
		pool.createIntent("i-1", "Intent", null, null);
		const task = pool.createTask("t-1", "i-1", PAYLOAD, null, 300);
		expect(task.id).toBe("t-1");
		expect(task.intentId).toBe("i-1");
		expect(task.status).toBe("pending");
		expect(task.payload).toEqual(PAYLOAD);
		expect(task.result).toBeNull();
		expect(task.dependsOn).toBeNull();
		expect(task.claimedBy).toBeNull();
		expect(task.claimedAt).toBeNull();
		expect(task.ttl).toBe(300);
		expect(task.retryCount).toBe(0);
		expect(task.completedAt).toBeNull();
	});

	test("stores dependsOn list", () => {
		pool.createIntent("i-1", "Intent", null, null);
		pool.createTask("t-dep", "i-1", PAYLOAD, null, 300);
		const task = pool.createTask("t-1", "i-1", PAYLOAD, ["t-dep"], 300);
		expect(task.dependsOn).toEqual(["t-dep"]);
	});
});

describe("getTask", () => {
	test("returns null for unknown id", () => {
		expect(pool.getTask("nope")).toBeNull();
	});

	test("retrieves a created task", () => {
		pool.createIntent("i-1", "Intent", null, null);
		pool.createTask("t-1", "i-1", PAYLOAD, null, 300);
		const task = pool.getTask("t-1");
		expect(task).not.toBeNull();
		expect(task!.id).toBe("t-1");
	});
});

describe("claimTask", () => {
	test("claims the oldest pending task", () => {
		pool.createIntent("i-1", "Intent", null, null);
		pool.createTask("t-1", "i-1", PAYLOAD, null, 300);
		pool.createTask("t-2", "i-1", PAYLOAD, null, 300);
		const claimed = pool.claimTask("worker-a");
		expect(claimed).not.toBeNull();
		expect(claimed!.id).toBe("t-1");
		expect(claimed!.status).toBe("claimed");
		expect(claimed!.claimedBy).toBe("worker-a");
		expect(claimed!.claimedAt).toBeGreaterThan(0);
	});

	test("returns null when no tasks available", () => {
		expect(pool.claimTask("worker-a")).toBeNull();
	});

	test("does not claim task with unresolved dependencies", () => {
		pool.createIntent("i-1", "Intent", null, null);
		pool.createTask("t-dep", "i-1", PAYLOAD, null, 300);
		pool.createTask("t-blocked", "i-1", PAYLOAD, ["t-dep"], 300);
		const first = pool.claimTask("worker-a");
		expect(first!.id).toBe("t-dep");
		// t-blocked depends on t-dep which is claimed (not done), so nothing else available
		expect(pool.claimTask("worker-b")).toBeNull();
	});

	test("claims dependent task after dependency completes", () => {
		pool.createIntent("i-1", "Intent", null, null);
		pool.createTask("t-dep", "i-1", PAYLOAD, null, 300);
		pool.createTask("t-blocked", "i-1", PAYLOAD, ["t-dep"], 300);
		const dep = pool.claimTask("worker-a");
		pool.completeTask(dep!.id, { summary: "done", filesChanged: [], exitCode: 0 });
		const next = pool.claimTask("worker-b");
		expect(next).not.toBeNull();
		expect(next!.id).toBe("t-blocked");
	});

	test("does not double-claim a task", () => {
		pool.createIntent("i-1", "Intent", null, null);
		pool.createTask("t-1", "i-1", PAYLOAD, null, 300);
		pool.claimTask("worker-a");
		expect(pool.claimTask("worker-b")).toBeNull();
	});
});

describe("completeTask", () => {
	test("marks task done when exitCode is 0", () => {
		pool.createIntent("i-1", "Intent", null, null);
		pool.createTask("t-1", "i-1", PAYLOAD, null, 300);
		pool.claimTask("worker-a");
		const result: TaskResult = { summary: "All good", filesChanged: ["src/foo.ts"], exitCode: 0 };
		pool.completeTask("t-1", result);
		const task = pool.getTask("t-1");
		expect(task!.status).toBe("done");
		expect(task!.result).toEqual(result);
		expect(task!.completedAt).toBeGreaterThan(0);
	});

	test("marks task failed when exitCode is non-zero", () => {
		pool.createIntent("i-1", "Intent", null, null);
		pool.createTask("t-1", "i-1", PAYLOAD, null, 300);
		pool.claimTask("worker-a");
		const result: TaskResult = { summary: "Crashed", filesChanged: [], exitCode: 1 };
		pool.completeTask("t-1", result);
		const task = pool.getTask("t-1");
		expect(task!.status).toBe("failed");
		expect(task!.result).toEqual(result);
	});
});

describe("resetTask", () => {
	test("resets a failed task back to pending", () => {
		pool.createIntent("i-1", "Intent", null, null);
		pool.createTask("t-1", "i-1", PAYLOAD, null, 300);
		pool.claimTask("worker-a");
		pool.completeTask("t-1", { summary: "Failed", filesChanged: [], exitCode: 1 });
		pool.resetTask("t-1");
		const task = pool.getTask("t-1");
		expect(task!.status).toBe("pending");
		expect(task!.claimedBy).toBeNull();
		expect(task!.claimedAt).toBeNull();
		expect(task!.result).toBeNull();
		expect(task!.completedAt).toBeNull();
	});
});

describe("listTasks", () => {
	test("returns all tasks when no filters", () => {
		pool.createIntent("i-1", "Intent", null, null);
		pool.createTask("t-1", "i-1", PAYLOAD, null, 300);
		pool.createTask("t-2", "i-1", PAYLOAD, null, 300);
		expect(pool.listTasks()).toHaveLength(2);
	});

	test("filters by intentId", () => {
		pool.createIntent("i-1", "Intent 1", null, null);
		pool.createIntent("i-2", "Intent 2", null, null);
		pool.createTask("t-1", "i-1", PAYLOAD, null, 300);
		pool.createTask("t-2", "i-2", PAYLOAD, null, 300);
		const tasks = pool.listTasks("i-1");
		expect(tasks).toHaveLength(1);
		expect(tasks[0]!.id).toBe("t-1");
	});

	test("filters by status", () => {
		pool.createIntent("i-1", "Intent", null, null);
		pool.createTask("t-1", "i-1", PAYLOAD, null, 300);
		pool.createTask("t-2", "i-1", PAYLOAD, null, 300);
		pool.claimTask("worker-a");
		const pending = pool.listTasks(undefined, "pending");
		expect(pending).toHaveLength(1);
		const claimed = pool.listTasks(undefined, "claimed");
		expect(claimed).toHaveLength(1);
		expect(claimed[0]!.status).toBe("claimed");
	});

	test("filters by both intentId and status", () => {
		pool.createIntent("i-1", "Intent 1", null, null);
		pool.createIntent("i-2", "Intent 2", null, null);
		pool.createTask("t-1", "i-1", PAYLOAD, null, 300);
		pool.createTask("t-2", "i-1", PAYLOAD, null, 300);
		pool.createTask("t-3", "i-2", PAYLOAD, null, 300);
		pool.claimTask("worker-a"); // claims t-1
		const result = pool.listTasks("i-1", "claimed");
		expect(result).toHaveLength(1);
		expect(result[0]!.id).toBe("t-1");
	});
});

describe("expireStale", () => {
	test("returns empty array when no stale tasks", () => {
		pool.createIntent("i-1", "Intent", null, null);
		pool.createTask("t-1", "i-1", PAYLOAD, null, 300);
		pool.claimTask("worker-a");
		// claimed_at is now, ttl is 300s — not yet expired
		expect(pool.expireStale()).toHaveLength(0);
	});

	test("resets tasks claimed beyond their TTL", () => {
		pool.createIntent("i-1", "Intent", null, null);
		pool.createTask("t-1", "i-1", PAYLOAD, null, 1); // 1-second TTL
		pool.claimTask("worker-a");

		// Manually back-date claimed_at to simulate expiry
		const db = (pool as unknown as { db: { exec: (s: string) => void } }).db;
		db.exec("UPDATE tasks SET claimed_at = claimed_at - 10 WHERE id = 't-1'");

		const expired = pool.expireStale();
		expect(expired).toHaveLength(1);
		expect(expired[0]!.id).toBe("t-1");
		expect(expired[0]!.status).toBe("pending");
		// Now claimable again
		const reclaimed = pool.claimTask("worker-b");
		expect(reclaimed).not.toBeNull();
	});
});

describe("stats", () => {
	test("returns zeros on empty pool", () => {
		const s = pool.stats();
		expect(s).toEqual({ total: 0, pending: 0, claimed: 0, done: 0, failed: 0 });
	});

	test("counts tasks by status", () => {
		pool.createIntent("i-1", "Intent", null, null);
		pool.createTask("t-1", "i-1", PAYLOAD, null, 300);
		pool.createTask("t-2", "i-1", PAYLOAD, null, 300);
		pool.createTask("t-3", "i-1", PAYLOAD, null, 300);
		pool.claimTask("worker-a"); // t-1 claimed
		pool.completeTask("t-1", { summary: "ok", filesChanged: [], exitCode: 0 }); // t-1 done
		pool.claimTask("worker-b"); // t-2 claimed
		pool.completeTask("t-2", { summary: "fail", filesChanged: [], exitCode: 1 }); // t-2 failed

		const s = pool.stats();
		expect(s.total).toBe(3);
		expect(s.done).toBe(1);
		expect(s.failed).toBe(1);
		expect(s.pending).toBe(1);
		expect(s.claimed).toBe(0);
	});

	test("filters stats by intentId", () => {
		pool.createIntent("i-1", "Intent 1", null, null);
		pool.createIntent("i-2", "Intent 2", null, null);
		pool.createTask("t-1", "i-1", PAYLOAD, null, 300);
		pool.createTask("t-2", "i-2", PAYLOAD, null, 300);
		const s1 = pool.stats("i-1");
		expect(s1.total).toBe(1);
		const s2 = pool.stats("i-2");
		expect(s2.total).toBe(1);
	});
});

describe("resetPool", () => {
	test("clears all intents and tasks", () => {
		pool.createIntent("i-1", "Intent", null, null);
		pool.createTask("t-1", "i-1", PAYLOAD, null, 300);
		pool.resetPool();
		expect(pool.listIntents()).toHaveLength(0);
		expect(pool.listTasks()).toHaveLength(0);
	});

	test("clears only the specified intent and its tasks", () => {
		pool.createIntent("i-1", "Intent 1", null, null);
		pool.createIntent("i-2", "Intent 2", null, null);
		pool.createTask("t-1", "i-1", PAYLOAD, null, 300);
		pool.createTask("t-2", "i-2", PAYLOAD, null, 300);
		pool.resetPool("i-1");
		expect(pool.listIntents()).toHaveLength(1);
		expect(pool.listIntents()[0]!.id).toBe("i-2");
		expect(pool.listTasks()).toHaveLength(1);
		expect(pool.listTasks()[0]!.id).toBe("t-2");
	});
});
