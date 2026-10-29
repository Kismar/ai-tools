import { combineUsage, type UsageStats } from "./subagent-runner.ts";

export interface AttemptSummary {
	readonly taskId: string;
	readonly attempt: number;
	readonly mode: "implement" | "correct";
	readonly status: "completed" | "blocked" | "failed" | "unknown";
	readonly usage: UsageStats;
	readonly model?: string;
	readonly contextWindow?: number;
	readonly commitHash?: string;
	readonly commitMessage?: string;
}

export interface CompletionInput {
	readonly overallStatus: "completed" | "partially-completed" | "blocked";
	readonly summary: string;
	readonly finalValidation: readonly string[];
	readonly deviations: readonly string[];
	readonly branch: string;
	readonly workingTreeClean: boolean;
	readonly taskCommitsCreated: number;
	readonly pushed: boolean;
}

export interface CompletionReportInput extends CompletionInput {
	readonly attempts: readonly AttemptSummary[];
	readonly taskIds: readonly string[];
	readonly orchestratorUsage: UsageStats;
	readonly orchestratorModels: readonly string[];
	readonly orchestratorContextWindow?: number;
}

const integer = (value: number): string => Math.round(value).toLocaleString("en-US");
const money = (value: number): string => `$${value.toFixed(6)}`;
const cell = (value: string): string => value.replaceAll("|", "\\|").replaceAll("\n", " ");

export const formatUsageLine = (
	usage: UsageStats,
	model?: string,
	contextWindow?: number,
): string => {
	const context = contextWindow
		? `${integer(usage.contextTokens)} / ${integer(contextWindow)}`
		: integer(usage.contextTokens);
	return [
		`Context: ${context}`,
		`Tokens In: ${integer(usage.input)}`,
		`Tokens Out: ${integer(usage.output)}`,
		`Cost: ${money(usage.cost)}`,
		...(model ? [`Model: ${model}`] : []),
	].join(" | ");
};

const successfulAttempts = (attempts: readonly AttemptSummary[]): Map<string, AttemptSummary> => {
	const latest = new Map<string, AttemptSummary>();
	for (const attempt of attempts) latest.set(attempt.taskId, attempt);
	return new Map(
		[...latest.entries()].filter(
			([, attempt]) => attempt.status === "completed" && Boolean(attempt.commitHash) && Boolean(attempt.commitMessage),
		),
	);
};

export const completedTaskIds = (attempts: readonly AttemptSummary[]): ReadonlySet<string> =>
	new Set(successfulAttempts(attempts).keys());

export const buildCompletionReport = (input: CompletionReportInput): string => {
	const attempts = input.attempts;
	const orchestratorModel = input.orchestratorModels.join(", ") || "unknown";
	const usageRows = attempts.map((attempt) => {
		const context = attempt.contextWindow
			? `${integer(attempt.usage.contextTokens)} / ${integer(attempt.contextWindow)}`
			: integer(attempt.usage.contextTokens);
		const commit = attempt.commitHash
			? `\`${attempt.commitHash}\` ${attempt.commitMessage ?? "message unavailable"}`
			: "None";
		return `| ${cell(`${attempt.taskId} #${attempt.attempt}`)} | ${attempt.mode} | ${attempt.status} | ${context} | ${integer(attempt.usage.input)} | ${integer(attempt.usage.output)} | ${money(attempt.usage.cost)} | ${cell(attempt.model ?? "unknown")} | ${commit} |`;
	});
	const orchestratorContext = input.orchestratorContextWindow
		? `${integer(input.orchestratorUsage.contextTokens)} / ${integer(input.orchestratorContextWindow)}`
		: integer(input.orchestratorUsage.contextTokens);
	usageRows.push(
		`| Orchestrator | coordinate | ${input.overallStatus} | ${orchestratorContext} | ${integer(input.orchestratorUsage.input)} | ${integer(input.orchestratorUsage.output)} | ${money(input.orchestratorUsage.cost)} | ${cell(orchestratorModel)} | N/A |`,
	);

	const total = combineUsage([...attempts.map((attempt) => attempt.usage), input.orchestratorUsage]);
	const finalCommits = successfulAttempts(attempts);
	const commitRows = input.taskIds.map((taskId) => {
		const attempt = finalCommits.get(taskId);
		return attempt
			? `| ${taskId} | \`${attempt.commitHash}\` | ${cell(attempt.commitMessage ?? "message unavailable")} |`
			: `| ${taskId} | None | No completed subagent report |`;
	});
	const validation = input.finalValidation.length > 0 ? input.finalValidation.map((item) => `- ${item}`).join("\n") : "- None";
	const deviations = input.deviations.length > 0 ? input.deviations.map((item) => `- ${item}`).join("\n") : "- None";

	return `# Task-plan implementation summary

## Overall status

${input.overallStatus}

${input.summary}

## Agent usage

| Agent | Work | Status | Context | Tokens In | Tokens Out | Cost | Model | Reported commit |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- |
${usageRows.join("\n")}

Context is the final reported context size. Token and cost values are cumulative for each agent.

**Combined tokens in:** ${integer(total.input)}  
**Combined tokens out:** ${integer(total.output)}  
**Combined cost:** ${money(total.cost)}

## Final task commits

| Task | Commit hash | Commit message |
| --- | --- | --- |
${commitRows.join("\n")}

## Final validation

${validation}

## Deviations and remaining concerns

${deviations}

## Repository state

- Branch: ${input.branch}
- Working tree clean: ${input.workingTreeClean ? "yes" : "no"}
- Task commits created: ${input.taskCommitsCreated}
- Pushed: ${input.pushed ? "yes" : "no"}
`;
};
