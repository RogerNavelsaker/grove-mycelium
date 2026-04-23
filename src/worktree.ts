/**
 * Git worktree management for mycelium workers.
 * Each task gets an isolated worktree on its own branch.
 */

export interface WorktreeInfo {
	path: string;
	branch: string;
	commit: string;
}

export interface MergeResult {
	success: boolean;
	commitSha?: string;
	error?: string;
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

/**
 * Create a git worktree for a task.
 * Branch name: `mycelium/task-{taskId}`
 * Returns the absolute path of the new worktree.
 */
export async function createWorktree(
	taskId: string,
	baseDir: string,
	repoRoot: string,
): Promise<string> {
	const worktreePath = `${baseDir}/${taskId}`;
	const branch = `mycelium/task-${taskId}`;

	const { exitCode, stderr } = await git(["worktree", "add", "-b", branch, worktreePath], repoRoot);
	if (exitCode !== 0) {
		throw new Error(`git worktree add failed for task ${taskId}: ${stderr}`);
	}
	return worktreePath;
}

/**
 * Remove a git worktree and delete its branch.
 * Uses --force to handle unclean states.
 */
export async function removeWorktree(worktreePath: string, repoRoot: string): Promise<void> {
	const { exitCode, stderr } = await git(["worktree", "remove", "--force", worktreePath], repoRoot);
	if (exitCode !== 0) {
		throw new Error(`git worktree remove failed for ${worktreePath}: ${stderr}`);
	}
}

/**
 * List all git worktrees, returning parsed info objects.
 */
export async function listWorktrees(repoRoot: string): Promise<WorktreeInfo[]> {
	const { stdout, exitCode } = await git(["worktree", "list", "--porcelain"], repoRoot);
	if (exitCode !== 0 || !stdout) return [];

	const worktrees: WorktreeInfo[] = [];
	let current: Partial<WorktreeInfo> = {};

	for (const line of stdout.split("\n")) {
		if (line.startsWith("worktree ")) {
			if (current.path) worktrees.push(current as WorktreeInfo);
			current = { path: line.slice(9) };
		} else if (line.startsWith("HEAD ")) {
			current.commit = line.slice(5);
		} else if (line.startsWith("branch ")) {
			current.branch = line.slice(7).replace("refs/heads/", "");
		} else if (line === "") {
			if (current.path) {
				worktrees.push({
					path: current.path,
					branch: current.branch ?? "(detached)",
					commit: current.commit ?? "",
				});
				current = {};
			}
		}
	}
	if (current.path) {
		worktrees.push({
			path: current.path,
			branch: current.branch ?? "(detached)",
			commit: current.commit ?? "",
		});
	}

	return worktrees;
}

/**
 * Merge a task worktree's branch into the canonical branch.
 * Runs `git merge --no-ff` from the repo root.
 * Returns the merge commit SHA on success.
 */
export async function mergeWorktree(
	branch: string,
	canonicalBranch: string,
	repoRoot: string,
): Promise<MergeResult> {
	// Stash any in-progress state and switch to canonical branch
	const checkout = await git(["checkout", canonicalBranch], repoRoot);
	if (checkout.exitCode !== 0) {
		return { success: false, error: `checkout failed: ${checkout.stderr}` };
	}

	const merge = await git(
		["merge", "--no-ff", branch, "-m", `merge: task branch ${branch}`],
		repoRoot,
	);
	if (merge.exitCode !== 0) {
		// Abort the failed merge
		await git(["merge", "--abort"], repoRoot);
		return { success: false, error: `merge failed: ${merge.stderr}` };
	}

	// Get the resulting commit SHA
	const rev = await git(["rev-parse", "HEAD"], repoRoot);
	return { success: true, commitSha: rev.stdout };
}

/**
 * Delete a branch by name (used to clean up after merge).
 */
export async function deleteBranch(branch: string, repoRoot: string): Promise<void> {
	await git(["branch", "-D", branch], repoRoot);
}
