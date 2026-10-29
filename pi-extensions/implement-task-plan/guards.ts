const SHELL_COMPOSITION = /(?:^|[^\\])(?:&&|\|\||[;&|<>`])|\$\(|\r|\n/;
/**
 * Brace expansion, PowerShell array, expression and script block arguments, and the typographic quotes
 * PowerShell also strips build words the guard never sees.
 */
const ARGUMENT_EXPANSION = /\{[^}]*(?:,|\.\.)[^}]*\}|(?:^|\s)[(@{]|[‘-‟]/;
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

export const isOrchestratorShellCommandAllowed = (command: string): boolean => {
	const trimmed = command.trim();
	if (!trimmed || SHELL_COMPOSITION.test(trimmed) || ARGUMENT_EXPANSION.test(trimmed)) return false;
	const words = shellWords(trimmed);
	if (!words || words.some(isWriteCapableGitOption)) return false;
	return [READ_ONLY_GIT, UV_VALIDATION, NODE_VALIDATION, PYTHON_VALIDATION, JS_VALIDATION, OTHER_VALIDATION].some(
		(pattern) => pattern.test(trimmed),
	);
};
