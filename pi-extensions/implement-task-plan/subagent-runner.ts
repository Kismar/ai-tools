import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import {
	DEFAULT_SUBAGENT_LIMITS,
	limitMessage,
	type SubagentLimitReason,
	type SubagentLimits,
} from "./safeguards.ts";

const MAX_STDERR_BYTES = 20_000;
const MAX_OUTPUT_BYTES = 48 * 1024;
const MAX_EVENT_BYTES = 1_000_000;

export interface UsageStats {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly costInput: number;
	readonly costOutput: number;
	readonly costCacheRead: number;
	readonly costCacheWrite: number;
	readonly cost: number;
	readonly contextTokens: number;
	readonly turns: number;
}

export interface ParsedSubagentReport {
	readonly status: "completed" | "blocked" | "failed" | "unknown";
	readonly commitHash?: string;
	readonly commitMessage?: string;
}

export interface RunSubagentOptions {
	readonly cwd: string;
	readonly systemPrompt: string;
	readonly model?: string;
	readonly thinkingLevel?: string;
	readonly contextWindow?: number;
	readonly signal?: AbortSignal;
	readonly onProgress?: (usage: UsageStats) => void;
	readonly limits?: Partial<SubagentLimits>;
	readonly invocationOverride?: { readonly command: string; readonly args: readonly string[] };
}

export interface SubagentRunResult {
	readonly exitCode: number;
	readonly output: string;
	readonly stderr: string;
	readonly usage: UsageStats;
	readonly report: ParsedSubagentReport;
	readonly model?: string;
	readonly contextWindow?: number;
	readonly stopReason?: string;
	readonly errorMessage?: string;
	readonly limitReason?: SubagentLimitReason;
	readonly aborted: boolean;
}

export const emptyUsage = (): UsageStats => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	costInput: 0,
	costOutput: 0,
	costCacheRead: 0,
	costCacheWrite: 0,
	cost: 0,
	contextTokens: 0,
	turns: 0,
});

const nonNegativeNumber = (value: unknown): number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

export const addUsage = (current: UsageStats, value: unknown): UsageStats => {
	if (!value || typeof value !== "object") return current;
	const usage = value as Record<string, unknown>;
	const cost = usage.cost && typeof usage.cost === "object" ? (usage.cost as Record<string, unknown>) : {};
	return {
		input: current.input + nonNegativeNumber(usage.input),
		output: current.output + nonNegativeNumber(usage.output),
		cacheRead: current.cacheRead + nonNegativeNumber(usage.cacheRead),
		cacheWrite: current.cacheWrite + nonNegativeNumber(usage.cacheWrite),
		costInput: current.costInput + nonNegativeNumber(cost.input),
		costOutput: current.costOutput + nonNegativeNumber(cost.output),
		costCacheRead: current.costCacheRead + nonNegativeNumber(cost.cacheRead),
		costCacheWrite: current.costCacheWrite + nonNegativeNumber(cost.cacheWrite),
		cost: current.cost + nonNegativeNumber(cost.total),
		contextTokens: nonNegativeNumber(usage.totalTokens),
		turns: current.turns + 1,
	};
};

export const combineUsage = (items: readonly UsageStats[]): UsageStats => {
	let combined = emptyUsage();
	for (const item of items) {
		combined = {
			input: combined.input + item.input,
			output: combined.output + item.output,
			cacheRead: combined.cacheRead + item.cacheRead,
			cacheWrite: combined.cacheWrite + item.cacheWrite,
			costInput: combined.costInput + item.costInput,
			costOutput: combined.costOutput + item.costOutput,
			costCacheRead: combined.costCacheRead + item.costCacheRead,
			costCacheWrite: combined.costCacheWrite + item.costCacheWrite,
			cost: combined.cost + item.cost,
			contextTokens: item.contextTokens,
			turns: combined.turns + item.turns,
		};
	}
	return combined;
};

export const toNestedUsage = (usage: UsageStats): Usage => ({
	input: usage.input,
	output: usage.output,
	cacheRead: usage.cacheRead,
	cacheWrite: usage.cacheWrite,
	totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
	cost: {
		input: usage.costInput,
		output: usage.costOutput,
		cacheRead: usage.costCacheRead,
		cacheWrite: usage.costCacheWrite,
		total: usage.cost,
	},
});

