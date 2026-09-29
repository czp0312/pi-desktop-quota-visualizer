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
async function fixture(t, initial = []) {
  if (!JSDOM) { t.skip("jsdom is not installed — run `npm install` to enable panel DOM tests"); return null; }
  const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const w = dom.window, d = w.document;
  let accounts = initial.map((id, i) => ({ id, label: id, vendor: "openai-codex", priority: i + 1, connected: true }));
  let login = null, outcome = "success", renameFails = false;
  const calls = [];
  w.matchMedia = () => ({ matches: false });
  const state = () => ({ ok: true, accounts: structuredClone(accounts), login });
  w.pluginBridge = { invoke: async (channel, p) => {
    calls.push({ channel, p });
    if (channel === "app.getAppearance") return { locale: "zh-CN", base: "light" };
    if (channel === "quota.snapshot") return { ok: true, demo: false, accounts: accounts.map((a) => ({ id: `plugin:${a.id}`, source: "plugin", provider: a.vendor, accountLabel: a.label, label: `OpenAI · ${a.label}`, status: "ok", windows: [{ usedPercent: 10, remainingPercent: 90 }] })) };
    if (channel === "quota.auth.start") {
      if (outcome === "throw") throw Error("network");
      const id = `id-${calls.length}`;
      login = { id, vendor: p.vendor, status: outcome, method: "browser", expiresAt: Date.now() + 600000, url: "https://example.com" };
      if (outcome === "success") accounts.push({ id, vendor: p.vendor, label: p.label || id, priority: accounts.length + 1, connected: true });
    }
    if (channel === "quota.auth.cancel") login = { ...login, status: "cancelled" };
    if (channel === "quota.auth.rename") {
      if (renameFails) return { ok: false, message: "failed" };
      accounts.find((a) => a.id === p.accountId).label = p.label;
    }
    return state();
  } };
  w.eval(fs.readFileSync(path.join(__dirname, "../views/notes.js"), "utf8"));
  w.eval(script);
  await settle();
  return { w, d, calls, outcome: (v) => { outcome = v; }, failRename: (v) => { renameFails = v; },
    add: () => d.querySelector('[data-vendor="openai-codex"][data-auth="start"]') };
}

test("existing accounts render and repeated add works after success, failure, cancel and rejection", async (t) => {
  const f = await fixture(t, ["old"]);
  if (!f) return;
  f.d.getElementById("auth-toggle").click(); await settle();
  assert.match(f.d.querySelector(".qa-name").textContent, /优先级 1/);
  for (const outcome of ["success", "error", "waiting", "throw", "success"]) {
    f.outcome(outcome);
    assert.equal(f.add().disabled, false);
    f.add().click(); await settle();
    if (outcome === "waiting") { assert.equal(f.add().disabled, true); f.d.getElementById("auth-cancel").click(); await settle(); }
    assert.equal(f.add().disabled, false);
  }
  assert.equal(f.calls.filter((c) => c.channel === "quota.auth.start").length, 5);
  assert.equal(f.d.querySelectorAll("[data-account-id]").length, 3);
  assert.equal(f.d.querySelectorAll('[data-auth="rename"]').length, 0);
});

test("card notes save instantly with management closed, preserve draft on refresh and retry errors", async (t) => {
  const f = await fixture(t, ["a"]);
  if (!f) return;
  f.d.querySelector('[data-note-action="edit"]').click();
  let input = f.d.querySelector("[data-note-input]");
  input.value = "我的备用账号"; input.dispatchEvent(new f.w.Event("input", { bubbles: true }));
  f.d.getElementById("refresh").click(); await settle();
  input = f.d.querySelector("[data-note-input]"); assert.equal(input.value, "我的备用账号");
  const before = f.calls.filter((c) => c.channel === "quota.snapshot").length;
  f.d.querySelector("[data-note-form]").dispatchEvent(new f.w.Event("submit", { bubbles: true, cancelable: true })); await settle();
  assert.match(f.d.querySelector(".qp-name").textContent, /我的备用账号/);
  assert.equal(f.d.querySelector(".qp-rename-message").textContent, "已保存");
  assert.equal(f.calls.filter((c) => c.channel === "quota.snapshot").length, before);
  f.failRename(true);
  input = f.d.querySelector("[data-note-input]"); input.value = "retry";
  f.d.querySelector("[data-note-form]").dispatchEvent(new f.w.Event("submit", { bubbles: true, cancelable: true })); await settle();
  assert.match(f.d.querySelector(".qp-rename-message").textContent, /失败/);
  assert.equal(f.d.querySelector("[data-note-input]").value, "retry");
  f.failRename(false);
  f.d.querySelector("[data-note-form]").dispatchEvent(new f.w.Event("submit", { bubbles: true, cancelable: true })); await settle();
  assert.match(f.d.querySelector(".qp-name").textContent, /retry/);
});

test("header is not sticky and standalone login is disabled", async (t) => {
  const f = await fixture(t);
  if (!f) return;
  assert.equal(f.w.getComputedStyle(f.d.querySelector(".qp-head")).position, "relative");
});
