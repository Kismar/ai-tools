import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	buildArtifactFiles,
	nextVersionedFolderName,
	previewMarkdown,
	type PlanDraft,
	validatePlanDraft,
	writePlanAtomically,
} from "./artifact.ts";

const validDraft = (): PlanDraft => ({
	projectSlug: "sample-project",
	featureSlug: "durable-history",
	readmeMarkdown: `# Durable history

## Purpose

Store completed conversations.

## Scope

Add durable history.

## Task index

1. 01-storage-contract
2. 02-storage-adapter

## Dependency graph

\`\`\`mermaid
graph LR
  T1[01-storage-contract] --> T2[02-storage-adapter]
\`\`\``,
	architectureMarkdown: `# Architecture

## Current architecture

\`\`\`mermaid
flowchart LR
  UI --> Memory
\`\`\`

The memory adapter stores history.

## Target architecture

\`\`\`mermaid
flowchart LR
  UI --> Contract --> Storage
\`\`\`

The storage adapter implements the contract.

## Architecture changes

Add a storage seam.`,
	tasks: [
		{
			id: "01-storage-contract",
			dependencies: [],
			taskMarkdown: `# Storage contract

## Purpose

Define durable history behavior.

## Required outcome

Callers use one storage interface.

## Dependencies

None.

## In scope

Define the interface.

## Out of scope

Provider code.

## Constraints

Keep provider types outside the interface.

## Acceptance criteria

1. Callers can store one completed turn.

## Required verification

Run the focused contract tests.

## Completion evidence

Provide the passing test result.`,
			implementationGuideMarkdown: `# Storage contract implementation guide

## Repository evidence

- \`src/history.ts\` owns history behavior.

## Architecture change

Add the storage interface.

## Implementation approach

Define immutable values.

Material deviations require a /pair-implement scope-change checkpoint.

## Tests

Add contract tests.

## Documentation

None.

## Verification

Run the repository test command.`,
		},
		{
			id: "02-storage-adapter",
			dependencies: ["01-storage-contract"],
			taskMarkdown: `# Storage adapter

## Purpose

Persist conversation history.

## Required outcome

Completed turns survive restart.

## Dependencies

- 01-storage-contract

## In scope

Add the storage adapter.

## Out of scope

Document storage.

## Constraints

Keep provider types in the adapter.

## Acceptance criteria

1. A stored turn remains available after adapter recreation.

## Required verification

Run adapter tests.

## Completion evidence

Provide the passing test result.`,
			implementationGuideMarkdown: `# Storage adapter implementation guide

## Repository evidence

- \`src/adapters\` contains adapters.

## Architecture change

Implement the storage interface.

## Implementation approach

Add one adapter.

Material deviations require a /pair-implement scope-change checkpoint.

## Tests

Test through the storage interface.

## Documentation

Update storage setup when required.

## Verification

Run the repository test command.`,
		},
	],
});

test("accepts a complete plan in dependency order", () => {
	const result = validatePlanDraft(validDraft());
	assert.equal(result.ok, true);
	assert.equal(buildArtifactFiles(validDraft()).length, 6);
	assert.match(previewMarkdown(validDraft()), /tasks\/01-storage-contract\/task\.md/);
});

test("rejects forward dependencies and unresolved markers", () => {
	const draft = validDraft();
	const [firstTask, ...remainingTasks] = draft.tasks;
	assert.ok(firstTask);
	const forward: PlanDraft = {
		...draft,
		tasks: [{ ...firstTask, dependencies: ["02-storage-adapter"] }, ...remainingTasks],
	};
	assert.deepEqual(validatePlanDraft(forward), { ok: false, reason: "invalid-dependency" });

	const unresolved: PlanDraft = {
		...draft,
		tasks: [{ ...firstTask, taskMarkdown: `${firstTask.taskMarkdown}\n\nTBD` }, ...remainingTasks],
	};
	assert.deepEqual(validatePlanDraft(unresolved), { ok: false, reason: "unresolved-question" });
});

test("selects numbered folder names without overwriting", () => {
	assert.equal(nextVersionedFolderName("feature", new Set()), "feature");
	assert.equal(nextVersionedFolderName("feature", new Set(["feature"])), "feature-v2");
	assert.equal(nextVersionedFolderName("feature", new Set(["feature", "feature-v2"])), "feature-v3");
});

test("writes complete plans and creates a numbered version", async () => {
	const root = await mkdtemp(join(tmpdir(), "grill-task-"));
	try {
		const first = await writePlanAtomically(validDraft(), root, () => "first");
		assert.equal(first.ok, true);
		if (!first.ok) return;
		assert.equal(first.folder, join(root, "sample-project", "durable-history"));
		assert.equal(first.firstTaskFolder, join(first.folder, "tasks", "01-storage-contract"));
		assert.match(await readFile(join(first.folder, "README.md"), "utf8"), /# Durable history\n/);

		const second = await writePlanAtomically(validDraft(), root, () => "second");
		assert.equal(second.ok, true);
		if (!second.ok) return;
		assert.equal(second.folder, join(root, "sample-project", "durable-history-v2"));
		assert.match(await readFile(join(second.folder, "tasks", "02-storage-adapter", "task.md"), "utf8"), /## Purpose/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("does not replace an existing folder", async () => {
	const root = await mkdtemp(join(tmpdir(), "grill-task-"));
	try {
		const existing = join(root, "sample-project", "durable-history");
		await mkdir(existing, { recursive: true });
		const marker = join(existing, "marker.txt");
		await writeFile(marker, "keep", "utf8");

		const result = await writePlanAtomically(validDraft(), root, () => "versioned");
		assert.equal(result.ok, true);
		assert.equal(await readFile(marker, "utf8"), "keep");
		if (result.ok) assert.equal(result.folder, join(root, "sample-project", "durable-history-v2"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
