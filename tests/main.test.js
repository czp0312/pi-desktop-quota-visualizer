"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const file = path.resolve(__dirname, "../main.js");
const actualRequire = createRequire(file);
const code = fs.readFileSync(file, "utf8");
const reply = (data, status = 200) => ({ status, bodyText: JSON.stringify(data) });
function app(settings = {}, pluginCredentials = {}, fetcher) {
  let changed, cliReads = 0;
  const requests = [];
  const auth = {
    credential: async (vendor) => pluginCredentials[vendor] ?? null,
    status: async () => ({ ok: true, accounts: [], login: null }),
    logout: async (vendor) => { delete pluginCredentials[vendor]; changed(); return auth.status(); },
    stop: async () => {},
    start: async () => { throw new Error("must not start in demo"); },
  };
  const pi = { plugin: { getSettings: async () => settings, setSettings: async (partial) => Object.assign(settings, partial) },
    commands: { unregister: async () => {} }, net: { fetch: async (input) => { requests.push(input); return fetcher(input); } } };
  const sandbox = { pi, module: { exports: {} }, console,
    require(name) {
      if (name === "./lib/oauth") return { createAuth: (_pi, opts) => { changed = opts.onChange; return auth; } };
      if (name === "node:fs/promises") return { stat: async () => { cliReads++; throw new Error("no CLI installed"); } };
      if (name === "node:os") return { homedir: () => "/nonexistent-home" };
      return actualRequire(name);
    }, process: { env: {} } };
  vm.runInNewContext(code, sandbox, { filename: file });
  return { invoke: sandbox.module.exports.onPanelInvoke, requests, get cliReads() { return cliReads; } };
}

test("plugin login drives ChatGPT quota with autoDetect off and no CLI", async () => {
  const a = app({ autoDetect: false }, { "openai-codex": { token: "private-plugin-token", accountId: "acct-1", source: "plugin" } }, () => reply({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000 } } }));
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.ok, true);
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].windows[0].remainingPercent, 75);
  assert.equal(a.requests[0].headers["chatgpt-account-id"], "acct-1");
  assert.equal(a.requests[0].headers.authorization, "Bearer private-plugin-token");
  assert.equal(a.cliReads, 0);
  assert.ok(!JSON.stringify(result).includes("private-plugin-token"));
  await a.invoke("quota.auth.logout", { vendor: "openai-codex" });
  assert.equal((await a.invoke("quota.snapshot", {})).accounts.length, 0);
});

test("manual tokens work with autoDetect off and take priority over plugin tokens", async () => {
  const a = app({ autoDetect: false, credentials: { "openai-codex": { token: "manual", accountId: "manual-acct" }, openrouter: "or-key" } },
    { "openai-codex": { token: "plugin" } }, () => reply({}));
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.accounts.length, 2);
  const req = a.requests.find((r) => r.url.includes("chatgpt.com"));
  assert.equal(req.headers.authorization, "Bearer manual");
  assert.equal(req.headers["chatgpt-account-id"], "manual-acct");
  assert.equal(a.cliReads, 0);
});

test("CLI discovery is optional fallback only", async () => {
  const a = app({ autoDetect: true }, { anthropic: { token: "saved" } }, () => reply({}));
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].provider, "anthropic");
  assert.ok(a.cliReads > 0);
});

test("demo is offline and refuses new OAuth starts", async () => {
  const a = app({ demoMode: true, autoDetect: true });
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.demo, true);
  assert.ok(result.accounts.length > 0);
  assert.equal(a.requests.length, 0);
  assert.equal(a.cliReads, 0);
  assert.equal((await a.invoke("quota.auth.start", { vendor: "openai-codex" })).code, "DEMO_MODE");
});

test("a revoked credential surfaces 401 without repeating another usage endpoint or leaking body", async () => {
  const a = app({ autoDetect: false }, { "openai-codex": { token: "secret" } }, () => reply({ error: "secret" }, 401));
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.accounts[0].status, "error");
  assert.match(result.accounts[0].error, /401/);
  assert.ok(!JSON.stringify(result).includes("secret"));
  assert.equal(a.requests.length, 1);
});

test("logout invalidates an in-flight snapshot instead of caching the previous account", async () => {
  let resolve;
  const pending = new Promise((r) => { resolve = r; });
  const a = app({ autoDetect: false }, { anthropic: { token: "old" } }, () => pending);
  const snapshot = a.invoke("quota.refresh", {});
  await new Promise((r) => setImmediate(r));
  await a.invoke("quota.auth.logout", { vendor: "anthropic" });
  resolve(reply({ five_hour: { utilization: 10 } }));
  assert.equal((await snapshot).code, "AUTH_CHANGED");
  assert.equal((await a.invoke("quota.snapshot", {})).accounts.length, 0);
});

test("generic mapped windows accept second-based periods without window_minutes", async () => {
  const a = app({ autoDetect: false, sources: [{ vendor: "xai", url: "https://api.x.ai/quota", token: "manual",
    windows: [{ path: "rate_limit" }] }] }, {}, () => reply({ rate_limit: { used_percent: 20, limit_window_seconds: 18000 } }));
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.accounts[0].status, "ok");
  assert.equal(result.accounts[0].windows[0].windowMinutes, 300);
  assert.equal(result.accounts[0].windows[0].remainingPercent, 80);
});
