"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { modelWindows, quotaWindows, projectId, metadata, clientMetadata, errorDetails, accountEmail, GOOGLE_ANTIGRAVITY } = require("../lib/antigravity");
const manifest = require("../manifest.json");

test("Antigravity converts remaining fractions, preserves zero/full quotas and model reset times", () => {
  const windows = modelWindows({ models: {
    claude: { displayName: "Claude Sonnet", quotaInfo: { remainingFraction: 0.7654, resetTime: "2030-01-02T03:04:05Z" } },
    gemini: { quotaInfo: { remainingFraction: 0 } },
    flash: { quotaInfo: { remainingFraction: 1, resetTime: "invalid" } },
  } });
  assert.equal(windows.length, 3);
  assert.equal(windows[0].customLabel, "Claude Sonnet");
  assert.equal(windows[0].remainingPercent, 76.5);
  assert.equal(windows[0].usedPercent, 23.5);
  assert.equal(windows[0].resetsAt, "2030-01-02T03:04:05.000Z");
  assert.equal(windows[0].period, "other");
  assert.equal(windows[0].windowMinutes, null);
  assert.equal(windows[1].remainingPercent, 0);
  assert.equal(windows[1].usedPercent, 100);
  assert.equal(windows[1].customLabel, "gemini");
  assert.equal(windows[2].remainingPercent, 100);
  assert.equal(windows[2].resetsAt, null);
});

test("Antigravity never converts absent, malformed or out-of-range quota to a fake number", () => {
  const models = Object.fromEntries([undefined, null, "0.5", false, NaN, Infinity, -0.1, 1.1].map((value, i) =>
    [String(i), { quotaInfo: { remainingFraction: value } }]));
  models.missing = {};
  for (const data of [null, {}, { models: [] }, { models: "bad" }, { models }]) assert.deepEqual(quotaWindows(data), []);
});

test("project discovery accepts actual string/object ids and has no guessed default", () => {
  assert.equal(projectId({ cloudaicompanionProject: "my-project" }), "my-project");
  assert.equal(projectId({ cloudaicompanionProject: { id: "my-project" } }), "my-project");
  for (const data of [null, {}, { cloudaicompanionProject: {} }, { cloudaicompanionProject: " " }]) assert.equal(projectId(data), null);
  assert.deepEqual(metadata(), { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" });
  assert.equal(clientMetadata().ideType, "ANTIGRAVITY");
  assert.ok(["WINDOWS", "MACOS", "LINUX"].includes(clientMetadata().platform));
});

test("Google identity is best-effort and all new network endpoints are explicitly allowed", async () => {
  const calls = [];
  assert.equal(await accountEmail({ fetch: async (input) => {
    calls.push(input); return { status: 200, bodyText: JSON.stringify({ email: " me@example.com " }) };
  } }, "private-google-token"), "me@example.com");
  assert.equal(calls[0].headers.authorization, "Bearer private-google-token");
  assert.equal(calls[0].timeoutMs, 8000);
  for (const response of [{ status: 403, bodyText: "private-google-token" }, { status: 200, bodyText: "broken" }, { status: 200, bodyText: "{}" }]) {
    assert.equal(await accountEmail({ fetch: async () => response }, "private-google-token"), null);
  }
  assert.equal(await accountEmail({ fetch: async () => { throw Error("private-google-token"); } }, "private-google-token"), null);
  for (const url of [GOOGLE_ANTIGRAVITY.authorize, GOOGLE_ANTIGRAVITY.token, calls[0].url, "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels"]) {
    assert.ok(manifest.net.domains.includes(new URL(url).hostname));
  }
  assert.equal(manifest.version, require("../package.json").version);
});

test("Antigravity error diagnostics only expose whitelisted status and protobuf field names", () => {
  const error = { status: "INVALID_ARGUMENT", message: "private-token", details: [{ fieldViolations: [
    { field: "metadata.platform", description: "private-token" },
    { field: "private-token", description: "private-token" },
    { field: "metadata.platform", description: "private-token" },
  ] }] };
  assert.equal(errorDetails({ error }), " [INVALID_ARGUMENT, metadata.platform]");
  for (const data of [null, {}, { error: { status: "private-token", details: [{ fieldViolations: "private-token" }] } },
    { error: { details: [{ fieldViolations: [null, {}, { field: "authorization" }] }] } }]) assert.equal(errorDetails(data), "");
});

test("Antigravity collapses duplicate model readings into Gemini / other using minima, never totals or averages", () => {
  const reset = "2030-01-01T12:00:00Z";
  const models = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`gemini-${i}`, { quotaInfo: { remainingFraction: 0.626, resetTime: reset } }]));
  models.claude = { displayName: "Claude Sonnet", quotaInfo: { remainingFraction: 1, resetTime: reset } };
  models.tab_jump_flash_lite_preview = { quotaInfo: { remainingFraction: 1 } };
  const groups = quotaWindows({ models });
  assert.deepEqual(groups.map((g) => g.labelKey), ["window.antigravity.gemini", "window.antigravity.other"]);
  assert.equal(groups[0].remainingPercent, 62.6);
  assert.equal(groups[0].usedPercent, 37.4);
  assert.equal(groups[0].members.length, 10);
  assert.equal(groups[0].resetsAt, "2030-01-01T12:00:00.000Z");
  assert.equal(groups[1].remainingPercent, 100);
  assert.equal(groups[1].members.length, 2);
  assert.equal(groups[1].resetsAt, null); // tied readings with different/unknown resets
  models["gemini-0"].quotaInfo.remainingFraction = 0.2;
  models["gemini-0"].quotaInfo.resetTime = "2030-01-02T12:00:00Z";
  const changed = quotaWindows({ models })[0];
  assert.equal(changed.remainingPercent, 20);
  assert.equal(changed.usedPercent, 80);
  assert.equal(changed.resetsAt, "2030-01-02T12:00:00.000Z");
  assert.equal(changed.members[1].remainingPercent, 62.6);
});

test("Antigravity recognizes Gemini by id, display name or modelName and omits absent/invalid-only groups", () => {
  const groups = quotaWindows({ models: {
    alias: { displayName: "GEMINI 3 Pro", quotaInfo: { remainingFraction: 1 } },
    alias2: { modelName: "models/gemini-3-flash", quotaInfo: { remainingFraction: 0 } },
    "gemini-pro": { displayName: "Pro", quotaInfo: { remainingFraction: 0.5 } },
    claude: { quotaInfo: {} },
  } });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].remainingPercent, 0);
  assert.equal(groups[0].members.length, 3);
  const others = quotaWindows({ models: { claude: { quotaInfo: { remainingFraction: 1 } } } });
  assert.equal(others.length, 1);
  assert.equal(others[0].labelKey, "window.antigravity.other");
});

test("Antigravity tied lowest readings with different resets do not imply a single reset countdown", () => {
  const groups = quotaWindows({ models: {
    "gemini-a": { quotaInfo: { remainingFraction: 0.5, resetTime: "2030-01-01T00:00:00Z" } },
    "gemini-b": { quotaInfo: { remainingFraction: 0.5, resetTime: "2030-01-02T00:00:00Z" } },
  } });
  assert.equal(groups[0].resetsAt, null);
  assert.equal(groups[0].members[0].resetsAt, "2030-01-01T00:00:00.000Z");
  assert.equal(groups[0].members[1].resetsAt, "2030-01-02T00:00:00.000Z");
});
