/**
 * Merge queue engine for mycelium task branches.
 *
 * Manages ordered (FIFO) merging of completed task worktrees into the
 * canonical branch, with optional AI-assisted conflict resolution.
 */

import { mergeWorktree } from "./worktree.ts";

export interface MergeEntry {
	taskId: string;
	branch: string;
	status: "queued" | "merging" | "merged" | "conflict" | "failed";
	queuedAt: number;
	mergedAt?: number;
	commitSha?: string;
	error?: string;
}

export interface MergeConfig {
	aiResolveEnabled: boolean;
	reimagineEnabled: boolean;
}

async function git(
	args: string[],
	cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const exitCode = await proc.exited;
	return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

async function getConflictedFiles(repoRoot: string): Promise<string[]> {
	const { stdout, exitCode } = await git(["diff", "--name-only", "--diff-filter=U"], repoRoot);
	if (exitCode !== 0 || !stdout) return [];
	return stdout.split("\n").filter(Boolean);
}

function buildResolutionPrompt(filePath: string, conflictContent: string): string {
	return `You are resolving a git merge conflict.
File: ${filePath}

The file below contains git conflict markers (<<<<<<<, =======, >>>>>>>).
Produce the complete resolved file content — no conflict markers, no prose, no markdown fences.
Output ONLY the final file content.

${conflictContent}`;
}

async function resolveFileConflict(
	filePath: string,
	repoRoot: string,
	model: string,
): Promise<boolean> {
	try {
		const fullPath = `${repoRoot}/${filePath}`;
		const content = await Bun.file(fullPath).text();
		if (!content.includes("<<<<<<<")) return true; // already resolved

		const prompt = buildResolutionPrompt(filePath, content);
		const proc = Bun.spawn(["claude", "--print", "--model", model, prompt], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const [resolved] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		await proc.exited;

		if (proc.exitCode !== 0 || !resolved.trim()) return false;

		await Bun.write(fullPath, resolved);
		const { exitCode } = await git(["add", filePath], repoRoot);
		return exitCode === 0;
	} catch {
		return false;
	}
}

/**
 * Attempt AI-assisted conflict resolution on a merge that has failed.
 * Starts a fresh merge attempt (does NOT rely on existing merge state).
 */
async function attemptAIResolve(
	branch: string,
	canonicalBranch: string,
	repoRoot: string,
	model: string,
): Promise<{ success: boolean; commitSha?: string; error?: string }> {
	// Ensure we're on the canonical branch
	const checkout = await git(["checkout", canonicalBranch], repoRoot);
	if (checkout.exitCode !== 0) {
		return { success: false, error: `checkout failed: ${checkout.stderr}` };
	}

	// Attempt merge — expected to produce conflicts
	await git(["merge", "--no-ff", branch, "-m", `merge: task branch ${branch}`], repoRoot);

	// Check if we're in a conflicted merge state
	const mergeHead = await git(["rev-parse", "--verify", "MERGE_HEAD"], repoRoot);
	if (mergeHead.exitCode !== 0) {
		// No MERGE_HEAD — merge either succeeded cleanly or failed without conflict state
		const rev = await git(["rev-parse", "HEAD"], repoRoot);
		return { success: true, commitSha: rev.stdout };
	}

	const conflicted = await getConflictedFiles(repoRoot);
	if (conflicted.length === 0) {
		await git(["merge", "--abort"], repoRoot);
		return { success: false, error: "Merge conflict with no identifiable conflicted files" };
	}

	// Resolve each file with AI
	const results = await Promise.all(conflicted.map((f) => resolveFileConflict(f, repoRoot, model)));
	const failCount = results.filter((r) => !r).length;

	if (failCount > 0) {
		await git(["merge", "--abort"], repoRoot);
		return {
			success: false,
			error: `AI could not resolve ${failCount}/${conflicted.length} conflict(s)`,
		};
	}

	// Complete the merge commit
	const cont = await git(["merge", "--continue", "--no-edit"], repoRoot);
	if (cont.exitCode !== 0) {
		await git(["merge", "--abort"], repoRoot).catch(() => {});
		return { success: false, error: `merge --continue failed: ${cont.stderr}` };
	}

	const rev = await git(["rev-parse", "HEAD"], repoRoot);
	return { success: true, commitSha: rev.stdout };
}

/**
 * In-memory merge queue. Processes task branches into the canonical branch
 * in FIFO order. Supports optional AI-assisted conflict resolution.
 */
export class MergeQueue {
	private readonly entries: MergeEntry[] = [];
	private readonly repoRoot: string;
	private readonly canonicalBranch: string;
	private readonly config: MergeConfig;

	constructor(repoRoot: string, canonicalBranch: string, config: MergeConfig) {
		this.repoRoot = repoRoot;
		this.canonicalBranch = canonicalBranch;
		this.config = config;
	}

	/** Add a completed task branch to the queue. */
	enqueue(taskId: string, branch: string): MergeEntry {
		const entry: MergeEntry = {
			taskId,
			branch,
			status: "queued",
			queuedAt: Date.now(),
		};
		this.entries.push(entry);
		return entry;
	}

	/** Return all queue entries (snapshot). */
	list(): MergeEntry[] {
		return [...this.entries];
	}

	/** Look up a queue entry by task ID. Returns null if not found. */
	get(taskId: string): MergeEntry | null {
		return this.entries.find((e) => e.taskId === taskId) ?? null;
	}

	/**
	 * Process the next queued entry (oldest first — FIFO by queuedAt).
	 * Returns the processed entry, or null if the queue is empty.
	 */
	async processNext(): Promise<MergeEntry | null> {
		const entry = this.entries
			.filter((e) => e.status === "queued")
			.sort((a, b) => a.queuedAt - b.queuedAt)[0];

		if (!entry) return null;

		entry.status = "merging";

		try {
			// Fast path: attempt clean merge via worktree helper
			const result = await mergeWorktree(entry.branch, this.canonicalBranch, this.repoRoot);

			if (result.success) {
				entry.status = "merged";
				entry.mergedAt = Date.now();
				entry.commitSha = result.commitSha;
				return entry;
			}

			// Non-merge failure (checkout error, invalid branch, etc.) — not recoverable by AI
			if (result.error?.startsWith("checkout failed")) {
				entry.status = "failed";
				entry.error = result.error;
				return entry;
			}

			// Merge conflict path — mergeWorktree already aborted, so state is clean
			if (this.config.aiResolveEnabled) {
				const aiResult = await attemptAIResolve(
					entry.branch,
					this.canonicalBranch,
					this.repoRoot,
					"sonnet",
				);
				if (aiResult.success) {
					entry.status = "merged";
					entry.mergedAt = Date.now();
					entry.commitSha = aiResult.commitSha;
					return entry;
				}
				entry.status = "conflict";
				entry.error = aiResult.error;
			} else {
				entry.status = "conflict";
				entry.error = result.error;
			}
		} catch (err) {
			entry.status = "failed";
			entry.error = err instanceof Error ? err.message : String(err);
		}

		return entry;
	}

	/**
	 * Process all queued entries in FIFO order.
	 * Returns the list of processed entries.
	 */
	async processAll(): Promise<MergeEntry[]> {
		const processed: MergeEntry[] = [];
		while (true) {
			const entry = await this.processNext();
			if (!entry) break;
			processed.push(entry);
		}
		return processed;
	}
}
