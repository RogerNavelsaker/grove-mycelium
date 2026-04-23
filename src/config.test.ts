import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateDefaultConfig, loadConfig } from "./config.ts";
import { DEFAULT_CONFIG } from "./types.ts";

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "mycelium-config-test-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("generateDefaultConfig", () => {
	test("produces a non-empty YAML string", () => {
		const yaml = generateDefaultConfig("my-project");
		expect(typeof yaml).toBe("string");
		expect(yaml.length).toBeGreaterThan(0);
	});

	test("includes the provided project name", () => {
		const yaml = generateDefaultConfig("my-project");
		expect(yaml).toContain("my-project");
	});

	test("serializes default pool settings", () => {
		const yaml = generateDefaultConfig("proj");
		expect(yaml).toContain(".mycelium/tasks.db");
		expect(yaml).toContain("300");
	});

	test("serializes boolean values as strings", () => {
		const yaml = generateDefaultConfig("proj");
		expect(yaml).toContain("true");
	});

	test("serializes empty arrays as []", () => {
		const yaml = generateDefaultConfig("proj");
		expect(yaml).toContain(": []");
	});
});

describe("loadConfig", () => {
	test("returns DEFAULT_CONFIG when .mycelium/config.yaml does not exist", async () => {
		const config = await loadConfig(tmpDir);
		expect(config).toEqual(DEFAULT_CONFIG);
	});

	test("returns DEFAULT_CONFIG when .mycelium/ directory does not exist", async () => {
		const config = await loadConfig(join(tmpDir, "nonexistent"));
		expect(config).toEqual(DEFAULT_CONFIG);
	});

	test("loads and merges a config file", async () => {
		const myceliumDir = join(tmpDir, ".mycelium");
		mkdirSync(myceliumDir, { recursive: true });
		writeFileSync(
			join(myceliumDir, "config.yaml"),
			"project:\n  name: loaded-project\n  root: .\n  canonicalBranch: main\n",
		);
		const config = await loadConfig(tmpDir);
		expect(config.project.name).toBe("loaded-project");
	});

	test("uses defaults for sections not in config file", async () => {
		const myceliumDir = join(tmpDir, ".mycelium");
		mkdirSync(myceliumDir, { recursive: true });
		writeFileSync(
			join(myceliumDir, "config.yaml"),
			"project:\n  name: partial-config\n  root: .\n  canonicalBranch: main\n",
		);
		const config = await loadConfig(tmpDir);
		// Pool section not in file — should use defaults
		expect(config.pool.database).toBe(DEFAULT_CONFIG.pool.database);
		expect(config.pool.defaultTtl).toBe(DEFAULT_CONFIG.pool.defaultTtl);
	});

	test("overrides deeply nested values from config file", async () => {
		const myceliumDir = join(tmpDir, ".mycelium");
		mkdirSync(myceliumDir, { recursive: true });
		writeFileSync(
			join(myceliumDir, "config.yaml"),
			"pool:\n  database: custom/tasks.db\n  defaultTtl: 600\n",
		);
		const config = await loadConfig(tmpDir);
		expect(config.pool.database).toBe("custom/tasks.db");
		expect(config.pool.defaultTtl).toBe(600);
	});

	test("parses boolean values correctly", async () => {
		const myceliumDir = join(tmpDir, ".mycelium");
		mkdirSync(myceliumDir, { recursive: true });
		writeFileSync(
			join(myceliumDir, "config.yaml"),
			"watcher:\n  pollInterval: 10\n  autoRedecompose: false\n",
		);
		const config = await loadConfig(tmpDir);
		expect(config.watcher.autoRedecompose).toBe(false);
	});

	test("round-trips generateDefaultConfig output", async () => {
		const yaml = generateDefaultConfig("round-trip-test");
		const myceliumDir = join(tmpDir, ".mycelium");
		mkdirSync(myceliumDir, { recursive: true });
		writeFileSync(join(myceliumDir, "config.yaml"), yaml);
		const config = await loadConfig(tmpDir);
		expect(config.project.name).toBe("round-trip-test");
		expect(config.pool.defaultTtl).toBe(DEFAULT_CONFIG.pool.defaultTtl);
		expect(config.workers.defaultCount).toBe(DEFAULT_CONFIG.workers.defaultCount);
	});
});
