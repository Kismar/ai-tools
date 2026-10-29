import { createHash } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const TASK_ID_PATTERN = /^(\d{2})-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TASK_REFERENCE_PATTERN = /\b\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\b/g;
const MAX_FILE_BYTES = 200_000;
const MAX_PLAN_BYTES = 1_000_000;

const TASK_HEADINGS = [
	"Purpose",
	"Required outcome",
	"Dependencies",
	"In scope",
	"Out of scope",
	"Constraints",
	"Acceptance criteria",
	"Required verification",
	"Completion evidence",
] as const;

const GUIDE_HEADINGS = [
	"Repository evidence",
	"Architecture change",
	"Implementation approach",
	"Tests",
	"Documentation",
	"Verification",
] as const;

export interface PlanTask {
	readonly id: string;
	readonly folder: string;
	readonly dependencies: readonly string[];
	readonly taskMarkdown: string;
	readonly implementationGuideMarkdown: string;
}

export interface TaskPlan {
	readonly folder: string;
	readonly digest: string;
	readonly readmeMarkdown: string;
	readonly architectureMarkdown: string;
	readonly tasks: readonly PlanTask[];
}

export type PlanLoadFailureReason =
	| "missing-path"
	| "not-directory"
	| "missing-plan-file"
	| "invalid-task-folder"
	| "invalid-task-order"
	| "missing-section"
	| "invalid-dependency"
	| "too-large"
	| "io";

export type PlanLoadResult =
	| { readonly ok: true; readonly plan: TaskPlan }
	| { readonly ok: false; readonly reason: PlanLoadFailureReason };

export interface PlanCommandArguments {
	readonly planArgument: string;
	readonly startTaskReference?: string;
}

