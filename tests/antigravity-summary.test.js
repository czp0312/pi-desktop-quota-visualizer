"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { summaryWindows, fractionValue, SUMMARY_ENDPOINTS } = require("../lib/antigravity-summary");
const { projectId } = require("../lib/antigravity");
const manifest = require("../manifest.json");
const bucket = (window, remainingFraction, resetTime) => ({ window, remainingFraction, resetTime });

test("DSH reference wrapped fixture yields distinct five-hour and weekly Gemini quotas", () => {
  const rows = summaryWindows({ body: JSON.stringify({ groups: [{ displayName: "Gemini Models", buckets: [
    bucket("weekly", "40%", "2030-01-01T00:00:00Z"), { window: "five_hour", remaining_fraction: 0.8 },
  ] }] }) });
  assert.deepEqual(rows.map((row) => [row.period, row.remainingPercent, row.windowMinutes]), [["session", 80, 300], ["week", 40, 10080]]);
  assert.equal(rows[1].resetsAt, "2030-01-01T00:00:00.000Z");
  assert.equal(rows[0].resetsAt, null);
});

test("Gemini / other × session / week aggregate independently, never mix durations or duplicate shared readings", () => {
  const rows = summaryWindows({ groups: [
    { display_name: "Gemini Pro", buckets: [bucket("5h", 0.8), bucket("week", 0.2)] },
    { displayName: "Gemini Flash", buckets: [bucket("five-hour", 0.7), bucket("weekly", 0.4)] },
    { displayName: "Claude", buckets: [bucket("5h", 0.9), bucket("weekly", 0.6)] },
    { displayName: "Other", buckets: [bucket("5h", 0.9)] },
  ] });
  assert.deepEqual(rows.map((r) => [r.labelKey, r.remainingPercent, r.members.length]), [
    ["window.antigravity.gemini.session", 70, 2], ["window.antigravity.gemini.week", 20, 2],
    ["window.antigravity.other.session", 90, 2], ["window.antigravity.other.week", 60, 1],
  ]);
});

test("missing/invalid windows disappear without placeholders; zero/full remain valid and no countdown inference", () => {
  const rows = summaryWindows({ groups: [
    { displayName: "Gemini", buckets: [bucket("weekly", 0), bucket("unknown", 0.8), bucket(undefined, 0.9, "2030-01-08T00:00:00Z")] },
    { displayName: "Claude", buckets: [bucket("5h", 1), bucket("week", null), bucket("week", 3)] },
  ] });
  assert.deepEqual(rows.map((r) => [r.period, r.remainingPercent]), [["week", 0], ["session", 100]]);
  for (const data of [null, {}, { body: "invalid" }, { groups: [] }, { groups: [null, { buckets: "bad" }] }]) assert.deepEqual(summaryWindows(data), []);
});

test("fraction accepts only safe reference numeric/percent representations", () => {
  for (const [value, expected] of [["40%", 0.4], ["0.8", 0.8], [{ val: "0.6" }, 0.6], [0, 0], [1, 1]]) assert.equal(fractionValue(value), expected);
  for (const value of [null, undefined, false, true, "", " ", "junk", "0x10", Infinity, NaN, -1, 2, "101%", "-1%", { val: {} }]) assert.equal(fractionValue(value), null);
});

test("window field overrides misleading display label; reset variants and duplicate timestamps are handled safely", () => {
  const rows = summaryWindows({ body: { groups: [{ displayName: "Gemini", buckets: [
    { window: "weekly", displayName: "5h", remaining_fraction: { val: 0.4 }, reset_time: 1893456000 },
    { window: "unknown", displayName: "weekly", remainingFraction: 0.3 },
    { display_name: "five_hour", remainingFraction: 0.5, resetTime: 1e50 },
  ] }] } });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].period, "session");
  assert.equal(rows[0].resetsAt, null);
  assert.equal(rows[1].period, "week");
  assert.equal(rows[1].resetsAt, "2030-01-01T00:00:00.000Z");
  const tied = summaryWindows({ groups: [{ displayName: "Gemini", buckets: [bucket("week", 0.4, "2030-01-01T00:00:00Z"), bucket("week", 0.4, "2030-01-02T00:00:00Z")] }] });
  assert.equal(tied[0].resetsAt, null);
});

test("project aliases use actual returned IDs; summary hosts are explicitly allowed", () => {
  assert.equal(projectId({ projectId: "actual-project" }), "actual-project");
  assert.equal(projectId({ project: { id: "actual-project" } }), "actual-project");
  assert.equal(projectId({ cloudaicompanionProject: " ", projectId: "actual-project" }), "actual-project");
  assert.equal(projectId({}), null);
  for (const endpoint of SUMMARY_ENDPOINTS) assert.ok(manifest.net.domains.includes(new URL(endpoint).hostname));
});
