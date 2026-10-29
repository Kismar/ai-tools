import assert from "node:assert/strict";
import test from "node:test";
import { isReadOnlyShellCommand } from "./guards.ts";

test("allows conservative repository inspection", () => {
	for (const command of [
		"pwd",
		"ls -la",
		"rg -n ConversationHistory src",
		"find . -maxdepth 3 -type f",
		"git status --short",
		"git diff --stat",
		"git branch --show-current",
		"git -C other log -5 --oneline",
	]) {
		assert.equal(isReadOnlyShellCommand(command), true, command);
	}
});

test("rejects composition, execution, and mutation", () => {
	for (const command of [
		"ls && rm file",
		"rg value . > output.txt",
		"find . -delete",
		"find . -exec rm {} ;",
		"rg --pre 'touch marker' value .",
		"git switch -c feature",
		"git add src",
		"git commit -m change",
		"uv run pytest",
		"node script.js",
	]) {
		assert.equal(isReadOnlyShellCommand(command), false, command);
	}
});
