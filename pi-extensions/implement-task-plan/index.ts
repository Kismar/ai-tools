import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	getMarkdownTheme,
	isToolCallEventType,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	captureGitSnapshot,
	inspectRepository,
	verifyFinalCommitSequence,
	verifyReportedCommit,
} from "./git.ts";
import { isOrchestratorShellCommandAllowed } from "./guards.ts";
import {
	loadTaskPlan,
	parsePlanCommandArguments,
	resolveStartTaskId,
	type PlanLoadFailureReason,
	type TaskPlan,
} from "./plan.ts";
import {
	buildCompletionReport,
	completedTaskIds,
	formatUsageLine,
	type AttemptSummary,
	type CompletionInput,
} from "./report.ts";
import { correctionLimitReached, MAX_CORRECTION_ATTEMPTS } from "./safeguards.ts";
import {
	addUsage,
	emptyUsage,
	runSubagent,
	toNestedUsage,
	type UsageStats,
} from "./subagent-runner.ts";

const STATE_ENTRY = "implement-task-plan-state";
const RUN_TOOL = "implement_plan_subtask";
const FINISH_TOOL = "finish_plan_implementation";
const WORKFLOW_TOOLS = new Set([RUN_TOOL, FINISH_TOOL]);
const ORCHESTRATOR_TOOLS = new Set(["read", "grep", "find", "ls", "bash", RUN_TOOL, FINISH_TOOL]);

type StoredAttempt = AttemptSummary;

interface WorkflowState {
	readonly version: 1;
	readonly active: boolean;
	readonly planPath: string;
	readonly planDigest: string;
	readonly startTaskId: string;
	readonly startBranch: string;
	readonly expectedHead: string;
	readonly repositorySafe: boolean;
	readonly attempts: readonly StoredAttempt[];
	readonly orchestratorUsage: UsageStats;
	readonly orchestratorModels: readonly string[];
	readonly orchestratorContextWindow?: number;
}

interface RunDetails extends StoredAttempt {
	readonly output: string;
	readonly stderr: string;
}

interface FinishDetails {
	readonly markdown: string;
}

const initialState = (): WorkflowState => ({
	version: 1,
	active: false,
	planPath: "",
	planDigest: "",
	startTaskId: "",
	startBranch: "",
	expectedHead: "",
	repositorySafe: true,
	attempts: [],
	orchestratorUsage: emptyUsage(),
	orchestratorModels: [],
});

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const parseUsage = (value: unknown): UsageStats | undefined => {
	if (!isRecord(value)) return undefined;
	const fields = [
		"input",
		"output",
		"cacheRead",
		"cacheWrite",
		"costInput",
		"costOutput",
		"costCacheRead",
		"costCacheWrite",
		"cost",
		"contextTokens",
		"turns",
	] as const;
	if (
		fields.some(
			(field) => typeof value[field] !== "number" || !Number.isFinite(value[field]) || Number(value[field]) < 0,
		)
	) {
		return undefined;
	}
	return Object.fromEntries(fields.map((field) => [field, value[field]])) as unknown as UsageStats;
};

const parseAttempt = (value: unknown): StoredAttempt | undefined => {
	if (!isRecord(value) || typeof value.taskId !== "string" || typeof value.attempt !== "number") return undefined;
	if (value.mode !== "implement" && value.mode !== "correct") return undefined;
	if (!["completed", "blocked", "failed", "unknown"].includes(String(value.status))) return undefined;
	const usage = parseUsage(value.usage);
	if (!usage) return undefined;
	return {
		taskId: value.taskId,
		attempt: value.attempt,
		mode: value.mode,
		status: value.status as StoredAttempt["status"],
		usage,
		...(typeof value.model === "string" ? { model: value.model } : {}),
		...(typeof value.contextWindow === "number" ? { contextWindow: value.contextWindow } : {}),
		...(typeof value.commitHash === "string" ? { commitHash: value.commitHash } : {}),
		...(typeof value.commitMessage === "string" ? { commitMessage: value.commitMessage } : {}),
	};
};

