import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { expandHome, globalSettingsPath, readSettings, writeSettings } from "../lib/settings.ts";

async function scratch() {
	return mkdtemp(join(tmpdir(), "faiku-settings-"));
}

test("a merge keeps every key it did not touch", async () => {
	const file = join(await scratch(), "settings.json");
	await writeFile(file, JSON.stringify({ theme: "dark", faiku: { box: true }, keep: [1, 2] }));
	const written = await writeSettings(file, { faiku: { box: false } });
	assert.deepEqual(written, { theme: "dark", faiku: { box: false }, keep: [1, 2] });
	assert.deepEqual(JSON.parse(await readFile(file, "utf8")), written);
});

test("a missing file is created rather than complained about", async () => {
	const file = join(await scratch(), "settings.json");
	assert.deepEqual(await readSettings(file), {});
	await writeSettings(file, { theme: "dark" });
	assert.deepEqual(await readSettings(file), { theme: "dark" });
});

test("a broken file is read as empty rather than thrown on", async () => {
	const file = join(await scratch(), "settings.json");
	await writeFile(file, "{ this is not json");
	assert.deepEqual(await readSettings(file), {});
});

test("a write is never visible half-finished", async () => {
	const file = join(await scratch(), "settings.json");
	// Big enough that the write takes real time: with truncate-then-write a
	// reader in this loop catches an empty or partial file, which is exactly
	// what broke pi's settings parse for another extension at startup.
	await writeFile(file, JSON.stringify({ filler: "x".repeat(400_000), theme: "dark" }));
	let reads = 0;
	const reading = (async () => {
		for (let attempt = 0; attempt < 400; attempt++) {
			const text = await readFile(file, "utf8");
			const parsed = JSON.parse(text);
			assert.equal(typeof parsed, "object");
			reads++;
		}
	})();
	for (let attempt = 0; attempt < 6; attempt++) {
		await writeSettings(file, { filler: "y".repeat(400_000), attempt });
	}
	await reading;
	assert.ok(reads > 0, "the reader ran");
});

test("a write leaves no temporary file behind", async () => {
	const dir = await scratch();
	const file = join(dir, "settings.json");
	await writeSettings(file, { theme: "dark" });
	assert.deepEqual(await readdir(dir), ["settings.json"]);
});

test("a replaced file keeps the mode it had", async () => {
	const file = join(await scratch(), "settings.json");
	await writeFile(file, "{}", { mode: 0o644 });
	await writeSettings(file, { theme: "dark" });
	const { stat } = await import("node:fs/promises");
	assert.equal((await stat(file)).mode & 0o777, 0o644);
});

test("the agent directory is pi's, unless it says otherwise", () => {
	assert.equal(globalSettingsPath({ PI_CODING_AGENT_DIR: "/tmp/agent" }), "/tmp/agent/settings.json");
	// The real home comes from the OS, so only the override is exact here.
	assert.ok(globalSettingsPath({}).endsWith("/.pi/agent/settings.json"));
	// `~` resolves against the OS home, which is the same on both counts.
	assert.equal(expandHome("~/x", {}), join(homedir(), "x"));
	assert.equal(expandHome("/already/absolute", {}), "/already/absolute");
});
