const READ_ONLY_COMMANDS = new Set([
	"basename",
	"cut",
	"dirname",
	"file",
	"grep",
	"head",
	"ls",
	"printf",
	"pwd",
	"realpath",
	"rg",
	"stat",
	"tail",
	"test",
	"tree",
	"type",
	"uniq",
	"wc",
	"where",
	"which",
]);

const READ_ONLY_GIT_COMMANDS = new Set([
	"blame",
	"describe",
	"diff",
	"grep",
	"log",
	"merge-base",
	"name-rev",
	"rev-parse",
	"shortlog",
	"show",
	"status",
]);

const SHELL_CONTROL_PATTERN = /[;&|><`\r\n]|\$\(/;
/**
 * Brace expansion, PowerShell array, expression and script block arguments, and the typographic quotes
 * PowerShell also strips build words the guard never sees.
 */
const ARGUMENT_EXPANSION_PATTERN = /\{[^}]*(?:,|\.\.)[^}]*\}|(?:^|\s)[(@{]|[‘-‟]/;
const EXECUTING_READ_OPTION_PATTERN = /(?:^|\s)(?:--pre(?:-glob)?|--ext-diff|--textconv)(?:[=\s]|$)/i;
const EXECUTING_GIT_LONG_OPTIONS = ["ext-diff", "open-files-in-pager", "output", "textconv"];

/** Git accepts bundled short options (`-nO<pager>`) and abbreviated long options (`--open=<pager>`). */
const isExecutingGitOption = (token: string): boolean => {
	if (/^-[^-]*O/.test(token)) return true;
	const name = /^--([^=]+)/.exec(token)?.[1].toLowerCase();
	return name !== undefined && EXECUTING_GIT_LONG_OPTIONS.some((option) => option.startsWith(name));
};

/**
 * Splits a command into the words the shell passes on, or returns undefined when a word depends on something
 * the guard cannot evaluate: `$` outside single quotes, an unquoted glob, an escaped quote or an unclosed quote.
 * Dropping backslashes covers both bash escapes and PowerShell's literal backslash.
 */
const shellWords = (command: string): string[] | undefined => {
	const words: string[] = [];
	let word = "";
	let inWord = false;
	let openBracket = false;
	let quote: string | undefined;
	for (let index = 0; index < command.length; index += 1) {
		const char = command[index];
		if (quote === "'") {
			if (char === "'") quote = undefined;
			else word += char;
			continue;
		}
		if (char === "$") return undefined;
		if (char === "\\") {
			if (command[index + 1] === "'" || command[index + 1] === '"') return undefined;
			inWord = true;
			continue;
		}
		if (quote === '"') {
			if (char === '"') quote = undefined;
			else word += char;
			continue;
		}
		if (/\s/.test(char)) {
			if (inWord) words.push(word);
			word = "";
			inWord = false;
			openBracket = false;
			continue;
		}
		inWord = true;
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (char === "*" || char === "?" || (char === "]" && openBracket)) return undefined;
		if (char === "[") openBracket = true;
		word += char;
	}
	if (quote) return undefined;
	if (inWord) words.push(word);
	return words;
};

const gitSubcommandIndex = (tokens: string[]): number => {
	for (let index = 1; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === "-C" || token === "--git-dir" || token === "--work-tree" || token === "--namespace") {
			index += 1;
			continue;
		}
		if (token === "--no-pager" || token === "--paginate" || token === "--literal-pathspecs") continue;
		if (token.startsWith("--git-dir=") || token.startsWith("--work-tree=") || token.startsWith("--namespace=")) {
			continue;
		}
		if (token.startsWith("-")) return -1;
		return index;
	}
	return -1;
};

const isReadOnlyGitBranch = (args: string[]): boolean =>
	args.length > 0 &&
	args.every((argument) => /^(?:--show-current|--list|--contains|--merged|--no-merged|-a|-r|-v|-vv)(?:=.*)?$/.test(argument));

const isReadOnlyGitTag = (args: string[]): boolean =>
	args.length > 0 && args.every((argument) => /^(?:--list|-l|--contains|--points-at)(?:=.*)?$/.test(argument));

const isReadOnlyGitRemote = (args: string[]): boolean => {
	const operation = args[0];
	return operation === "-v" || operation === "get-url" || operation === "show";
};

const isReadOnlyGit = (tokens: string[]): boolean => {
	const subcommandIndex = gitSubcommandIndex(tokens);
	if (subcommandIndex < 0) return false;

	const subcommand = tokens[subcommandIndex].toLowerCase();
	const args = tokens.slice(subcommandIndex + 1);
	if (READ_ONLY_GIT_COMMANDS.has(subcommand)) return true;
	if (subcommand === "branch") return isReadOnlyGitBranch(args);
	if (subcommand === "tag") return isReadOnlyGitTag(args);
	if (subcommand === "remote") return isReadOnlyGitRemote(args);
	if (subcommand === "worktree") return args[0] === "list";
	return subcommand === "ls-files" || subcommand === "ls-tree";
};

const isReadOnlyFind = (tokens: string[]): boolean => {
	const mutatingActions = new Set([
		"-delete",
		"-exec",
		"-execdir",
		"-fls",
		"-fprint",
		"-fprint0",
		"-fprintf",
		"-ok",
		"-okdir",
	]);
	return !tokens.some((token) => mutatingActions.has(token.toLowerCase()));
};

/** `tree -o <file>` writes the listing, and `-R` with `-H` writes `00Tree.html` into each directory. */
const isReadOnlyTree = (words: string[]): boolean =>
	!words.some((word) => /^-[^-]*[oR]/.test(word) || word.startsWith("--o"));

/** `uniq <input> <output>` writes its second operand. */
const isReadOnlyUniq = (words: string[]): boolean =>
	words.slice(1).filter((word) => !word.startsWith("-")).length <= 1;

/** `file -C` and its abbreviations of `--compile` write `magic.mgc`. */
const isReadOnlyFile = (words: string[]): boolean =>
	!words.some((word) => {
		const name = /^--([^=]+)/.exec(word)?.[1];
		return /^-[^-]*C/.test(word) || (name !== undefined && "compile".startsWith(name));
	});

/** Returns true only for a conservatively classified inspection command. */
export const isReadOnlyShellCommand = (command: string): boolean => {
	const trimmed = command.trim();
	if (!trimmed || SHELL_CONTROL_PATTERN.test(trimmed) || ARGUMENT_EXPANSION_PATTERN.test(trimmed)) return false;
	const words = shellWords(trimmed);
	if (!words || EXECUTING_READ_OPTION_PATTERN.test(words.join(" "))) return false;

	const executable = words[0]?.toLowerCase();
	if (!executable) return false;
	if (executable === "git") return !words.some(isExecutingGitOption) && isReadOnlyGit(words);
	if (executable === "find") return isReadOnlyFind(words);
	if (executable === "tree") return isReadOnlyTree(words);
	if (executable === "uniq") return isReadOnlyUniq(words);
	if (executable === "file") return isReadOnlyFile(words);
	if (executable === "[") return words[words.length - 1] === "]";
	return READ_ONLY_COMMANDS.has(executable);
};
