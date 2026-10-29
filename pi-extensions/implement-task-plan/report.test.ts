import assert from "node:assert/strict";
import test from "node:test";
import { buildCompletionReport, completedTaskIds, formatUsageLine, type AttemptSummary } from "./report.ts";
import { addUsage, emptyUsage, parseSubagentReport, toNestedUsage } from "./subagent-runner.ts";

const usage = {
	input: 1_200,
	output: 300,
	cacheRead: 400,
	cacheWrite: 50,
	costInput: 0.01,
	costOutput: 0.02,
	costCacheRead: 0.003,
	costCacheWrite: 0.004,
	cost: 0.037,
	contextTokens: 1_900,
	turns: 2,
};

const attempt: AttemptSummary = {
	taskId: "01-first",
	attempt: 1,
	mode: "implement",
	status: "completed",
	usage,
	model: "provider/model",
	contextWindow: 10_000,
	commitHash: "abcdef1234567",
	commitMessage: "feat(first): implement behavior",
};

test("parses the required subagent status and commit report", () => {
	const report = parseSubagentReport(`STATUS: completed

SUMMARY:
- Done.

COMMIT:
- Hash: abcdef1234567
- Message: feat(first): implement behavior
`);
	assert.deepEqual(report, {
		status: "completed",
		commitHash: "abcdef1234567",
		commitMessage: "feat(first): implement behavior",
	});
});

test("parses Markdown inline-code commit fields", () => {
	const report = parseSubagentReport(`STATUS: completed

COMMIT:
- Hash: \`71cf76c\`
- Message: \`refactor(frontend): extract presentation components\`
`);
	assert.deepEqual(report, {
		status: "completed",
		commitHash: "71cf76c",
		commitMessage: "refactor(frontend): extract presentation components",
	});
});

test("rejects a commit hash that is not hexadecimal", () => {
	const report = parseSubagentReport(`STATUS: completed

COMMIT:
- Hash: \`not-a-hash\`
- Message: feat: reported message
`);
	assert.deepEqual(report, {
		status: "completed",
		commitMessage: "feat: reported message",
	});
});

test("aggregates provider usage and returns nested usage", () => {
	const aggregate = addUsage(emptyUsage(), {
		input: 12,
		output: 4,
		cacheRead: 3,
		cacheWrite: 2,
		totalTokens: 21,
		cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
	});
	assert.equal(aggregate.contextTokens, 21);
	assert.equal(aggregate.cost, 10);
	assert.deepEqual(toNestedUsage(aggregate), {
		input: 12,
		output: 4,
		cacheRead: 3,
		cacheWrite: 2,
		totalTokens: 21,
		cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
	});
});

test("formats the requested transcript usage fields", () => {
	assert.equal(
		formatUsageLine(usage, "provider/model", 10_000),
		"Context: 1,900 / 10,000 | Tokens In: 1,200 | Tokens Out: 300 | Cost: $0.037000 | Model: provider/model",
	);
});

test("builds a final report with subagent, commit, and orchestrator values", () => {
	const markdown = buildCompletionReport({
		overallStatus: "completed",
		summary: "All work completed.",
		finalValidation: ["test: passed"],
		deviations: [],
		branch: "dev",
		workingTreeClean: true,
		taskCommitsCreated: 1,
		pushed: false,
		attempts: [attempt],
		taskIds: ["01-first"],
		orchestratorUsage: { ...usage, input: 2_000, output: 500 },
		orchestratorModels: ["provider/model"],
		orchestratorContextWindow: 10_000,
	});
	assert.match(markdown, /\| 01-first #1 \| implement \| completed \|/);
	assert.match(markdown, /\| Orchestrator \| coordinate \| completed \|/);
	assert.match(markdown, /abcdef1234567/);
	assert.match(markdown, /feat\(first\): implement behavior/);
	assert.match(markdown, /\*\*Combined tokens in:\*\* 3,200/);
	assert.deepEqual([...completedTaskIds([attempt])], ["01-first"]);
});

test("a failed correction makes the task incomplete", () => {
	const failedCorrection: AttemptSummary = {
		...attempt,
		attempt: 2,
		mode: "correct",
		status: "failed",
		commitHash: undefined,
		commitMessage: undefined,
	};
	assert.deepEqual([...completedTaskIds([attempt, failedCorrection])], []);
});
