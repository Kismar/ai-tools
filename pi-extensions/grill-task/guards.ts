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
const EXECUTING_READ_OPTION_PATTERN = /(?:^|\s)(?:--pre(?:-glob)?|--ext-diff|--textconv)(?:[=\s]|$)/i;

const tokenize = (command: string): string[] => command.trim().split(/\s+/).filter(Boolean);

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
		"-fprintf",
		"-ok",
		"-okdir",
	]);
	return !tokens.some((token) => mutatingActions.has(token.toLowerCase()));
};

/** Returns true only for a conservatively classified inspection command. */
export const isReadOnlyShellCommand = (command: string): boolean => {
	const trimmed = command.trim();
	if (!trimmed || SHELL_CONTROL_PATTERN.test(trimmed) || EXECUTING_READ_OPTION_PATTERN.test(trimmed)) return false;

	const tokens = tokenize(trimmed);
	const executable = tokens[0]?.toLowerCase();
	if (!executable) return false;
	if (executable === "git") return isReadOnlyGit(tokens);
	if (executable === "find") return isReadOnlyFind(tokens);
	if (executable === "[") return tokens[tokens.length - 1] === "]";
	return READ_ONLY_COMMANDS.has(executable);
};
