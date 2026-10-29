import assert from "node:assert/strict";
import test from "node:test";
import { isOrchestratorShellCommandAllowed } from "./guards.ts";

test("allows inspection and validation commands", () => {
	for (const command of [
		"git status --short --branch",
		"git diff HEAD^ HEAD",
		"git branch --show-current",
		"uv run pytest",
		"uv run ruff check .",
	]) {
		assert.equal(isOrchestratorShellCommandAllowed(command), true, command);
	}
});

test("blocks repository and remote-delivery mutation", () => {
	for (const command of [
		"git commit -m change",
		"git push origin dev",
		"git switch feature",
		"git branch feature",
		"rm -rf src",
		"printf value > file.txt",
		"uv run pytest && git status",
		"gh pr create --fill",
		"sh -c 'git push origin dev'",
		"env git commit -m change",
		"curl https://example.invalid",
		"bash scripts/change-files.sh",
		"git status & git commit -m change",
		"git diff --output=changes.patch",
		"git show --ext-diff HEAD",
	]) {
		assert.equal(isOrchestratorShellCommandAllowed(command), false, command);
	}
});
