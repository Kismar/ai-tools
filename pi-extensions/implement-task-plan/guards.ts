const SHELL_COMPOSITION = /(?:^|[^\\])(?:&&|\|\||[;&|<>`])|\$\(|\r|\n/;
/** Brace expansion and PowerShell array or expression arguments build words the guard never sees. */
const ARGUMENT_EXPANSION = /\{[^}]*(?:,|\.\.)[^}]*\}|(?:^|\s)[(@]/;
const WRITE_CAPABLE_GIT_OPTIONS = ["ext-diff", "open-files-in-pager", "output", "textconv"];
const READ_ONLY_GIT =
	/^\s*git\s+(?:status|diff|show|log|rev-parse|rev-list|merge-base|ls-files|grep)(?:\s|$)|^\s*git\s+branch\s+(?:--show-current|-a|-r|--contains)(?:\s|$)/i;
const UV_VALIDATION =
	/^\s*uv\s+run\s+(?:ruff\s+(?:format\s+--check|check)|pyright|pytest|pip-audit|detect-secrets\s+scan)(?:\s|$)/i;
const NODE_VALIDATION = /^\s*node\s+--test(?:\s|$)/i;
const PYTHON_VALIDATION = /^\s*(?:python|python3)\s+-m\s+(?:pytest|unittest|mypy|ruff)(?:\s|$)/i;
const JS_VALIDATION = /^\s*(?:npm|pnpm|yarn)\s+(?:test|run\s+(?:test|lint|check|build|typecheck|format:check))(?:\s|$)/i;
const OTHER_VALIDATION =
	/^\s*(?:cargo\s+(?:test|check|clippy|fmt\s+--check)|go\s+test|dotnet\s+(?:test|build)|mvn\s+(?:test|verify)|(?:gradle|\.\/gradlew)\s+(?:test|check|build)|make\s+(?:test|check|lint))(?:\s|$)/i;

/** Git accepts bundled short options (`-nO<pager>`) and abbreviated long options (`--open=<pager>`). */
const isWriteCapableGitOption = (token: string): boolean => {
	if (/^-[^-]*O/.test(token)) return true;
	const name = /^--([^=]+)/.exec(token)?.[1].toLowerCase();
	return name !== undefined && WRITE_CAPABLE_GIT_OPTIONS.some((option) => option.startsWith(name));
};

/** Removes quotes and escapes, so `'--output'`, `\-O` and `$'-O'` are checked as the option the shell passes on. */
const unquote = (command: string): string => command.replace(/\$(?=['"])/g, "").replace(/['"\\]/g, "");

export const isOrchestratorShellCommandAllowed = (command: string): boolean => {
	const trimmed = command.trim();
	if (!trimmed || SHELL_COMPOSITION.test(trimmed) || ARGUMENT_EXPANSION.test(trimmed)) return false;
	if (unquote(trimmed).split(/\s+/).some(isWriteCapableGitOption)) return false;
	return [READ_ONLY_GIT, UV_VALIDATION, NODE_VALIDATION, PYTHON_VALIDATION, JS_VALIDATION, OTHER_VALIDATION].some(
		(pattern) => pattern.test(trimmed),
	);
};
