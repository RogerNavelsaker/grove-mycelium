import chalk from "chalk";

// Forest palette — deep purple/violet (mycelium underground network)
export const brand = chalk.rgb(138, 92, 168);
export const accent = chalk.rgb(255, 183, 77);
export const muted = chalk.rgb(120, 120, 110);

let _quiet = false;

export function setQuiet(v: boolean): void {
	_quiet = v;
}

export function isQuiet(): boolean {
	return _quiet;
}

export function outputJson(data: unknown): void {
	console.log(JSON.stringify(data, null, 2));
}

export function printSuccess(msg: string): void {
	if (_quiet) return;
	console.log(`${brand("\u2713")} ${brand(msg)}`);
}

export function printError(msg: string): void {
	console.error(`${chalk.red("\u2717")} ${msg}`);
}

export function printWarning(msg: string): void {
	console.log(`${chalk.yellow("!")} ${msg}`);
}

export function printInfo(msg: string): void {
	if (_quiet) return;
	console.log(`${muted("-")} ${msg}`);
}