const parseState = (value: unknown): WorkflowState | undefined => {
	if (!isRecord(value) || value.version !== 1 || typeof value.active !== "boolean") return undefined;
	if (
		typeof value.planPath !== "string" ||
		typeof value.planDigest !== "string" ||
		typeof value.startBranch !== "string" ||
		typeof value.expectedHead !== "string" ||
		typeof value.repositorySafe !== "boolean" ||
		!Array.isArray(value.attempts)
	) {
		return undefined;
	}
	const attempts = value.attempts.map(parseAttempt);
	if (attempts.some((attempt) => !attempt)) return undefined;
	const orchestratorUsage = parseUsage(value.orchestratorUsage);
	if (!orchestratorUsage || !Array.isArray(value.orchestratorModels)) return undefined;
	if (!value.orchestratorModels.every((model) => typeof model === "string")) return undefined;
	return {
		version: 1,
		active: value.active,
		planPath: value.planPath,
		planDigest: value.planDigest,
		startTaskId: typeof value.startTaskId === "string" ? value.startTaskId : "",
		startBranch: value.startBranch,
		expectedHead: value.expectedHead,
		repositorySafe: value.repositorySafe,
		attempts: attempts as StoredAttempt[],
		orchestratorUsage,
		orchestratorModels: value.orchestratorModels,
		...(typeof value.orchestratorContextWindow === "number"
			? { orchestratorContextWindow: value.orchestratorContextWindow }
			: {}),
	};
};

const failureMessage = (reason: PlanLoadFailureReason): string => {
	const messages: Record<PlanLoadFailureReason, string> = {
		"missing-path": "Supply a Grill Task plan folder.",
		"not-directory": "The supplied plan path is not a folder.",
		"missing-plan-file": "The folder does not contain a complete Grill Task plan.",
		"invalid-task-folder": "The plan has an invalid task folder.",
		"invalid-task-order": "Task folders must use contiguous dependency order.",
		"missing-section": "A plan file does not contain all required sections.",
		"invalid-dependency": "A task dependency is unknown or does not precede its task.",
		"too-large": "The plan exceeds the Grill Task size limit.",
		io: "Pi could not read the plan folder.",
	};
	return messages[reason];
};

const fillSubagentPrompt = (
	template: string,
	task: TaskPlan["tasks"][number],
	params: {
		architectureSummary: string;
		repositoryContext: string;
		prerequisiteOutputs: string;
		validationCommands: readonly string[];
		mode: "implement" | "correct";
		reviewFindings?: string;
		priorTaskCommit?: string;
	},
): string => {
	const correction =
		params.mode === "correct"
			? params.priorTaskCommit
				? `This is a correction attempt. Review findings:\n\n${params.reviewFindings?.trim() || "No findings supplied."}\n\nCorrect only this task. The verified prior task commit is ${params.priorTaskCommit}. Amend it only if it is still HEAD. Report the new hash.`
				: `This is a correction attempt after an attempt that made no verified commit. Review findings:\n\n${params.reviewFindings?.trim() || "No findings supplied."}\n\nCorrect only this task. Create one new task commit.`
			: "This is the initial implementation attempt. Do not amend an existing commit.";
	return template
		.replaceAll("{{TASK_MD_CONTENT}}", task.taskMarkdown.trim())
		.replaceAll("{{IMPLEMENTATION_GUIDE_CONTENT}}", task.implementationGuideMarkdown.trim())
		.replaceAll("{{RELEVANT_ARCHITECTURE_SUMMARY}}", params.architectureSummary.trim() || "None.")
		.replaceAll("{{RELEVANT_REPOSITORY_CONTEXT}}", params.repositoryContext.trim() || "None.")
		.replaceAll("{{PREREQUISITE_OUTPUTS}}", params.prerequisiteOutputs.trim() || "None.")
		.replaceAll(
			"{{EXPECTED_VALIDATION_COMMANDS}}",
			params.validationCommands.length > 0
				? params.validationCommands.map((command) => `- ${command}`).join("\n")
				: "- Use the verification commands from the assigned task.",
		)
		.replaceAll("{{CORRECTION_INSTRUCTIONS}}", correction);
};

const tasksInScope = (plan: TaskPlan, startTaskId: string): readonly TaskPlan["tasks"][number][] => {
	const startIndex = plan.tasks.findIndex((task) => task.id === startTaskId);
	return plan.tasks.slice(startIndex < 0 ? 0 : startIndex);
};

