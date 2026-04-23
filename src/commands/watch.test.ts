import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TaskPool } from "../pool.ts";
import type { TaskPayload } from "../types.ts";
import type { WatchOptions } from "./watch.ts";
import { runWatchTick } from "./watch.ts";

const PAYLOAD: TaskPayload = {
	description: "test task",
	fileScope: [],
	context: "",
	acceptanceCriteria: "",
};

const BASE_OPTIONS: WatchOptions = {
	pollInterval: 10,
	autoRedecompose: false,
	seedsAutoClose: false,
	once: false,
	daemon: false,
	jsonMode: false,
	verbose: false,
	root: process.cwd(),
};

let pool: TaskPool;

beforeEach(() => {
	pool = new TaskPool(":memory:");
});

afterEach(() => {
	pool.close();
});

// --- TTL expiry ---

describe("TTL expiry", () => {
	test("returns empty expired list when no stale tasks", async () => {
		pool.createIntent("i1", "intent", null, null);
		pool.createTask("t1", "i1", PAYLOAD, null, 300);
		pool.claimTask("w1");

		const result = await runWatchTick(pool, BASE_OPTIONS, 1);
		expect(result.expired).toHaveLength(0);
	});

	test("expires claimed tasks past their TTL", async () => {
		pool.createIntent("i1", "intent", null, null);
		pool.createTask("t1", "i1", PAYLOAD, null, 1); // 1s TTL
		pool.claimTask("w1");

		// Backdate claimed_at to simulate expiry
		const db = (pool as unknown as { db: { exec: (s: string) => void } }).db;
		db.exec("UPDATE tasks SET claimed_at = claimed_at - 10 WHERE id = 't1'");

		const result = await runWatchTick(pool, BASE_OPTIONS, 1);
		expect(result.expired).toHaveLength(1);
		expect(result.expired).toContain("t1");

		// Task should be claimable again
		const reclaimed = pool.claimTask("w2");
		expect(reclaimed).not.toBeNull();
		expect(reclaimed?.id).toBe("t1");
	});

	test("expired tasks reset to pending status", async () => {
		pool.createIntent("i1", "intent", null, null);
		pool.createTask("t1", "i1", PAYLOAD, null, 1);
		pool.claimTask("w1");

		const db = (pool as unknown as { db: { exec: (s: string) => void } }).db;
		db.exec("UPDATE tasks SET claimed_at = claimed_at - 10 WHERE id = 't1'");

		await runWatchTick(pool, BASE_OPTIONS, 1);

		const task = pool.getTask("t1");
		expect(task?.status).toBe("pending");
		expect(task?.claimedBy).toBeNull();
		expect(task?.claimedAt).toBeNull();
	});
});

// --- Intent satisfaction ---

describe("intent satisfaction", () => {
	test("marks intent satisfied when all tasks are done", async () => {
		pool.createIntent("i1", "intent", null, null);
		pool.createTask("t1", "i1", PAYLOAD, null, 300);
		pool.claimTask("w1");
		pool.completeTask("t1", { summary: "done", filesChanged: [], exitCode: 0 });

		const result = await runWatchTick(pool, BASE_OPTIONS, 1);
		expect(result.satisfied).toContain("i1");

		const intent = pool.getIntent("i1");
		expect(intent?.status).toBe("satisfied");
	});

	test("marks all done tasks as satisfied in one tick", async () => {
		pool.createIntent("i1", "intent 1", null, null);
		pool.createIntent("i2", "intent 2", null, null);
		pool.createTask("t1", "i1", PAYLOAD, null, 300);
		pool.createTask("t2", "i2", PAYLOAD, null, 300);
		pool.claimTask("w1");
		pool.claimTask("w2");
		pool.completeTask("t1", { summary: "done", filesChanged: [], exitCode: 0 });
		pool.completeTask("t2", { summary: "done", filesChanged: [], exitCode: 0 });

		const result = await runWatchTick(pool, BASE_OPTIONS, 1);
		const ids = result.satisfied.slice().sort();
		expect(ids).toContain("i1");
		expect(ids).toContain("i2");
	});

	test("does not satisfy intent with pending tasks remaining", async () => {
		pool.createIntent("i1", "intent", null, null);
		pool.createTask("t1", "i1", PAYLOAD, null, 300);
		pool.createTask("t2", "i1", PAYLOAD, null, 300);
		pool.claimTask("w1");
		pool.completeTask("t1", { summary: "done", filesChanged: [], exitCode: 0 });

		const result = await runWatchTick(pool, BASE_OPTIONS, 1);
		expect(result.satisfied).toHaveLength(0);

		const intent = pool.getIntent("i1");
		expect(intent?.status).toBe("active");
	});

	test("does not satisfy intent with claimed tasks in progress", async () => {
		pool.createIntent("i1", "intent", null, null);
		pool.createTask("t1", "i1", PAYLOAD, null, 300);
		pool.claimTask("w1"); // t1 is now claimed, not done

		const result = await runWatchTick(pool, BASE_OPTIONS, 1);
		expect(result.satisfied).toHaveLength(0);
	});

	test("skips empty intents (no tasks)", async () => {
		pool.createIntent("i1", "empty intent", null, null);

		const result = await runWatchTick(pool, BASE_OPTIONS, 1);
		expect(result.satisfied).toHaveLength(0);

		const intent = pool.getIntent("i1");
		expect(intent?.status).toBe("active");
	});
});

