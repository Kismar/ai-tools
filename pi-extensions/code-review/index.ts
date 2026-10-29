import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const REVIEW_PROMPT = `CODE-REVIEW MODE IS ACTIVE.

Review diffs for unnecessary complexity. Report each finding as a structured Markdown list item with file name, priority, line, reason, and proposed fix. The diff's best outcome is getting shorter.

Scope:
- Review over-engineering and complexity only.
- Correctness bugs, security holes, and performance are explicitly out of scope. Route them to a normal review pass, not this one.
- A single smoke test or assert-based self-check is the ponytail minimum, not bloat; never flag it for deletion.
- Do not apply fixes. Only list findings.

Output:
- Return exactly one numbered Markdown list using this structure for every finding:
  1. **File name:** \`<file>\`
     - **Priority:** \`<High, Medium, or Low>\`
     - **Line:** \`<line number or range>\`
     - **Reason:** \`<tag: explanation>\`
     - **Proposed fix:** \`<concrete fix>\`
- Use one numbered item per finding, keep the fields in that exact order, and always include every field, even for a single-file diff.
- Use a line number or line range without an "L" prefix.
- Use only High, Medium, or Low for Priority:
  - High: removes a dependency, dead/speculative feature, or large unnecessary abstraction.
  - Medium: removes meaningful local complexity or replaces hand-rolled code with standard/platform functionality.
  - Low: provides a small, localized simplification.
- Start each Reason with one of these tags: delete, stdlib, native, yagni, or shrink.
- Keep Reason focused on what is unnecessarily complex.
- Keep Proposed fix concrete; name the replacement and estimated resulting line count where useful.
- After the list, end with exactly: **Net:** -<N> lines possible.
- Do not add text before the list or between the list and the net metric.
- If there is nothing to cut, say exactly "Lean already. Ship." and stop without a list or net metric.

Tags:
- delete: dead code, unused flexibility, or a speculative feature. Replacement: nothing.
- stdlib: hand-rolled functionality shipped by the standard library. Name the function.
- native: a dependency or code doing what the platform already does. Name the feature.
- yagni: an abstraction with one implementation, configuration nobody sets, or a layer with one caller.
- shrink: the same logic in fewer lines. Show the shorter form.

Example:
1. **File name:** \`validator.py\`
   - **Priority:** High
   - **Line:** 12-38
   - **Reason:** stdlib: A 27-line validator class duplicates basic string checks.
   - **Proposed fix:** Replace it with \`"@" in email\`; real validation belongs in the confirmation flow. Result: 1 line.
2. **File name:** \`repo.py\`
   - **Priority:** Medium
   - **Line:** 88
   - **Reason:** yagni: \`AbstractRepository\` has one implementation and one caller.
   - **Proposed fix:** Inline it until a second implementation exists.
3. **File name:** \`format.ts\`
   - **Priority:** High
   - **Line:** 4
   - **Reason:** native: \`moment.js\` is imported for one formatting call.
   - **Proposed fix:** Use \`Intl.DateTimeFormat\`; result: 0 dependencies.

**Net:** -42 lines possible.

Keep every finding direct and concrete. Do not hedge or add praise, summaries, correctness commentary, security commentary, or performance commentary.`;

const STOP_PHRASES = new Set(["stop ponytail-review", "normal mode"]);

export default function codeReviewExtension(pi: ExtensionAPI): void {
	let active = false;

	const updateStatus = (ctx: ExtensionContext): void => {
		ctx.ui.setStatus("code-review", active ? ctx.ui.theme.fg("accent", "review: shorter") : undefined);
	};

	const stop = (ctx: ExtensionContext): void => {
		active = false;
		updateStatus(ctx);
		ctx.ui.notify("Code-review mode stopped. Normal review style restored.", "info");
	};

	pi.registerCommand("code-review", {
		description: "Review the current diff for unnecessary complexity and removable lines",
		handler: async (args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for the current agent run to finish before starting code review.", "warning");
				return;
			}

			active = true;
			updateStatus(ctx);
			const request = args.trim() || "Review the current diff for unnecessary complexity. Do not modify files.";
			pi.sendUserMessage(request);
		},
	});

	pi.registerCommand("code-review-stop", {
		description: "Stop terse complexity-only code-review mode",
		handler: async (_args, ctx) => {
			if (!active) {
				ctx.ui.notify("Code-review mode is not active.", "info");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Abort or wait for the current agent run before stopping code review.", "warning");
				return;
			}
			stop(ctx);
		},
	});

	pi.on("input", (event, ctx) => {
		if (!active || event.source === "extension") return { action: "continue" };
		if (!STOP_PHRASES.has(event.text.trim().toLowerCase())) return { action: "continue" };
		stop(ctx);
		return { action: "handled" };
	});

	pi.on("before_agent_start", (event) => {
		if (!active) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${REVIEW_PROMPT}` };
	});
}
