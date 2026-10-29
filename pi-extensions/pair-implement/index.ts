import { StringEnum } from "@earendil-works/pi-ai";
import {
	getMarkdownTheme,
	isToolCallEventType,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { isForbiddenRemoteCommand, isLocalBranchSetupCommand, isReadOnlyShellCommand } from "./guards.ts";

const STATE_ENTRY = "pair-implement-state";
const CLARIFY_TOOL = "pair_clarify";
const CHECKPOINT_TOOL = "pair_checkpoint";
const FINISH_TOOL = "pair_finish";
const PAIR_TOOLS = new Set([CLARIFY_TOOL, CHECKPOINT_TOOL, FINISH_TOOL]);
const INSPECTION_TOOLS = new Set(["read", "grep", "find", "ls", CLARIFY_TOOL, CHECKPOINT_TOOL, FINISH_TOOL]);

const CHECKPOINT_KINDS = ["initial", "implementation-unit", "design-seam", "scope-change"] as const;
type CheckpointKind = (typeof CHECKPOINT_KINDS)[number];

interface ClarificationQuestion {
	question: string;
	impact: string;
	recommendation?: string;
}

interface PendingClarification {
	context: string;
	questions: ClarificationQuestion[];
}

interface PendingCheckpoint {
	kind: CheckpointKind;
	title: string;
	summary: string;
}

interface PairState {
	version: 1;
	active: boolean;
	task: string;
	mutationAllowed: boolean;
	authorization?: CheckpointKind;
	pendingClarification?: PendingClarification;
	pending?: PendingCheckpoint;
}

interface FinishDetails {
	summary: string;
	commits: string[];
	verification: string[];
	concerns?: string;
}

const initialState = (): PairState => ({
	version: 1,
	active: false,
	task: "",
	mutationAllowed: false,
});

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const isCheckpointKind = (value: unknown): value is CheckpointKind =>
	typeof value === "string" && CHECKPOINT_KINDS.some((kind) => kind === value);

const parseClarificationQuestion = (value: unknown): ClarificationQuestion | undefined => {
	if (!isRecord(value) || typeof value.question !== "string" || typeof value.impact !== "string") return undefined;
	if (value.recommendation !== undefined && typeof value.recommendation !== "string") return undefined;
	return {
		question: value.question,
		impact: value.impact,
		...(value.recommendation ? { recommendation: value.recommendation } : {}),
	};
};

const parseClarification = (value: unknown): PendingClarification | undefined => {
	if (!isRecord(value) || typeof value.context !== "string" || !Array.isArray(value.questions)) return undefined;
	const questions = value.questions.map(parseClarificationQuestion);
	if (questions.length === 0 || questions.some((question) => question === undefined)) return undefined;
	return { context: value.context, questions: questions as ClarificationQuestion[] };
};

const parseCheckpoint = (value: unknown): PendingCheckpoint | undefined => {
	if (!isRecord(value)) return undefined;
	if (!isCheckpointKind(value.kind) || typeof value.title !== "string" || typeof value.summary !== "string") {
		return undefined;
	}
	return { kind: value.kind, title: value.title, summary: value.summary };
};

const parseState = (value: unknown): PairState | undefined => {
	if (!isRecord(value) || value.version !== 1 || typeof value.active !== "boolean") return undefined;
	if (typeof value.task !== "string" || typeof value.mutationAllowed !== "boolean") return undefined;
	const pendingClarification =
		value.pendingClarification === undefined ? undefined : parseClarification(value.pendingClarification);
	if (value.pendingClarification !== undefined && pendingClarification === undefined) return undefined;
	const pending = value.pending === undefined ? undefined : parseCheckpoint(value.pending);
	if (value.pending !== undefined && pending === undefined) return undefined;
	const authorization = value.authorization === undefined ? undefined : value.authorization;
	if (authorization !== undefined && !isCheckpointKind(authorization)) return undefined;
	return {
		version: 1,
		active: value.active,
		task: value.task,
		mutationAllowed: value.mutationAllowed,
		...(authorization ? { authorization } : {}),
		...(pendingClarification ? { pendingClarification } : {}),
		...(pending ? { pending } : {}),
	};
};

const clarificationMarkdown = (clarification: PendingClarification): string => {
	const questions = clarification.questions
		.map((item, index) => {
			const recommendation = item.recommendation?.trim()
				? `\n   - **Recommended default:** ${item.recommendation.trim()}`
				: "";
			return `${index + 1}. **${item.question}**\n   - **Why it matters:** ${item.impact}${recommendation}`;
		})
		.join("\n");
	return `## Clarification needed\n\n${clarification.context}\n\n### Questions\n${questions}\n\n---\n\nReply with your answers, or say \`use recommended defaults\` when every question has one. Exact \`confirm\` is reserved for checkpoints.`;
};

const checkpointMarkdown = (checkpoint: PendingCheckpoint): string =>
	`## ${checkpoint.title}\n\n${checkpoint.summary}\n\n---\n\nType exactly \`confirm\` to authorize this unchanged checkpoint, or provide feedback to revise it.`;

const finishMarkdown = (details: FinishDetails): string => {
	const commits = details.commits.length > 0 ? details.commits.map((commit) => `- ${commit}`).join("\n") : "- None";
	const verification =
		details.verification.length > 0 ? details.verification.map((check) => `- ${check}`).join("\n") : "- None";
	const concerns = details.concerns?.trim() || "None";
	return `## Pair implementation complete\n\n${details.summary}\n\n### Local commits\n${commits}\n\n### Verification\n${verification}\n\n### Concerns\n${concerns}\n\nNo branch was pushed and no change request was opened.`;
};

const workflowPrompt = (task: string): string => `PAIR IMPLEMENTATION MODE IS ACTIVE.

Task supplied by the user:
${task}

This is a self-contained workflow. Do not load or invoke any project or user dev-implement skill.

Operating contract:
- Work in the current checkout (in-place mode). You may create a local branch and local commits after confirmation.
- Never push, open or modify a pull/merge request, or use a provider CLI to publish changes. The user owns all remote operations.
- Treat the supplied prompt as one task. During the initial checkpoint, propose whether it should remain one coherent commit or be split into multiple coherent commits. The user decides by confirming or giving feedback.
- Inspect the current state read-only before proposing implementation. Respect all applicable project context and conventions. While locked, issue one conservative read-only shell command per bash call; shell composition is intentionally blocked.
- Use red-green-refactor where practical. Each proposed commit must be coherent, independently valid, verified, and self-reviewed.
- Do not expand the requested scope. If evidence changes scope, design, sequence, or commit structure, stop at a scope-change checkpoint.

Mandatory pre-implementation clarification gate:
1. After read-only inspection, identify any unresolved requirement, behavior, acceptance criterion, constraint, or preference that could materially change the implementation.
2. Answer questions from repository evidence when possible. Do not ask the user questions that inspection can resolve, and do not ask low-value preference questions when a conventional choice has no material consequence.
3. If material ambiguity remains, call pair_clarify as the only tool call in its assistant message. Ask a small, focused set of numbered questions, explain each question's impact, and provide a recommended default when one is safe. Then stop for the user's answers.
4. Reassess after every answer and repeat pair_clarify only if material ambiguity remains. Do not present the initial checkpoint while a blocking question is unresolved.
5. If nothing material is unclear, proceed directly to the initial checkpoint. Do not invent questions merely to create a Q&A turn.

Mandatory checkpoints:
1. Initial: only after the clarification gate is complete, call pair_checkpoint with kind "initial". Its summary must contain: Current state; resolved clarifications and explicit assumptions; implementation-unit and commit plan; verification after each commit; differences from the request; proposed local branch; working mode (in-place); and local Git operations. Do not mutate before this checkpoint is confirmed.
2. Before every implementation unit: call pair_checkpoint with kind "implementation-unit". Name every file to add or change, its directory, the resulting structure, and why. This includes tests. Wait for confirmation before touching files.
3. Before encoding a new domain rule, core control flow, or public interface: call pair_checkpoint with kind "design-seam". State exactly what will be created, where, and why. Routine implementation needs no extra checkpoint.
4. For any scope, design, sequence, or commit-plan change: call pair_checkpoint with kind "scope-change" and explain the discrepancy, evidence, options, and recommendation.

Clarification protocol:
- pair_clarify is for unanswered questions, not approval. The user's next ordinary message supplies answers; it does not authorize mutation.
- Exact \`confirm\` is not a clarification answer and remains reserved for checkpoint authorization.
- If new ambiguity is discovered after the initial checkpoint, use a scope-change checkpoint to explain it and request the needed decision before continuing.

Checkpoint protocol:
- pair_checkpoint must be the only tool call in its assistant message.
- A checkpoint is authorized only by the user's next message consisting entirely of "confirm", ignoring case and surrounding whitespace.
- Any other reply is feedback and invalidates the checkpoint. Revise it and present a new checkpoint.
- One confirmation authorizes only the immediately preceding unchanged action bundle.
- Never claim that ordinary approval wording counts as confirmation.

Delivery:
- After a confirmed implementation-unit checkpoint, implement its complete red-green-refactor cycle, run its verification, self-review the diff, fix findings, and create its local commit.
- Pause at the next required checkpoint before beginning another implementation unit or a newly discovered design seam.
- Run applicable complete verification after all commits.
- Finish by calling pair_finish with the delivered summary, local commits, verification, and concerns. Do not push or open a change request.`;

export default function pairImplementExtension(pi: ExtensionAPI): void {
	let state = initialState();

	const persist = (): void => pi.appendEntry<PairState>(STATE_ENTRY, state);

	const setPairToolsActive = (active: boolean): void => {
		const current = pi.getActiveTools().filter((name) => !PAIR_TOOLS.has(name));
		pi.setActiveTools(active ? [...new Set([...current, ...PAIR_TOOLS])] : current);
	};

	const updateStatus = (ctx: ExtensionContext): void => {
		if (!state.active) {
			ctx.ui.setStatus("pair-implement", undefined);
			return;
		}
		const label = state.pending
			? "pair: confirm"
			: state.pendingClarification
				? "pair: answer"
				: state.mutationAllowed
					? "pair: implementing"
					: "pair: checkpoint";
		const color = state.pending || state.pendingClarification || !state.mutationAllowed ? "warning" : "accent";
		ctx.ui.setStatus("pair-implement", ctx.ui.theme.fg(color, label));
	};

	const restoreState = (ctx: ExtensionContext): void => {
		state = initialState();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
			const restored = parseState(entry.data);
			if (restored) state = restored;
		}

		if (state.active && state.mutationAllowed && !state.pending) {
			state = { ...state, mutationAllowed: false, authorization: undefined };
			persist();
		}
		setPairToolsActive(state.active);
		updateStatus(ctx);
	};

	pi.registerTool({
		name: CLARIFY_TOOL,
		label: "Pair Clarification",
		description:
			"Ask focused pre-implementation questions when repository inspection cannot resolve material ambiguity. Call it alone, then stop for the user's answers.",
		parameters: Type.Object({
			context: Type.String({ description: "Concise summary of what is known and why clarification is needed" }),
			questions: Type.Array(
				Type.Object({
					question: Type.String({ description: "One focused question for the user" }),
					impact: Type.String({ description: "How the answer materially changes implementation or acceptance" }),
					recommendation: Type.Optional(
						Type.String({ description: "Safe recommended default when one exists" }),
					),
				}),
				{ minItems: 1, description: "Material questions that repository evidence cannot answer" },
			),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!state.active) throw new Error("Pair implementation mode is not active. Start it with /pair-implement <task>.");
			if (state.pending) throw new Error("The pending checkpoint must receive feedback before asking clarifying questions.");
			const pendingClarification: PendingClarification = {
				context: params.context,
				questions: params.questions.map((question) => ({ ...question })),
			};
			state = {
				...state,
				mutationAllowed: false,
				authorization: undefined,
				pendingClarification,
			};
			persist();
			updateStatus(ctx);
			return {
				content: [{ type: "text", text: clarificationMarkdown(pendingClarification) }],
				details: pendingClarification,
				terminate: true,
			};
		},
		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("pair clarification "))}${theme.fg("accent", String(args.questions?.length ?? 0))} question(s)`,
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const details = result.details;
			if (!details) return new Text(theme.fg("error", "Clarification details unavailable"), 0, 0);
			const container = new Container();
			container.addChild(new Markdown(clarificationMarkdown(details), 0, 0, getMarkdownTheme()));
			return container;
		},
	});

	pi.registerTool({
		name: CHECKPOINT_TOOL,
		label: "Pair Checkpoint",
		description:
			"Present a mandatory pair-implementation decision checkpoint. Call it alone, then stop until the user types exact confirm.",
		parameters: Type.Object({
			kind: StringEnum(CHECKPOINT_KINDS, { description: "Decision boundary represented by this checkpoint" }),
			title: Type.String({ description: "Short checkpoint title" }),
			summary: Type.String({ description: "Markdown containing the exact proposed action bundle and rationale" }),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!state.active) throw new Error("Pair implementation mode is not active. Start it with /pair-implement <task>.");
			if (state.pendingClarification) {
				throw new Error("The user must answer the pending clarification before a checkpoint can be presented.");
			}
			const pending: PendingCheckpoint = { kind: params.kind, title: params.title, summary: params.summary };
			state = { ...state, mutationAllowed: false, authorization: undefined, pending };
			persist();
			updateStatus(ctx);
			return {
				content: [{ type: "text", text: checkpointMarkdown(pending) }],
				details: pending,
				terminate: true,
			};
		},
		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("pair checkpoint "))}${theme.fg("accent", args.kind)}\n${theme.fg("muted", args.title)}`,
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const details = result.details;
			if (!details) return new Text(theme.fg("error", "Checkpoint details unavailable"), 0, 0);
			const container = new Container();
			container.addChild(new Markdown(checkpointMarkdown(details), 0, 0, getMarkdownTheme()));
			return container;
		},
	});

	pi.registerTool({
		name: FINISH_TOOL,
		label: "Finish Pair Implementation",
		description: "Finish an active pair implementation after all local commits, verification, and self-review are complete.",
		parameters: Type.Object({
			summary: Type.String({ description: "Concise delivered-scope summary" }),
			commits: Type.Array(Type.String({ description: "Local commit hash and subject" })),
			verification: Type.Array(Type.String({ description: "Verification command and result" })),
			concerns: Type.Optional(Type.String({ description: "Remaining concerns, or omit when there are none" })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!state.active) throw new Error("Pair implementation mode is not active.");
			if (state.pendingClarification) throw new Error("The pending clarification must be answered before finishing.");
			if (state.pending) throw new Error("The pending checkpoint must be confirmed or revised before finishing.");
			if (!state.mutationAllowed || state.authorization === "initial") {
				throw new Error("A confirmed implementation checkpoint is required before finishing.");
			}
			const details: FinishDetails = {
				summary: params.summary,
				commits: [...params.commits],
				verification: [...params.verification],
				...(params.concerns ? { concerns: params.concerns } : {}),
			};
			state = initialState();
			persist();
			updateStatus(ctx);
			setPairToolsActive(false);
			return {
				content: [{ type: "text", text: finishMarkdown(details) }],
				details,
				terminate: true,
			};
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("finish pair implementation")), 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details;
			if (!details) return new Text(theme.fg("error", "Completion details unavailable"), 0, 0);
			const container = new Container();
			container.addChild(new Markdown(finishMarkdown(details), 0, 0, getMarkdownTheme()));
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "Remote delivery remains manual."), 0, 0));
			return container;
		},
	});

	pi.registerCommand("pair-implement", {
		description: "Implement one task interactively with exact-confirm decision checkpoints",
		handler: async (args, ctx) => {
			const task = args.trim();
			if (!task) {
				ctx.ui.notify("Usage: /pair-implement <task prompt>", "warning");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for the current agent run to finish before starting pair implementation.", "warning");
				return;
			}
			if (state.active) {
				ctx.ui.notify("Pair implementation is already active. Use /pair-implement-stop first.", "warning");
				return;
			}

			state = { version: 1, active: true, task, mutationAllowed: false };
			persist();
			setPairToolsActive(true);
			updateStatus(ctx);
			pi.sendUserMessage(`Implement this task using the active pair-implementation workflow:\n\n${task}`);
		},
	});

	pi.registerCommand("pair-implement-stop", {
		description: "Stop pair implementation without pushing or opening a change request",
		handler: async (_args, ctx) => {
			if (!state.active) {
				ctx.ui.notify("Pair implementation is not active.", "info");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Abort or wait for the current agent run before stopping pair implementation.", "warning");
				return;
			}
			state = initialState();
			persist();
			setPairToolsActive(false);
			updateStatus(ctx);
			ctx.ui.notify("Pair implementation stopped. Local changes were left untouched.", "info");
		},
	});

	pi.on("before_agent_start", (event) => {
		if (!state.active) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${workflowPrompt(state.task)}` };
	});

	pi.on("input", (event, ctx) => {
		if (!state.active || event.source === "extension") return { action: "continue" };
		const exactConfirm = event.text.trim().toLowerCase() === "confirm" && (event.images?.length ?? 0) === 0;

		if (state.pendingClarification) {
			if (exactConfirm) {
				ctx.ui.notify('Answer the clarification questions, or type "use recommended defaults".', "warning");
				return { action: "handled" };
			}
			state = { ...state, mutationAllowed: false, authorization: undefined, pendingClarification: undefined };
			persist();
			updateStatus(ctx);
			return { action: "continue" };
		}

		if (!state.pending) {
			if (exactConfirm) {
				ctx.ui.notify("No pair checkpoint is awaiting confirmation.", "warning");
				return { action: "handled" };
			}
			return { action: "continue" };
		}

		if (exactConfirm) {
			state = { ...state, mutationAllowed: true, authorization: state.pending.kind, pending: undefined };
			persist();
			updateStatus(ctx);
			return { action: "continue" };
		}

		state = { ...state, mutationAllowed: false, authorization: undefined, pending: undefined };
		persist();
		updateStatus(ctx);
		ctx.ui.notify("Checkpoint invalidated by feedback; a revised checkpoint is required.", "info");
		return { action: "continue" };
	});

	pi.on("tool_call", (event, ctx) => {
		if (!state.active) return;

		if (isToolCallEventType("bash", event) && isForbiddenRemoteCommand(event.input.command)) {
			return {
				block: true,
				reason: "Pair implementation forbids pushes and remote change-request operations. The user owns remote delivery.",
			};
		}

		if (event.toolName === CLARIFY_TOOL) {
			state = { ...state, mutationAllowed: false, authorization: undefined };
			persist();
			updateStatus(ctx);
			return;
		}
		if (event.toolName === CHECKPOINT_TOOL) {
			state = { ...state, mutationAllowed: false, authorization: undefined };
			persist();
			updateStatus(ctx);
			return;
		}
		if (state.mutationAllowed && state.authorization !== "initial") return;
		if (INSPECTION_TOOLS.has(event.toolName)) return;

		if (isToolCallEventType("bash", event)) {
			if (isReadOnlyShellCommand(event.input.command)) return;
			if (state.mutationAllowed && state.authorization === "initial" && isLocalBranchSetupCommand(event.input.command)) {
				return;
			}
		}
		return {
			block: true,
			reason:
				state.authorization === "initial"
					? "The initial confirmation authorizes only local branch setup. Present and receive confirmation for an implementation-unit checkpoint before changing files."
					: "Pair implementation is locked at a decision boundary. Only conservative read-only inspection is allowed until pair_checkpoint is presented and the user types exact confirm.",
		};
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!state.active || state.pending || !state.mutationAllowed) return;
		state = { ...state, mutationAllowed: false, authorization: undefined };
		persist();
		updateStatus(ctx);
	});

	pi.on("session_start", (_event, ctx) => restoreState(ctx));
	pi.on("session_tree", (_event, ctx) => restoreState(ctx));
}
