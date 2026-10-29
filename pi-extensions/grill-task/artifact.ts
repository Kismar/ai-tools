import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface PlanTask {
	readonly id: string;
	readonly dependencies: readonly string[];
	readonly taskMarkdown: string;
	readonly implementationGuideMarkdown: string;
}

export interface PlanDraft {
	readonly projectSlug: string;
	readonly featureSlug: string;
	readonly readmeMarkdown: string;
	readonly architectureMarkdown: string;
	readonly tasks: readonly PlanTask[];
}

export interface ArtifactFile {
	readonly relativePath: string;
	readonly content: string;
}

export type DraftFailureReason =
	| "invalid-structure"
	| "invalid-slug"
	| "invalid-task-id"
	| "invalid-dependency"
	| "missing-section"
	| "unresolved-question"
	| "invalid-diagrams"
	| "too-large";

export type DraftValidationResult =
	| { readonly ok: true; readonly draft: PlanDraft }
	| { readonly ok: false; readonly reason: DraftFailureReason };

export type WritePlanResult =
	| { readonly ok: true; readonly folder: string; readonly firstTaskFolder: string }
	| { readonly ok: false; readonly reason: "invalid-draft" | "io" };

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TASK_ID_PATTERN = /^(\d{2})-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG_LENGTH = 80;
const MAX_FILE_BYTES = 200_000;
const MAX_PLAN_BYTES = 1_000_000;
const FORBIDDEN_OPEN_ITEM_PATTERN = /\b(?:TBD|TODO|TO BE DECIDED|UNRESOLVED|OPEN QUESTION)\b|\?\?\?/i;

const REQUIRED_TASK_SECTIONS = [
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

const REQUIRED_GUIDE_SECTIONS = [
	"Repository evidence",
	"Architecture change",
	"Implementation approach",
	"Tests",
	"Documentation",
	"Verification",
] as const;

const hasSection = (markdown: string, heading: string): boolean =>
	new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "im").test(markdown);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const parseTask = (value: unknown): PlanTask | undefined => {
	if (!isRecord(value) || typeof value.id !== "string" || !Array.isArray(value.dependencies)) return undefined;
	if (!value.dependencies.every((dependency) => typeof dependency === "string")) return undefined;
	if (typeof value.taskMarkdown !== "string" || typeof value.implementationGuideMarkdown !== "string") return undefined;
	return {
		id: value.id,
		dependencies: [...value.dependencies],
		taskMarkdown: value.taskMarkdown,
		implementationGuideMarkdown: value.implementationGuideMarkdown,
	};
};

const parseDraft = (value: unknown): PlanDraft | undefined => {
	if (!isRecord(value)) return undefined;
	if (typeof value.projectSlug !== "string" || typeof value.featureSlug !== "string") return undefined;
	if (typeof value.readmeMarkdown !== "string" || typeof value.architectureMarkdown !== "string") return undefined;
	if (!Array.isArray(value.tasks)) return undefined;
	const tasks = value.tasks.map(parseTask);
	if (tasks.some((task) => task === undefined)) return undefined;
	return {
		projectSlug: value.projectSlug,
		featureSlug: value.featureSlug,
		readmeMarkdown: value.readmeMarkdown,
		architectureMarkdown: value.architectureMarkdown,
		tasks: tasks as PlanTask[],
	};
};

const validSlug = (value: string): boolean => value.length <= MAX_SLUG_LENGTH && SLUG_PATTERN.test(value);

const markdownValues = (draft: PlanDraft): string[] => [
	draft.readmeMarkdown,
	draft.architectureMarkdown,
	...draft.tasks.flatMap((task) => [task.taskMarkdown, task.implementationGuideMarkdown]),
];

