import assert from "node:assert/strict";
import test from "node:test";
import {
	correctionLimitReached,
	DEFAULT_SUBAGENT_LIMITS,
	MAX_CORRECTION_ATTEMPTS,
} from "./safeguards.ts";

test("uses finite limits for every subagent", () => {
	assert.deepEqual(DEFAULT_SUBAGENT_LIMITS, {
		wallClockTimeoutMs: 60 * 60 * 1_000,
		inactivityTimeoutMs: 10 * 60 * 1_000,
		maxTurns: 80,
	});
});

test("stops corrections after two attempts for one task", () => {
	const attempts = [
		{ taskId: "03-third", mode: "implement" },
		{ taskId: "03-third", mode: "correct" },
		{ taskId: "02-second", mode: "correct" },
	];
	assert.equal(MAX_CORRECTION_ATTEMPTS, 2);
	assert.equal(correctionLimitReached(attempts, "03-third"), false);
	assert.equal(
		correctionLimitReached([...attempts, { taskId: "03-third", mode: "correct" }], "03-third"),
		true,
	);
});
