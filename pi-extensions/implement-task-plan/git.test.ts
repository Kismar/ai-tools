import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
	captureGitSnapshot,
	inspectRepository,
	verifyFinalCommitSequence,
	verifyReportedCommit,
	type GitExec,
} from "./git.ts";

const execFileAsync = promisify(execFile);

const gitExec: GitExec = async (command, args, options) => {
	try {
		const result = await execFileAsync(command, args, { cwd: options?.cwd, timeout: options?.timeout });
		return { stdout: result.stdout, stderr: result.stderr, code: 0, killed: false };
	} catch (error) {
		const value = error as { stdout?: string; stderr?: string; code?: number; killed?: boolean };
		return {
			stdout: value.stdout ?? "",
			stderr: value.stderr ?? "",
			code: typeof value.code === "number" ? value.code : 1,
			killed: value.killed ?? false,
		};
	}
};

const git = async (cwd: string, ...args: string[]): Promise<string> => {
	const result = await gitExec("git", args, { cwd });
	assert.equal(result.code, 0, result.stderr);
	return result.stdout.trim();
};

const createRepository = async (): Promise<string> => {
	const cwd = await mkdtemp(join(tmpdir(), "implement-task-plan-git-"));
	await git(cwd, "init");
	await git(cwd, "config", "user.email", "test@example.invalid");
	await git(cwd, "config", "user.name", "Test User");
	await writeFile(join(cwd, "file.txt"), "baseline\n", "utf8");
	await git(cwd, "add", "file.txt");
	await git(cwd, "commit", "-m", "chore: baseline");
	return cwd;
};

test("verifies one reported task commit against Git", async () => {
	const cwd = await createRepository();
	try {
		const before = await captureGitSnapshot(gitExec, cwd);
		assert.ok(before);
		await writeFile(join(cwd, "file.txt"), "changed\n", "utf8");
		await git(cwd, "add", "file.txt");
		await git(cwd, "commit", "-m", "feat: task change");
		const head = await git(cwd, "rev-parse", "HEAD");
		const result = await verifyReportedCommit(gitExec, cwd, before, head, "feat: task change", undefined);
		assert.deepEqual(result, { ok: true, commitHash: head, commitMessage: "feat: task change" });
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("rejects amendment of the pre-task commit", async () => {
	const cwd = await createRepository();
	try {
		const before = await captureGitSnapshot(gitExec, cwd);
		assert.ok(before);
		await writeFile(join(cwd, "file.txt"), "changed\n", "utf8");
		await git(cwd, "add", "file.txt");
		await git(cwd, "commit", "--amend", "-m", "feat: rewritten baseline");
		const head = await git(cwd, "rev-parse", "HEAD");
		const result = await verifyReportedCommit(gitExec, cwd, before, head, "feat: rewritten baseline", undefined);
		assert.equal(result.ok, false);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("rejects a stale or fabricated reported hash", async () => {
	const cwd = await createRepository();
	try {
		const before = await captureGitSnapshot(gitExec, cwd);
		assert.ok(before);
		await writeFile(join(cwd, "file.txt"), "changed\n", "utf8");
		await git(cwd, "add", "file.txt");
		await git(cwd, "commit", "-m", "feat: task change");
		const result = await verifyReportedCommit(gitExec, cwd, before, before.head, "chore: baseline", undefined);
		assert.equal(result.ok, false);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("verifies final commit reachability, messages, and sequence", async () => {
	const cwd = await createRepository();
	try {
		await writeFile(join(cwd, "file.txt"), "first\n", "utf8");
		await git(cwd, "add", "file.txt");
		await git(cwd, "commit", "-m", "feat: first");
		const first = await git(cwd, "rev-parse", "HEAD");
		await writeFile(join(cwd, "file.txt"), "second\n", "utf8");
		await git(cwd, "add", "file.txt");
		await git(cwd, "commit", "-m", "feat: second");
		const second = await git(cwd, "rev-parse", "HEAD");
		const branch = await git(cwd, "branch", "--show-current");
		assert.deepEqual(
			await verifyFinalCommitSequence(
				gitExec,
				cwd,
				[
					{ hash: first, message: "feat: first" },
					{ hash: second, message: "feat: second" },
				],
				branch,
			),
			{ ok: true },
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("inspects branch and working-tree state", async () => {
	const cwd = await createRepository();
	try {
		const head = await git(cwd, "rev-parse", "HEAD");
		const summary = await inspectRepository(gitExec, cwd, [head]);
		assert.ok(summary);
		assert.equal(summary.workingTreeClean, true);
		assert.equal(summary.pushed, false);
		assert.ok(summary.branch);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
