import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configPatch, DEFAULT_CONFIG, describeConfig, MIN_BOX_WIDTH, parseConfig } from "../lib/config.ts";
import { agentDir, globalSettingsPath, readSettings, writeSettings } from "../lib/settings.ts";

test("an empty settings file gives the whole experience", () => {
	assert.deepEqual(parseConfig({}), DEFAULT_CONFIG);
	assert.deepEqual(parseConfig({ faiku: undefined }), DEFAULT_CONFIG);
	assert.deepEqual(parseConfig({ faiku: "nonsense" }), DEFAULT_CONFIG);
	assert.deepEqual(parseConfig({ faiku: [1, 2] }), DEFAULT_CONFIG);
});

test("every documented key is read", () => {
	const config = parseConfig({
		faiku: {
			enabled: false,
			box: false,
			toasts: false,
			applyTheme: false,
			header: false,
			hintRail: false,
			gitStatus: false,
			elapsed: false,
			padding: "compact",
			placeholder: "Say something",
			toastTtlMs: 4000,
			toastWidth: 44,
		},
	});
	assert.equal(config.enabled, false);
	assert.equal(config.box, false);
	assert.equal(config.toasts, false);
	assert.equal(config.applyTheme, false);
	assert.equal(config.header, false);
	assert.equal(config.hintRail, false);
	assert.equal(config.gitStatus, false);
	assert.equal(config.elapsed, false);
	assert.equal(config.padding, "compact");
	assert.equal(config.placeholder, "Say something");
	assert.equal(config.toastTtlMs, 4000);
	assert.equal(config.toastWidth, 44);
});

test("a value of the wrong type falls back to the default", () => {
	const config = parseConfig({
		faiku: {
			enabled: "yes",
			padding: "roomy",
			placeholder: "   ",
			toastTtlMs: 5,
			toastWidth: 1000,
		},
	});
	assert.equal(config.enabled, DEFAULT_CONFIG.enabled);
	assert.equal(config.padding, DEFAULT_CONFIG.padding);
	assert.equal(config.placeholder, DEFAULT_CONFIG.placeholder);
	// A toast that vanishes instantly, or a box wider than the screen, is clamped.
	assert.equal(config.toastTtlMs, 400);
	assert.equal(config.toastWidth, 60);
});

test("the box has a floor width, and the configuration says so", () => {
	assert.ok(MIN_BOX_WIDTH >= 20);
});

test("a patch carries the whole block, so a later read is complete", () => {
	const patch = configPatch(DEFAULT_CONFIG, { box: false });
	assert.equal(patch.faiku.box, false);
	assert.equal(patch.faiku.toasts, DEFAULT_CONFIG.toasts);
	assert.equal(patch.faiku.placeholder, DEFAULT_CONFIG.placeholder);
});

test("describeConfig reports every switch as on or off", () => {
	const described = describeConfig({ ...DEFAULT_CONFIG, toasts: false, padding: "compact" });
	assert.ok(described.includes("toasts     off"));
	assert.ok(described.includes("box        on"));
	assert.ok(described.includes("history    on, 6 rows"));
	assert.ok(described.includes("tabs       on, 8 chats, 0 closed"));
	assert.ok(described.includes("fullscreen on may switch pi's TUI mode"));
	assert.ok(described.includes("collapse   all"));
	assert.ok(described.includes("padding    compact"));
	assert.equal(described.split("\n").length, 14);
});

test("the collapse mode is read, and only the four modes are", () => {
	assert.equal(parseConfig({}).collapse, "all");
	assert.equal(parseConfig({ faiku: { collapse: "thinking" } }).collapse, "thinking");
	assert.equal(parseConfig({ faiku: { collapse: "off" } }).collapse, "off");
	// A mode that never existed is a typo, not a new posture.
	assert.equal(parseConfig({ faiku: { collapse: "everything" } }).collapse, "all");
	assert.equal(parseConfig({ faiku: { collapse: true } }).collapse, "all");
});

test("settings live in the pi agent directory", () => {
	assert.equal(agentDir({ PI_CODING_AGENT_DIR: "/tmp/agent" }), "/tmp/agent");
	assert.equal(agentDir({ PI_CODING_AGENT_DIR: "" }).endsWith("/.pi/agent"), true);
	assert.equal(globalSettingsPath({ PI_CODING_AGENT_DIR: "/tmp/agent" }), "/tmp/agent/settings.json");
});

test("writing settings merges instead of replacing", async () => {
	const dir = await mkdtemp(join(tmpdir(), "faiku-settings-"));
	const file = join(dir, "settings.json");
	await writeFile(file, JSON.stringify({ theme: "dark", faiku: { box: false } }));
	// What the extension actually writes: the whole resolved block, so a later
	// read never has to guess a value the user changed earlier.
	await writeSettings(file, configPatch({ ...DEFAULT_CONFIG, toasts: false }));
	const settings = await readSettings(file);
	assert.equal(settings.theme, "dark");
	assert.equal(settings.faiku.toasts, false);
	assert.equal(settings.faiku.box, DEFAULT_CONFIG.box);
	assert.equal(settings.faiku.placeholder, DEFAULT_CONFIG.placeholder);
});

test("a missing or broken settings file reads as empty", async () => {
	const dir = await mkdtemp(join(tmpdir(), "faiku-settings-"));
	assert.deepEqual(await readSettings(join(dir, "nope.json")), {});
	const broken = join(dir, "broken.json");
	await writeFile(broken, "{ not json");
	assert.deepEqual(await readSettings(broken), {});
});
