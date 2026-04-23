import type { MyceliumConfig } from "./types.ts";
import { DEFAULT_CONFIG } from "./types.ts";

const CONFIG_PATH = ".mycelium/config.yaml";

/** Minimal YAML serializer for flat/nested config */
function toYaml(obj: Record<string, unknown>, indent = 0): string {
	const lines: string[] = [];
	const pad = "  ".repeat(indent);
	for (const [key, val] of Object.entries(obj)) {
		if (val !== null && typeof val === "object" && !Array.isArray(val)) {
			lines.push(`${pad}${key}:`);
			lines.push(toYaml(val as Record<string, unknown>, indent + 1));
		} else if (Array.isArray(val)) {
			if (val.length === 0) {
				lines.push(`${pad}${key}: []`);
			} else {
				lines.push(`${pad}${key}:`);
				for (const item of val) {
					lines.push(`${pad}  - ${String(item)}`);
				}
			}
		} else {
			lines.push(`${pad}${key}: ${String(val)}`);
		}
	}
	return lines.join("\n");
}

/** Minimal YAML parser for flat/nested config */
function fromYaml(text: string): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	const stack: { obj: Record<string, unknown>; indent: number }[] = [{ obj: result, indent: -1 }];

	for (const line of text.split("\n")) {
		const trimmed = line.trimEnd();
		if (!trimmed || trimmed.startsWith("#")) continue;

		const indent = line.length - line.trimStart().length;
		const content = trimmed.trim();

		// Pop stack to find parent
		while (stack.length > 1 && stack[stack.length - 1]!.indent >= indent) {
			stack.pop();
		}
		const parent = stack[stack.length - 1]!.obj;

		if (content.startsWith("- ")) {
			// Array item — find the key in parent that's an array
			const lastKey = Object.keys(parent).pop();
			if (lastKey && Array.isArray(parent[lastKey])) {
				(parent[lastKey] as unknown[]).push(parseValue(content.slice(2)));
			}
		} else if (content.includes(": ")) {
			const colonIdx = content.indexOf(": ");
			const key = content.slice(0, colonIdx);
			const val = content.slice(colonIdx + 2);
			parent[key] = parseValue(val);
		} else if (content.endsWith(":")) {
			const key = content.slice(0, -1);
			const child: Record<string, unknown> = {};
			parent[key] = child;
			stack.push({ obj: child, indent });
		}
	}
	return result;
}

function parseValue(val: string): unknown {
	if (val === "true") return true;
	if (val === "false") return false;
	if (val === "null") return null;
	if (val === "[]") return [];
	if (/^-?\d+$/.test(val)) return Number.parseInt(val, 10);
	if (/^-?\d+\.\d+$/.test(val)) return Number.parseFloat(val);
	return val;
}

export function generateDefaultConfig(projectName: string): string {
	const config = { ...DEFAULT_CONFIG, project: { ...DEFAULT_CONFIG.project, name: projectName } };
	return toYaml(config as unknown as Record<string, unknown>);
}

export async function loadConfig(root: string): Promise<MyceliumConfig> {
	const path = `${root}/${CONFIG_PATH}`;
	const file = Bun.file(path);
	if (!(await file.exists())) {
		return DEFAULT_CONFIG;
	}
	const text = await file.text();
	const parsed = fromYaml(text);
	return deepMerge(
		DEFAULT_CONFIG as unknown as Record<string, unknown>,
		parsed,
	) as unknown as MyceliumConfig;
}

function deepMerge(
	defaults: Record<string, unknown>,
	overrides: Record<string, unknown>,
): Record<string, unknown> {
	const result = { ...defaults };
	for (const [key, val] of Object.entries(overrides)) {
		if (
			val !== null &&
			typeof val === "object" &&
			!Array.isArray(val) &&
			typeof defaults[key] === "object" &&
			defaults[key] !== null
		) {
			result[key] = deepMerge(
				defaults[key] as Record<string, unknown>,
				val as Record<string, unknown>,
			);
		} else {
			result[key] = val;
		}
	}
	return result;
}