const START_TASK_SUFFIX = /\s+start\s+from\s+task\s+(\d{1,2}(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?)\s*$/i;

export const parsePlanCommandArguments = (argument: string): PlanCommandArguments => {
	const match = START_TASK_SUFFIX.exec(argument);
	if (!match) return { planArgument: argument.trim() };
	return {
		planArgument: argument.slice(0, match.index).trim(),
		startTaskReference: match[1].toLowerCase(),
	};
};

export const resolveStartTaskId = (plan: TaskPlan, reference?: string): string | undefined => {
	if (!reference) return plan.tasks[0]?.id;
	if (/^\d{1,2}$/.test(reference)) {
		return plan.tasks[Number(reference) - 1]?.id;
	}
	return plan.tasks.find((task) => task.id.toLowerCase() === reference.toLowerCase())?.id;
};

const markdownLines = (markdown: string): string[] => markdown.split(/\r?\n/);

const hasHeading = (markdown: string, heading: string): boolean =>
	markdownLines(markdown).some((line) => line.trim().toLowerCase() === `## ${heading.toLowerCase()}`);

const section = (markdown: string, heading: string): string | undefined => {
	const lines = markdownLines(markdown);
	const target = `## ${heading.toLowerCase()}`;
	const start = lines.findIndex((line) => line.trim().toLowerCase() === target);
	if (start < 0) return undefined;
	const next = lines.findIndex((line, index) => index > start && line.trim().startsWith("## "));
	const body = lines.slice(start + 1, next < 0 ? undefined : next).join("\n").trim();
	return body || undefined;
};

const cleanPathArgument = (argument: string): string => {
	let value = argument.trim();
	if (value.startsWith("@")) value = value.slice(1).trim();
	if (
		value.length >= 2 &&
		((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
	) {
		value = value.slice(1, -1);
	}
	return value.trim();
};

export const resolvePlanPath = (argument: string, cwd: string): string | undefined => {
	const cleaned = cleanPathArgument(argument);
	if (!cleaned) return undefined;
	const expanded = cleaned === "~" ? homedir() : cleaned.startsWith("~/") || cleaned.startsWith("~\\") ? join(homedir(), cleaned.slice(2)) : cleaned;
	return resolve(isAbsolute(expanded) ? expanded : join(cwd, expanded));
};

const readBoundedFile = async (path: string): Promise<{ content: string; bytes: number } | undefined> => {
	const fileStat = await stat(path);
	if (!fileStat.isFile() || fileStat.size > MAX_FILE_BYTES) return undefined;
	return { content: await readFile(path, "utf8"), bytes: fileStat.size };
};

export const loadTaskPlan = async (argument: string, cwd: string): Promise<PlanLoadResult> => {
	const requestedPath = resolvePlanPath(argument, cwd);
	if (!requestedPath) return { ok: false, reason: "missing-path" };

	try {
		const folder = await realpath(requestedPath);
		if (!(await stat(folder)).isDirectory()) return { ok: false, reason: "not-directory" };

		const readme = await readBoundedFile(join(folder, "README.md"));
		const architecture = await readBoundedFile(join(folder, "architecture.md"));
		if (!readme || !architecture) return { ok: false, reason: "missing-plan-file" };

		const tasksFolder = join(folder, "tasks");
		if (!(await stat(tasksFolder)).isDirectory()) return { ok: false, reason: "missing-plan-file" };
		const entries = (await readdir(tasksFolder, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
		if (entries.length === 0 || entries.length > 99) return { ok: false, reason: "invalid-task-folder" };

		const taskFiles: Array<{
			id: string;
			folder: string;
			taskMarkdown: string;
			implementationGuideMarkdown: string;
		}> = [];
		let totalBytes = readme.bytes + architecture.bytes;

		for (const [index, id] of entries.entries()) {
			const match = TASK_ID_PATTERN.exec(id);
			if (!match) return { ok: false, reason: "invalid-task-folder" };
			if (Number(match[1]) !== index + 1) return { ok: false, reason: "invalid-task-order" };
			const taskFolder = join(tasksFolder, id);
			const task = await readBoundedFile(join(taskFolder, "task.md"));
			const guide = await readBoundedFile(join(taskFolder, "implementation-guide.md"));
			if (!task || !guide) return { ok: false, reason: "missing-plan-file" };
			totalBytes += task.bytes + guide.bytes;
			if (totalBytes > MAX_PLAN_BYTES) return { ok: false, reason: "too-large" };
			if (TASK_HEADINGS.some((heading) => !hasHeading(task.content, heading))) {
				return { ok: false, reason: "missing-section" };
			}
			if (GUIDE_HEADINGS.some((heading) => !hasHeading(guide.content, heading))) {
				return { ok: false, reason: "missing-section" };
			}
			taskFiles.push({
				id,
				folder: taskFolder,
				taskMarkdown: task.content,
				implementationGuideMarkdown: guide.content,
			});
		}

		const knownIds = new Set(entries);
		const tasks: PlanTask[] = [];
		for (const [index, task] of taskFiles.entries()) {
			const dependencySection = section(task.taskMarkdown, "Dependencies");
			if (!dependencySection) return { ok: false, reason: "missing-section" };
			const dependencies = [...new Set(dependencySection.match(TASK_REFERENCE_PATTERN) ?? [])];
			if (
				dependencies.some((dependency) => !knownIds.has(dependency) || entries.indexOf(dependency) >= index)
			) {
				return { ok: false, reason: "invalid-dependency" };
			}
			tasks.push({ ...task, dependencies });
		}

		const digest = createHash("sha256")
			.update(readme.content)
			.update("\0")
			.update(architecture.content)
			.update("\0")
			.update(
				tasks
					.flatMap((task) => [task.id, task.taskMarkdown, task.implementationGuideMarkdown])
					.join("\0"),
			)
			.digest("hex");
		return {
			ok: true,
			plan: {
				folder,
				digest,
				readmeMarkdown: readme.content,
				architectureMarkdown: architecture.content,
				tasks,
			},
		};
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
		if (code === "ENOENT") return { ok: false, reason: "missing-plan-file" };
		return { ok: false, reason: "io" };
	}
};
