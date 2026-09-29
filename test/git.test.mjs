import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDirtyProbe, findGitDir, parsePorcelain, readGitBranch } from "../lib/git.ts";

async function repo(head) {
	const root = await mkdtemp(join(tmpdir(), "faiku-git-"));
	await mkdir(join(root, ".git"), { recursive: true });
	await writeFile(join(root, ".git", "HEAD"), head);
	return root;
}

test("porcelain lines are counted by what they mean", () => {
	const counts = parsePorcelain([" M src/a.ts", "M  src/b.ts", "?? notes.md", " D src/c.ts"].join("\n"));
	assert.equal(counts.changed, 3);
	assert.equal(counts.untracked, 1);
});

test("a rename is one change, not two", () => {
	const counts = parsePorcelain("R  old.ts -> new.ts\n M other.ts");
	assert.equal(counts.changed, 1);
});

test("an empty status is a clean tree", () => {
	assert.deepEqual(parsePorcelain(""), { changed: 0, untracked: 0 });
	assert.deepEqual(parsePorcelain("\n\n"), { changed: 0, untracked: 0 });
});

test("the branch is read from .git/HEAD", async () => {
	assert.equal(await readGitBranch(await repo("ref: refs/heads/feat/theme\n")), "feat/theme");
	assert.equal(await readGitBranch(await repo("ref: refs/heads/main\n")), "main");
});

test("a detached HEAD says so", async () => {
	assert.equal(await readGitBranch(await repo("9f2c1ab4e5d6\n")), "detached");
});

test("outside a repository there is no branch and no panic", async () => {
	const empty = await mkdtemp(join(tmpdir(), "faiku-nogit-"));
	assert.equal(await findGitDir(empty), null);
	assert.equal(await readGitBranch(empty), null);
});

test("the repository is found from a subdirectory", async () => {
	const root = await repo("ref: refs/heads/main\n");
	const nested = join(root, "a", "b", "c");
	await mkdir(nested, { recursive: true });
	assert.equal(await findGitDir(nested), join(root, ".git"));
	assert.equal(await readGitBranch(nested), "main");
});

test("a worktree's .git file is followed", async () => {
	const real = await repo("ref: refs/heads/worktree-branch\n");
	const root = await mkdtemp(join(tmpdir(), "faiku-worktree-"));
	await writeFile(join(root, ".git"), `gitdir: ${join(real, ".git")}\n`);
	assert.equal(await readGitBranch(root), "worktree-branch");
});

test("the probe caches until its interval is up", async () => {
	let now = 0;
	const runs = [];
	const probe = createDirtyProbe("/repo", {
		minIntervalMs: 1000,
		now: () => now,
		run: async (cwd) => {
			runs.push(cwd);
			return " M a.ts\n";
		},
	});
	// The store has no clock of its own here, so drive it through the interval.
	probe.refresh();
	probe.refresh();
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(runs.length, 1);
	now = 2000;
	probe.refresh();
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(runs.length, 2);
	assert.deepEqual(probe.get(), { changed: 1, untracked: 0 });
	probe.dispose();
});

test("a failing probe leaves the rail without counts instead of throwing", async () => {
	const probe = createDirtyProbe("/repo", {
		minIntervalMs: 0,
		run: async () => {
			throw new Error("git is not installed");
		},
	});
	probe.refresh();
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(probe.get(), null);
	probe.dispose();
});

test("a disposed probe never runs again", async () => {
	let runs = 0;
	const probe = createDirtyProbe("/repo", {
		minIntervalMs: 0,
		run: async () => {
			runs++;
			return "";
		},
	});
	probe.dispose();
	probe.refresh();
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(runs, 0);
});