const reportField = (output: string, name: "Hash" | "Message"): string | undefined => {
	const match = new RegExp(`^\\s*-\\s*${name}:\\s*(.+?)\\s*$`, "im").exec(output);
	const value = match?.[1]?.trim();
	if (!value) return undefined;
	const inlineCode = /^`([^`]+)`$/.exec(value);
	return inlineCode?.[1]?.trim() || value;
};

export const parseSubagentReport = (output: string): ParsedSubagentReport => {
	const statusMatch = /^STATUS:\s*(completed|blocked|failed)\s*$/im.exec(output);
	const hash = reportField(output, "Hash");
	const message = reportField(output, "Message");
	return {
		status: (statusMatch?.[1]?.toLowerCase() as ParsedSubagentReport["status"] | undefined) ?? "unknown",
		...(hash && /^[0-9a-f]{7,64}$/i.test(hash) ? { commitHash: hash } : {}),
		...(message ? { commitMessage: message } : {}),
	};
};

const finalText = (message: unknown): string => {
	if (!message || typeof message !== "object") return "";
	const record = message as Record<string, unknown>;
	if (record.role !== "assistant" || !Array.isArray(record.content)) return "";
	return record.content
		.flatMap((part) => {
			if (!part || typeof part !== "object") return [];
			const item = part as Record<string, unknown>;
			return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
		})
		.join("\n");
};

const truncateOutput = (value: string): string => {
	const bytes = Buffer.byteLength(value, "utf8");
	if (bytes <= MAX_OUTPUT_BYTES) return value;
	const contentLimit = MAX_OUTPUT_BYTES - 100;
	let content = value;
	while (Buffer.byteLength(content, "utf8") > contentLimit) {
		content = content.slice(0, Math.max(0, content.length - 256));
	}
	const omitted = bytes - Buffer.byteLength(content, "utf8");
	return `${content}\n\n[Output truncated: ${omitted} bytes omitted.]`;
};

const boundedAppend = (current: string, addition: string, maxBytes: number): string => {
	const next = current + addition;
	if (Buffer.byteLength(next, "utf8") <= maxBytes) return next;
	let suffix = next.slice(-maxBytes);
	while (Buffer.byteLength(suffix, "utf8") > maxBytes) suffix = suffix.slice(1);
	return `[Earlier output omitted.]\n${suffix}`;
};

const positiveLimit = (value: number | undefined, fallback: number): number =>
	typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;

const resolvedLimits = (limits?: Partial<SubagentLimits>): SubagentLimits => ({
	wallClockTimeoutMs: positiveLimit(limits?.wallClockTimeoutMs, DEFAULT_SUBAGENT_LIMITS.wallClockTimeoutMs),
	inactivityTimeoutMs: positiveLimit(limits?.inactivityTimeoutMs, DEFAULT_SUBAGENT_LIMITS.inactivityTimeoutMs),
	maxTurns: positiveLimit(limits?.maxTurns, DEFAULT_SUBAGENT_LIMITS.maxTurns),
});

const piInvocation = (args: string[]): { command: string; args: string[] } => {
	const currentScript = process.argv[1];
	const bunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !bunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const runtime = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(runtime)) return { command: process.execPath, args };
	return { command: "pi", args };
};

export const runSubagent = async (options: RunSubagentOptions): Promise<SubagentRunResult> => {
	const promptFolder = await mkdtemp(join(tmpdir(), "pi-plan-subagent-"));
	const promptPath = join(promptFolder, "system-prompt.md");
	await writeFile(promptPath, options.systemPrompt, { encoding: "utf8", mode: 0o600 });

	let usage = emptyUsage();
	let output = "";
	let stderr = "";
	let stopReason: string | undefined;
	let errorMessage: string | undefined;
	let responseModel = options.model;
	let aborted = false;
	let limitReason: SubagentLimitReason | undefined;
	const limits = resolvedLimits(options.limits);

	try {
		const args = [
			"--no-extensions",
			"--no-context-files",
			"--no-skills",
			"--mode",
			"json",
			"-p",
			"--no-session",
		];
		if (options.model) args.push("--model", options.model);
		if (options.thinkingLevel) args.push("--thinking", options.thinkingLevel);
		args.push("--append-system-prompt", promptPath, "Complete the assigned task and return the required report.");
		const invocation = options.invocationOverride ?? piInvocation(args);

		const exitCode = await new Promise<number>((resolveExit) => {
			const child = spawn(invocation.command, [...invocation.args], {
				cwd: options.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				detached: process.platform !== "win32",
			});
			let buffer = "";
			let closed = false;
			let forceTimer: NodeJS.Timeout | undefined;
			let wallClockTimer: NodeJS.Timeout | undefined;
			let inactivityTimer: NodeJS.Timeout | undefined;
			let terminationPromise: Promise<void> | undefined;

			const terminateProcessTree = (force: boolean): void => {
				if (closed || child.pid === undefined) return;
				if (process.platform === "win32") {
					terminationPromise ??= new Promise<void>((resolveTermination) => {
						const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
							stdio: "ignore",
							windowsHide: true,
						});
						killer.once("close", () => resolveTermination());
						killer.once("error", () => resolveTermination());
					});
					return;
				}
				try {
					process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
				} catch {
					child.kill(force ? "SIGKILL" : "SIGTERM");
				}
			};

			const abort = (): void => {
				if (closed) return;
				aborted = true;
				terminateProcessTree(false);
				if (process.platform !== "win32") {
					forceTimer = setTimeout(() => terminateProcessTree(true), 5_000);
					forceTimer.unref();
				}
			};

			const stopAtLimit = (reason: SubagentLimitReason): void => {
				if (closed || limitReason) return;
				limitReason = reason;
				errorMessage = limitMessage(reason, limits);
				abort();
			};

			const resetInactivityTimer = (): void => {
				if (inactivityTimer) clearTimeout(inactivityTimer);
				inactivityTimer = setTimeout(
					() => stopAtLimit("inactivity-timeout"),
					limits.inactivityTimeoutMs,
				);
				inactivityTimer.unref();
			};

			wallClockTimer = setTimeout(() => stopAtLimit("wall-clock-timeout"), limits.wallClockTimeoutMs);
			wallClockTimer.unref();
			resetInactivityTimer();

			const processLine = (line: string): void => {
				if (!line.trim()) return;
				let event: unknown;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}
				if (!event || typeof event !== "object") return;
				const record = event as Record<string, unknown>;
				if (record.type !== "message_end" || !record.message || typeof record.message !== "object") return;
				const message = record.message as Record<string, unknown>;
				if (message.role !== "assistant") return;
				usage = addUsage(usage, message.usage);
				const text = finalText(message);
				if (text) output = truncateOutput(text);
				if (typeof message.model === "string") {
					responseModel =
						typeof message.provider === "string" ? `${message.provider}/${message.model}` : message.model;
				}
				if (typeof message.stopReason === "string") stopReason = message.stopReason;
				if (!limitReason && typeof message.errorMessage === "string") errorMessage = message.errorMessage;
				options.onProgress?.(usage);
				if (usage.turns >= limits.maxTurns && stopReason === "toolUse") stopAtLimit("turn-limit");
			};

			child.stdout.on("data", (data: Buffer) => {
				resetInactivityTimer();
				buffer += data.toString("utf8");
				if (Buffer.byteLength(buffer, "utf8") > MAX_EVENT_BYTES) {
					stderr = boundedAppend(
						stderr,
						"A subagent JSON event exceeded the 1 MB safety limit.\n",
						MAX_STDERR_BYTES,
					);
					buffer = "";
					abort();
					return;
				}
				const lines = buffer.split(/\r?\n/);
				buffer = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			});
			child.stderr.on("data", (data: Buffer) => {
				resetInactivityTimer();
				stderr = boundedAppend(stderr, data.toString("utf8"), MAX_STDERR_BYTES);
			});
			child.on("error", (error) => {
				stderr = boundedAppend(stderr, String(error), MAX_STDERR_BYTES);
				resolveExit(1);
			});
			child.on("close", async (code) => {
				closed = true;
				if (forceTimer) clearTimeout(forceTimer);
				if (wallClockTimer) clearTimeout(wallClockTimer);
				if (inactivityTimer) clearTimeout(inactivityTimer);
				options.signal?.removeEventListener("abort", abort);
				if (terminationPromise) await terminationPromise;
				if (buffer.trim()) processLine(buffer);
				resolveExit(code ?? 1);
			});

			if (options.signal?.aborted) abort();
			else options.signal?.addEventListener("abort", abort, { once: true });
		});

		return {
			exitCode,
			output,
			stderr,
			usage,
			report: parseSubagentReport(output),
			...(responseModel ? { model: responseModel } : {}),
			...(options.contextWindow ? { contextWindow: options.contextWindow } : {}),
			...(stopReason ? { stopReason } : {}),
			...(errorMessage ? { errorMessage } : {}),
			...(limitReason ? { limitReason } : {}),
			aborted,
		};
	} finally {
		await rm(promptFolder, { recursive: true, force: true });
	}
};
