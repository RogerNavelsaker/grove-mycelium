import { Database } from "bun:sqlite";
import type { Intent, IntentStatus, Task, TaskPayload, TaskResult, TaskStatus } from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS intents (
  id            TEXT PRIMARY KEY,
  seed_id       TEXT,
  description   TEXT NOT NULL,
  context       TEXT,
  status        TEXT DEFAULT 'active',
  created_at    INTEGER NOT NULL,
  satisfied_at  INTEGER
);

CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  intent_id     TEXT NOT NULL REFERENCES intents(id),
  status        TEXT DEFAULT 'pending',
  payload       TEXT NOT NULL,
  result        TEXT,
  depends_on    TEXT,
  claimed_by    TEXT,
  claimed_at    INTEGER,
  ttl           INTEGER DEFAULT 300,
  retry_count   INTEGER DEFAULT 0,
  created_at    INTEGER NOT NULL,
  completed_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_intent ON tasks(intent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_claimed ON tasks(claimed_by) WHERE status = 'claimed';
`;

const CLAIM_QUERY = `
UPDATE tasks SET status = 'claimed', claimed_by = ?, claimed_at = ?
WHERE id = (
  SELECT id FROM tasks
  WHERE status = 'pending'
  AND (depends_on IS NULL OR NOT EXISTS (
    SELECT 1 FROM tasks AS dep
    WHERE dep.id IN (SELECT value FROM json_each(tasks.depends_on))
    AND dep.status != 'done'
  ))
  ORDER BY created_at ASC LIMIT 1
)
RETURNING *;
`;

const EXPIRE_QUERY = `
UPDATE tasks SET status = 'pending', claimed_by = NULL, claimed_at = NULL
WHERE status = 'claimed'
AND (unixepoch() - claimed_at) > ttl
RETURNING *;
`;

export class TaskPool {
	private db: Database;

	constructor(dbPath: string) {
		this.db = new Database(dbPath, { create: true });
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec("PRAGMA busy_timeout = 5000");
		this.db.exec(SCHEMA);
	}

	close(): void {
		this.db.close();
	}

	// --- Intents ---

	createIntent(
		id: string,
		description: string,
		seedId: string | null,
		context: string | null,
	): Intent {
		const now = Math.floor(Date.now() / 1000);
		this.db
			.prepare(
				"INSERT INTO intents (id, seed_id, description, context, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)",
			)
			.run(id, seedId, description, context, now);
		return {
			id,
			seedId,
			description,
			context,
			status: "active",
			createdAt: now,
			satisfiedAt: null,
		};
	}

	getIntent(id: string): Intent | null {
		const row = this.db.prepare("SELECT * FROM intents WHERE id = ?").get(id) as Record<
			string,
			unknown
		> | null;
		return row ? this.rowToIntent(row) : null;
	}

	updateIntentStatus(id: string, status: IntentStatus): void {
		const satisfiedAt = status === "satisfied" ? Math.floor(Date.now() / 1000) : null;
		this.db
			.prepare("UPDATE intents SET status = ?, satisfied_at = ? WHERE id = ?")
			.run(status, satisfiedAt, id);
	}

	listIntents(status?: IntentStatus): Intent[] {
		const query = status
			? "SELECT * FROM intents WHERE status = ? ORDER BY created_at DESC"
			: "SELECT * FROM intents ORDER BY created_at DESC";
		const rows = (
			status ? this.db.prepare(query).all(status) : this.db.prepare(query).all()
		) as Record<string, unknown>[];
		return rows.map((r) => this.rowToIntent(r));
	}

	// --- Tasks ---

	createTask(
		id: string,
		intentId: string,
		payload: TaskPayload,
		dependsOn: string[] | null,
		ttl: number,
	): Task {
		const now = Math.floor(Date.now() / 1000);
		const depsJson = dependsOn ? JSON.stringify(dependsOn) : null;
		this.db
			.prepare(
				"INSERT INTO tasks (id, intent_id, status, payload, depends_on, ttl, created_at) VALUES (?, ?, 'pending', ?, ?, ?, ?)",
			)
			.run(id, intentId, JSON.stringify(payload), depsJson, ttl, now);
		return {
			id,
			intentId,
			status: "pending",
			payload,
			result: null,
			dependsOn,
			claimedBy: null,
			claimedAt: null,
			ttl,
			retryCount: 0,
			createdAt: now,
			completedAt: null,
		};
	}

	claimTask(workerId: string): Task | null {
		const now = Math.floor(Date.now() / 1000);
		const row = this.db.prepare(CLAIM_QUERY).get(workerId, now) as Record<string, unknown> | null;
		return row ? this.rowToTask(row) : null;
	}

	completeTask(id: string, result: TaskResult): void {
		const now = Math.floor(Date.now() / 1000);
		const status: TaskStatus = result.exitCode === 0 ? "done" : "failed";
		this.db
			.prepare("UPDATE tasks SET status = ?, result = ?, completed_at = ? WHERE id = ?")
			.run(status, JSON.stringify(result), now, id);
	}

	resetTask(id: string): void {
		this.db
			.prepare(
				"UPDATE tasks SET status = 'pending', claimed_by = NULL, claimed_at = NULL, result = NULL, completed_at = NULL WHERE id = ?",
			)
			.run(id);
	}

	getTask(id: string): Task | null {
		const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Record<
			string,
			unknown
		> | null;
		return row ? this.rowToTask(row) : null;
	}

	listTasks(intentId?: string, status?: TaskStatus): Task[] {
		let query = "SELECT * FROM tasks WHERE 1=1";
		const params: unknown[] = [];
		if (intentId) {
			query += " AND intent_id = ?";
			params.push(intentId);
		}
		if (status) {
			query += " AND status = ?";
			params.push(status);
		}
		query += " ORDER BY created_at ASC";
		const rows = this.db.prepare(query).all(...(params as [string])) as Record<string, unknown>[];
		return rows.map((r) => this.rowToTask(r));
	}

	expireStale(): Task[] {
		const rows = this.db.prepare(EXPIRE_QUERY).all() as Record<string, unknown>[];
		return rows.map((r) => this.rowToTask(r));
	}

	// --- Stats ---

	stats(intentId?: string): {
		pending: number;
		claimed: number;
		done: number;
		failed: number;
		total: number;
	} {
		const where = intentId ? " WHERE intent_id = ?" : "";
		const params = intentId ? [intentId] : [];
		const row = this.db
			.prepare(
				`SELECT
					COUNT(*) as total,
					SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
					SUM(CASE WHEN status = 'claimed' THEN 1 ELSE 0 END) as claimed,
					SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done,
					SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
				FROM tasks${where}`,
			)
			.get(...params) as Record<string, number>;
		return {
			total: row.total ?? 0,
			pending: row.pending ?? 0,
			claimed: row.claimed ?? 0,
			done: row.done ?? 0,
			failed: row.failed ?? 0,
		};
	}

	resetPool(intentId?: string): void {
		if (intentId) {
			this.db.prepare("DELETE FROM tasks WHERE intent_id = ?").run(intentId);
			this.db.prepare("DELETE FROM intents WHERE id = ?").run(intentId);
		} else {
			this.db.exec("DELETE FROM tasks");
			this.db.exec("DELETE FROM intents");
		}
	}

	// --- Row mappers ---

	private rowToTask(row: Record<string, unknown>): Task {
		return {
			id: row.id as string,
			intentId: row.intent_id as string,
			status: row.status as TaskStatus,
			payload: JSON.parse(row.payload as string) as TaskPayload,
			result: row.result ? (JSON.parse(row.result as string) as TaskResult) : null,
			dependsOn: row.depends_on ? (JSON.parse(row.depends_on as string) as string[]) : null,
			claimedBy: row.claimed_by as string | null,
			claimedAt: row.claimed_at as number | null,
			ttl: row.ttl as number,
			retryCount: row.retry_count as number,
			createdAt: row.created_at as number,
			completedAt: row.completed_at as number | null,
		};
	}

	private rowToIntent(row: Record<string, unknown>): Intent {
		return {
			id: row.id as string,
			seedId: row.seed_id as string | null,
			description: row.description as string,
			context: row.context as string | null,
			status: row.status as IntentStatus,
			createdAt: row.created_at as number,
			satisfiedAt: row.satisfied_at as number | null,
		};
	}
}
