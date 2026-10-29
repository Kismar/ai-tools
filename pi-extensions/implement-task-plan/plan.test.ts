import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	loadTaskPlan,
	parsePlanCommandArguments,
	resolvePlanPath,
	resolveStartTaskId,
} from "./plan.ts";

const taskHeadings = [
	"Purpose",
	"Required outcome",
	"Dependencies",
	"In scope",
	"Out of scope",
	"Constraints",
	"Acceptance criteria",
	"Required verification",
	"Completion evidence",
];
const guideHeadings = [
	"Repository evidence",
	"Architecture change",
	"Implementation approach",
	"Tests",
	"Documentation",
	"Verification",
];

const markdown = (title: string, headings: readonly string[], dependencies = "None."): string =>
	[`# ${title}`, ...headings.flatMap((heading) => [`## ${heading}`, heading === "Dependencies" ? dependencies : "Content."])].join(
		"\n\n",
	);

const createPlan = async (): Promise<{ root: string; plan: string }> => {
	const root = await mkdtemp(join(tmpdir(), "implement-task-plan-"));
	const plan = join(root, "feature");
	await mkdir(join(plan, "tasks", "01-first"), { recursive: true });
	await mkdir(join(plan, "tasks", "02-second"), { recursive: true });
	await writeFile(join(plan, "README.md"), "# Feature\n", "utf8");
	await writeFile(join(plan, "architecture.md"), "# Architecture\n", "utf8");
	await writeFile(join(plan, "tasks", "01-first", "task.md"), markdown("First", taskHeadings), "utf8");
	await writeFile(
		join(plan, "tasks", "01-first", "implementation-guide.md"),
		markdown("First guide", guideHeadings),
		"utf8",
	);
	await writeFile(
		join(plan, "tasks", "02-second", "task.md"),
		markdown("Second", taskHeadings, "- `01-first`"),
		"utf8",
	);
	await writeFile(
		join(plan, "tasks", "02-second", "implementation-guide.md"),
		markdown("Second guide", guideHeadings),
		"utf8",
	);
	return { root, plan };
};

test("loads a complete Grill Task plan and its dependencies", async () => {
	const fixture = await createPlan();
	try {
		const result = await loadTaskPlan(`@"${fixture.plan}"`, fixture.root);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.deepEqual(
			result.plan.tasks.map((task) => ({ id: task.id, dependencies: task.dependencies })),
			[
				{ id: "01-first", dependencies: [] },
				{ id: "02-second", dependencies: ["01-first"] },
			],
		);
	} finally {
		await rm(fixture.root, { recursive: true, force: true });
	}
});

test("changes the plan digest when a task file changes", async () => {
	const fixture = await createPlan();
	try {
		const first = await loadTaskPlan(fixture.plan, fixture.root);
		assert.equal(first.ok, true);
		await writeFile(
			join(fixture.plan, "tasks", "01-first", "implementation-guide.md"),
			`${markdown("First guide", guideHeadings)}\nChanged.\n`,
			"utf8",
		);
		const second = await loadTaskPlan(fixture.plan, fixture.root);
		assert.equal(second.ok, true);
		if (first.ok && second.ok) assert.notEqual(first.plan.digest, second.plan.digest);
	} finally {
		await rm(fixture.root, { recursive: true, force: true });
	}
});

test("rejects a dependency that does not precede its task", async () => {
	const fixture = await createPlan();
	try {
		await writeFile(
			join(fixture.plan, "tasks", "01-first", "task.md"),
			markdown("First", taskHeadings, "- `02-second`"),
			"utf8",
		);
		const result = await loadTaskPlan(fixture.plan, fixture.root);
		assert.deepEqual(result, { ok: false, reason: "invalid-dependency" });
	} finally {
		await rm(fixture.root, { recursive: true, force: true });
	}
});

test("rejects missing task sections", async () => {
	const fixture = await createPlan();
	try {
		await writeFile(join(fixture.plan, "tasks", "01-first", "task.md"), "# Incomplete\n", "utf8");
		const result = await loadTaskPlan(fixture.plan, fixture.root);
		assert.deepEqual(result, { ok: false, reason: "missing-section" });
	} finally {
		await rm(fixture.root, { recursive: true, force: true });
	}
});

test("resolves at-prefixed relative and home plan paths", () => {
	assert.equal(resolvePlanPath("@plans/feature", "C:/repo"), join("C:/repo", "plans", "feature"));
	assert.equal(resolvePlanPath("@~/.pi/agent/task-plans/example", "C:/repo"), join(homedir(), ".pi", "agent", "task-plans", "example"));
});

test("parses an optional starting task from the command suffix", () => {
	assert.deepEqual(parsePlanCommandArguments("@plans/feature start from task 3"), {
		planArgument: "@plans/feature",
		startTaskReference: "3",
	});
	assert.deepEqual(
		parsePlanCommandArguments('"C:/task plans/feature" START FROM TASK 02-SECOND'),
		{
			planArgument: '"C:/task plans/feature"',
			startTaskReference: "02-second",
		},
	);
	assert.deepEqual(parsePlanCommandArguments("@plans/feature"), {
		planArgument: "@plans/feature",
	});
});

test("resolves starting tasks by ordinal or exact task ID", async () => {
	const fixture = await createPlan();
	try {
		const result = await loadTaskPlan(fixture.plan, fixture.root);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(resolveStartTaskId(result.plan), "01-first");
		assert.equal(resolveStartTaskId(result.plan, "2"), "02-second");
		assert.equal(resolveStartTaskId(result.plan, "02-second"), "02-second");
		assert.equal(resolveStartTaskId(result.plan, "3"), undefined);
	} finally {
		await rm(fixture.root, { recursive: true, force: true });
	}
});
