import type { Command } from "commander";
import { muted, outputJson, printError, printInfo, printSuccess } from "../output.ts";

async function runGit(
	args: string[],
	cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout: stdout.trim(), stderr: stderr.trim(), code };
}

export function register(program: Command): void {
	program
		.command("sync")
		.description("Stage and commit .mycelium/ changes")
		.option("--status", "Check without committing")
		.option("--dry-run", "Show what would be committed")
		.action(async (options: { status?: boolean; dryRun?: boolean }) => {
			const jsonMode = program.opts().json;
			const root = process.cwd();

			// Show staged/unstaged diff for .mycelium/
			if (options.status) {
				const diff = await runGit(["status", "--short", ".mycelium/"], root);
				if (jsonMode) {
					const hasChanges = diff.stdout.length > 0;
					outputJson({ success: true, command: "sync", hasChanges, status: diff.stdout });
				} else {
					if (diff.stdout) {
						console.log(diff.stdout);
					} else {
						printInfo("No changes in .mycelium/");
					}
				}
				return;
			}

			if (options.dryRun) {
				printInfo(muted("git add .mycelium/"));
				printInfo(muted("git commit -m 'chore: sync .mycelium/ state'"));
				if (jsonMode) {
					outputJson({ success: true, command: "sync", dryRun: true });
				}
				return;
			}

			// Stage .mycelium/
			const add = await runGit(["add", ".mycelium/"], root);
			if (add.code !== 0) {
				const msg = `git add failed: ${add.stderr}`;
				if (jsonMode) {
					outputJson({ success: false, command: "sync", error: msg });
				} else {
					printError(msg);
				}
				process.exitCode = 1;
				return;
			}

			// Check for staged changes
			const check = await runGit(["diff", "--cached", "--quiet"], root);
			if (check.code === 0) {
				// No staged changes
				if (jsonMode) {
					outputJson({
						success: true,
						command: "sync",
						committed: false,
						message: "Nothing to commit",
					});
				} else {
					printInfo("Nothing to commit — .mycelium/ is up to date");
				}
				return;
			}

			// Commit
			const commit = await runGit(["commit", "-m", "chore: sync .mycelium/ state"], root);
			if (commit.code !== 0) {
				const msg = `git commit failed: ${commit.stderr}`;
				if (jsonMode) {
					outputJson({ success: false, command: "sync", error: msg });
				} else {
					printError(msg);
				}
				process.exitCode = 1;
				return;
			}

			if (jsonMode) {
				outputJson({ success: true, command: "sync", committed: true });
			} else {
				printSuccess("Committed .mycelium/ changes");
			}
		});
}