// --- Seed auto-close ---

describe("seed auto-close", () => {
	test("returns empty closedSeeds when seedsAutoClose is false", async () => {
		pool.createIntent("i1", "intent", "seed-abc1", null);
		pool.createTask("t1", "i1", PAYLOAD, null, 300);
		pool.claimTask("w1");
		pool.completeTask("t1", { summary: "done", filesChanged: [], exitCode: 0 });

		const result = await runWatchTick(pool, { ...BASE_OPTIONS, seedsAutoClose: false }, 1);
		expect(result.satisfied).toContain("i1");
		expect(result.closedSeeds).toHaveLength(0);
	});

	test("returns empty closedSeeds when intent has no seedId", async () => {
		pool.createIntent("i1", "intent", null, null);
		pool.createTask("t1", "i1", PAYLOAD, null, 300);
		pool.claimTask("w1");
		pool.completeTask("t1", { summary: "done", filesChanged: [], exitCode: 0 });

		const result = await runWatchTick(pool, { ...BASE_OPTIONS, seedsAutoClose: true }, 1);
		expect(result.satisfied).toContain("i1");
		expect(result.closedSeeds).toHaveLength(0);
	});

	test("attempts to close seed when seedsAutoClose=true and seedId present", async () => {
		pool.createIntent("i1", "intent", "seed-abc1", null);
		pool.createTask("t1", "i1", PAYLOAD, null, 300);
		pool.claimTask("w1");
		pool.completeTask("t1", { summary: "done", filesChanged: [], exitCode: 0 });

		// sd close will fail in test env (no real seeds project), but closedSeeds tracks attempts
		const result = await runWatchTick(pool, { ...BASE_OPTIONS, seedsAutoClose: true }, 1);
		expect(result.satisfied).toContain("i1");
		expect(result.closedSeeds).toContain("seed-abc1");
	});

	test("closes multiple seeds when multiple intents are satisfied", async () => {
		pool.createIntent("i1", "intent 1", "seed-aaa1", null);
		pool.createIntent("i2", "intent 2", "seed-bbb2", null);
		pool.createTask("t1", "i1", PAYLOAD, null, 300);
		pool.createTask("t2", "i2", PAYLOAD, null, 300);
		pool.claimTask("w1");
		pool.claimTask("w2");
		pool.completeTask("t1", { summary: "done", filesChanged: [], exitCode: 0 });
		pool.completeTask("t2", { summary: "done", filesChanged: [], exitCode: 0 });

		const result = await runWatchTick(pool, { ...BASE_OPTIONS, seedsAutoClose: true }, 1);
		expect(result.satisfied).toContain("i1");
		expect(result.satisfied).toContain("i2");
		expect(result.closedSeeds).toContain("seed-aaa1");
		expect(result.closedSeeds).toContain("seed-bbb2");
	});

	test("does not attempt seed close for failed intents", async () => {
		pool.createIntent("i1", "intent", "seed-abc1", null);
		pool.createTask("t1", "i1", PAYLOAD, null, 300);
		pool.claimTask("w1");
		pool.completeTask("t1", { summary: "fail", filesChanged: [], exitCode: 1 });

		const result = await runWatchTick(pool, { ...BASE_OPTIONS, seedsAutoClose: true }, 1);
		expect(result.satisfied).toHaveLength(0);
		expect(result.closedSeeds).toHaveLength(0);
	});
});

// --- Failed intent detection ---