export const validatePlanDraft = (value: unknown): DraftValidationResult => {
	const draft = parseDraft(value);
	if (!draft || draft.tasks.length === 0 || draft.tasks.length > 99) {
		return { ok: false, reason: "invalid-structure" };
	}
	if (!validSlug(draft.projectSlug) || !validSlug(draft.featureSlug)) {
		return { ok: false, reason: "invalid-slug" };
	}

	const taskIds = new Set<string>();
	for (const [index, task] of draft.tasks.entries()) {
		const match = TASK_ID_PATTERN.exec(task.id);
		if (!match || Number(match[1]) !== index + 1 || taskIds.has(task.id)) {
			return { ok: false, reason: "invalid-task-id" };
		}
		if (task.dependencies.some((dependency) => !taskIds.has(dependency))) {
			return { ok: false, reason: "invalid-dependency" };
		}
		if (new Set(task.dependencies).size !== task.dependencies.length) {
			return { ok: false, reason: "invalid-dependency" };
		}
		if (REQUIRED_TASK_SECTIONS.some((section) => !hasSection(task.taskMarkdown, section))) {
			return { ok: false, reason: "missing-section" };
		}
		if (REQUIRED_GUIDE_SECTIONS.some((section) => !hasSection(task.implementationGuideMarkdown, section))) {
			return { ok: false, reason: "missing-section" };
		}
		taskIds.add(task.id);
	}

	if (["Purpose", "Scope", "Task index", "Dependency graph"].some((section) => !hasSection(draft.readmeMarkdown, section))) {
		return { ok: false, reason: "missing-section" };
	}
	if (
		["Current architecture", "Target architecture", "Architecture changes"].some(
			(section) => !hasSection(draft.architectureMarkdown, section),
		)
	) {
		return { ok: false, reason: "missing-section" };
	}
	if ((draft.architectureMarkdown.match(/```mermaid\s/gi) ?? []).length < 2) {
		return { ok: false, reason: "invalid-diagrams" };
	}
	if (!/```mermaid\s[\s\S]*?(?:graph|flowchart)\s/gi.test(draft.readmeMarkdown)) {
		return { ok: false, reason: "invalid-diagrams" };
	}

	const markdown = markdownValues(draft);
	if (markdown.some((content) => !content.trim() || FORBIDDEN_OPEN_ITEM_PATTERN.test(content))) {
		return { ok: false, reason: "unresolved-question" };
	}
	const byteLengths = markdown.map((content) => Buffer.byteLength(content, "utf8"));
	if (byteLengths.some((length) => length > MAX_FILE_BYTES) || byteLengths.reduce((sum, length) => sum + length, 0) > MAX_PLAN_BYTES) {
		return { ok: false, reason: "too-large" };
	}
	return { ok: true, draft };
};

const withFinalNewline = (content: string): string => `${content.trimEnd()}\n`;

export const buildArtifactFiles = (draft: PlanDraft): ArtifactFile[] => [
	{ relativePath: "README.md", content: withFinalNewline(draft.readmeMarkdown) },
	{ relativePath: "architecture.md", content: withFinalNewline(draft.architectureMarkdown) },
	...draft.tasks.flatMap((task) => [
		{ relativePath: join("tasks", task.id, "task.md"), content: withFinalNewline(task.taskMarkdown) },
		{
			relativePath: join("tasks", task.id, "implementation-guide.md"),
			content: withFinalNewline(task.implementationGuideMarkdown),
		},
	]),
];

export const nextVersionedFolderName = (featureSlug: string, existingNames: ReadonlySet<string>): string => {
	if (!existingNames.has(featureSlug)) return featureSlug;
	for (let version = 2; version < Number.MAX_SAFE_INTEGER; version += 1) {
		const candidate = `${featureSlug}-v${version}`;
		if (!existingNames.has(candidate)) return candidate;
	}
	throw new Error("No plan folder version is available.");
};

const pathExists = async (path: string): Promise<boolean> => {
	try {
		await stat(path);
		return true;
	} catch (error) {
		const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
		if (code === "ENOENT") return false;
		throw error;
	}
};

const nextAvailableFolder = async (projectFolder: string, featureSlug: string): Promise<string> => {
	if (!(await pathExists(join(projectFolder, featureSlug)))) return featureSlug;
	for (let version = 2; version < Number.MAX_SAFE_INTEGER; version += 1) {
		const candidate = `${featureSlug}-v${version}`;
		if (!(await pathExists(join(projectFolder, candidate)))) return candidate;
	}
	throw new Error("No plan folder version is available.");
};

const isCollision = async (error: unknown, target: string): Promise<boolean> => {
	const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
	if (code === "EEXIST" || code === "ENOTEMPTY") return true;
	return code === "EPERM" && (await pathExists(target));
};

export const writePlanAtomically = async (
	value: unknown,
	root: string,
	id: () => string = randomUUID,
): Promise<WritePlanResult> => {
	const validation = validatePlanDraft(value);
	if (!validation.ok) return { ok: false, reason: "invalid-draft" };

	const { draft } = validation;
	const files = buildArtifactFiles(draft);
	const projectFolder = join(root, draft.projectSlug);
	const temporaryFolder = join(projectFolder, `.${draft.featureSlug}.tmp-${id()}`);

	try {
		await mkdir(projectFolder, { recursive: true });
		await mkdir(temporaryFolder, { recursive: false });
		for (const file of files) {
			const target = join(temporaryFolder, file.relativePath);
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, file.content, { encoding: "utf8", flag: "wx" });
		}
		for (const file of files) {
			const written = await readFile(join(temporaryFolder, file.relativePath), "utf8");
			if (written !== file.content) throw new Error("Artifact validation failed.");
		}

		let folderName = await nextAvailableFolder(projectFolder, draft.featureSlug);
		while (true) {
			const target = join(projectFolder, folderName);
			try {
				await rename(temporaryFolder, target);
				const firstTask = draft.tasks.find((task) => task.dependencies.length === 0) ?? draft.tasks[0];
				return { ok: true, folder: target, firstTaskFolder: join(target, "tasks", firstTask.id) };
			} catch (error) {
				if (!(await isCollision(error, target))) throw error;
				folderName = await nextAvailableFolder(projectFolder, draft.featureSlug);
			}
		}
	} catch {
		await rm(temporaryFolder, { recursive: true, force: true }).catch(() => undefined);
		return { ok: false, reason: "io" };
	}
};

export const previewMarkdown = (draft: PlanDraft): string => {
	const files = buildArtifactFiles(draft);
	const rendered = files.map((file) => `## \`${file.relativePath.replaceAll("\\", "/")}\`\n\n${file.content}`).join("\n");
	return `# Proposed task plan\n\nProject folder: \`${draft.projectSlug}\`\n\nFeature folder: \`${draft.featureSlug}\` or the next numbered version.\n\n${rendered}\n---\n\nType exactly \`confirm\` to write these unchanged files. Give feedback to revise them.`;
};
