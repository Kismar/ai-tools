import type { ExecResult } from "@earendil-works/pi-coding-agent";

export type GitExec = (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => Promise<ExecResult>;

export interface GitSnapshot {
	readonly head: string;
	readonly branch: string;
	readonly porcelain: string;
}

export type GitVerificationResult =
	| { readonly ok: true; readonly commitHash: string; readonly commitMessage: string }
	| { readonly ok: false; readonly reason: string };

const runGit = async (exec: GitExec, cwd: string, args: string[]): Promise<ExecResult> =>
	exec("git", args, { cwd, timeout: 30_000 });

export const captureGitSnapshot = async (exec: GitExec, cwd: string): Promise<GitSnapshot | undefined> => {
	const [headResult, branchResult, statusResult] = await Promise.all([
		runGit(exec, cwd, ["rev-parse", "HEAD"]),
		runGit(exec, cwd, ["branch", "--show-current"]),
		runGit(exec, cwd, ["status", "--porcelain"]),
	]);
	if (headResult.code !== 0 || branchResult.code !== 0 || statusResult.code !== 0) return undefined;
	const head = headResult.stdout.trim();
	if (!/^[0-9a-f]{40,64}$/i.test(head)) return undefined;
	return {
		head,
		branch: branchResult.stdout.trim() || "detached HEAD",
		porcelain: statusResult.stdout.trim(),
	};
};

export const verifyReportedCommit = async (
	exec: GitExec,
	cwd: string,
	before: GitSnapshot,
	reportedHash: string | undefined,
	reportedMessage: string | undefined,
	priorTaskCommit: string | undefined,
): Promise<GitVerificationResult> => {
	if (!reportedHash || !reportedMessage) return { ok: false, reason: "The completed report has no commit hash or message." };
	const after = await captureGitSnapshot(exec, cwd);
	if (!after) return { ok: false, reason: "Git HEAD is unavailable after the subagent run." };
	if (before.porcelain) return { ok: false, reason: "The working tree was not clean before the subagent run." };
	if (after.branch !== before.branch) return { ok: false, reason: "The subagent changed the Git branch." };
	if (after.porcelain) return { ok: false, reason: "The subagent left uncommitted repository changes." };
	if (after.head === before.head) return { ok: false, reason: "The subagent did not create or amend a commit." };

	const commit = await runGit(exec, cwd, ["show", "-s", "--format=%H%n%s", reportedHash]);
	if (commit.code !== 0) return { ok: false, reason: "The reported commit does not exist in this repository." };
	const [fullHash, ...subjectParts] = commit.stdout.trimEnd().split(/\r?\n/);
	const subject = subjectParts.join(" ").trim();
	if (fullHash !== after.head) return { ok: false, reason: "The reported commit is not the current Git HEAD." };
	if (subject !== reportedMessage.trim()) return { ok: false, reason: "The reported commit message does not match Git." };

	if (priorTaskCommit) {
		if (before.head !== priorTaskCommit) {
			return { ok: false, reason: "A correction can amend a task commit only while that commit is HEAD." };
		}
		const [beforeParent, afterParent] = await Promise.all([
			runGit(exec, cwd, ["show", "-s", "--format=%P", before.head]),
			runGit(exec, cwd, ["show", "-s", "--format=%P", after.head]),
		]);
		if (
			beforeParent.code !== 0 ||
			afterParent.code !== 0 ||
			beforeParent.stdout.trim() !== afterParent.stdout.trim()
		) {
			return { ok: false, reason: "The correction did not amend exactly the current task commit." };
		}
	} else {
		const [count, parents] = await Promise.all([
			runGit(exec, cwd, ["rev-list", "--count", `${before.head}..${after.head}`]),
			runGit(exec, cwd, ["show", "-s", "--format=%P", after.head]),
		]);
		if (count.code !== 0 || count.stdout.trim() !== "1" || parents.code !== 0 || parents.stdout.trim() !== before.head) {
			return { ok: false, reason: "The subagent must create exactly one new task commit after the prior HEAD." };
		}
	}

	return { ok: true, commitHash: fullHash, commitMessage: subject };
};

export interface ExpectedCommit {
	readonly hash: string;
	readonly message: string;
}

export const verifyFinalCommitSequence = async (
	exec: GitExec,
	cwd: string,
	expected: readonly ExpectedCommit[],
	expectedBranch: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> => {
	const snapshot = await captureGitSnapshot(exec, cwd);
	if (!snapshot) return { ok: false, reason: "Git repository state is unavailable." };
	if (snapshot.branch !== expectedBranch) return { ok: false, reason: "The current branch differs from the workflow branch." };

	let previous: string | undefined;
	for (const commit of expected) {
		const show = await runGit(exec, cwd, ["show", "-s", "--format=%H%n%s", commit.hash]);
		if (show.code !== 0) return { ok: false, reason: `Task commit ${commit.hash} does not exist.` };
		const [hash, ...subjectParts] = show.stdout.trimEnd().split(/\r?\n/);
		if (hash !== commit.hash || subjectParts.join(" ").trim() !== commit.message) {
			return { ok: false, reason: `Task commit ${commit.hash} no longer matches its verified report.` };
		}
		const reachable = await runGit(exec, cwd, ["merge-base", "--is-ancestor", commit.hash, snapshot.head]);
		if (reachable.code !== 0) return { ok: false, reason: `Task commit ${commit.hash} is not reachable from HEAD.` };
		if (previous) {
			const ordered = await runGit(exec, cwd, ["merge-base", "--is-ancestor", previous, commit.hash]);
			if (ordered.code !== 0) return { ok: false, reason: "Task commits are not in execution order." };
		}
		previous = commit.hash;
	}
	return { ok: true };
};

export interface RepositorySummary {
	readonly head: string;
	readonly branch: string;
	readonly workingTreeClean: boolean;
	readonly pushed: boolean;
}

export const inspectRepository = async (
	exec: GitExec,
	cwd: string,
	commitHashes: readonly string[],
): Promise<RepositorySummary | undefined> => {
	const [head, branch, status] = await Promise.all([
		runGit(exec, cwd, ["rev-parse", "HEAD"]),
		runGit(exec, cwd, ["branch", "--show-current"]),
		runGit(exec, cwd, ["status", "--porcelain"]),
	]);
	if (head.code !== 0 || branch.code !== 0 || status.code !== 0) return undefined;
	let pushed = false;
	for (const hash of commitHashes) {
		const remote = await runGit(exec, cwd, ["branch", "-r", "--contains", hash]);
		if (remote.code === 0 && remote.stdout.trim()) {
			pushed = true;
			break;
		}
	}
	return {
		head: head.stdout.trim(),
		branch: branch.stdout.trim() || "detached HEAD",
		workingTreeClean: status.stdout.trim().length === 0,
		pushed,
	};
};
