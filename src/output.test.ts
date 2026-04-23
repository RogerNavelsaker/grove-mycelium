import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import {
	isQuiet,
	outputJson,
	printError,
	printInfo,
	printSuccess,
	printWarning,
	setQuiet,
} from "./output.ts";

beforeEach(() => {
	setQuiet(false);
});

afterEach(() => {
	setQuiet(false);
});

describe("setQuiet / isQuiet", () => {
	it("defaults to false", () => {
		expect(isQuiet()).toBe(false);
	});

	it("can be set to true", () => {
		setQuiet(true);
		expect(isQuiet()).toBe(true);
	});

	it("can be toggled back to false", () => {
		setQuiet(true);
		setQuiet(false);
		expect(isQuiet()).toBe(false);
	});
});

describe("outputJson", () => {
	it("writes pretty-printed JSON to stdout", () => {
		const spy = spyOn(console, "log").mockImplementation(() => {});
		outputJson({ foo: "bar", n: 42 });
		expect(spy).toHaveBeenCalledWith(JSON.stringify({ foo: "bar", n: 42 }, null, 2));
		spy.mockRestore();
	});
});

describe("printSuccess", () => {
	it("logs to stdout when not quiet", () => {
		const spy = spyOn(console, "log").mockImplementation(() => {});
		printSuccess("it worked");
		expect(spy).toHaveBeenCalledTimes(1);
		spy.mockRestore();
	});

	it("is silent when quiet", () => {
		setQuiet(true);
		const spy = spyOn(console, "log").mockImplementation(() => {});
		printSuccess("it worked");
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});
});

describe("printError", () => {
	it("always logs to stderr", () => {
		const spy = spyOn(console, "error").mockImplementation(() => {});
		printError("something broke");
		expect(spy).toHaveBeenCalledTimes(1);
		spy.mockRestore();
	});

	it("logs even when quiet mode is on", () => {
		setQuiet(true);
		const spy = spyOn(console, "error").mockImplementation(() => {});
		printError("always visible");
		expect(spy).toHaveBeenCalledTimes(1);
		spy.mockRestore();
	});
});

describe("printWarning", () => {
	it("logs to stdout", () => {
		const spy = spyOn(console, "log").mockImplementation(() => {});
		printWarning("heads up");
		expect(spy).toHaveBeenCalledTimes(1);
		spy.mockRestore();
	});
});

describe("printInfo", () => {
	it("logs to stdout when not quiet", () => {
		const spy = spyOn(console, "log").mockImplementation(() => {});
		printInfo("some info");
		expect(spy).toHaveBeenCalledTimes(1);
		spy.mockRestore();
	});

	it("is silent when quiet", () => {
		setQuiet(true);
		const spy = spyOn(console, "log").mockImplementation(() => {});
		printInfo("some info");
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});
});

// Ensure mock import doesn't leak
mock.restore();
