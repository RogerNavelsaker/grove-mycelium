import type { Command } from "commander";
import { VERSION } from "../index.ts";
import { brand, muted, outputJson, printError, printSuccess } from "../output.ts";

export function register(program: Command): void {
	program
		.command("upgrade")
		.description("Upgrade mycelium to latest version from npm")
		.option("--check", "Check for updates without installing")
		.action(async (options: { check?: boolean }) => {
			const jsonMode = program.opts().json;

			try {
				const proc = Bun.spawn(["npm", "view", "@os-eco/mycelium-cli", "version"], {
					stdout: "pipe",
					stderr: "pipe",
				});
				const output = await new Response(proc.stdout).text();
				const latest = output.trim();

				if (!latest) {
					if (jsonMode) {
						outputJson({ success: false, command: "upgrade", error: "Package not found on npm" });
					} else {
						printError("Package not yet published to npm");
					}
					return;
				}

				if (latest === VERSION) {
					if (jsonMode) {
						outputJson({
							success: true,
							command: "upgrade",
							current: VERSION,
							latest,
							upToDate: true,
						});
					} else {
						printSuccess(`Already on latest version (${VERSION})`);
					}
					return;
				}

				if (options.check) {
					if (jsonMode) {
						outputJson({
							success: true,
							command: "upgrade",
							current: VERSION,
							latest,
							upToDate: false,
						});
					} else {
						console.log(`${muted("Current:")} ${VERSION}  ${brand("Latest:")} ${latest}`);
					}
					return;
				}

				// Install latest
				const install = Bun.spawn(["bun", "add", "-g", `@os-eco/mycelium-cli@${latest}`], {
					stdout: "inherit",
					stderr: "inherit",
				});
				await install.exited;

				if (install.exitCode === 0) {
					if (jsonMode) {
						outputJson({ success: true, command: "upgrade", from: VERSION, to: latest });
					} else {
						printSuccess(`Upgraded ${VERSION} → ${latest}`);
					}
				} else {
					printError("Upgrade failed");
					process.exitCode = 1;
				}
			} catch {
				printError("Failed to check npm for updates");
				process.exitCode = 1;
			}
		});
}