describe("failed intent detection", () => {
	test("marks intent failed when all tasks are failed and autoRedecompose=false", async () => {
		pool.createIntent("i1", "intent", null, null);
		pool.createTask("t1", "i1", PAYLOAD, null, 300);
		pool.claimTask("w1");
		pool.completeTask("t1", { summary: "fail", filesChanged: [], exitCode: 1 });

		const result = await runWatchTick(pool, { ...BASE_OPTIONS, autoRedecompose: false }, 1);

		// Not in satisfied list
		expect(result.satisfied).toHaveLength(0);
		// Not redecomposed (autoRedecompose off)
		expect(result.redecomposed).toHaveLength(0);
		// Intent status updated to failed to prevent re-detection
		const intent = pool.getIntent("i1");
		expect(intent?.status).toBe("failed");
	});

	test("detects stalled intent with mixed done/failed tasks", async () => {
		pool.createIntent("i1", "intent", null, null);
		pool.createTask("t1", "i1", PAYLOAD, null, 300);
		pool.createTask("t2", "i1", PAYLOAD, null, 300);
		pool.claimTask("w1");
		pool.claimTask("w2");
		pool.completeTask("t1", { summary: "done", filesChanged: [], exitCode: 0 });
		pool.completeTask("t2", { summary: "fail", filesChanged: [], exitCode: 1 });

		const result = await runWatchTick(pool, { ...BASE_OPTIONS, autoRedecompose: false }, 1);

		// All terminal, at least one failed → mark failed
		const intent = pool.getIntent("i1");
		expect(intent?.status).toBe("failed");
		expect(result.satisfied).toHaveLength(0);
	});

	test("does not mark intent failed when pending tasks remain", async () => {
		pool.createIntent("i1", "intent", null, null);
		pool.createTask("t1", "i1", PAYLOAD, null, 300);
		pool.createTask("t2", "i1", PAYLOAD, null, 300);
		pool.claimTask("w1");
		pool.completeTask("t1", { summary: "fail", filesChanged: [], exitCode: 1 });
		// t2 is still pending

		await runWatchTick(pool, { ...BASE_OPTIONS, autoRedecompose: false }, 1);

		const intent = pool.getIntent("i1");
		expect(intent?.status).toBe("active");
	});

	test("does not mark intent failed when claimed tasks in progress", async () => {
		pool.createIntent("i1", "intent", null, null);
		pool.createTask("t1", "i1", PAYLOAD, null, 300);
		pool.createTask("t2", "i1", PAYLOAD, null, 300);
		pool.claimTask("w1");
		pool.completeTask("t1", { summary: "fail", filesChanged: [], exitCode: 1 });
		pool.claimTask("w2"); // t2 claimed

		await runWatchTick(pool, { ...BASE_OPTIONS, autoRedecompose: false }, 1);

		const intent = pool.getIntent("i1");
		expect(intent?.status).toBe("active");
	});
});

// --- Stats accuracy ---

describe("stats accuracy", () => {
	test("returns global stats across all intents", async () => {
		pool.createIntent("i1", "intent 1", null, null);
		pool.createIntent("i2", "intent 2", null, null);
		pool.createTask("t1", "i1", PAYLOAD, null, 300);
		pool.createTask("t2", "i1", PAYLOAD, null, 300);
		pool.createTask("t3", "i2", PAYLOAD, null, 300);
		pool.claimTask("w1"); // t1 claimed
		pool.completeTask("t1", { summary: "ok", filesChanged: [], exitCode: 0 }); // t1 done
		pool.claimTask("w2"); // t2 claimed
		pool.completeTask("t2", { summary: "fail", filesChanged: [], exitCode: 1 }); // t2 failed

		const result = await runWatchTick(pool, BASE_OPTIONS, 1);

		expect(result.stats.total).toBe(3);
		expect(result.stats.done).toBe(1);
		expect(result.stats.failed).toBe(1);
		expect(result.stats.pending).toBe(1);
		expect(result.stats.claimed).toBe(0);
	});

	test("returns zero stats on empty pool", async () => {
		const result = await runWatchTick(pool, BASE_OPTIONS, 1);
		expect(result.stats).toEqual({ total: 0, pending: 0, claimed: 0, done: 0, failed: 0 });
	});

	test("includes tick number and timestamp in result", async () => {
		const result = await runWatchTick(pool, BASE_OPTIONS, 42);
		expect(result.tick).toBe(42);
		expect(typeof result.timestamp).toBe("string");
		expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});
});

// --- Multiple intents, independent handling ---

describe("multiple intents", () => {
	test("handles satisfied and failed intents in the same tick", async () => {
		// Intent 1: all done → satisfied
		pool.createIntent("i1", "intent 1", null, null);
		pool.createTask("t1", "i1", PAYLOAD, null, 300);
		pool.claimTask("w1");
		pool.completeTask("t1", { summary: "done", filesChanged: [], exitCode: 0 });

		// Intent 2: all failed → mark failed
		pool.createIntent("i2", "intent 2", null, null);
		pool.createTask("t2", "i2", PAYLOAD, null, 300);
		pool.claimTask("w2");
		pool.completeTask("t2", { summary: "fail", filesChanged: [], exitCode: 1 });

		const result = await runWatchTick(pool, { ...BASE_OPTIONS, autoRedecompose: false }, 1);

		expect(result.satisfied).toContain("i1");
		expect(result.satisfied).not.toContain("i2");

		const i1 = pool.getIntent("i1");
		const i2 = pool.getIntent("i2");
		expect(i1?.status).toBe("satisfied");
		expect(i2?.status).toBe("failed");
	});
});
