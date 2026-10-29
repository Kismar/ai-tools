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

test("rejects composition, execution, and mutation", () => {
	for (const command of [
		"ls && rm file",
		"rg value . > output.txt",
		"find . -delete",
		"find . -exec rm {} ;",
		"rg --pre 'touch marker' value .",
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
		"git switch -c feature",
		"git add src",
		"git commit -m change",
		"uv run pytest",
		"node script.js",
	]) {
		assert.equal(isReadOnlyShellCommand(command), false, command);
	}
});
