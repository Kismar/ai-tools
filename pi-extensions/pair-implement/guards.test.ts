import assert from "node:assert/strict";
import test from "node:test";
import { isForbiddenRemoteCommand, isLocalBranchSetupCommand, isReadOnlyShellCommand } from "./guards.ts";

test("allows conservative inspection commands", () => {
	for (const command of [
		"pwd",
		"ls -la",
		"rg -n pair src",
		"find . -maxdepth 2 -type f",
		"git status --short --branch",
		"git -C other status --short",
		"git diff --stat",
		"git branch --show-current",
		"git worktree list",
		"git grep -n -o TODO",
		'git log --format="%h %s" -5',
		"rg 'end$' src",
		"find . -name '*.ts'",
		"[ -f README.md ]",
		"tree -L 2 src",
		"uniq -c sorted.txt",
		"file README.md",
	]) {
		assert.equal(isReadOnlyShellCommand(command), true, command);
	}
});

test("rejects shell composition and commands that can mutate", () => {
	for (const command of [
		"ls && rm file",
		"rg value . > result.txt",
		"git grep -Otouch TODO",
		"git grep -nOtouch TODO",
		"git grep --open-files-in-pager=touch TODO",
		"git grep --open=touch TODO",
		"git diff --output=changes.patch",
		"rg '--pre=touch marker' value .",
		'git grep "-Otouch" TODO',
		"git grep '--open=touch' TODO",
		"git grep \\-Otouch TODO",
		"git grep $'-Otouch' TODO",
		"git grep --o{x,pen}=touch TODO",
		"git grep ('-O'+'touch') TODO",
		"git grep @('-Otouch') TODO",
		"git grep $'\\055Otouch' TODO",
		"git grep ${X:--Otouch} TODO",
		"git grep \\'-Otouch\\' TODO",
		"git grep {-Otouch} TODO",
		"git grep ‘-Otouch’ TODO",
		"git grep TODO *",
		"find . '-delete'",
		"find . -fprint0 found.txt",
		"tree -o listing.txt",
		"tree -aR -H .",
		"uniq input.txt output.txt",
		"file -C -m magic",
		"file --comp -m magic",
		"find . -delete",
		"find . -exec rm {} ;",
		"rg --pre 'touch marker' value .",
		"git switch -c feature",
		"git commit -m change",
		"git branch feature",
		"node script.js",
	]) {
		assert.equal(isReadOnlyShellCommand(command), false, command);
	}
});

test("detects prohibited remote publication", () => {
	for (const command of [
		"git push origin feature",
		"git --no-pager push origin feature",
		"git -C other push origin feature",
		"/usr/bin/git push origin feature",
		"glab mr create --draft",
		"gh pr create --draft",
		"hub pull-request",
		"az repos pr create",
	]) {
		assert.equal(isForbiddenRemoteCommand(command), true, command);
	}
});

test("does not classify local git operations as remote publication", () => {
	for (const command of ["git switch -c feature", "git add src", "git commit -m change", "git status"]) {
		assert.equal(isForbiddenRemoteCommand(command), false, command);
	}
});

test("allows only focused local branch setup commands", () => {
	for (const command of ["git switch -c feature", "git switch existing", "git -C repo checkout -b feature"]) {
		assert.equal(isLocalBranchSetupCommand(command), true, command);
	}
	for (const command of ["git switch -c feature && touch file", "git checkout feature", "git branch feature", "git commit"]) {
		assert.equal(isLocalBranchSetupCommand(command), false, command);
	}
});
