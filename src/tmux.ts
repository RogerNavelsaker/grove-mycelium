/**
 * Thin wrapper around the tmux CLI.
 * All functions spawn tmux as a subprocess and return results.
 */

async function run(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(["tmux", ...args], {
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

/** Check if a named tmux session exists. */
export async function hasSession(name: string): Promise<boolean> {
	const { exitCode } = await run(["has-session", "-t", name]);
	return exitCode === 0;
}

/**
 * Create a new detached tmux session.
 * Throws if the session already exists.
 */
export async function createSession(name: string, dir: string): Promise<void> {
	const { exitCode, stderr } = await run(["new-session", "-d", "-s", name, "-c", dir]);
	if (exitCode !== 0) {
		throw new Error(`tmux new-session failed: ${stderr}`);
	}
}

/** Kill a tmux session by name. No-ops if session does not exist. */
export async function killSession(name: string): Promise<void> {
	const exists = await hasSession(name);
	if (!exists) return;
	const { exitCode, stderr } = await run(["kill-session", "-t", name]);
	if (exitCode !== 0) {
		throw new Error(`tmux kill-session failed: ${stderr}`);
	}
}

/**
 * Send keystrokes to the first pane of a tmux session.
 * Appends Enter unless `noEnter` is true.
 */
export async function sendKeys(session: string, keys: string, noEnter = false): Promise<void> {
	const args = ["send-keys", "-t", session, keys];
	if (!noEnter) args.push("Enter");
	const { exitCode, stderr } = await run(args);
	if (exitCode !== 0) {
		throw new Error(`tmux send-keys failed: ${stderr}`);
	}
}

/** Capture the current text content of a tmux pane. */
export async function capturePane(session: string): Promise<string> {
	const { stdout, exitCode, stderr } = await run(["capture-pane", "-t", session, "-p"]);
	if (exitCode !== 0) {
		throw new Error(`tmux capture-pane failed: ${stderr}`);
	}
	return stdout;
}

/**
 * List all tmux session names, optionally filtered by a prefix.
 * Returns an empty array if tmux is not running or has no sessions.
 */
export async function listSessions(prefix?: string): Promise<string[]> {
	const { stdout, exitCode } = await run(["list-sessions", "-F", "#{session_name}"]);
	if (exitCode !== 0) {
		// tmux exits non-zero when no sessions exist
		return [];
	}
	const names = stdout.split("\n").filter(Boolean);
	if (prefix) {
		return names.filter((n) => n.startsWith(prefix));
	}
	return names;
}
