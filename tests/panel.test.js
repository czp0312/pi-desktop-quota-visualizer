"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
let JSDOM = null;
try { ({ JSDOM } = require("jsdom")); } catch { /* optional dev dependency; tests skip without it */ }
const html = fs.readFileSync(path.join(__dirname, "../views/quota.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const settle = () => new Promise((r) => setImmediate(r));
async function fixture(t, initial = [], locale = "zh-CN") {
  if (!JSDOM) { t.skip("jsdom is not installed — run `npm install` to enable panel DOM tests"); return null; }
  const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const w = dom.window, d = w.document;
  let accounts = initial.map((item, i) => {
    const base = typeof item === "string" ? { id: item, label: item } : item;
    return { vendor: "openai-codex", priority: i + 1, connected: true, ...base };
  });
  let login = null, outcome = "success";
  const calls = [];
  w.matchMedia = () => ({ matches: false });
  const state = () => ({ ok: true, accounts: structuredClone(accounts), login });
  w.pluginBridge = { invoke: async (channel, p) => {
    calls.push({ channel, p });
    if (channel === "app.getAppearance") return { locale, base: "light" };
    if (["quota.snapshot", "quota.refresh"].includes(channel)) return { ok: true, demo: false, accounts: accounts.map((a) => ({ id: `plugin:${a.id}`, source: "plugin", provider: a.vendor, identity: a.identity ?? null, email: a.email ?? null, label: a.label, status: a.status ?? "ok", error: a.error, quotaSource: a.quotaSource, diagnostics: a.diagnostics, windows: a.windows ?? [{ usedPercent: 10, remainingPercent: 90 }] })) };
    if (channel === "quota.auth.start") {
      if (outcome === "throw") throw Error("network");
      const id = `id-${calls.length}`;
      login = { id, vendor: p.vendor, status: outcome, method: "browser", expiresAt: Date.now() + 600000, url: "https://example.com" };
      if (outcome === "success") accounts.push({ id, vendor: p.vendor, label: id, priority: accounts.length + 1, connected: true });
    }
    if (channel === "quota.auth.cancel") login = { ...login, status: "cancelled" };
    return state();
  } };
  w.eval(script);
  await settle();
  return { w, d, calls, outcome: (v) => { outcome = v; },
    add: () => d.querySelector('[data-vendor="openai-codex"][data-auth="start"]') };
}

test("existing accounts render and repeated add works after success, failure, cancel and rejection", async (t) => {
  const f = await fixture(t, ["old"]);
  if (!f) return;
  f.d.getElementById("auth-toggle").click(); await settle();
  assert.match(f.d.querySelector(".qa-name").textContent, /优先级 1/);
  // The note feature is gone: neither a card note control nor a label field when adding.
  assert.equal(f.d.querySelectorAll("[data-note-action], [data-note-input], .qp-rename").length, 0);
  assert.equal(f.d.querySelectorAll(".qa-add input").length, 0);
  for (const outcome of ["success", "error", "waiting", "throw", "success"]) {
    f.outcome(outcome);
    assert.equal(f.add().disabled, false);
    f.add().click(); await settle();
    if (outcome === "waiting") { assert.equal(f.add().disabled, true); f.d.getElementById("auth-cancel").click(); await settle(); }
    assert.equal(f.add().disabled, false);
  }
  assert.equal(f.calls.filter((c) => c.channel === "quota.auth.start").length, 5);
  assert.equal(f.calls.filter((c) => c.channel === "quota.auth.start").every((c) => c.p.label === undefined), true);
  assert.equal(f.d.querySelectorAll("[data-account-id]").length, 3);
});

test("the card and the account list show the detected identity from the snapshot", async (t) => {
  const f = await fixture(t, [{ id: "one", label: "OpenAI (ChatGPT Plus/Pro) · alice@example.com" }]);
  if (!f) return;
  assert.equal(f.d.querySelector(".qp-name").textContent, "OpenAI (ChatGPT Plus/Pro) · alice@example.com");
  f.d.getElementById("auth-toggle").click(); await settle();
  assert.equal(f.d.querySelector(".qa-name").textContent, "优先级 1 · OpenAI (ChatGPT Plus/Pro) · alice@example.com");
});

test("the name stays the title while the email shows as a chip", async (t) => {
  const f = await fixture(t, [{ id: "one", label: "OpenAI (ChatGPT Plus/Pro) · 山口 愛", identity: "山口 愛", email: "kacieknauber291290@outlook.de" }]);
  if (!f) return;
  assert.equal(f.d.querySelector(".qp-name").textContent, "OpenAI (ChatGPT Plus/Pro) · 山口 愛");
  assert.equal(f.d.querySelector(".qp-chip-mail").textContent, "kacieknauber291290@outlook.de");
});

test("an account whose only identity is the email does not repeat it as a chip", async (t) => {
  const f = await fixture(t, [{ id: "one", label: "Anthropic (Claude Pro/Max) · me@example.com", identity: "me@example.com", email: "me@example.com" }]);
  if (!f) return;
  assert.equal(f.d.querySelectorAll(".qp-chip-mail").length, 0);
});

test("header is not sticky and standalone login is disabled", async (t) => {
  const f = await fixture(t);
  if (!f) return;
  assert.equal(f.w.getComputedStyle(f.d.querySelector(".qp-head")).position, "relative");
});

test("Antigravity uses the existing account manager and starts the Google vendor flow", async (t) => {
  const f = await fixture(t, [{ id: "google-one", vendor: "google-antigravity", label: "Google Antigravity · me@example.com" }]);
  if (!f) return;
  f.d.getElementById("auth-toggle").click(); await settle();
  const group = f.d.querySelector('.qa-group[data-vendor="google-antigravity"]');
  const add = f.d.querySelector('[data-vendor="google-antigravity"][data-auth="start"]');
  assert.ok(add);
  assert.match(f.d.querySelector('[data-account-id="google-one"]').textContent, /me@example.com/);
  add.click(); await settle();
  assert.equal(f.calls.filter((c) => c.channel === "quota.auth.start").at(-1).p.vendor, "google-antigravity");
  assert.equal(add.disabled, false);
});

test("Antigravity keeps Gemini / other summaries but removes model details after refresh", async (t) => {
  const { quotaWindows } = require("../lib/antigravity");
  const windows = quotaWindows({ models: {
    "gemini-pro": { displayName: "Gemini Pro", quotaInfo: { remainingFraction: 0.626, resetTime: "2030-01-01T00:00:00Z" } },
    "gemini-flash": { displayName: "Gemini Flash", quotaInfo: { remainingFraction: 0.626, resetTime: "2030-01-01T00:00:00Z" } },
    claude: { displayName: '<img src=x onerror="alert(1)">', quotaInfo: { remainingFraction: 1 } },
  } });
  const f = await fixture(t, [{ id: "google-one", vendor: "google-antigravity", label: "Google Antigravity", windows }]);
  if (!f) return;
  const summaries = f.d.querySelectorAll(".qp-windows > .qp-window");
  assert.equal(summaries.length, 2);
  assert.equal(summaries[0].querySelector(".qp-window-label").textContent, "Gemini");
  assert.equal(summaries[1].querySelector(".qp-window-label").textContent, "其他");
  assert.equal(summaries[0].querySelector(".qp-bar").getAttribute("aria-valuenow"), "62.6");
  assert.equal(f.d.querySelectorAll(".qp-group-details, .qp-group-members").length, 0);
  assert.ok(!f.d.getElementById("list").textContent.includes("模型读数"));
  assert.ok(!f.d.getElementById("list").textContent.includes("Gemini Pro"));
  assert.equal(f.d.querySelector(".qp-card img"), null);
  f.d.getElementById("refresh").click(); await settle();
  assert.equal(f.d.querySelectorAll(".qp-group-details, .qp-group-members").length, 0);
  assert.equal(f.d.querySelectorAll(".qp-windows > .qp-window").length, 2);
});

test("Antigravity group labels follow the English locale without model details", async (t) => {
  const { quotaWindows } = require("../lib/antigravity");
  const windows = quotaWindows({ models: { claude: { quotaInfo: { remainingFraction: 0.9 } } } });
  const f = await fixture(t, [{ id: "google-one", vendor: "google-antigravity", label: "Google Antigravity", windows }], "en");
  if (!f) return;
  assert.equal(f.d.querySelector(".qp-window-label").textContent, "Other");
  assert.equal(f.d.querySelector(".qp-group-details"), null);
  assert.ok(!f.d.getElementById("list").textContent.includes("Model readings"));
});

test("quota diagnostics stay absent for populated, failed and empty accounts in both locales", async (t) => {
  for (const locale of ["zh-CN", "en"]) {
    const diagnostics = { version: 1, text: "OLD-DIAGNOSTIC-TEXT" };
    const f = await fixture(t, [
      { id: "google", vendor: "google-antigravity", label: "Google", diagnostics },
      { id: "failed", vendor: "google-antigravity", label: "Failed", status: "error", windows: [], error: "HTTP 400", diagnostics },
      { id: "empty", vendor: "google-antigravity", label: "Empty", windows: [] },
      { id: "other", vendor: "openai-codex", label: "Other", diagnostics },
    ], locale);
    if (!f) return;
    const assertRemoved = () => {
      assert.equal(f.d.querySelectorAll('.qp-diagnostics, [data-action="copy-diagnostic"]').length, 0);
      assert.ok(!f.d.getElementById("list").textContent.includes(diagnostics.text));
      assert.equal(f.d.querySelectorAll(".qp-card").length, 4);
    };
    assertRemoved();
    f.d.getElementById("refresh").click(); await settle();
    assertRemoved();
  }
});

test("Antigravity period summary shows Gemini / other five-hour and seven-day windows; absent windows are omitted", async (t) => {
  const { summaryWindows } = require("../lib/antigravity-summary");
  const windows = summaryWindows({ groups: [
    { displayName: "Gemini", buckets: [{ window: "5h", remainingFraction: 0.8 }, { window: "weekly", remainingFraction: 0.4 }] },
    { displayName: "Claude", buckets: [{ window: "5h", remainingFraction: 0.9 }] },
  ] });
  const f = await fixture(t, [{ id: "google", vendor: "google-antigravity", label: "Google", windows, quotaSource: "summary" }]);
  if (!f) return;
  const rows = f.d.querySelectorAll(".qp-windows > .qp-window");
  assert.deepEqual(Array.from(rows, (row) => row.querySelector(".qp-window-label").textContent), ["Gemini · 5 小时", "Gemini · 7 天", "其他 · 5 小时"]);
  assert.deepEqual(Array.from(rows, (row) => row.querySelector(".qp-bar").getAttribute("aria-valuenow")), ["80", "40", "90"]);
  assert.ok(!f.d.getElementById("list").textContent.includes("其他 · 7 天"));
  assert.equal(f.d.querySelectorAll(".qp-group-details[open]").length, 0);
});

test("Antigravity fallback is labelled unclassified rather than five-hour/weekly", async (t) => {
  const { quotaWindows } = require("../lib/antigravity");
  const windows = quotaWindows({ models: { gemini: { quotaInfo: { remainingFraction: 0.7 } } } });
  const f = await fixture(t, [{ id: "google", vendor: "google-antigravity", label: "Google", windows, quotaSource: "model-fallback" }]);
  if (!f) return;
  assert.match(f.d.querySelector(".qp-note").textContent, /未分类额度汇总/);
  assert.equal(f.d.querySelector(".qp-window-label").textContent, "Gemini");
});
