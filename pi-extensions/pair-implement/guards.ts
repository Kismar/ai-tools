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
/** Brace expansion and PowerShell array or expression arguments build words the guard never sees. */
const ARGUMENT_EXPANSION_PATTERN = /\{[^}]*(?:,|\.\.)[^}]*\}|(?:^|\s)[(@]/;
const EXECUTING_READ_OPTION_PATTERN = /(?:^|\s)(?:--pre(?:-glob)?|--ext-diff|--textconv)(?:[=\s]|$)/i;
const EXECUTING_GIT_LONG_OPTIONS = ["ext-diff", "open-files-in-pager", "output", "textconv"];

/** Git accepts bundled short options (`-nO<pager>`) and abbreviated long options (`--open=<pager>`). */
const isExecutingGitOption = (token: string): boolean => {
	if (/^-[^-]*O/.test(token)) return true;
	const name = /^--([^=]+)/.exec(token)?.[1].toLowerCase();
	return name !== undefined && EXECUTING_GIT_LONG_OPTIONS.some((option) => option.startsWith(name));
};

const tokenize = (command: string): string[] => command.trim().split(/\s+/).filter(Boolean);

/** Removes quotes and escapes, so `'--pre'`, `\-O` and `$'-O'` are checked as the option the shell passes on. */
const unquote = (command: string): string => command.replace(/\$(?=['"])/g, "").replace(/['"\\]/g, "");

const gitSubcommandIndex = (tokens: string[]): number => {
	for (let index = 1; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === "-C" || token === "--git-dir" || token === "--work-tree" || token === "--namespace") {
			index += 1;
			continue;
		}
		if (token === "--no-pager" || token === "--paginate" || token === "--literal-pathspecs") {
			continue;
		}
		if (token.startsWith("--git-dir=") || token.startsWith("--work-tree=") || token.startsWith("--namespace=")) {
			continue;
		}
		if (token.startsWith("-")) {
			return -1;
		}
		return index;
	}
	return -1;
};

const isReadOnlyGitBranch = (args: string[]): boolean => {
	if (args.length === 0) return false;
	return args.every((argument) =>
		/^(?:--show-current|--list|--contains|--merged|--no-merged|-a|-r|-v|-vv)(?:=.*)?$/.test(argument),
	);
};

const isReadOnlyGitTag = (args: string[]): boolean => {
	if (args.length === 0) return false;
	return args.every((argument) => /^(?:--list|-l|--contains|--points-at)(?:=.*)?$/.test(argument));
};

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
	if (subcommand === "ls-files" || subcommand === "ls-tree") return true;
	return false;
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

/** Returns whether a shell command is conservatively classified as read-only. */
export const isReadOnlyShellCommand = (command: string): boolean => {
	const trimmed = command.trim();
	if (!trimmed || SHELL_CONTROL_PATTERN.test(trimmed) || ARGUMENT_EXPANSION_PATTERN.test(trimmed)) return false;
	const unquoted = unquote(trimmed);
	if (EXECUTING_READ_OPTION_PATTERN.test(unquoted)) return false;

	const tokens = tokenize(trimmed);
	const executable = tokens[0]?.toLowerCase();
	if (!executable) return false;
	if (executable === "git") return !tokenize(unquoted).some(isExecutingGitOption) && isReadOnlyGit(tokens);
	if (executable === "find") return isReadOnlyFind(tokens);
	if (executable === "[") return tokens[tokens.length - 1] === "]";
	return READ_ONLY_COMMANDS.has(executable);
};

const FORBIDDEN_REMOTE_PATTERNS = [
	/\bgit(?:\.exe)?\b[^\r\n;&|]*\bpush\b/i,
	/\bglab\s+mr\s+(?:create|merge|update|close|delete)\b/i,
	/\bgh\s+pr\s+(?:create|merge|edit|close|reopen)\b/i,
	/\bhub\s+pull-request\b/i,
	/\baz\s+repos\s+pr\s+create\b/i,
	/\bbb\s+pr\s+create\b/i,
];

/** Returns whether a command performs a prohibited push or change-request operation. */
export const isForbiddenRemoteCommand = (command: string): boolean =>
	FORBIDDEN_REMOTE_PATTERNS.some((pattern) => pattern.test(command));

const LOCAL_BRANCH_SETUP_PATTERN =
	/^git\s+(?:(?:-C\s+\S+|--git-dir(?:=|\s+)\S+|--work-tree(?:=|\s+)\S+)\s+)*(?:(?:switch\s+(?:-c\s+)?|checkout\s+-b\s+)\S+)$/i;

/** Returns whether a command only creates or selects the locally approved branch. */
export const isLocalBranchSetupCommand = (command: string): boolean => LOCAL_BRANCH_SETUP_PATTERN.test(command.trim());
