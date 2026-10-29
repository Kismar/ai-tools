export interface SubagentLimits {
	readonly wallClockTimeoutMs: number;
	readonly inactivityTimeoutMs: number;
	readonly maxTurns: number;
}

export type SubagentLimitReason = "wall-clock-timeout" | "inactivity-timeout" | "turn-limit";

export const DEFAULT_SUBAGENT_LIMITS: SubagentLimits = {
	wallClockTimeoutMs: 60 * 60 * 1_000,
	inactivityTimeoutMs: 10 * 60 * 1_000,
	maxTurns: 80,
};

export const MAX_CORRECTION_ATTEMPTS = 2;

export const correctionLimitReached = (
	attempts: readonly { readonly taskId: string; readonly mode: string }[],
	taskId: string,
): boolean =>
	attempts.filter((attempt) => attempt.taskId === taskId && attempt.mode === "correct").length >=
	MAX_CORRECTION_ATTEMPTS;

export const limitMessage = (reason: SubagentLimitReason, limits: SubagentLimits): string => {
	switch (reason) {
		case "wall-clock-timeout":
			return `Subagent exceeded the ${Math.round(limits.wallClockTimeoutMs / 60_000)} minute wall-clock limit.`;
		case "inactivity-timeout":
			return `Subagent produced no process output for ${Math.round(limits.inactivityTimeoutMs / 60_000)} minutes.`;
		case "turn-limit":
			return `Subagent requested more work after ${limits.maxTurns} assistant turns.`;
	}
};