const workflowPrompt = (template: string, plan: TaskPlan, startTaskId: string): string => {
	const scopedTasks = tasksInScope(plan, startTaskId);
	const index = scopedTasks
		.map((task) => `- ${task.id}: dependencies ${task.dependencies.length > 0 ? task.dependencies.join(", ") : "None"}`)
		.join("\n");
	return `${template.trim()}\n\n## Active plan\n\nPlan folder: ${plan.folder}\nExecution starts at: ${scopedTasks[0]?.id ?? "no task"}\nTasks before this point are outside the execution scope and count as satisfied prerequisites.\n\nTask index:\n${index}`;
};

const successfulTaskAttempt = (state: WorkflowState, taskId: string): StoredAttempt | undefined =>
	[...state.attempts]
		.reverse()
		.find(
			(attempt) =>
				attempt.taskId === taskId &&
				attempt.status === "completed" &&
				Boolean(attempt.commitHash) &&
				Boolean(attempt.commitMessage),
		);

export default async function implementTaskPlanExtension(pi: ExtensionAPI): Promise<void> {
	const extensionFolder = dirname(fileURLToPath(import.meta.url));
	const [orchestratorTemplate, subagentTemplate] = await Promise.all([
		readFile(join(extensionFolder, "prompts", "orchestrator.md"), "utf8"),
		readFile(join(extensionFolder, "prompts", "subagent.md"), "utf8"),
	]);
	let state = initialState();
	let plan: TaskPlan | undefined;
	let turnToolNames: string[] = [];
	let finishBatchInvalid = false;

	const persist = (): void => pi.appendEntry<WorkflowState>(STATE_ENTRY, state);

	const setWorkflowToolsActive = (active: boolean): void => {
		const current = pi.getActiveTools().filter((name) => !WORKFLOW_TOOLS.has(name));
		pi.setActiveTools(active ? [...new Set([...current, ...WORKFLOW_TOOLS])] : current);
	};

	const updateStatus = (ctx: ExtensionContext): void => {
		const scopedTasks = plan ? tasksInScope(plan, state.startTaskId) : undefined;
		const scopedIds = new Set(scopedTasks?.map((task) => task.id) ?? []);
		const completed = [...completedTaskIds(state.attempts)].filter((taskId) => scopedIds.has(taskId)).length;
		ctx.ui.setStatus(
			"implement-task-plan",
			state.active
				? ctx.ui.theme.fg("accent", `plan: ${completed}/${scopedTasks?.length ?? "?"}`)
				: undefined,
		);
	};

	const restoreState = async (ctx: ExtensionContext): Promise<void> => {
		state = initialState();
		plan = undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
			const restored = parseState(entry.data);
			if (restored) state = restored;
		}
		if (state.active) {
			const loaded = await loadTaskPlan(state.planPath, ctx.cwd);
			if (loaded.ok && loaded.plan.digest === state.planDigest) {
				plan = loaded.plan;
				const restoredStartTaskId = state.startTaskId || plan.tasks[0]?.id;
				if (!restoredStartTaskId || !plan.tasks.some((task) => task.id === restoredStartTaskId)) {
					state = initialState();
					persist();
					ctx.ui.notify("Task-plan workflow stopped because its starting task is invalid.", "error");
					setWorkflowToolsActive(false);
					updateStatus(ctx);
					return;
				}
				if (state.startTaskId !== restoredStartTaskId) {
					state = { ...state, startTaskId: restoredStartTaskId };
					persist();
				}
				const snapshot = await captureGitSnapshot(
					(command, args, options) => pi.exec(command, args, options),
					ctx.cwd,
				);
				if (
					!snapshot ||
					snapshot.branch !== state.startBranch ||
					snapshot.head !== state.expectedHead ||
					snapshot.porcelain
				) {
					state = { ...state, repositorySafe: false };
					persist();
					ctx.ui.notify(
						"Task-plan implementation is locked because the branch changed or the working tree is not clean.",
						"warning",
					);
				}
			} else {
				state = initialState();
				persist();
				ctx.ui.notify(
					loaded.ok
						? "Task-plan workflow stopped because a plan file changed. Start a new workflow for the revised plan."
						: `Task-plan workflow stopped. ${failureMessage(loaded.reason)}`,
					"error",
				);
			}
		}
		setWorkflowToolsActive(state.active);
		updateStatus(ctx);
	};

	pi.registerTool({
		name: RUN_TOOL,
		label: "Implement Plan Subtask",
		description:
			"Run one task-plan subtask in a fresh isolated Pi process. The tool reads the task files, enforces dependency order, captures usage, and returns the subagent report.",
		promptSnippet: "Run one active task-plan task in a fresh implementation subagent",
		parameters: Type.Object({
			taskId: Type.String({ description: "Exact task folder ID from the active plan" }),
			mode: StringEnum(["implement", "correct"] as const, {
				description: "Use implement first. Use correct only after a failed attempt or orchestrator review.",
			}),
			architectureSummary: Type.String({ description: "Architecture constraints relevant only to this task" }),
			repositoryContext: Type.String({ description: "Repository facts, paths, interfaces, and tests needed for this task" }),
			prerequisiteOutputs: Type.String({ description: "Relevant interfaces or outcomes from completed dependencies" }),
			validationCommands: Type.Array(Type.String(), { description: "Focused validation commands for this task" }),
			reviewFindings: Type.Optional(
				Type.String({ description: "Exact review defects for a correction attempt" }),
			),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (!state.active || !plan) throw new Error("No task-plan workflow is active.");
			if (!state.repositorySafe) {
				throw new Error("The repository changed outside a verified task commit. Finish as blocked or restart after reconciliation.");
			}
			const currentPlan = await loadTaskPlan(state.planPath, ctx.cwd);
			if (!currentPlan.ok || currentPlan.plan.digest !== state.planDigest) {
				throw new Error("A plan file changed after this workflow started. Stop and restart the workflow.");
			}
			plan = currentPlan.plan;
			const task = plan.tasks.find((candidate) => candidate.id === params.taskId);
			if (!task) throw new Error("The task ID is not in the active plan.");
			const scopedTasks = tasksInScope(plan, state.startTaskId);
			const scopedTaskIds = new Set(scopedTasks.map((candidate) => candidate.id));
			if (!scopedTaskIds.has(task.id)) throw new Error("The task is before the requested starting task.");
			if (params.mode === "implement" && state.attempts.some((attempt) => attempt.taskId === task.id)) {
				throw new Error("This task already has an attempt. Use correction mode after review.");
			}
			if (params.mode === "correct" && !state.attempts.some((attempt) => attempt.taskId === task.id)) {
				throw new Error("Correction mode requires an earlier attempt for this task.");
			}
			if (params.mode === "correct" && !params.reviewFindings?.trim()) {
				throw new Error("Correction mode requires exact review findings.");
			}
			if (params.mode === "correct" && correctionLimitReached(state.attempts, task.id)) {
				throw new Error(
					`Task ${task.id} reached the limit of ${MAX_CORRECTION_ATTEMPTS} correction attempts. Finish the workflow as blocked.`,
				);
			}
			const completed = completedTaskIds(state.attempts);
			const missingDependency = task.dependencies.find(
				(dependency) => scopedTaskIds.has(dependency) && !completed.has(dependency),
			);
			if (missingDependency) throw new Error(`Complete dependency ${missingDependency} before ${task.id}.`);

			const attemptNumber = state.attempts.filter((attempt) => attempt.taskId === task.id).length + 1;
			const priorTaskCommit =
				params.mode === "correct" ? successfulTaskAttempt(state, task.id)?.commitHash : undefined;
			const execGit = (command: string, args: string[], options?: { cwd?: string; timeout?: number }) =>
				pi.exec(command, args, options);
			const before = await captureGitSnapshot(execGit, ctx.cwd);
			if (!before) throw new Error("Git HEAD is unavailable. The subagent cannot create a verified task commit.");
			if (before.branch !== state.startBranch || before.head !== state.expectedHead || before.porcelain) {
				state = { ...state, repositorySafe: false };
				persist();
				throw new Error("The workflow branch changed or the working tree is not clean.");
			}
			if (priorTaskCommit && before.head !== priorTaskCommit) {
				throw new Error("The verified task commit is not HEAD. A correction cannot amend it safely.");
			}
			const prompt = fillSubagentPrompt(subagentTemplate, task, { ...params, priorTaskCommit });
			const selectedModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const contextWindow = ctx.model?.contextWindow;
			const result = await runSubagent({
				cwd: ctx.cwd,
				systemPrompt: prompt,
				model: selectedModel,
				thinkingLevel: ctx.thinkingLevel,
				contextWindow,
				signal,
				onProgress: (usage) => {
					onUpdate?.({
						content: [{ type: "text", text: `${task.id} is running. ${formatUsageLine(usage, selectedModel, contextWindow)}` }],
						details: undefined,
					});
				},
			});
			const processFailed =
				result.exitCode !== 0 || result.aborted || result.stopReason === "error" || result.stopReason === "aborted";
			const after = await captureGitSnapshot(execGit, ctx.cwd);
			let repositorySafe = state.repositorySafe;
			let status = processFailed ? "failed" : result.report.status;
			let commitHash = result.report.commitHash;
			let commitMessage = result.report.commitMessage;
			let verificationFailure: string | undefined;
			if (status === "completed") {
				const verification = await verifyReportedCommit(
					execGit,
					ctx.cwd,
					before,
					commitHash,
					commitMessage,
					priorTaskCommit,
				);
				if (verification.ok) {
					commitHash = verification.commitHash;
					commitMessage = verification.commitMessage;
				} else {
					status = "failed";
					verificationFailure = verification.reason;
					repositorySafe = false;
				}
			}
			if (
				status !== "completed" &&
				(!after || after.head !== before.head || after.branch !== before.branch || Boolean(after.porcelain))
			) {
				repositorySafe = false;
				verificationFailure ??= "The unsuccessful subagent changed the repository. Reconcile it before another task.";
			}
			const attempt: StoredAttempt = {
				taskId: task.id,
				attempt: attemptNumber,
				mode: params.mode,
				status,
				usage: result.usage,
				...(result.model ? { model: result.model } : {}),
				...(result.contextWindow ? { contextWindow: result.contextWindow } : {}),
				...(status === "completed" && commitHash ? { commitHash } : {}),
				...(status === "completed" && commitMessage ? { commitMessage } : {}),
			};
			const processDiagnostic = result.limitReason ? result.errorMessage : undefined;
			const output = [
				processDiagnostic,
				result.output,
				verificationFailure ? `COMMIT VERIFICATION FAILED: ${verificationFailure}` : undefined,
			]
				.filter((value): value is string => Boolean(value))
				.join("\n\n")
				.trim();
			const details: RunDetails = { ...attempt, output, stderr: result.stderr };
			state = {
				...state,
				attempts: [...state.attempts, attempt],
				repositorySafe,
				...(status === "completed" && commitHash ? { expectedHead: commitHash } : {}),
			};
			persist();
			updateStatus(ctx);
			const diagnostic = output || result.errorMessage || result.stderr || "The subagent returned no report.";
			const usageLine = formatUsageLine(result.usage, result.model, result.contextWindow);
			return {
				content: [{ type: "text", text: `${diagnostic}\n\nSubagent usage: ${usageLine}` }],
				details,
				usage: toNestedUsage(result.usage),
			};
		},
		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("plan subagent "))}${theme.fg("accent", args.taskId)} ${theme.fg("muted", args.mode)}`,
				0,
				0,
			);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as RunDetails | undefined;
			if (!details) {
				const content = result.content[0];
				return new Text(content?.type === "text" ? content.text : "Subagent result unavailable.", 0, 0);
			}
			const color = details.status === "completed" ? "success" : details.status === "blocked" ? "warning" : "error";
			const header = `${theme.fg(color, details.status.toUpperCase())} ${theme.fg("accent", `${details.taskId} #${details.attempt}`)}`;
			const commit = details.commitHash
				? `${details.commitHash} ${details.commitMessage ?? ""}`.trim()
				: "No commit reported";
			const usage = formatUsageLine(details.usage, details.model, details.contextWindow);
			if (!expanded) return new Text(`${header}\n${theme.fg("muted", commit)}\n${theme.fg("dim", usage)}`, 0, 0);
			const container = new Container();
			container.addChild(new Text(header, 0, 0));
			container.addChild(new Text(theme.fg("muted", commit), 0, 0));
			container.addChild(new Spacer(1));
			container.addChild(new Markdown(details.output || details.stderr || "No report.", 0, 0, getMarkdownTheme()));
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("dim", usage), 0, 0));
			return container;
		},
	});

	pi.registerTool({
		name: FINISH_TOOL,
		label: "Finish Plan Implementation",
		description:
			"Finish the active task-plan workflow. Call this as the final action after repository review and final validation, or when a blocker stops the workflow.",
		promptSnippet: "Write the final task-plan summary with agent usage and commits",
		parameters: Type.Object({
			overallStatus: StringEnum(["completed", "partially-completed", "blocked"] as const),
			summary: Type.String({ description: "Concise implementation result" }),
			finalValidation: Type.Array(Type.String(), { description: "Final command and result entries" }),
			deviations: Type.Array(Type.String(), {
				description: "Plan deviations, assumptions, failures, risks, and follow-up work",
			}),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!state.active || !plan) throw new Error("No task-plan workflow is active.");
			if (finishBatchInvalid || turnToolNames.length !== 1 || turnToolNames[0] !== FINISH_TOOL) {
				throw new Error("Finish must be the only tool call in its assistant message.");
			}
			const currentPlan = await loadTaskPlan(state.planPath, ctx.cwd);
			if (!currentPlan.ok || currentPlan.plan.digest !== state.planDigest) {
				throw new Error("A plan file changed after this workflow started. Stop and restart the workflow.");
			}
			plan = currentPlan.plan;
			const scopedTasks = tasksInScope(plan, state.startTaskId);
			const completed = completedTaskIds(state.attempts);
			if (
				params.overallStatus === "completed" &&
				(!state.repositorySafe || scopedTasks.some((task) => !completed.has(task.id)))
			) {
				throw new Error("Completed status requires every task commit and a verified repository state.");
			}
			const finalAttempts = scopedTasks.flatMap((task) => {
				const attempt = successfulTaskAttempt(state, task.id);
				return attempt ? [attempt] : [];
			});
			const execGit = (command: string, args: string[], options?: { cwd?: string; timeout?: number }) =>
				pi.exec(command, args, options);
			const finalHashes = finalAttempts.flatMap((attempt) => (attempt.commitHash ? [attempt.commitHash] : []));
			const repository = await inspectRepository(execGit, ctx.cwd, finalHashes);
			if (!repository) throw new Error("Git repository state is unavailable for the final summary.");
			if (
				params.overallStatus === "completed" &&
				(!repository.workingTreeClean ||
					repository.branch !== state.startBranch ||
					repository.head !== state.expectedHead)
			) {
				throw new Error("Completed status requires the expected branch, HEAD, and a clean working tree.");
			}
			const sequence = await verifyFinalCommitSequence(
				execGit,
				ctx.cwd,
				finalAttempts.flatMap((attempt) =>
					attempt.commitHash && attempt.commitMessage
						? [{ hash: attempt.commitHash, message: attempt.commitMessage }]
						: [],
				),
				state.startBranch,
			);
			if (!sequence.ok && params.overallStatus === "completed") {
				throw new Error(`Final task commit verification failed. ${sequence.reason}`);
			}
			const completion: CompletionInput = {
				...params,
				deviations: [
					...params.deviations,
					...(!sequence.ok ? [`Final task commit verification failed: ${sequence.reason}`] : []),
				],
				branch: repository.branch,
				workingTreeClean: repository.workingTreeClean,
				pushed: repository.pushed,
				taskCommitsCreated: finalAttempts.length,
			};
			const markdown = buildCompletionReport({
				...completion,
				attempts: state.attempts,
				taskIds: scopedTasks.map((task) => task.id),
				orchestratorUsage: state.orchestratorUsage,
				orchestratorModels: state.orchestratorModels,
				orchestratorContextWindow: state.orchestratorContextWindow ?? ctx.model?.contextWindow,
			});
			state = { ...state, active: false };
			persist();
			setWorkflowToolsActive(false);
			updateStatus(ctx);
			return {
				content: [{ type: "text", text: markdown }],
				details: { markdown } satisfies FinishDetails,
				terminate: true,
			};
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("finish task-plan implementation")), 0, 0);
		},
		renderResult(result) {
			const details = result.details as FinishDetails | undefined;
			const content = result.content[0];
			return new Markdown(
				details?.markdown ?? (content?.type === "text" ? content.text : "Summary unavailable."),
				0,
				0,
				getMarkdownTheme(),
			);
		},
	});

	pi.registerCommand("implement-task-plan", {
		description: "Implement a Grill Task plan, optionally starting from a specified task",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("implement-task-plan requires interactive TUI mode.", "error");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for the current agent run before you start a task plan.", "warning");
				return;
			}
			if (state.active) {
				ctx.ui.notify("A task-plan workflow is active. Use /implement-task-plan-stop first.", "warning");
				return;
			}
			const commandArguments = parsePlanCommandArguments(args);
			const loaded = await loadTaskPlan(commandArguments.planArgument, ctx.cwd);
			if (!loaded.ok) {
				ctx.ui.notify(`Cannot start task-plan implementation. ${failureMessage(loaded.reason)}`, "error");
				return;
			}
			const snapshot = await captureGitSnapshot(
				(command, commandArgs, options) => pi.exec(command, commandArgs, options),
				ctx.cwd,
			);
			if (!snapshot || snapshot.branch === "detached HEAD" || snapshot.porcelain) {
				ctx.ui.notify(
					"Cannot start task-plan implementation. Use a named branch and a clean working tree.",
					"error",
				);
				return;
			}
			plan = loaded.plan;
			const startTaskId = resolveStartTaskId(plan, commandArguments.startTaskReference);
			if (!startTaskId) {
				ctx.ui.notify(
					`Cannot start task-plan implementation. Task ${commandArguments.startTaskReference ?? "1"} does not exist.`,
					"error",
				);
				return;
			}
			const scopedTasks = tasksInScope(plan, startTaskId);
			state = {
				version: 1,
				active: true,
				planPath: plan.folder,
				planDigest: plan.digest,
				startTaskId,
				startBranch: snapshot.branch,
				expectedHead: snapshot.head,
				repositorySafe: true,
				attempts: [],
				orchestratorUsage: emptyUsage(),
				orchestratorModels: [],
				...(ctx.model?.contextWindow ? { orchestratorContextWindow: ctx.model.contextWindow } : {}),
			};
			persist();
			setWorkflowToolsActive(true);
			updateStatus(ctx);
			pi.sendUserMessage(
				`Implement the Grill Task plan at ${plan.folder}, starting with ${startTaskId}. Process the ${scopedTasks.length} tasks in the active execution scope. Do not pause between tasks unless a genuine blocker requires user input.`,
			);
		},
	});

	pi.registerCommand("implement-task-plan-stop", {
		description: "Stop task-plan orchestration and leave repository changes untouched",
		handler: async (_args, ctx) => {
			if (!state.active) {
				ctx.ui.notify("No task-plan workflow is active.", "info");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Abort or wait for the current agent run before you stop the workflow.", "warning");
				return;
			}
			state = { ...state, active: false };
			persist();
			setWorkflowToolsActive(false);
			updateStatus(ctx);
			ctx.ui.notify("Task-plan workflow stopped. Repository changes remain unchanged.", "info");
		},
	});

	pi.on("before_agent_start", (event) => {
		if (!state.active || !plan) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${workflowPrompt(orchestratorTemplate, plan, state.startTaskId)}`,
		};
	});

	pi.on("turn_start", () => {
		turnToolNames = [];
		finishBatchInvalid = false;
	});

	pi.on("tool_call", (event) => {
		if (!state.active) return;
		turnToolNames.push(event.toolName);
		if (event.toolName === FINISH_TOOL && turnToolNames.length !== 1) {
			finishBatchInvalid = true;
			return { block: true, reason: "Finish must be the only tool call in its assistant message." };
		}
		if (turnToolNames[0] === FINISH_TOOL && turnToolNames.length > 1) {
			finishBatchInvalid = true;
			return { block: true, reason: "Finish must be the only tool call in its assistant message." };
		}
		if (!ORCHESTRATOR_TOOLS.has(event.toolName)) {
			return {
				block: true,
				reason: "The orchestrator can inspect and validate the repository. A fresh plan subagent must make each code change.",
			};
		}
		if (isToolCallEventType("bash", event) && !isOrchestratorShellCommandAllowed(event.input.command)) {
			return {
				block: true,
				reason: "The orchestrator shell command can mutate files, Git history, branches, or remote delivery state.",
			};
		}
	});

	pi.on("message_end", (event, ctx) => {
		if (!state.active || event.message.role !== "assistant") return;
		const model = `${event.message.provider}/${event.message.model}`;
		state = {
			...state,
			orchestratorUsage: addUsage(state.orchestratorUsage, event.message.usage),
			orchestratorModels: state.orchestratorModels.includes(model)
				? state.orchestratorModels
				: [...state.orchestratorModels, model],
			...(ctx.model?.contextWindow ? { orchestratorContextWindow: ctx.model.contextWindow } : {}),
		};
		persist();
	});

	pi.on("session_start", (_event, ctx) => restoreState(ctx));
	pi.on("session_tree", (_event, ctx) => restoreState(ctx));
}
