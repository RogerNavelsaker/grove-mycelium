// --- Task Pool ---

export type TaskStatus = "pending" | "claimed" | "done" | "failed";
export type IntentStatus = "active" | "satisfied" | "failed";

export interface Task {
	id: string;
	intentId: string;
	status: TaskStatus;
	payload: TaskPayload;
	result: TaskResult | null;
	dependsOn: string[] | null;
	claimedBy: string | null;
	claimedAt: number | null;
	ttl: number;
	retryCount: number;
	createdAt: number;
	completedAt: number | null;
}

export interface TaskPayload {
	description: string;
	fileScope: string[];
	context: string;
	acceptanceCriteria: string;
	hints?: string[];
}

export interface TaskResult {
	summary: string;
	filesChanged: string[];
	commitSha?: string;
	errors?: string[];
	exitCode: number;
}

export interface Intent {
	id: string;
	seedId: string | null;
	description: string;
	context: string | null;
	status: IntentStatus;
	createdAt: number;
	satisfiedAt: number | null;
}

// --- Configuration ---

export interface MyceliumConfig {
	project: {
		name: string;
		root: string;
		canonicalBranch: string;
	};
	pool: {
		database: string;
		defaultTtl: number;
	};
	decomposer: {
		maxDepth: number;
		runtime: string;
		model: string;
	};
	workers: {
		defaultCount: number;
		runtime: string;
		model: string;
		idleTimeout: number;
		pollInterval: number;
		maxRetries: number;
	};
	watcher: {
		pollInterval: number;
		autoRedecompose: boolean;
	};
	worktrees: {
		baseDir: string;
	};
	merge: {
		aiResolveEnabled: boolean;
		reimagineEnabled: boolean;
	};
	mulch: {
		enabled: boolean;
		domains: string[];
	};
	seeds: {
		enabled: boolean;
		autoClose: boolean;
	};
	runtime: {
		default: string;
		capabilities: Record<string, string>;
	};
}

export const DEFAULT_CONFIG: MyceliumConfig = {
	project: {
		name: "",
		root: ".",
		canonicalBranch: "main",
	},
	pool: {
		database: ".mycelium/tasks.db",
		defaultTtl: 300,
	},
	decomposer: {
		maxDepth: 3,
		runtime: "claude",
		model: "opus",
	},
	workers: {
		defaultCount: 3,
		runtime: "claude",
		model: "sonnet",
		idleTimeout: 60,
		pollInterval: 5,
		maxRetries: 2,
	},
	watcher: {
		pollInterval: 10,
		autoRedecompose: true,
	},
	worktrees: {
		baseDir: ".mycelium/worktrees",
	},
	merge: {
		aiResolveEnabled: true,
		reimagineEnabled: false,
	},
	mulch: {
		enabled: true,
		domains: [],
	},
	seeds: {
		enabled: true,
		autoClose: true,
	},
	runtime: {
		default: "claude",
		capabilities: {},
	},
};
