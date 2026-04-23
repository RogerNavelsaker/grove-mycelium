import { existsSync } from "node:fs";
import type { Command } from "commander";
import { loadConfig } from "../config.ts";
import {
	accent,
	brand,
	muted,
	outputJson,
	printError,
	printInfo,
	printSuccess,
} from "../output.ts";
import { TaskPool } from "../pool.ts";
import type { TaskPayload } from "../types.ts";

// Shape returned by Claude decomposition
interface DecomposedTask {
	label?: string;
	description: string;
	fileScope: string[];
	context: string;
	acceptanceCriteria: string;
	hints?: string[];
	dependsOnLabels?: string[];
	isComplex?: boolean;
}

function shortId(): string {
	return Math.random().toString(36).slice(2, 10);
}

async function gatherWorkspaceContext(root: string, contextPaths: string[]): Promise<string> {
	if (contextPaths.length === 0) return "";
	const parts: string[] = [];
	for (const ctxPath of contextPaths) {
		const fullPath = ctxPath.startsWith("/") ? ctxPath : `${root}/${ctxPath}`;
		if (!existsSync(fullPath)) continue;
		const glob = new Bun.Glob("**/*");
		const files: string[] = [];
		for await (const file of glob.scan({ cwd: fullPath, onlyFiles: true })) {
			files.push(file);
		}
		if (files.length > 0) {
			parts.push(`${ctxPath}:\n${files.map((f) => `  ${f}`).join("\n")}`);
		}
	}
	return parts.join("\n\n");
}

function buildDecompositionPrompt(
	intent: string,
	workspaceContext: string,
	depth: number,
	maxDepth: number,
): string {
	const contextSection = workspaceContext
		? `\nWorkspace context (relevant files):\n${workspaceContext}\n`
		: "";

	return `You are a task decomposer for a multi-agent swarm system called Mycelium.

Your job: decompose the given intent into a list of atomic, independent, idempotent tasks that stateless workers can execute in parallel.

Intent: "${intent}"
${contextSection}
Rules:
- Each task must be atomic: completable by a single Claude Code session in one pass
- Maximize independence. Avoid unnecessary dependencies between tasks.
- File scope: each task touches as few files as possible
- If a task is too complex to be atomic AND depth ${depth} < ${maxDepth}, set isComplex: true
- Use "label" as a short local identifier for dependency references within this batch
- Use "dependsOnLabels" to reference labels of tasks that must complete first
- If depth ${depth} == ${maxDepth}, mark all tasks as atomic (isComplex: false)

Output ONLY a valid JSON array. No prose, no markdown, no explanation.

[
  {
    "label": "short-label",
    "description": "Clear, actionable task description",
    "fileScope": ["src/foo.ts"],
    "context": "Additional context the worker needs to execute this",
    "acceptanceCriteria": "How to know this task is complete",
    "hints": ["Optional hint"],
    "dependsOnLabels": [],
    "isComplex": false
  }
]`;
}

