const SHELL_COMPOSITION = /(?:^|[^\\])(?:&&|\|\||[;&|<>`])|\$\(|\r|\n/;
const WRITE_CAPABLE_GIT_OPTION = /--(?:output|ext-diff|textconv)(?:=|\s|$)/i;
const READ_ONLY_GIT =
	/^\s*git\s+(?:status|diff|show|log|rev-parse|rev-list|merge-base|ls-files|grep)(?:\s|$)|^\s*git\s+branch\s+(?:--show-current|-a|-r|--contains)(?:\s|$)/i;
const UV_VALIDATION =
	/^\s*uv\s+run\s+(?:ruff\s+(?:format\s+--check|check)|pyright|pytest|pip-audit|detect-secrets\s+scan)(?:\s|$)/i;
const NODE_VALIDATION = /^\s*node\s+--test(?:\s|$)/i;
const PYTHON_VALIDATION = /^\s*(?:python|python3)\s+-m\s+(?:pytest|unittest|mypy|ruff)(?:\s|$)/i;
const JS_VALIDATION = /^\s*(?:npm|pnpm|yarn)\s+(?:test|run\s+(?:test|lint|check|build|typecheck|format:check))(?:\s|$)/i;
const OTHER_VALIDATION =
	/^\s*(?:cargo\s+(?:test|check|clippy|fmt\s+--check)|go\s+test|dotnet\s+(?:test|build)|mvn\s+(?:test|verify)|(?:gradle|\.\/gradlew)\s+(?:test|check|build)|make\s+(?:test|check|lint))(?:\s|$)/i;

export const isOrchestratorShellCommandAllowed = (command: string): boolean => {
	const trimmed = command.trim();
	if (!trimmed || SHELL_COMPOSITION.test(trimmed) || WRITE_CAPABLE_GIT_OPTION.test(trimmed)) return false;
	return [READ_ONLY_GIT, UV_VALIDATION, NODE_VALIDATION, PYTHON_VALIDATION, JS_VALIDATION, OTHER_VALIDATION].some(
		(pattern) => pattern.test(trimmed),
	);
};
