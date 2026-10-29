import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";
import { runSubagent } from "./subagent-runner.ts";

const runScript = (script: string, limits: { wallClockTimeoutMs: number; inactivityTimeoutMs: number; maxTurns: number }) =>
	runSubagent({
		cwd: tmpdir(),
		systemPrompt: "test",
		limits,
		invocationOverride: { command: process.execPath, args: ["-e", script] },
	});

test("terminates a subagent after the inactivity limit", async () => {
	const result = await runScript("setInterval(() => {}, 1000)", {
		wallClockTimeoutMs: 2_000,
		inactivityTimeoutMs: 300,
		maxTurns: 10,
	});
	assert.equal(result.aborted, true);
	assert.equal(result.limitReason, "inactivity-timeout");
});

test("terminates an active subagent after the wall-clock limit", async () => {
	const result = await runScript("setInterval(() => console.log('active'), 25)", {
		wallClockTimeoutMs: 300,
		inactivityTimeoutMs: 2_000,
		maxTurns: 10,
	});
	assert.equal(result.aborted, true);
	assert.equal(result.limitReason, "wall-clock-timeout");
});

test("terminates a subagent that requests tools at the turn limit", async () => {
	const event = JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content: [],
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
		},
	});
	const script = `console.log(${JSON.stringify(event)}); setInterval(() => {}, 1000)`;
	const result = await runScript(script, {
		wallClockTimeoutMs: 2_000,
		inactivityTimeoutMs: 2_000,
		maxTurns: 1,
	});
	assert.equal(result.aborted, true);
	assert.equal(result.limitReason, "turn-limit");
	assert.equal(result.usage.turns, 1);
});