async function runClaude(prompt: string, model: string): Promise<string> {
	const proc = Bun.spawn(["claude", "--print", "--model", model, prompt], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [output, errText] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	await proc.exited;
	if (proc.exitCode !== 0) {
		throw new Error(`claude exited ${proc.exitCode}: ${errText.slice(0, 400)}`);
	}
	return output;
}

function extractJsonArray(text: string): DecomposedTask[] {
	// Find the outermost JSON array in the output
	const match = text.match(/\[[\s\S]*\]/);
	if (!match) {
		throw new Error(`No JSON array found in decomposer output. Got: ${text.slice(0, 200)}`);
	}
	const parsed: unknown = JSON.parse(match[0]);
	if (!Array.isArray(parsed)) {
		throw new Error("Decomposer output is not a JSON array");
	}
	return parsed as DecomposedTask[];
}

async function createSeedIntent(intent: string): Promise<string | null> {
	try {
		const proc = Bun.spawn(
			["sd", "create", "--title", intent, "--type", "feature", "--priority", "2"],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const out = await new Response(proc.stdout).text();
		await proc.exited;
		if (proc.exitCode !== 0) return null;
		// Seeds typically outputs the ID as the first token on the first line
		const match = out.match(/([a-z]+-[a-z0-9]{4})/);
		return match?.[1] ?? null;
	} catch {
		return null;
	}
}

async function decomposeRecursive(
	pool: TaskPool | null,
	intentId: string,
	intent: string,
	contextPaths: string[],
	root: string,
	depth: number,
	maxDepth: number,
	model: string,
	dryRun: boolean,
	ttl: number,
	parentDepIds: string[],
	verbose: boolean,
	allDryRunTasks: DecomposedTask[],
): Promise<string[]> {
	if (depth > maxDepth) return [];

	if (verbose) {
		printInfo(`Decomposing depth ${depth}: "${intent.slice(0, 80)}"`);
	}

	const workspaceContext = await gatherWorkspaceContext(root, contextPaths);
	const prompt = buildDecompositionPrompt(intent, workspaceContext, depth, maxDepth);

	let rawOutput: string;
	try {
		rawOutput = await runClaude(prompt, model);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		// If claude isn't available, provide a clear error
		if (msg.includes("No such file") || msg.includes("not found") || msg.includes("ENOENT")) {
			throw new Error(
				"claude CLI not found. Install Claude Code: https://docs.anthropic.com/claude-code",
			);
		}
		throw new Error(`Decomposition failed: ${msg}`);
	}

	let decomposed: DecomposedTask[];
	try {
		decomposed = extractJsonArray(rawOutput);
	} catch (err) {
		throw new Error(
			`Failed to parse decomposer output: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	// Assign IDs and build label map
	const labelToId = new Map<string, string>();
	const taskIds: string[] = decomposed.map((item) => {
		const id = `task-${shortId()}`;
		if (item.label) labelToId.set(item.label, id);
		return id;
	});

	const createdIds: string[] = [];

	for (const [i, item] of decomposed.entries()) {
		const id = taskIds[i] ?? `task-${shortId()}`;

		// Resolve dependency IDs from labels
		const depIds: string[] = [...parentDepIds];
		for (const depLabel of item.dependsOnLabels ?? []) {
			const depId = labelToId.get(depLabel);
			if (depId) depIds.push(depId);
		}

		if (item.isComplex && depth < maxDepth) {
			// Recurse on complex sub-task
			const subIds = await decomposeRecursive(
				pool,
				intentId,
				item.description,
				item.fileScope ?? contextPaths,
				root,
				depth + 1,
				maxDepth,
				model,
				dryRun,
				ttl,
				depIds,
				verbose,
				allDryRunTasks,
			);
			createdIds.push(...subIds);
		} else {
			const payload: TaskPayload = {
				description: item.description,
				fileScope: item.fileScope ?? [],
				context: item.context ?? "",
				acceptanceCriteria: item.acceptanceCriteria ?? "",
				...(item.hints ? { hints: item.hints } : {}),
			};

			if (dryRun) {
				allDryRunTasks.push({ ...item, label: id });
			} else if (pool) {
				pool.createTask(id, intentId, payload, depIds.length > 0 ? depIds : null, ttl);
			}
			createdIds.push(id);
		}
	}

	return createdIds;
}

export function register(program: Command): void {
	program
		.command("decompose")
		.argument("<intent>", "High-level goal to decompose into tasks")
		.description("Recursive decomposition of intent into atomic tasks")
		.option("--context <paths>", "Comma-separated paths to scope decomposer view")
		.option("--max-depth <n>", "Maximum recursion depth", "3")
		.option("--dry-run", "Show planned tasks without writing to pool")
		.option("--runtime <name>", "Runtime for decomposer instance", "claude")
		.option("--re-decompose <id>", "Re-decompose an existing intent by ID")
		.action(
			async (
				intent: string,
				options: {
					context?: string;
					maxDepth?: string;
					dryRun?: boolean;
					runtime?: string;
					reDecompose?: string;
				},
			) => {
				const jsonMode = program.opts().json;
				const verbose = program.opts().verbose ?? false;
				const root = process.cwd();

				// Require initialized .mycelium/
				if (!existsSync(`${root}/.mycelium/config.yaml`)) {
					if (jsonMode) {
						outputJson({
							success: false,
							command: "decompose",
							error: "Not initialized. Run mc init first.",
						});
					} else {
						printError("Not initialized. Run mc init first.");
					}
					process.exitCode = 1;
					return;
				}

				const config = await loadConfig(root);
				const maxDepth = Number.parseInt(options.maxDepth ?? "3", 10);
				const dryRun = options.dryRun ?? false;
				const model = config.decomposer.model;
				const contextPaths = options.context ? options.context.split(",").map((s) => s.trim()) : [];
				const pool = new TaskPool(`${root}/${config.pool.database}`);

				try {
					let intentId: string;
					let seedId: string | null = null;

					if (options.reDecompose) {
						// Re-decompose existing intent
						const existing = pool.getIntent(options.reDecompose);
						if (!existing) {
							if (jsonMode) {
								outputJson({
									success: false,
									command: "decompose",
									error: `Intent not found: ${options.reDecompose}`,
								});
							} else {
								printError(`Intent not found: ${options.reDecompose}`);
							}
							process.exitCode = 1;
							return;
						}
						intentId = existing.id;
						seedId = existing.seedId;
						if (!dryRun) {
							printInfo(`Re-decomposing intent ${intentId}`);
						}
					} else {
						// Create new intent
						intentId = `intent-${shortId()}`;

						// Create Seeds issue if enabled
						if (config.seeds.enabled && !dryRun) {
							seedId = await createSeedIntent(intent);
							if (verbose && seedId) {
								printInfo(`Created seed issue: ${seedId}`);
							}
						}

						if (!dryRun) {
							pool.createIntent(
								intentId,
								intent,
								seedId,
								contextPaths.length > 0 ? JSON.stringify(contextPaths) : null,
							);
						}
					}

					const allDryRunTasks: DecomposedTask[] = [];
					const taskIds = await decomposeRecursive(
						dryRun ? null : pool,
						intentId,
						intent,
						contextPaths,
						root,
						1,
						maxDepth,
						model,
						dryRun,
						config.pool.defaultTtl,
						[],
						verbose,
						allDryRunTasks,
					);

					if (jsonMode) {
						outputJson({
							success: true,
							command: "decompose",
							dryRun,
							intentId,
							seedId,
							taskCount: taskIds.length,
							taskIds: dryRun ? undefined : taskIds,
							tasks: dryRun ? allDryRunTasks : undefined,
						});
					} else if (dryRun) {
						console.log(
							`${brand("dry-run")} ${muted(`—`)} ${taskIds.length} tasks would be created\n`,
						);
						for (const t of allDryRunTasks) {
							console.log(`  ${accent(t.label ?? "?")}  ${t.description}`);
							if (t.fileScope?.length) {
								console.log(`    ${muted("files:")} ${t.fileScope.join(", ")}`);
							}
							if (t.dependsOnLabels?.length) {
								console.log(`    ${muted("deps:")}  ${t.dependsOnLabels.join(", ")}`);
							}
						}
					} else {
						printSuccess(
							`Decomposed into ${taskIds.length} task${taskIds.length === 1 ? "" : "s"}`,
						);
						console.log(`  ${muted("intent")}  ${accent(intentId)}`);
						if (seedId) console.log(`  ${muted("seed")}    ${accent(seedId)}`);
						console.log(`  ${muted("tasks")}   ${taskIds.length} pending`);
						console.log(`\nRun ${brand("mc spawn")} to start workers.`);
					}
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					if (jsonMode) {
						outputJson({ success: false, command: "decompose", error: msg });
					} else {
						printError(msg);
					}
					process.exitCode = 1;
				} finally {
					pool.close();
				}
			},
		);
}
